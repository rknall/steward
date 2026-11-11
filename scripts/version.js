/*
 * Release version helper, shared by scripts/build.js and tests/harness.js so
 * the bundle and the tests substitute the version the same way.
 *
 * Precedence: STEWARD_VERSION (set by the release workflow) >
 * `git describe --tags --match v[0-9]* --dirty` with the leading v stripped >
 * package.json "version" > "0.0.0". package.json is only a fallback for a
 * checkout without git or tags. The git result is memoised per repo root,
 * because the test harness reads the version once per source file per boot.
 * Source files carry the quoted TOKEN_LITERAL, which inject() replaces with a
 * JSON-quoted version.
 */

const fs = require("fs");
const path = require("path");
const execFileSync = require("child_process").execFileSync;

const TOKEN_LITERAL = "'__STEWARD_VERSION__'";

// The one release-tag pattern; build and release script both use it.
const TAG_MATCH = "v[0-9]*";

const describeCache = {};

// No shell, so the tag glob needs no quoting on Windows. Never throws: a
// missing git or a non-repo directory just means "no answer".
function git(args, cwd) {
	try {
		const out = execFileSync("git", args, {
			cwd: cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return String(out).trim();
	} catch (e) {
		return null;
	}
}

function fromDescribe(str) {
	if (typeof str !== "string" || !str) return null;
	return str.charAt(0) === "v" ? str.slice(1) || null : str;
}

function describe(repoRoot) {
	if (!Object.prototype.hasOwnProperty.call(describeCache, repoRoot)) {
		describeCache[repoRoot] = fromDescribe(
			git(["describe", "--tags", "--match", TAG_MATCH, "--dirty"], repoRoot),
		);
	}
	return describeCache[repoRoot];
}

// First non-empty value wins.
function resolve(envValue, describeValue, pkgVersion) {
	return envValue || describeValue || pkgVersion || "0.0.0";
}

function pkgVersion(repoRoot) {
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
		);
		return pkg.version || null;
	} catch (e) {
		return null;
	}
}

// The env is read on every call so tests can override it; git only runs
// when the env is unset.
function read(repoRoot) {
	const env = process.env.STEWARD_VERSION;
	if (env) return env;
	return resolve(undefined, describe(repoRoot), pkgVersion(repoRoot));
}

// split/join avoids regex escaping; JSON.stringify keeps a quote in an
// env-provided version from breaking the bundle.
function inject(body, version) {
	return body.split(TOKEN_LITERAL).join(JSON.stringify(String(version)));
}

module.exports = {
	TOKEN_LITERAL: TOKEN_LITERAL,
	TAG_MATCH: TAG_MATCH,
	git: git,
	fromDescribe: fromDescribe,
	describe: describe,
	resolve: resolve,
	read: read,
	inject: inject,
};
