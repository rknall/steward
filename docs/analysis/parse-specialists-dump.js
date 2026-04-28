#!/usr/bin/env node
/*
 * Specialist-dump comparator.
 *
 * Reads one or more dumps produced by docs/analysis/dump_specialists.js
 * (`tso.specialists.v1` or `v2`) and reports per-family GetType
 * inventory. With multiple files it produces a diff highlighting types
 * present in only one source — useful for spotting specialists that
 * other rosters have but ours does not (so we can fold them into our
 * trait catalog).
 *
 * Usage:
 *   node parse-specialists-dump.js <dump.json> [more-dump.json ...]
 *   node parse-specialists-dump.js --family explorer <a.json> <b.json>
 *   node parse-specialists-dump.js --diff-only <a.json> <b.json>
 *   node parse-specialists-dump.js --json <dump.json>          # machine output
 *
 * Trait identity comes from `spec.traitSkills[].name_string` — the
 * per-instance skill investments. The universal `friendpremiumbuff1`
 * (id=301) is filtered out since every spec has it.
 *
 * For single-file runs, GetTypes labelled as `(vanilla)` are vanilla
 * tier specialists that carry no per-instance trait beyond the
 * universal premium buff — only their `description.GetTimeBonus`
 * differentiates them.
 */

'use strict';

var fs   = require('fs');
var path = require('path');

var UNIVERSAL_BUFF = 'friendpremiumbuff1';

function usage() {
    process.stdout.write([
        'Usage: parse-specialists-dump.js [options] <dump.json> [more.json...]',
        '',
        'Options:',
        '  --family <name>   Filter by family (explorer | geologist | general | all)',
        '                    Default: explorer + geologist',
        '  --diff-only       Print only rows where presence differs between files',
        '                    (requires 2+ files)',
        '  --json            Emit machine-readable JSON instead of a text table',
        '  -h, --help        Show this help',
        ''
    ].join('\n'));
}

function parseArgs(argv) {
    var opts = { files: [], family: null, diffOnly: false, json: false };
    for (var i = 2; i < argv.length; i++) {
        var a = argv[i];
        if (a === '-h' || a === '--help') { usage(); process.exit(0); }
        else if (a === '--family')        { opts.family = argv[++i]; }
        else if (a === '--diff-only')     { opts.diffOnly = true; }
        else if (a === '--json')          { opts.json = true; }
        else if (a[0] === '-')            { fail('Unknown option: ' + a); }
        else                              { opts.files.push(a); }
    }
    if (!opts.files.length) { usage(); process.exit(1); }
    return opts;
}

function fail(msg) {
    process.stderr.write('parse-specialists-dump: ' + msg + '\n');
    process.exit(1);
}

function readDump(file) {
    var raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { fail('cannot read ' + file + ': ' + e.message); }
    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { fail('invalid JSON in ' + file + ': ' + e.message); }
    if (!parsed || !Array.isArray(parsed.specialists)) {
        fail(file + ' does not look like a specialists dump (missing .specialists[])');
    }
    return parsed;
}

function traitsOf(spec) {
    var out = [];
    var ts = spec.traitSkills || [];
    for (var i = 0; i < ts.length; i++) {
        var n = (ts[i].name_string || '').trim();
        if (!n) continue;
        if (n === UNIVERSAL_BUFF) continue;
        out.push(n);
    }
    return out;
}

function timeBonusOf(spec) {
    if (!spec.description) return null;
    var b = spec.description.GetTimeBonus;
    if (typeof b === 'number') return b;
    return null;
}

// Build per-file index keyed by (family, GetType) → { count, traits, bonuses }
function indexDump(file, fileLabel) {
    var idx = {};
    var specs = file.specialists || [];
    for (var i = 0; i < specs.length; i++) {
        var s = specs[i];
        var fam = s.family || 'unknown';
        var key = fam + '/' + s.GetType;
        if (!idx[key]) {
            idx[key] = {
                family:  fam,
                getType: s.GetType,
                count:   0,
                traits:  {},
                bonuses: {}
            };
        }
        var row = idx[key];
        row.count++;
        var ts = traitsOf(s);
        var label = ts.length ? ts.join('+') : '(vanilla)';
        row.traits[label] = (row.traits[label] || 0) + 1;
        var bonus = timeBonusOf(s);
        if (bonus !== null) row.bonuses[String(bonus)] = (row.bonuses[String(bonus)] || 0) + 1;
    }
    return { label: fileLabel, idx: idx, meta: file.meta || {} };
}

function familyAllowed(opts, fam) {
    if (!opts.family || opts.family === 'all') {
        return fam === 'explorer' || fam === 'geologist';
    }
    return fam === opts.family;
}

function mergeKeys(indexes) {
    var keys = {};
    for (var i = 0; i < indexes.length; i++) {
        var idx = indexes[i].idx;
        for (var k in idx) if (Object.prototype.hasOwnProperty.call(idx, k)) keys[k] = true;
    }
    return Object.keys(keys).sort(function (a, b) {
        var fa = a.split('/')[0], fb = b.split('/')[0];
        if (fa !== fb) return fa.localeCompare(fb);
        return Number(a.split('/')[1]) - Number(b.split('/')[1]);
    });
}

function presenceFlags(indexes, key) {
    return indexes.map(function (i) { return !!i.idx[key]; });
}

function combinedTraitLabel(indexes, key) {
    var combined = {};
    for (var i = 0; i < indexes.length; i++) {
        var row = indexes[i].idx[key];
        if (!row) continue;
        for (var t in row.traits) if (row.traits.hasOwnProperty(t)) combined[t] = true;
    }
    return Object.keys(combined).join(' | ') || '(vanilla)';
}

function combinedBonusLabel(indexes, key) {
    var combined = {};
    for (var i = 0; i < indexes.length; i++) {
        var row = indexes[i].idx[key];
        if (!row) continue;
        for (var b in row.bonuses) if (row.bonuses.hasOwnProperty(b)) combined[b] = true;
    }
    var keys = Object.keys(combined).sort(function (a, b) { return Number(a) - Number(b); });
    return keys.length ? keys.join('/') + '%' : '?';
}

function statusLabel(flags) {
    var truthy = 0;
    for (var i = 0; i < flags.length; i++) if (flags[i]) truthy++;
    if (truthy === flags.length) return 'all';
    if (truthy === 1) {
        var only = flags.indexOf(true);
        return 'only-' + (only + 1);
    }
    return truthy + '/' + flags.length;
}

function pad(s, n) {
    s = String(s);
    while (s.length < n) s += ' ';
    return s;
}

function renderText(opts, indexes) {
    var families = {};
    var keys = mergeKeys(indexes);

    keys.forEach(function (k) {
        var fam = k.split('/')[0];
        if (!familyAllowed(opts, fam)) return;
        if (!families[fam]) families[fam] = [];
        families[fam].push(k);
    });

    var fileWidth = Math.max.apply(null, indexes.map(function (i) { return i.label.length; }));
    fileWidth = Math.max(fileWidth, 5);

    Object.keys(families).sort().forEach(function (fam) {
        process.stdout.write('\n=== ' + fam.toUpperCase() + 's ===\n');

        // header
        var hdr = '  type  ';
        indexes.forEach(function (i) { hdr += pad(i.label, fileWidth + 2); });
        hdr += 'status      bonus     trait';
        process.stdout.write(hdr + '\n');
        process.stdout.write('  ' + '-'.repeat(hdr.length - 2) + '\n');

        families[fam].forEach(function (key) {
            var row = '';
            var flags = presenceFlags(indexes, key);
            var status = statusLabel(flags);
            if (opts.diffOnly && status === 'all') return;
            var t = key.split('/')[1];
            row += '  ' + pad(t, 6);
            for (var i = 0; i < indexes.length; i++) {
                var r = indexes[i].idx[key];
                row += pad(r ? String(r.count) : '-', fileWidth + 2);
            }
            row += pad(status, 12);
            row += pad(combinedBonusLabel(indexes, key), 10);
            row += combinedTraitLabel(indexes, key);
            process.stdout.write(row + '\n');
        });
    });
}

function renderJson(opts, indexes) {
    var out = {
        files: indexes.map(function (i) {
            return { label: i.label, meta: i.meta };
        }),
        rows: []
    };
    var keys = mergeKeys(indexes);
    keys.forEach(function (k) {
        var fam = k.split('/')[0];
        if (!familyAllowed(opts, fam)) return;
        var t = Number(k.split('/')[1]);
        var flags = presenceFlags(indexes, k);
        var status = statusLabel(flags);
        if (opts.diffOnly && status === 'all') return;
        var perFile = indexes.map(function (i) {
            var r = i.idx[k];
            return r ? { count: r.count, traits: Object.keys(r.traits), bonuses: Object.keys(r.bonuses).map(Number) }
                     : { count: 0 };
        });
        out.rows.push({
            family:  fam,
            getType: t,
            status:  status,
            traits:  combinedTraitLabel(indexes, k).split(' | '),
            bonuses: combinedBonusLabel(indexes, k),
            files:   perFile
        });
    });
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function main() {
    var opts = parseArgs(process.argv);
    if (opts.diffOnly && opts.files.length < 2) {
        fail('--diff-only requires at least 2 files');
    }
    var indexes = opts.files.map(function (f) {
        var data = readDump(f);
        var label = path.basename(f).replace(/\.json$/, '').replace(/^specialists-/, '');
        return indexDump(data, label);
    });
    if (opts.json) renderJson(opts, indexes);
    else           renderText(opts, indexes);
}

main();
