#!/usr/bin/env node
/*
 * Steward user guide build script.
 *
 * Stamps the shared page layout onto each hand-written page fragment under
 * docs/userguide/ and writes a flat static site to build/userguide/. The
 * output is plain HTML, CSS and one small script, so GitHub Pages can serve it
 * as is. No dependency.
 *
 * Sources (docs/userguide/):
 *   _layout.html       page shell with the tokens {{title}} {{nav}} {{content}}
 *                      {{version}} {{repo}}; any other {{...}} is an error
 *   guide.css, guide.js, img/*   copied to the output (img/README.md is not)
 *   index.html, install.html, ui.html     the general pages, in that order
 *   modules/<id>.html  one page per directory in src/modules/, in alphabetical
 *                      order, so a new module without a page fails the build
 *
 * A fragment is body content only. It starts with one <h1>, whose plain text
 * is the page title and the sidebar label. A screenshot placeholder is
 *   <figure class="ug-shot" data-shot="<name>.png"> <div class="ug-shot-box">
 *   ...</div> <figcaption>...</figcaption> </figure>
 * and the box is swapped for the image when img/<name> exists.
 *
 * Usage:
 *   node scripts/userguide.js [--out <dir>]
 *   STEWARD_VERSION=0.1.0 node scripts/userguide.js
 *
 * The footer version follows scripts/version.js, so it matches the bundle.
 */

const fs = require("fs");
const path = require("path");
const version = require("./version");

const REPO_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(REPO_ROOT, "docs", "userguide");
const MODULES_DIR = path.join(REPO_ROOT, "src", "modules");
const OUT_DIR = path.join(REPO_ROOT, "build", "userguide");

// The one order of the general pages; module pages follow, alphabetically.
const GENERAL_PAGES = ["index", "install", "ui"];
const TOKENS = ["title", "nav", "content", "version", "repo"];
const SHOT_NAME = /^[a-z0-9-]+\.(png|jpg)$/;

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

// The first <h1> is the title, so the nav label has no second source.
function titleOf(fragment, label) {
	const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(fragment);
	const title = m ? stripTags(m[1]) : "";
	if (!title) throw new Error(label + ": no <h1> title");
	return title;
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

function navHtml(pages, current) {
	function item(p) {
		const on = p.slug === current ? ' class="on" aria-current="page"' : "";
		return '<li><a href="' + p.slug + '.html"' + on + ">" +
			escapeHtml(p.title) + "</a></li>";
	}
	const general = pages.filter(function (p) { return !p.module; });
	const modules = pages.filter(function (p) { return p.module; });
	return [
		"<ul>",
		general.map(item).join("\n"),
		"</ul>",
		'<p class="ug-group">Modules</p>',
		"<ul>",
		modules.map(item).join("\n"),
		"</ul>",
	].join("\n");
}

// Swaps a placeholder box for the image once the file exists, so a shot can
// land later without touching the page.
function processShots(fragment, imgDir, label) {
	const figure = /<figure class="ug-shot" data-shot="([^"]*)">([\s\S]*?)<\/figure>/g;
	return fragment.replace(figure, function (whole, name, inner) {
		if (!SHOT_NAME.test(name)) {
			throw new Error(label + ': bad data-shot "' + name + '"');
		}
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
	const moduleIds = listDirs(modulesDir);

	const pages = [];
	GENERAL_PAGES.forEach(function (slug) {
		pages.push({ slug: slug, module: false, file: path.join(srcDir, slug + ".html") });
	});
	moduleIds.forEach(function (id) {
		if (GENERAL_PAGES.indexOf(id) !== -1) {
			throw new Error("module id collides with a general page: " + id);
		}
		pages.push({ slug: id, module: true, file: path.join(srcDir, "modules", id + ".html") });
	});

	const listed = pages.map(function (p) { return p.file; });
	listHtml(srcDir)
		.filter(function (n) { return n !== "_layout"; })
		.map(function (n) { return path.join(srcDir, n + ".html"); })
		.concat(listHtml(path.join(srcDir, "modules")).map(function (n) {
			return path.join(srcDir, "modules", n + ".html");
		}))
		.forEach(function (f) {
			if (listed.indexOf(f) === -1) throw new Error("unlisted page fragment: " + f);
		});

	pages.forEach(function (p) {
		p.fragment = readFragment(p.file);
		p.title = titleOf(p.fragment, p.file);
	});

	const imgDir = path.join(srcDir, "img");
	const rendered = pages.map(function (p) {
		const html = stamp(layout, {
			title: escapeHtml(p.title),
			nav: navHtml(pages, p.slug),
			content: processShots(p.fragment, imgDir, p.file),
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
	if (fs.existsSync(imgDir)) {
		fs.readdirSync(imgDir, { withFileTypes: true }).forEach(function (e) {
			if (!e.isFile() || e.name === "README.md") return;
			fs.mkdirSync(path.join(outDir, "img"), { recursive: true });
			fs.copyFileSync(path.join(imgDir, e.name), path.join(outDir, "img", e.name));
		});
	}

	return {
		version: ver,
		pages: pages.map(function (p) { return { slug: p.slug, title: p.title }; }),
	};
}

function main(argv) {
	const opts = {};
	const i = argv.indexOf("--out");
	if (i !== -1) {
		if (!argv[i + 1]) throw new Error("--out needs a directory");
		opts.outDir = path.resolve(argv[i + 1]);
	}
	const res = build(opts);
	process.stdout.write(
		"userguide " + res.version + ": " + res.pages.length + " pages -> " +
			(opts.outDir || OUT_DIR) + "\n",
	);
}

if (require.main === module) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(err.message + "\n");
		process.exit(1);
	}
}

module.exports = {
	build: build,
	escapeHtml: escapeHtml,
	titleOf: titleOf,
	GENERAL_PAGES: GENERAL_PAGES,
};
