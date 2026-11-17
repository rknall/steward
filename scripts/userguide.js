#!/usr/bin/env node
/*
 * Steward user guide build script.
 *
 * Stamps the shared page layout onto each hand-written page fragment and
 * writes a flat static site to build/userguide/. The output is plain HTML, CSS
 * and one small script, so GitHub Pages can serve it as is. No dependency.
 *
 * Sources:
 *   docs/userguide/_layout.html   page shell with the tokens {{title}} {{nav}}
 *                      {{content}} {{version}} {{repo}}; any other {{...}} is
 *                      an error
 *   docs/userguide/guide.css, guide.js, img/*   copied to the output (img/README.md
 *                      is not)
 *   docs/userguide/<slug>.html    the general pages listed in SECTIONS
 *   src/modules/<id>/guide/page.html   one page per module directory; a module
 *                      without one fails the build
 *   src/modules/<id>/guide/img/*  that module's screenshots, copied flat
 *
 * A general fragment is body content only and starts with one <h1>, whose
 * plain text is the page title and the sidebar label. A module fragment has no
 * <h1>: the build inserts the module's registered ui.section.title, so the
 * display name has one source. A screenshot placeholder is
 *   <figure class="ug-shot" data-shot="<slug>-<name>.png"> <div class="ug-shot-box">
 *   ...</div> <figcaption>...</figcaption> </figure>
 * and the box is swapped for the image when the file exists.
 *
 * Usage:
 *   node scripts/userguide.js [--out <dir>]
 *   node scripts/userguide.js --check <fragment>...
 *   STEWARD_VERSION=0.1.0 node scripts/userguide.js
 *
 * --check validates single fragments without a whole-tree build and exits 1
 * when any fails. The footer version follows scripts/version.js, so it matches
 * the bundle.
 */

const fs = require("fs");
const path = require("path");
const version = require("./version");

const REPO_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(REPO_ROOT, "docs", "userguide");
const MODULES_DIR = path.join(REPO_ROOT, "src", "modules");
const OUT_DIR = path.join(REPO_ROOT, "build", "userguide");

// The one order and grouping of the pages; the module pages are found on disk.
const SECTIONS = [
	{ title: "Getting started", pages: ["index", "install", "ui"] },
	{ title: "Modules", modules: true },
	{ title: "Reference", pages: ["logs", "troubleshooting"] },
];
// The h2s every module page carries. title is the heading text, nav the label
// in the sidebar, so both names live here.
const MODULE_SECTIONS = [
	{ id: "use-cases", title: "What you can do", nav: "Use cases" },
	{ id: "settings", title: "Settings", nav: "Settings" },
	{ id: "notes", title: "Notes", nav: "Notes", optional: true },
];
const MODULE_GUIDE = path.join("guide", "page.html");
const MODULE_IMG = path.join("guide", "img");
const TOKENS = ["title", "nav", "content", "version", "repo"];
const SHOT_NAME = /^[a-z0-9-]+\.(png|jpg)$/;

function generalSlugs() {
	const out = [];
	SECTIONS.forEach(function (s) {
		(s.pages || []).forEach(function (slug) { out.push(slug); });
	});
	return out;
}

function escapeHtml(str) {
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function stripTags(html) {
	return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function slugify(text) {
	return String(text)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// The first <h1> is the title, so the nav label has no second source.
function titleOf(fragment, label) {
	const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(fragment);
	const title = m ? stripTags(m[1]) : "";
	if (!title) throw new Error(label + ": no <h1> title");
	return title;
}

// Display names come from the registry the menu itself uses. Experimental is
// on so a gated module still has a title; the guide documents every module.
function moduleTitles() {
	const harness = require("../tests/harness");
	const H = harness.boot({ host: { mainSettings: { experimental: true } } });
	const titles = {};
	H.Steward.kernel.registry.list().forEach(function (m) {
		if (m.ui && m.ui.section && m.ui.section.title) {
			titles[m.id] = m.ui.section.title;
		}
	});
	return titles;
}

function repoUrl() {
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
		);
		const url = String((pkg.repository && pkg.repository.url) || "");
		return url.replace(/^git\+/, "").replace(/\.git$/, "");
	} catch (e) {
		return "";
	}
}

function contains(outer, inner) {
	const rel = path.relative(outer, inner);
	return rel === "" || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel));
}

function listHtml(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter(function (e) { return e.isFile() && /\.html$/.test(e.name); })
		.map(function (e) { return e.name.replace(/\.html$/, ""); });
}

function listDirs(dir) {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter(function (e) { return e.isDirectory(); })
		.map(function (e) { return e.name; })
		.sort();
}

function readFragment(file) {
	if (!fs.existsSync(file)) throw new Error("missing page fragment: " + file);
	return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

// Gives every h2 and h3 an id unless it has one, and collects the h2s. The
// required module h2s take their id from MODULE_SECTIONS.
function addHeadingIds(fragment, file, isModule) {
	const used = {};
	const h2s = [];
	const html = fragment.replace(
		/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi,
		function (whole, level, attrs, inner, offset) {
			const text = stripTags(inner);
			const explicit = /\sid="([^"]*)"/.exec(attrs);
			let id;
			let req = null;
			if (level === "2" && isModule) {
				MODULE_SECTIONS.forEach(function (s) {
					if (s.title === text) req = s;
				});
			}
			if (explicit) id = explicit[1];
			else id = req ? req.id : slugify(text);
			if (!id) throw new Error(file + ': empty heading id for "' + text + '"');
			if (used[id]) throw new Error(file + ": duplicate heading id " + id);
			used[id] = true;
			if (level === "2") {
				h2s.push({ id: id, text: text, offset: offset, nav: req ? req.nav : text });
			}
			if (explicit) return whole;
			return "<h" + level + ' id="' + id + '"' + attrs + ">" + inner + "</h" + level + ">";
		},
	);
	return { html: html, h2s: h2s };
}

function checkModuleStructure(fragment, file, h2s, hasSettings) {
	const first = MODULE_SECTIONS[0];
	const second = MODULE_SECTIONS[1];
	const last = MODULE_SECTIONS[2];
	if (!h2s.length || h2s[0].text !== first.title) {
		throw new Error(file + ': the first h2 must be "' + first.title + '"');
	}
	const end = h2s.length > 1 ? h2s[1].offset : fragment.length;
	if (fragment.slice(h2s[0].offset, end).indexOf('class="ug-story"') === -1) {
		throw new Error(file + ': "' + first.title + '" has no div.ug-story');
	}
	const at = h2s.map(function (h) { return h.text; }).indexOf(second.title);
	if (at < 1) throw new Error(file + ': no "' + second.title + '" h2 after "' + first.title + '"');
	const notes = h2s.map(function (h) { return h.text; }).indexOf(last.title);
	if (notes !== -1 && (notes !== h2s.length - 1 || notes < at)) {
		throw new Error(file + ': "' + last.title + '" must be the last h2, after "' + second.title + '"');
	}
	if (!hasSettings && /class="ug-set"/.test(fragment)) {
		throw new Error(file + ": ug-set found but the module has no settings.js");
	}
}

// Every documented key must occur in the module's settings.js, matched per
// dotted segment so a nested key is found by its parts.
function checkSettingKeys(fragment, file, settingsFile) {
	const src = fs.readFileSync(settingsFile, "utf8");
	const re = /<div class="ug-set"[^>]*>\s*<h3[^>]*>\s*<code>([^<]*)<\/code>/g;
	let m;
	while ((m = re.exec(fragment))) {
		const key = m[1].trim();
		key.split(".").forEach(function (seg) {
			if (!new RegExp("\\b" + seg.replace(/[^\w]/g, "") + "\\b").test(src)) {
				throw new Error(file + ": setting " + key + " is not in settings.js");
			}
		});
	}
}

function checkShotNames(fragment, file, slug) {
	const re = /data-shot="([^"]*)"/g;
	let m;
	while ((m = re.exec(fragment))) {
		if (!SHOT_NAME.test(m[1])) {
			throw new Error(file + ': bad data-shot "' + m[1] + '"');
		}
		if (m[1].indexOf(slug + "-") !== 0) {
			throw new Error(file + ': data-shot "' + m[1] + '" must start with "' + slug + '-"');
		}
	}
}

// The path decides the kind: <id>/guide/page.html is a module page, anything
// else is a general page named by its file.
function kindOf(file) {
	const dir = path.dirname(file);
	if (path.basename(file) === "page.html" && path.basename(dir) === "guide") {
		const modDir = path.dirname(dir);
		return { module: true, slug: path.basename(modDir), modDir: modDir };
	}
	return { module: false, slug: path.basename(file).replace(/\.html$/, "") };
}

// All per-page rules in one place; build() calls it too. Returns the page with
// the processed fragment, checkFragment() returns the short form.
function preparePage(file, opts) {
	const kind = kindOf(file);
	const fragment = readFragment(file);
	let title;
	let section;
	if (kind.module) {
		const titles = opts.moduleTitles || moduleTitles();
		title = titles[kind.slug];
		if (!title) throw new Error("module " + kind.slug + ": no ui.section.title (" + file + ")");
		if (/<h1/i.test(fragment)) {
			throw new Error(file + ": a module fragment has no <h1>; the build adds it");
		}
		section = "Modules";
	} else {
		if (generalSlugs().indexOf(kind.slug) === -1) {
			throw new Error(file + ": " + kind.slug + " is not listed in SECTIONS");
		}
		title = titleOf(fragment, file);
		SECTIONS.forEach(function (s) {
			if ((s.pages || []).indexOf(kind.slug) !== -1) section = s.title;
		});
	}
	const ids = addHeadingIds(fragment, file, kind.module);
	if (kind.module) {
		const settingsFile = path.join(kind.modDir, "settings.js");
		const hasSettings = fs.existsSync(settingsFile);
		checkModuleStructure(fragment, file, ids.h2s, hasSettings);
		if (hasSettings) checkSettingKeys(fragment, file, settingsFile);
	}
	checkShotNames(fragment, file, kind.slug);
	return {
		slug: kind.slug,
		title: title,
		section: section,
		module: kind.module,
		h2s: ids.h2s,
		html: ids.html,
	};
}

function checkFragment(file, opts) {
	const p = preparePage(file, opts || {});
	return { slug: p.slug, title: p.title, section: p.section, h2s: p.h2s };
}

// The sidebar: SECTIONS > pages > a module page's h2s. A section is open when
// it holds the current page; Modules is always open.
function navHtml(pages, current) {
	function generalItem(p) {
		const on = p.slug === current ? ' class="on" aria-current="page"' : "";
		return '<li class="l2"><a href="' + p.slug + '.html"' + on + ">" +
			escapeHtml(p.title) + "</a></li>";
	}
	function moduleItem(p) {
		const cur = p.slug === current;
		const links = p.h2s.map(function (h, i) {
			const on = cur && i === 0 ? ' class="on"' : "";
			return '<li><a href="' + p.slug + ".html#" + h.id + '"' + on + ">" +
				escapeHtml(h.nav) + "</a></li>";
		});
		return '<li class="l2' + (cur ? " cur" : "") + '"><details' + (cur ? " open" : "") +
			"><summary" + (cur ? ' aria-current="page"' : "") + ">" + escapeHtml(p.title) +
			'</summary><ul class="l3">' + links.join("") + "</ul></details></li>";
	}
	return SECTIONS.map(function (s) {
		let list;
		if (s.modules) {
			list = pages
				.filter(function (p) { return p.module; })
				.sort(function (a, b) { return a.title.localeCompare(b.title); });
		} else {
			list = s.pages.map(function (slug) {
				return pages.filter(function (p) { return p.slug === slug; })[0];
			}).filter(Boolean);
		}
		const holds = list.some(function (p) { return p.slug === current; });
		const open = s.modules || holds ? " open" : "";
		return '<details class="l1"' + open + "><summary>" + escapeHtml(s.title) +
			"</summary><ul>" + list.map(s.modules ? moduleItem : generalItem).join("\n") +
			"</ul></details>";
	}).join("\n");
}

// Swaps a placeholder box for the image once the file exists, so a shot can
// land later without touching the page.
function processShots(fragment, imgDir) {
	const figure = /<figure class="ug-shot" data-shot="([^"]*)">([\s\S]*?)<\/figure>/g;
	return fragment.replace(figure, function (whole, name, inner) {
		if (!fs.existsSync(path.join(imgDir, name))) return whole;
		const cap = /<figcaption>([\s\S]*?)<\/figcaption>/.exec(inner);
		const alt = escapeHtml(cap ? stripTags(cap[1]) : name);
		const img = '<img src="img/' + name + '" alt="' + alt + '">';
		return whole.replace(/<div class="ug-shot-box">[\s\S]*?<\/div>/, img);
	});
}

function stamp(layout, values) {
	let out = layout;
	TOKENS.forEach(function (token) {
		out = out.split("{{" + token + "}}").join(values[token]);
	});
	return out;
}

function copyImgs(from, to) {
	if (!fs.existsSync(from)) return;
	fs.readdirSync(from, { withFileTypes: true }).forEach(function (e) {
		if (!e.isFile() || e.name === "README.md") return;
		fs.mkdirSync(to, { recursive: true });
		fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
	});
}

function build(opts) {
	opts = opts || {};
	const srcDir = opts.srcDir || SRC_DIR;
	const modulesDir = opts.modulesDir || MODULES_DIR;
	const outDir = opts.outDir || OUT_DIR;
	const ver = opts.version !== undefined ? opts.version : version.read(REPO_ROOT);
	const repo = opts.repoUrl !== undefined ? opts.repoUrl : repoUrl();

	// The output dir is deleted first, so it must never hold the sources.
	[REPO_ROOT, srcDir, modulesDir].forEach(function (p) {
		if (contains(outDir, p)) {
			throw new Error("refusing output dir " + outDir + ": it contains " + p);
		}
	});

	const layout = readFragment(path.join(srcDir, "_layout.html"));
	const slugs = generalSlugs();
	const moduleIds = listDirs(modulesDir);
	const titles = opts.moduleTitles || moduleTitles();

	const found = [];
	slugs.forEach(function (slug) {
		found.push({ file: path.join(srcDir, slug + ".html"), imgDir: path.join(srcDir, "img") });
	});
	moduleIds.forEach(function (id) {
		if (slugs.indexOf(id) !== -1) {
			throw new Error("module id collides with a general page: " + id);
		}
		const file = path.join(modulesDir, id, MODULE_GUIDE);
		if (!fs.existsSync(file)) throw new Error("module " + id + ": missing guide/page.html");
		if (!titles[id]) throw new Error("module " + id + ": no ui.section.title");
		found.push({ file: file, imgDir: path.join(modulesDir, id, MODULE_IMG) });
	});

	const listed = found.map(function (f) { return f.file; });
	listHtml(srcDir)
		.filter(function (n) { return n !== "_layout"; })
		.map(function (n) { return path.join(srcDir, n + ".html"); })
		.concat(moduleIds.reduce(function (acc, id) {
			return acc.concat(listHtml(path.join(modulesDir, id, "guide")).map(function (n) {
				return path.join(modulesDir, id, "guide", n + ".html");
			}));
		}, []))
		.forEach(function (f) {
			if (listed.indexOf(f) === -1) throw new Error("unlisted page fragment: " + f);
		});

	const pages = found.map(function (f) {
		const p = preparePage(f.file, { moduleTitles: titles });
		p.file = f.file;
		p.imgDir = f.imgDir;
		const crumb = '<p class="ug-crumb">' + escapeHtml(p.section) + " &rsaquo; " +
			escapeHtml(p.title) + "</p>\n";
		if (p.module) {
			p.html = crumb + "<h1>" + escapeHtml(p.title) + "</h1>\n" + p.html;
		} else {
			p.html = p.html.replace(/<h1/i, function (m) { return crumb + m; });
		}
		return p;
	});

	// Nav order: SECTIONS order, modules by display name.
	const ordered = [];
	SECTIONS.forEach(function (s) {
		if (s.modules) {
			pages.filter(function (p) { return p.module; })
				.sort(function (a, b) { return a.title.localeCompare(b.title); })
				.forEach(function (p) { ordered.push(p); });
		} else {
			s.pages.forEach(function (slug) {
				ordered.push(pages.filter(function (p) { return p.slug === slug; })[0]);
			});
		}
	});

	const rendered = ordered.map(function (p) {
		const html = stamp(layout, {
			title: escapeHtml(p.title),
			nav: navHtml(pages, p.slug),
			content: processShots(p.html, p.imgDir),
			version: escapeHtml(ver),
			repo: escapeHtml(repo),
		});
		const left = /\{\{[a-z]+\}\}/.exec(html);
		if (left) throw new Error(p.file + ": unknown token " + left[0]);
		return { slug: p.slug, html: html };
	});

	fs.rmSync(outDir, { recursive: true, force: true });
	fs.mkdirSync(outDir, { recursive: true });
	rendered.forEach(function (r) {
		fs.writeFileSync(path.join(outDir, r.slug + ".html"), r.html, "utf8");
	});
	["guide.css", "guide.js"].forEach(function (name) {
		const from = path.join(srcDir, name);
		if (fs.existsSync(from)) fs.copyFileSync(from, path.join(outDir, name));
	});
	copyImgs(path.join(srcDir, "img"), path.join(outDir, "img"));
	moduleIds.forEach(function (id) {
		copyImgs(path.join(modulesDir, id, MODULE_IMG), path.join(outDir, "img"));
	});

	return {
		version: ver,
		pages: ordered.map(function (p) {
			return { slug: p.slug, title: p.title, section: p.section };
		}),
	};
}

// Returns the exit code so a test can call it without ending the process.
function main(argv) {
	const c = argv.indexOf("--check");
	const o = argv.indexOf("--out");
	if (c !== -1 && o !== -1) throw new Error("--check and --out cannot be combined");
	if (c !== -1) {
		const files = argv.slice(c + 1);
		if (!files.length) throw new Error("--check needs at least one file");
		let failed = 0;
		const opts = {};
		files.forEach(function (f) {
			try {
				checkFragment(f, opts);
				process.stdout.write("ok " + f + "\n");
			} catch (err) {
				failed++;
				process.stderr.write(err.message + "\n");
			}
		});
		return failed ? 1 : 0;
	}
	const opts = {};
	if (o !== -1) {
		if (!argv[o + 1]) throw new Error("--out needs a directory");
		opts.outDir = path.resolve(argv[o + 1]);
	}
	const res = build(opts);
	process.stdout.write(
		"userguide " + res.version + ": " + res.pages.length + " pages -> " +
			(opts.outDir || OUT_DIR) + "\n",
	);
	return 0;
}

if (require.main === module) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		process.stderr.write(err.message + "\n");
		process.exit(1);
	}
}

module.exports = {
	build: build,
	checkFragment: checkFragment,
	escapeHtml: escapeHtml,
	titleOf: titleOf,
	slugify: slugify,
	moduleTitles: moduleTitles,
	navHtml: navHtml,
	main: main,
	SECTIONS: SECTIONS,
	MODULE_SECTIONS: MODULE_SECTIONS,
};
