'use strict';

var t = require('../runner');
var harness = require('../harness');

// Boots a harness with a mounted zone holding the given deposits per type.
function setup(byType) {
    var H = harness.boot();
    var zb = H.zone.zone();
    for (var name in byType) {
        if (Object.prototype.hasOwnProperty.call(byType, name)) zb.deposits(name, byType[name]);
    }
    var z = zb.mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    return { H: H, sdm: z.zone.mStreetDataMap };
}

t.test('byType returns the host vector contents', function () {
    var a = harness.boot().zone.deposit({ name: 'IronOre', grid: 1 });
    var b = harness.boot().zone.deposit({ name: 'IronOre', grid: 2 });
    var s = setup({ IronOre: [a, b] });
    var got = s.H.Steward.core.deposits.byType('IronOre');
    t.assert.strictEqual(got.length, 2);
    t.assert.strictEqual(got[0], a);
    t.assert.strictEqual(got[1], b);
});

t.test('byType retries once after a transient throw', function () {
    var d = harness.boot().zone.deposit({ name: 'IronOre', grid: 1 });
    var s = setup({ IronOre: [d] });
    var calls = 0;
    s.sdm.getDeposits_vectorByType = function () {
        calls++;
        if (calls === 1) throw new Error('[undefined] is not a function');
        return [d];
    };
    var got = s.H.Steward.core.deposits.byType('IronOre');
    t.assert.strictEqual(got.length, 1);
    t.assert.strictEqual(got[0], d);
    t.assert.strictEqual(calls, 2);
    var logs = s.H.logs().filter(function (l) {
        return l.level === 'log' && l.category === 'deposits';
    });
    t.assert.ok(logs.length >= 1, 'recovery should be logged');
});

t.test('byType throws when the host call fails twice', function () {
    var s = setup({ IronOre: [] });
    var calls = 0;
    s.sdm.getDeposits_vectorByType = function () {
        calls++;
        throw new Error('[undefined] is not a function');
    };
    var msg = null;
    try { s.H.Steward.core.deposits.byType('IronOre'); }
    catch (e) { msg = e.message; }
    t.assert.ok(msg !== null, 'byType should throw');
    t.assert.ok(msg.indexOf('IronOre') !== -1);
    t.assert.strictEqual(calls, 2);
});

t.test('byType does not fall back to mDepositContainer', function () {
    var d = harness.boot().zone.deposit({ name: 'IronOre', grid: 1 });
    var s = setup({ IronOre: [] });
    s.sdm.mDepositContainer = { length: 1, 0: d };
    s.sdm.getDeposits_vectorByType = function () { throw new Error('boom'); };
    t.assert.throws(function () { s.H.Steward.core.deposits.byType('IronOre'); });
});

t.test('byType throws when the host method is missing', function () {
    var s = setup({ IronOre: [] });
    delete s.sdm.getDeposits_vectorByType;
    t.assert.throws(function () { s.H.Steward.core.deposits.byType('IronOre'); });
});

t.test('byType throws when there is no current zone', function () {
    var s = setup({ IronOre: [] });
    s.H.host.game.gi.mCurrentPlayerZone = null;
    t.assert.throws(function () { s.H.Steward.core.deposits.byType('IronOre'); });
});

t.test('list concatenates byType over types()', function () {
    var Z = harness.boot().zone;
    var s = setup({
        IronOre: [Z.deposit({ name: 'IronOre', grid: 1 })],
        Coal:    [Z.deposit({ name: 'Coal', grid: 2 })]
    });
    t.assert.strictEqual(s.H.Steward.core.deposits.list().length, 2);
});

t.test('byGrid finds a deposit by grid', function () {
    var d = harness.boot().zone.deposit({ name: 'IronOre', grid: 12 });
    var s = setup({ IronOre: [d] });
    t.assert.strictEqual(s.H.Steward.core.deposits.byGrid(12), d);
    t.assert.strictEqual(s.H.Steward.core.deposits.byGrid(99), null);
});
