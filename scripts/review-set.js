/*
 * Review-set generator and validator. A review set is one self-contained HTML
 * page (the shell in .claude/skills/so-pipeline/review-shell/) that the user
 * reviews and approves page by page. Mockup pages must look like the real
 * steward UI, so the shell carries a copy of the steward stylesheet; this
 * script regenerates that copy from the kernel's STYLE_RULES instead of a
 * hand-kept paste, and scopes every rule to #rv-content so the steward rules
 * cannot restyle the shell chrome around them.
 *
 * check() enforces what the artifact host and the shell rely on, so a bad set
 * fails here and not after publishing.
 *
 *   node scripts/review-set.js css [file]    rewrite the steward block, or print it
 *   node scripts/review-set.js check <file...>
 */

const fs = require("fs");
const path = require("path");

const BEGIN = "/* steward-css:begin */";
const END = "/* steward-css:end */";
const SCOPE_ID = "rv-content";

// The host draws its window chrome from images; these two values only imitate
// that wood frame around a mockup.
const HOST_CHROME = { background: "#5b4527", radius: "8px" };

const KINDS = ["mockup", "plan", "explainer"];
const RESERVED_IDS = ["settings", "sidebar", "customize", "upgrade", "downloads"];
const HASH_SAFE = /^[A-Za-z0-9-]+$/;
const ID_SAFE = /^[A-Za-z0-9_-]+$/;
const TITLE_LIMIT = 8192;

const SCRIPT_HOSTS = [
	"https://cdnjs.cloudflare.com/",
	"https://cdn.jsdelivr.net/npm/",
	"https://unpkg.com/",
	"https://cdn.tailwindcss.com",
	"https://code.jquery.com/"
];
const STYLE_HOSTS = ["https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];

function stewardCss() {
	const ui = require("../tests/harness").boot({ sections: ["kernel"] }).Steward.kernel.ui;
	const t = ui.tokens;
	const frame =
		"#" + SCOPE_ID + " .rv-frame{width:1000px;max-width:none;" +
		"background:" + HOST_CHROME.background + ";" +
		"border:1px solid " + t.ink + ";border-radius:" + HOST_CHROME.radius + ";" +
		"color:" + t.text + ";font:" + t.fontBase + "px Arial,Helvetica,sans-serif;}";
	return ui.scopeCss(ui.STYLE_RULES, [SCOPE_ID]) + frame;
}

function count(html, needle) {
	return html.split(needle).length - 1;
}

function inject(html, css) {
	[BEGIN, END].forEach(function (m) {
		const n = count(html, m);
		if (n !== 1) throw new Error("marker " + m + " found " + n + " times, expected 1");
	});
	const a = html.indexOf(BEGIN);
	const b = html.indexOf(END);
	if (b < a) throw new Error("marker " + END + " comes before " + BEGIN);
	return html.slice(0, a + BEGIN.length) + "\n" + css + "\n" + html.slice(b);
}

function startsWithAny(url, list) {
	return list.some(function (p) { return url.indexOf(p) === 0; });
}

// Validates the set object and attaches each page's option map as _opts for
// the section check; returns nothing.
function checkSet(set, errors) {
	if (!set || typeof set !== "object") {
		errors.push("review-set JSON is not an object");
		return;
	}
	["set", "task"].forEach(function (k) {
		if (typeof set[k] !== "string" || !set[k]) errors.push(k + " must be a non-empty string");
		else if (!HASH_SAFE.test(set[k])) errors.push(k + " is not hash-safe: " + set[k]);
	});
	if (KINDS.indexOf(set.kind) < 0) errors.push("kind must be one of " + KINDS.join("/"));
	if (typeof set.rev !== "number" || set.rev < 1 || Math.floor(set.rev) !== set.rev) {
		errors.push("rev must be a positive integer");
	}
	if (!Array.isArray(set.pages) || !set.pages.length) {
		errors.push("pages must be a non-empty array");
		return;
	}
	const seen = {};
	set.pages.forEach(function (p, i) {
		const label = "page " + (p && p.id ? p.id : "#" + (i + 1));
		if (!p || typeof p.id !== "string" || !HASH_SAFE.test(p.id)) {
			errors.push(label + ": id missing or not hash-safe");
			return;
		}
		if (seen[p.id]) errors.push(label + ": duplicate id");
		seen[p.id] = true;
		if (RESERVED_IDS.indexOf(p.id) >= 0 || p.id.indexOf("comment-") === 0) {
			errors.push(label + ": id is reserved by the host");
		}
		["title", "summary"].forEach(function (k) {
			if (typeof p[k] !== "string" || !p[k].trim()) errors.push(label + ": " + k + " is empty");
		});
		const optIds = {};
		(p.options || []).forEach(function (o) {
			if (!o || typeof o.id !== "string" || !ID_SAFE.test(o.id)) {
				errors.push(label + ": option id missing or invalid");
				return;
			}
			if (optIds[o.id]) errors.push(label + ": duplicate option " + o.id);
			optIds[o.id] = {};
			const values = Array.isArray(o.values) ? o.values : [];
			if (!values.length) errors.push(label + ": option " + o.id + " has no values");
			values.forEach(function (v) {
				if (!v || typeof v.id !== "string" || !ID_SAFE.test(v.id)) {
					errors.push(label + ": option " + o.id + " has an invalid value id");
				} else if (optIds[o.id][v.id]) {
					errors.push(label + ": option " + o.id + " duplicate value " + v.id);
				} else {
					optIds[o.id][v.id] = true;
				}
			});
		});
		p._opts = optIds;
	});
}

// Returns the text from `from` (just after an opening <section>) to its
// matching </section>, counting nested sections so inner ones do not end it.
function sectionBody(html, from) {
	const tag = /<(\/?)section\b[^>]*>/gi;
	let depth = 1;
	let m;
	tag.lastIndex = from;
	while ((m = tag.exec(html))) {
		depth += m[1] ? -1 : 1;
		if (!depth) return html.slice(from, m.index);
	}
	return html.slice(from);
}

// Shell chrome ids and the rv-shell class must each appear once; a hand edit
// that pastes the chrome twice would otherwise pass.
function checkChrome(html, errors) {
	const ids = {};
	let m;
	const ire = /\bid\s*=\s*"(rv-[^"]*)"/gi;
	while ((m = ire.exec(html))) ids[m[1]] = (ids[m[1]] || 0) + 1;
	Object.keys(ids).forEach(function (id) {
		if (ids[id] > 1) errors.push("duplicate id=\"" + id + "\" (" + ids[id] + " times)");
	});
	let shells = 0;
	const cre = /\bclass\s*=\s*"([^"]*)"/gi;
	while ((m = cre.exec(html))) {
		if (m[1].split(/\s+/).indexOf("rv-shell") >= 0) shells++;
	}
	if (shells > 1) errors.push("class rv-shell appears " + shells + " times");
}

function checkSections(html, set, errors) {
	const sections = {};
	const re = /<section\b[^>]*\bdata-page="([^"]*)"[^>]*>/g;
	let m;
	while ((m = re.exec(html))) {
		const id = m[1];
		const body = sectionBody(html, re.lastIndex);
		sections[id] = (sections[id] || 0) + 1;
		const page = set.pages.filter(function (p) { return p.id === id; })[0];
		if (!page) continue;
		const wre = /\bdata-when="([^"]*)"/g;
		let w;
		while ((w = wre.exec(body))) {
			w[1].split("&").forEach(function (cond) {
				const eq = cond.indexOf("=");
				const opt = (eq < 0 ? cond : cond.slice(0, eq)).trim();
				const val = eq < 0 ? "" : cond.slice(eq + 1).trim();
				const known = page._opts && page._opts[opt];
				if (!known) errors.push("page " + id + ": data-when names unknown option " + opt);
				else if (!known[val]) errors.push("page " + id + ": data-when names unknown value " + opt + "=" + val);
			});
		}
	}
	set.pages.forEach(function (p) {
		const n = sections[p.id] || 0;
		if (n !== 1) errors.push("page " + p.id + ": expected one section, found " + n);
	});
	Object.keys(sections).forEach(function (id) {
		const known = set.pages.some(function (p) { return p.id === id; });
		if (!known) errors.push("section " + id + " has no page in the JSON");
	});
}

function check(html) {
	const errors = [];
	if (/<!doctype[\s>]/i.test(html)) errors.push("contains <!doctype");
	if (/<html[\s>]/i.test(html)) errors.push("contains <html");
	if (/<head[\s>]/i.test(html)) errors.push("contains <head");
	if (/<body[\s>]/i.test(html)) errors.push("contains <body");
	checkChrome(html, errors);

	const tm = /<title>([\s\S]*?)<\/title>/i.exec(html);
	if (!tm) errors.push("missing <title>");
	else {
		if (tm.index + tm[0].length > TITLE_LIMIT) errors.push("<title> ends after the first " + TITLE_LIMIT + " characters");
		const words = tm[1].trim().split(/\s+/).filter(Boolean).length;
		if (words < 2 || words > 4) errors.push("<title> must be 2-4 words, found " + words);
	}

	const jm = /<script\b[^>]*\bid="review-set"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
	let set = null;
	if (!jm) errors.push("missing <script id=\"review-set\">");
	else {
		try {
			set = JSON.parse(jm[1]);
		} catch (e) {
			errors.push("review-set JSON does not parse: " + e.message);
		}
	}
	if (set) {
		checkSet(set, errors);
		if (Array.isArray(set.pages)) checkSections(html, set, errors);
		if (set.kind === "mockup") {
			const a = html.indexOf(BEGIN);
			const b = html.indexOf(END);
			if (a < 0 || b < a || !html.slice(a + BEGIN.length, b).trim()) {
				errors.push("kind mockup requires a non-empty steward block");
			}
		}
	}

	if (/\b(alert|confirm|prompt)\s*\(/.test(html)) errors.push("uses alert/confirm/prompt");
	if (/window\.print/.test(html)) errors.push("uses window.print");
	if (/<a\b[^>]*\bdownload\b/i.test(html)) errors.push("contains <a download>");

	let s;
	const sre = /<script\b[^>]*\bsrc\s*=\s*["']([^"']*)["']/gi;
	while ((s = sre.exec(html))) {
		if (!startsWithAny(s[1], SCRIPT_HOSTS)) errors.push("script from a non-allowlisted source: " + s[1]);
	}
	let l;
	const lre = /<link\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>/gi;
	while ((l = lre.exec(html))) {
		if (/rel\s*=\s*["']?stylesheet/i.test(l[0]) && !startsWithAny(l[1], STYLE_HOSTS)) {
			errors.push("stylesheet from a non-allowlisted source: " + l[1]);
		}
	}
	return errors;
}

function main(argv) {
	const cmd = argv[0];
	const files = argv.slice(1);
	if (cmd === "css") {
		const css = stewardCss();
		if (!files.length) {
			process.stdout.write(css + "\n");
			return 0;
		}
		const file = path.resolve(files[0]);
		fs.writeFileSync(file, inject(fs.readFileSync(file, "utf8"), css), "utf8");
		return 0;
	}
	if (cmd === "check" && files.length) {
		let failed = false;
		files.forEach(function (f) {
			const errs = check(fs.readFileSync(f, "utf8"));
			if (!errs.length) console.log(f + ": ok");
			else {
				failed = true;
				errs.forEach(function (e) { console.log(f + ": " + e); });
			}
		});
		return failed ? 1 : 0;
	}
	console.error("usage: node scripts/review-set.js css [file] | check <file...>");
	return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { stewardCss, inject, check, BEGIN, END, SCOPE_ID };
