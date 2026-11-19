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

t.test('byTypeRead is unreadable where byType throws', function () {
    var d = harness.boot().zone.deposit({ name: 'IronOre', grid: 1 });
    var s = setup({ IronOre: [d] });
    var D = s.H.Steward.core.deposits;
    var ok = D.byTypeRead('IronOre');
    t.assert.strictEqual(ok.state, 'ok');
    t.assert.strictEqual(ok.value.length, 1);
    s.sdm.getDeposits_vectorByType = function () { throw new Error('boom'); };
    var r = D.byTypeRead('IronOre');
    t.assert.strictEqual(r.state, 'unreadable');
    t.assert.ok(r.why.indexOf('boom') !== -1);
    t.assert.throws(function () { D.byType('IronOre'); });
});

t.test('depletedManagedRead is unreadable when the building list is', function () {
    var H = harness.boot();
    var D = H.Steward.core.deposits;
    var za = H.zone.zone()
        .building(H.zone.building({ name: 'DepletedIronOre', grid: 1 }))
        .building(H.zone.building({ name: 'Farm', grid: 2 }));
    H.installZone(za);
    var r = D.depletedManagedRead();
    t.assert.strictEqual(r.state, 'ok');
    t.assert.strictEqual(r.value.length, 1);
    H.host.game.gi.mCurrentPlayerZone = null;
    t.assert.strictEqual(D.depletedManagedRead().state, 'notReady');
    H.host.game.gi.mCurrentPlayerZone = {};
    t.assert.strictEqual(D.depletedManagedRead().state, 'unreadable');
});

t.test('depleted and depletedManagedRead agree on the Depleted prefix', function () {
    var H = harness.boot();
    var D = H.Steward.core.deposits;
    var za = H.zone.zone()
        .building(H.zone.building({ name: 'DepletedIronOre', grid: 1 }))
        .building(H.zone.building({ name: 'DepletedFoo', grid: 2 }))
        .building(H.zone.building({ name: 'IronOreMine', grid: 3 }));
    H.installZone(za);
    t.assert.strictEqual(D.depleted().length, 2);
    var r = D.depletedManagedRead();
    t.assert.strictEqual(r.state, 'ok');
    t.assert.strictEqual(r.value.length, 1);
    t.assert.strictEqual(H.Steward.core.buildings.name(r.value[0]), 'DepletedIronOre');
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

t.test('amountsRead maps grid to amount and max, keeps an amount above max, null max without GetMaxAmount', function () {
    var Z = harness.boot().zone;
    var s = setup({ Corn: [
        Z.deposit({ name: 'Corn', grid: 5, amount: 56, maxAmount: 45 }),
        Z.deposit({ name: 'Corn', grid: 6, amount: 10 })
    ] });
    var r = s.H.Steward.core.deposits.amountsRead('Corn');
    t.assert.strictEqual(r.state, s.H.Steward.kernel.read.OK);
    t.assert.strictEqual(r.value[5].amount, 56);
    t.assert.strictEqual(r.value[5].max, 45);
    t.assert.strictEqual(r.value[6].amount, 10);
    t.assert.strictEqual(r.value[6].max, null);
});

t.test('amountsRead gives a null amount for a throwing GetAmount', function () {
    var Z = harness.boot().zone;
    var d = Z.deposit({ name: 'Corn', grid: 7, maxAmount: 45 });
    d.GetAmount = function () { throw new Error('boom'); };
    var s = setup({ Corn: [d] });
    var r = s.H.Steward.core.deposits.amountsRead('Corn');
    t.assert.strictEqual(r.value[7].amount, null);
    t.assert.strictEqual(r.value[7].max, 45);
});

t.test('amountsRead is unreadable where byTypeRead is', function () {
    var s = setup({});
    s.sdm.getDeposits_vectorByType = function () { throw new Error('down'); };
    var r = s.H.Steward.core.deposits.amountsRead('Corn');
    t.assert.strictEqual(r.state, s.H.Steward.kernel.read.UNREADABLE);
});
