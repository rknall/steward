'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');

var assert = t.assert;

var DIR = 'C:/client/steward/adventures/scenarios';

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup() {
    var fs = airfs.make();
    var H = harness.boot({ host: { air: fs.air } });
    var S = H.Steward;
    return { fs: fs, S: S, sc: S.modules.adventures.scenarios };
}

function twins() {
    return {
        version: 1,
        label: 'Twins (easy)',
        adventure: 'BuffAdventures_Twins',
        trips: [
            {},
            { items: [{ buff: 'BattleBuffHurt_Bridge', grids: [3] }, { buff: 'ChangeSkin_Broadsheet', grids: [4, 5, 6] }] },
            { items: [{ buff: 'EmptyEffectBuff_Dynamite', grids: [7, 8, 9, 10], amount: 10 }] }
        ]
    };
}

function text(o) { return JSON.stringify(o); }

t.test('normTrips accepts the approved shape and visit-only trips', function () {
    var s = setup();
    var out = s.sc.normTrips(twins().trips);
    assert.strictEqual(out.length, 3);
    assert.deepStrictEqual(plain(out[0]), { items: [] });
    assert.deepStrictEqual(plain(out[1].items[0]), { buff: 'BattleBuffHurt_Bridge', grids: [3], amount: null });
    assert.strictEqual(out[2].items[0].amount, 10);
});

t.test('normTrips rejects bad shapes', function () {
    var s = setup();
    var bad = [
        [],
        'x',
        [5],
        [{ items: 'x' }],
        [{ items: [{ grids: [1] }] }],
        [{ items: [{ buff: '', grids: [1] }] }],
        [{ items: [{ buff: 'A', grids: [] }] }],
        [{ items: [{ buff: 'A', grids: [0] }] }],
        [{ items: [{ buff: 'A', grids: [1.5] }] }],
        [{ items: [{ buff: 'A', grids: ['1'] }] }],
        [{ items: [{ buff: 'A', grids: [1], amount: 0 }] }],
        [{ items: [{ buff: 'A', grids: [1], amount: -2 }] }],
        [{ items: [{ buff: 'A', grids: [1], amount: 1.5 }] }]
    ];
    for (var i = 0; i < bad.length; i++) {
        assert.strictEqual(s.sc.normTrips(bad[i]), null, 'case ' + i);
    }
});

t.test('fromText parses a scenario and reports why a broken one is broken', function () {
    var s = setup();
    var rec = s.sc.fromText('twins_easy', 'built-in', text(twins()), 'builtin');
    assert.strictEqual(rec.id, 'twins_easy');
    assert.strictEqual(rec.label, 'Twins (easy)');
    assert.strictEqual(rec.source, 'builtin');
    assert.strictEqual(rec.trips.length, 3);

    var o = twins();
    o.label = '  Padded  ';
    assert.strictEqual(s.sc.fromText('a', 'p', text(o), 'file').label, 'Padded');
    assert.strictEqual(s.sc.fromText('a', 'p', text(o), 'file').source, 'file');

    function reason(txt) {
        var r = s.sc.fromText('a', 'p', txt, 'file');
        assert.strictEqual(r.id, 'a');
        assert.strictEqual(r.path, 'p');
        return r.error;
    }
    assert.ok(/not valid JSON/.test(reason('{nope')));
    assert.ok(/not an object/.test(reason('[]')));
    var v = twins(); v.version = 2;
    assert.ok(/version/.test(reason(text(v))));
    var l = twins(); l.label = ' ';
    assert.ok(/label/.test(reason(text(l))));
    var a = twins(); a.adventure = '';
    assert.ok(/adventure/.test(reason(text(a))));
    var tr = twins(); tr.trips = [];
    assert.ok(/no trips/.test(reason(text(tr))));
    var bg = twins(); bg.trips[1].items[0].grids = [0];
    assert.ok(/trip 2 item 1 has a bad grid/.test(reason(text(bg))));
});

t.test('list merges built-ins and files, a file overrides, broken entries come last', function () {
    var s = setup();
    var other = twins(); other.label = 'Alpha';
    var over = twins(); over.label = 'Twins edited';
    s.S.modules.adventures.builtinScenarios = {
        twins_easy: text(twins()),
        alpha: text(other),
        'bad id': text(twins())
    };
    s.fs.disk[DIR + '/twins_easy.json'] = text(over);
    s.fs.disk[DIR + '/zeta.json'] = '{nope';
    s.fs.disk[DIR + '/notes.txt'] = 'x';
    var all = s.sc.list();
    assert.deepStrictEqual(plain(all.map(function (r) { return r.id; })), ['alpha', 'twins_easy', 'zeta']);
    assert.strictEqual(all[0].source, 'builtin');
    assert.strictEqual(all[1].label, 'Twins edited');
    assert.strictEqual(all[1].source, 'file');
    assert.ok(all[2].error);
});

t.test('a broken user file replaces the built-in of its id', function () {
    var s = setup();
    s.S.modules.adventures.builtinScenarios = { twins_easy: text(twins()) };
    s.fs.disk[DIR + '/twins_easy.json'] = '{nope';
    var all = s.sc.list();
    assert.strictEqual(all.length, 1);
    assert.ok(all[0].error);
    assert.strictEqual(s.sc.get('twins_easy'), null);
});

t.test('list works without a built-in table and get finds records', function () {
    var s = setup();
    assert.deepStrictEqual(plain(s.sc.list()), []);
    s.S.modules.adventures.builtinScenarios = { twins_easy: text(twins()) };
    assert.strictEqual(s.sc.get('twins_easy').label, 'Twins (easy)');
    assert.strictEqual(s.sc.get('missing'), null);
});

t.test('buffsOf lists unique names in trip order', function () {
    var s = setup();
    var o = twins();
    o.trips.push({ items: [{ buff: 'BattleBuffHurt_Bridge', grids: [1] }] });
    var rec = s.sc.fromText('a', 'p', text(o), 'file');
    assert.deepStrictEqual(plain(s.sc.buffsOf(rec)),
        ['BattleBuffHurt_Bridge', 'ChangeSkin_Broadsheet', 'EmptyEffectBuff_Dynamite']);
});

t.test('sendAmount defaults to 1 and needOf follows the amount rule', function () {
    var s = setup();
    var plainItem = { buff: 'B', grids: [4, 5, 6], amount: null };
    var capped = { buff: 'D', grids: [7, 8, 9, 10], amount: 10 };
    assert.strictEqual(s.sc.sendAmount(plainItem), 1);
    assert.strictEqual(s.sc.sendAmount(capped), 10);
    assert.strictEqual(s.sc.needOf(plainItem, 3), 3);
    assert.strictEqual(s.sc.needOf(capped, 4), 10);
    assert.strictEqual(s.sc.needOf(capped, 1), 10);
    assert.strictEqual(s.sc.needOf(capped, 0), 0);
});

t.test('tripNeeds sums per buff over open grids', function () {
    var s = setup();
    var trips = s.sc.normTrips(twins().trips);
    var all = function () { return true; };
    assert.deepStrictEqual(plain(s.sc.tripNeeds(trips[0], all)), {});
    assert.deepStrictEqual(plain(s.sc.tripNeeds(trips[1], all)),
        { BattleBuffHurt_Bridge: 1, ChangeSkin_Broadsheet: 3 });
    assert.deepStrictEqual(plain(s.sc.tripNeeds(trips[2], all)), { EmptyEffectBuff_Dynamite: 10 });
    var oneOpen = function (item, grid) { return grid === 7; };
    assert.deepStrictEqual(plain(s.sc.tripNeeds(trips[2], oneOpen)), { EmptyEffectBuff_Dynamite: 10 });
    var none = function () { return false; };
    assert.deepStrictEqual(plain(s.sc.tripNeeds(trips[2], none)), {});

    var twice = { items: [{ buff: 'X', grids: [1, 2], amount: null }, { buff: 'X', grids: [3], amount: null }] };
    assert.deepStrictEqual(plain(s.sc.tripNeeds(twice, all)), { X: 3 });
});
