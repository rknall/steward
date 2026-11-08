/*
 * Built-in scenario embedding, shared by scripts/build.js and the tests so the
 * bundle and the tests read scenarios/*.json the same way (like version.js).
 *
 * collect() reads every scenarios/*.json of the repo and only checks that the
 * text is JSON, so a typo fails the build loudly. The schema and the id rules
 * live in the runtime parser (adventures scenarios.fromText), the one
 * validator. chunk() turns the list into ES5 source that hands the texts to
 * the adventures module at load; the runtime parses them like a user file.
 */

const fs = require("fs");
const path = require("path");

const DIR_NAME = "scenarios";

function collect(repoRoot) {
	const dir = path.join(repoRoot, DIR_NAME);
	if (!fs.existsSync(dir)) return [];
	const names = fs
		.readdirSync(dir)
		.filter(function (n) { return /\.json$/i.test(n); })
		.sort();
	return names.map(function (name) {
		// CRLF -> LF so the bundle is the same on every checkout.
		const text = fs
			.readFileSync(path.join(dir, name), "utf8")
			.replace(/\r\n/g, "\n");
		try {
			JSON.parse(text);
		} catch (e) {
			throw new Error(DIR_NAME + "/" + name + ": " + e.message);
		}
		return { id: name.replace(/\.json$/i, ""), text: text };
	});
}

function chunk(list) {
	const entries = list.map(function (e) {
		return "\t\t" + JSON.stringify(e.id) + ": " + JSON.stringify(e.text);
	});
	return [
		"(function (S) {",
		"\tif (!S.modules.adventures) S.modules.adventures = {};",
		"\tS.modules.adventures.builtinScenarios = {",
		entries.join(",\n"),
		"\t};",
		"}(Steward));",
		"",
	].join("\n");
}

module.exports = { collect: collect, chunk: chunk };
