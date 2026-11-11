#!/usr/bin/env node
/*
 * Steward release planner.
 *
 * Works out the next version from the latest v* tag plus the "Bump: major|minor"
 * trailers in the commits since that tag (no trailer means patch), and builds
 * release notes from the commit subjects. It never tags, commits or pushes and
 * never writes into the repo; the only files it writes are --notes-out and the
 * file named by $GITHUB_OUTPUT.
 *
 * Usage:
 *   node scripts/release.js                       dry run: last tag, bump, next version, notes
 *   node scripts/release.js --at v0.11.0          notes for an existing tag
 *   node scripts/release.js --notes-out notes.md  also write the notes to a file
 *   node scripts/release.js --github-output       append version/tag/level/pending/tagged/count
 *                                                 to $GITHUB_OUTPUT
 */

const fs = require("fs");
const path = require("path");
const version = require("./version");

const REPO_ROOT = path.resolve(__dirname, "..");
const LEVEL_RANK = { patch: 0, minor: 1, major: 2 };
const BUMP_LINE = /^\s*Bump:\s*(major|minor|patch)\s*$/i;
const REF_LINE = /^\s*(Fixes|Closes|Resolves|Refs)\s+#(\d+)/i;
const USAGE =
	"Usage: node scripts/release.js [--at <tag>] [--notes-out <file>] [--github-output]";

function parseSemver(str) {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(str));
	if (!m) return null;
	return {
		major: parseInt(m[1], 10),
		minor: parseInt(m[2], 10),
		patch: parseInt(m[3], 10),
	};
}

function nextVersion(base, level) {
	const v = typeof base === "string" ? parseSemver(base) : base;
	if (level === "major") return String(v.major + 1) + ".0.0";
	if (level === "minor") return v.major + "." + (v.minor + 1) + ".0";
	return v.major + "." + v.minor + "." + (v.patch + 1);
}

// The trailer can sit anywhere in a message, because a squash can bury it
// mid-body, so every line is checked.
function bumpLevel(bodies) {
	let best = "patch";
	bodies.forEach(function (body) {
		String(body).split(/\r?\n/).forEach(function (line) {
			const m = BUMP_LINE.exec(line);
			if (!m) return;
			const level = m[1].toLowerCase();
			if (LEVEL_RANK[level] > LEVEL_RANK[best]) best = level;
		});
	});
	return best;
}

// Older subjects carried a "; v0.10.13" version suffix.
function cleanSubject(s) {
	return String(s).replace(/;\s*v\d+\.\d+\.\d+\S*\s*$/, "").trim();
}

function issueRefs(body) {
	const refs = [];
	String(body || "").split(/\r?\n/).forEach(function (line) {
		const m = REF_LINE.exec(line);
		if (m && refs.indexOf(m[2]) === -1) refs.push(m[2]);
	});
	return refs;
}

function formatNotes(commits) {
	if (!commits || !commits.length) return "No changes.\n";
	return commits.map(function (c) {
		const refs = issueRefs(c.body).map(function (n) { return "#" + n; });
		return "- " + cleanSubject(c.subject) + " (" + String(c.sha).slice(0, 7) + ")" +
			(refs.length ? " " + refs.join(", ") : "");
	}).join("\n") + "\n";
}

function splitRecords(out) {
	if (!out) return [];
	const parts = out.split("\0");
	if (!parts.length || !parts[parts.length - 1].trim()) parts.pop();
	return parts;
}

function pkgVersion(repoRoot) {
	const pkg = JSON.parse(
		fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
	);
	return pkg.version;
}

function plan(repoRoot, opts) {
	const at = opts && opts.at;
	const ref = at ? at + "^" : "HEAD";
	const base = version.git(
		["describe", "--tags", "--abbrev=0", "--match", version.TAG_MATCH, ref],
		repoRoot,
	);
	const end = at || "HEAD";
	const range = base ? base + ".." + end : end;

	const bodies = splitRecords(
		version.git(["log", "--format=%B%x00", range], repoRoot),
	).map(function (b) { return b.trim(); });
	const commits = splitRecords(
		version.git(
			["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x00", range],
			repoRoot,
		),
	).map(function (rec) {
		const f = rec.replace(/^\s+/, "").split("\x1f");
		return { sha: f[0], subject: f[1] || "", body: f[2] || "" };
	});

	const level = bumpLevel(bodies);
	let ver;
	if (at) {
		if (!parseSemver(at)) throw new Error("Not a version tag: " + at);
		ver = at.charAt(0) === "v" ? at.slice(1) : at;
	} else if (base) {
		ver = nextVersion(base, level);
	} else {
		ver = pkgVersion(repoRoot);
	}
	const tagged = version.git(
		["tag", "--points-at", "HEAD", "--list", version.TAG_MATCH],
		repoRoot,
	);

	return {
		base: base,
		version: ver,
		tag: "v" + ver,
		level: level,
		pending: level !== "patch",
		count: bodies.length,
		headTagged: !!tagged,
		notes: formatNotes(commits),
	};
}

function parseArgs(argv) {
	const opts = { at: undefined, notesOut: undefined, githubOutput: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--at" && i + 1 < argv.length) opts.at = argv[++i];
		else if (a === "--notes-out" && i + 1 < argv.length) opts.notesOut = argv[++i];
		else if (a === "--github-output") opts.githubOutput = true;
		else return null;
	}
	return opts;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (!opts) {
		console.error(USAGE);
		process.exit(2);
	}
	if (opts.githubOutput && !process.env.GITHUB_OUTPUT) {
		console.error("--github-output needs $GITHUB_OUTPUT to be set.");
		process.exit(1);
	}

	let p;
	try {
		p = plan(REPO_ROOT, { at: opts.at });
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}

	if (opts.notesOut) fs.writeFileSync(opts.notesOut, p.notes);
	if (opts.githubOutput) {
		fs.appendFileSync(
			process.env.GITHUB_OUTPUT,
			"version=" + p.version + "\n" +
			"tag=" + p.tag + "\n" +
			"level=" + p.level + "\n" +
			"pending=" + (p.pending ? "true" : "false") + "\n" +
			"tagged=" + (p.headTagged ? "true" : "false") + "\n" +
			"count=" + p.count + "\n",
		);
	}

	console.log("Last tag: " + (p.base || "none"));
	console.log("Commits: " + p.count);
	console.log("Bump: " + p.level);
	console.log("Next: " + p.tag);
	if (p.count === 0 && p.base) {
		console.log("");
		console.log("Nothing to release since " + p.base + ".");
		return;
	}
	console.log("");
	process.stdout.write(p.notes);
	console.log("");
	console.log(
		"Minor/major releases are cut by CI on merge to main; for a patch release " +
		"run the Release workflow (workflow_dispatch) or " +
		"`git tag -a " + p.tag + " -m ... && git push origin " + p.tag + "`.",
	);
}

if (require.main === module) main();

module.exports = {
	parseSemver: parseSemver,
	nextVersion: nextVersion,
	bumpLevel: bumpLevel,
	cleanSubject: cleanSubject,
	issueRefs: issueRefs,
	formatNotes: formatNotes,
	plan: plan,
};
