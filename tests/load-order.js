/*
 * Source-file load order, shared by scripts/build.js and tests/harness.js.
 *
 * Walks src/{kernel,core,modules,vendor} in the same order the AIR bundle
 * concatenates them. Keeping this in one place means a new module added to
 * src/ is picked up by both build and tests without editing two files.
 *
 * Section recursion mirrors scripts/build.js:
 *   - kernel  : flat (numeric prefix lexicographic)
 *   - core    : recursive (subdirs after their parent file, alphabetical)
 *   - modules : recursive
 *   - vendor  : recursive (optional)
 *
 * Returns paths relative to repoRoot, forward-slashed.
 */

'use strict';

var fs   = require('fs');
var path = require('path');

var SECTION_DEFS = {
    kernel:  { dir: 'src/kernel',  recursive: false },
    core:    { dir: 'src/core',    recursive: true  },
    modules: { dir: 'src/modules', recursive: true  },
    vendor:  { dir: 'src/vendor',  recursive: true  }
};

function walk(absDir, relDir, recursive) {
    if (!fs.existsSync(absDir)) return [];
    var entries = fs.readdirSync(absDir, { withFileTypes: true });
    entries.sort(function (a, b) { return a.name.localeCompare(b.name); });

    var out = [];
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var absChild = path.join(absDir, e.name);
        var relChild = path.join(relDir, e.name).replace(/\\/g, '/');
        if (e.isDirectory()) {
            if (recursive) {
                Array.prototype.push.apply(out, walk(absChild, relChild, true));
            }
        } else if (e.isFile() && e.name.endsWith('.js')) {
            out.push(relChild);
        }
    }
    return out;
}

function collect(sectionNames, repoRoot) {
    var all = [];
    for (var i = 0; i < sectionNames.length; i++) {
        var def = SECTION_DEFS[sectionNames[i]];
        if (!def) continue;
        var abs = path.join(repoRoot, def.dir);
        Array.prototype.push.apply(all, walk(abs, def.dir, def.recursive));
    }
    return all;
}

module.exports = {
    collect:      collect,
    SECTION_DEFS: SECTION_DEFS
};
