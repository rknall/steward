'use strict';

// Kind lists on deposit rows: a listed type takes only geologists of its
// kinds, and a listed kind is reserved for the types that list it.

var t = require('../runner');
var harness = require('../harness');

var NAMES = ['Stone', 'BronzeOre', 'Marble', 'IronOre', 'GoldOre',
             'Coal', 'Granite', 'TitaniumOre', 'Salpeter'];

// Every deposit row is written, so the defaults' enabled:true does not leak
// in through the settings merge. rows: { Name: { enabled, max, kinds } }.
function settingsWith(rows, overrides) {
    var deposits = {};
    for (var i = 0; i < NAMES.length; i++) {
        deposits[NAMES[i]] = rows[NAMES[i]] || { enabled: false, max: 0 };
    }
    return { enabled: true, dispatchDelay: 0, deposits: deposits, overrides: overrides || {} };
}

// The core caches the static specialist class per context, so it is
// installed right after boot, before the first specialist read. Kind 76
// is a geologist kind of its own (base type 2).
function boot() {
    var H = harness.boot();
    var cls = H.specs.kindClass({ 76: 'Gingerbread Geologist' });
    H.host.game.def = function (n) { return n === 'Specialists::cSpecialist' ? cls : null; };
    return H;
}

// onMap: { Name: count } of deposits already on the map. Returns the queued
// sends as sorted 'uid>Deposit' strings.
function planWith(H, geos, rows, overrides, onMap) {
    var z = H.zone.zone();
    for (var i = 0; i < NAMES.length; i++) {
        var list = [];
        var n = (onMap && onMap[NAMES[i]]) || 0;
        for (var j = 0; j < n; j++) list.push(H.zone.deposit({ name: NAMES[i], grid: 10 + j }));
        z.deposits(NAMES[i], list);
    }
    z.specialists(geos).mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('geologists', settingsWith(rows, overrides));
    H.module('geologists').plan({ zone: { isHome: true } });
    return H.queued().map(function (q) { return q.params[0] + '>' + q.params[2]; }).sort();
}

function ginger(uid, name) { return { uid: uid, name: name || ('Ginger ' + uid), kind: 76 }; }

t.test('no kind list anywhere routes as before', function () {
    var H = boot();
    var sent = planWith(H, [H.specs.geologist({ name: 'irongut', uid: 'g1' })],
                        { IronOre: { enabled: true, max: 1 } });
    t.assert.deepStrictEqual(sent, ['g1>IronOre']);
});

t.test('a listed type takes only its kinds', function () {
    var H = boot();
    var sent = planWith(H, [
        H.specs.geologist(ginger('g1')),
        H.specs.geologist({ name: 'vanilla', uid: 'g2' })
    ], { BronzeOre: { enabled: true, max: 2, kinds: [76] } });
    t.assert.deepStrictEqual(sent, ['g1>BronzeOre']);
});

t.test('a listed type with none of its kinds idle gets nobody', function () {
    var H = boot();
    var sent = planWith(H, [H.specs.geologist({ name: 'vanilla', uid: 'g2' })],
                        { BronzeOre: { enabled: true, max: 2, kinds: [76] } });
    t.assert.deepStrictEqual(sent, []);
});

t.test('a reserved kind stays idle when its types need nobody', function () {
    var H = boot();
    var sent = planWith(H, [
        H.specs.geologist(ginger('g1')),
        H.specs.geologist({ name: 'vanilla', uid: 'g2' })
    ], {
        BronzeOre: { enabled: true, max: 1, kinds: [76] },
        Stone:     { enabled: true, max: 2 }
    }, null, { BronzeOre: 1 });
    t.assert.deepStrictEqual(sent, ['g2>Stone']);
});

t.test('a kind listed for two types searches both and nothing else', function () {
    var H = boot();
    var sent = planWith(H, [
        H.specs.geologist(ginger('g1')),
        H.specs.geologist(ginger('g2')),
        H.specs.geologist(ginger('g3'))
    ], {
        Stone:     { enabled: true, max: 3 },
        BronzeOre: { enabled: true, max: 1, kinds: [76] },
        Coal:      { enabled: true, max: 1, kinds: [76] }
    });
    t.assert.strictEqual(sent.length, 2);
    var to = sent.map(function (s) { return s.split('>')[1]; }).sort();
    t.assert.deepStrictEqual(to, ['BronzeOre', 'Coal']);
});

t.test('a disabled listed type still reserves its kinds', function () {
    var H = boot();
    var sent = planWith(H, [H.specs.geologist(ginger('g1'))], {
        BronzeOre: { enabled: false, max: 2, kinds: [76] },
        Stone:     { enabled: true, max: 2 }
    });
    t.assert.deepStrictEqual(sent, []);
});

t.test('name override and kind list combine as an intersection', function () {
    var H = boot();
    var a = H.specs.geologist(ginger('g1', 'Ginger A'));
    var b = H.specs.geologist(ginger('g2', 'Ginger B'));
    var rows = {
        Stone:     { enabled: true, max: 2 },
        BronzeOre: { enabled: true, max: 2, kinds: [76] }
    };
    // A is pinned by name to Stone, but its kind is reserved for BronzeOre,
    // so it passes both filters for neither type.
    var sent = planWith(H, [a, b], rows, { 'Ginger A': ['Stone'] });
    t.assert.deepStrictEqual(sent, ['g2>BronzeOre']);

    var g = H.Steward.modules.geologists;
    var rule = g.kindRule(settingsWith(rows).deposits, H.Steward.core.deposits.types());
    var ov = { 'Ginger A': ['BronzeOre'] };
    t.assert.strictEqual(g.eligibleForDeposit([a, b], 'BronzeOre', ov, rule).length, 2);
    t.assert.strictEqual(g.eligibleForDeposit([a], 'Stone', ov, rule).length, 0);
});

t.test('an unreadable kind never enters a listed type', function () {
    var H = boot();
    var g = H.Steward.modules.geologists;
    var rule = g.kindRule({ BronzeOre: { enabled: true, max: 1, kinds: [76] } },
                          H.Steward.core.deposits.types());
    var odd = H.specs.geologist({ name: 'odd', uid: 'g9' });
    odd.GetType = function () { return 'x'; };
    t.assert.strictEqual(g.eligibleForDeposit([odd], 'BronzeOre', {}, rule).length, 0);
    t.assert.strictEqual(g.eligibleForDeposit([odd], 'Stone', {}, rule).length, 1);
    odd.GetType = function () { return null; };
    t.assert.strictEqual(g.eligibleForDeposit([odd], 'BronzeOre', {}, rule).length, 0);
    t.assert.strictEqual(g.eligibleForDeposit([odd], 'Stone', {}, rule).length, 1);
    // Without a rule nothing is filtered by kind.
    t.assert.strictEqual(g.eligibleForDeposit([odd], 'BronzeOre', {}).length, 1);
});

t.test('an empty stored list routes as default', function () {
    var H = boot();
    var rows = { BronzeOre: { enabled: true, max: 1, kinds: [] } };
    var sent = planWith(H, [H.specs.geologist({ name: 'vanilla', uid: 'g2' })], rows);
    t.assert.deepStrictEqual(sent, ['g2>BronzeOre']);
    var rule = H.Steward.modules.geologists.kindRule(rows, H.Steward.core.deposits.types());
    t.assert.strictEqual(Object.keys(rule.lists).length, 0);
    t.assert.strictEqual(Object.keys(rule.reserved).length, 0);
});

t.test('rowKinds keeps finite numbers, deduped and sorted, and kindRule ignores stale types', function () {
    var H = boot();
    var g = H.Steward.modules.geologists;
    t.assert.strictEqual(JSON.stringify(g.rowKinds({ kinds: [76, 2, 'x', 76, NaN, 3] })), JSON.stringify([2, 3, 76]));
    t.assert.strictEqual(JSON.stringify(g.rowKinds({})), JSON.stringify([]));
    t.assert.strictEqual(JSON.stringify(g.rowKinds(null)), JSON.stringify([]));
    var rule = g.kindRule({ Gone: { kinds: [76] } }, H.Steward.core.deposits.types());
    t.assert.strictEqual(Object.keys(rule.reserved).length, 0);
});
