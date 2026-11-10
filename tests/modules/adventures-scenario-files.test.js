'use strict';

// The checked-in scenarios/*.json: each one parses through the runtime parser
// with no broken entry, has a valid id and full buff names, and the build
// chunk of the repo folder hands the same ids to the bundle.

var fsys = require('fs');
var path = require('path');
var vm = require('vm');
var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var embed = require('../../scripts/scenarios');

var assert = t.assert;

var ROOT = path.join(__dirname, '..', '..');
var DIR = path.join(ROOT, 'scenarios');

// Full buff names of adventure items start with one of these; the Easter
// names carry '_Buff' inside instead.
var PREFIXES = ['BattleBuffHurt_', 'ChangeSkin_', 'EmptyEffectBuff_'];

// A plain copy: arrays made in another context are not deep-equal to ours.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function boot() {
    var fs = airfs.make();
    var H = harness.boot({ host: { air: fs.air, showGameAlert: function () {} } });
    return H.Steward;
}

function files() {
    return fsys.readdirSync(DIR).filter(function (n) { return /\.json$/i.test(n); }).sort();
}

function fullName(b) {
    return PREFIXES.some(function (p) { return b.indexOf(p) === 0; }) || b.indexOf('_Buff') >= 0;
}

t.test('the repo has checked-in scenario files', function () {
    assert.ok(files().length >= 1, 'scenarios/*.json');
});

// Windows git ignores case-only renames, and CI checks out on a case-sensitive
// file system. Keeping every id lowercase stops the two platforms from
// disagreeing on the id a file embeds under.
t.test('every checked-in scenario file name is lowercase', function () {
    files().forEach(function (name) {
        assert.strictEqual(name, name.toLowerCase(), name + ': file name must be lowercase');
    });
});

t.test('every checked-in scenario parses with a valid id and full buff names', function () {
    var S = boot();
    var sc = S.modules.adventures.scenarios;
    var tp = S.modules.adventures.templates;
    files().forEach(function (name) {
        var id = name.replace(/\.json$/i, '');
        var text = fsys.readFileSync(path.join(DIR, name), 'utf8');
        var rec = sc.fromText(id, 'built-in', text, 'builtin');
        assert.ok(!rec.error, name + ': ' + rec.error);
        assert.strictEqual(tp.validId(id), true, name + ': id');
        assert.ok(rec.trips.length >= 1, name + ': trips');
        sc.buffsOf(rec).forEach(function (b) {
            assert.ok(fullName(b), name + ': buff ' + b + ' is not a full buff name');
        });
    });
});

t.test('the build chunk of the repo folder gives the same ids, and the store lists none broken', function () {
    var list = embed.collect(ROOT);
    var ids = files().map(function (n) { return n.replace(/\.json$/i, ''); });
    var ctx = { Steward: { modules: {} } };
    vm.runInNewContext(embed.chunk(list), ctx);
    var table = ctx.Steward.modules.adventures.builtinScenarios;
    assert.deepStrictEqual(plain(Object.keys(table).sort()), ids.slice(0).sort());

    var S = boot();
    S.modules.adventures.builtinScenarios = table;
    var all = S.modules.adventures.scenarios.list();
    var broken = all.filter(function (e) { return e.error; });
    assert.deepStrictEqual(plain(broken.map(function (e) { return e.id + ': ' + e.error; })), []);
    assert.deepStrictEqual(plain(all.map(function (e) { return e.id; }).sort()), ids.slice(0).sort());
});
