'use strict';

var t = require('../runner');
var harness = require('../harness');
var zoneStubs = require('../stubs/zone');
var buff = zoneStubs.buff;
var building = zoneStubs.building;

function bootWithBuffs(buffList) {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var z = H.zone.zone()
        .buffs(buffList || [])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    return H;
}

t.test('available() returns empty list when player inventory is empty', function () {
    var H = bootWithBuffs([]);
    var list = H.Steward.core.buffs.available();
    t.assert.ok(Array.isArray(list));
    t.assert.strictEqual(list.length, 0);
});

t.test('available() returns every inventory entry as-is', function () {
    var H = bootWithBuffs([
        buff({ name: 'IronMineBuff', amount: 3, targets: 'IronMine' }),
        buff({ name: 'ZoneSpeedup', amount: 1, targets: '', buffType: 8 })
    ]);
    var list = H.Steward.core.buffs.available();
    t.assert.strictEqual(list.length, 2);
    t.assert.strictEqual(H.Steward.core.buffs.name(list[0]), 'IronMineBuff');
});

t.test('forBuilding(name) filters to matching building-buffs with amount > 0', function () {
    var H = bootWithBuffs([
        buff({ name: 'IronMineBuff',  amount: 3, targets: 'IronMine,GoldMine' }),
        buff({ name: 'CoalMineBuff',  amount: 1, targets: 'CoalMine' }),
        buff({ name: 'ZoneSpeedup',   amount: 5, targets: '', buffType: 8 }),  // not type 0
        buff({ name: 'EmptyIronBuff', amount: 0, targets: 'IronMine' })        // amount = 0
    ]);
    var iron = H.Steward.core.buffs.forBuilding('IronMine');
    t.assert.strictEqual(iron.length, 1);
    t.assert.strictEqual(H.Steward.core.buffs.name(iron[0]), 'IronMineBuff');

    var gold = H.Steward.core.buffs.forBuilding('GoldMine');
    t.assert.strictEqual(gold.length, 1);
    t.assert.strictEqual(H.Steward.core.buffs.name(gold[0]), 'IronMineBuff');

    var coal = H.Steward.core.buffs.forBuilding('CoalMine');
    t.assert.strictEqual(coal.length, 1);
});

t.test('forBuilding() returns [] when target is empty/missing', function () {
    var H = bootWithBuffs([
        buff({ name: 'IronMineBuff', amount: 1, targets: 'IronMine' })
    ]);
    t.assert.strictEqual(H.Steward.core.buffs.forBuilding('').length, 0);
    t.assert.strictEqual(H.Steward.core.buffs.forBuilding(null).length, 0);
});

t.test('byName(name) returns the matching inventory entry, null otherwise', function () {
    var H = bootWithBuffs([
        buff({ name: 'IronMineBuff', amount: 2, targets: 'IronMine' })
    ]);
    var b = H.Steward.core.buffs.byName('IronMineBuff');
    t.assert.ok(b);
    t.assert.strictEqual(H.Steward.core.buffs.amount(b), 2);

    t.assert.strictEqual(H.Steward.core.buffs.byName('Nope'), null);
    t.assert.strictEqual(H.Steward.core.buffs.byName(''), null);
});

t.test('canApply() rejects when buff is not in inventory', function () {
    var H = bootWithBuffs([]);
    var bld = building({ name: 'IronMine', grid: 12 });
    t.assert.strictEqual(H.Steward.core.buffs.canApply(bld, 'IronMineBuff'), false);
});

t.test('canApply() rejects when building already has productionBuff', function () {
    var H = bootWithBuffs([
        buff({ name: 'IronMineBuff', amount: 1, targets: 'IronMine' })
    ]);
    var bld = building({
        name: 'IronMine', grid: 12, productionBuff: { sentinel: true }
    });
    t.assert.strictEqual(H.Steward.core.buffs.canApply(bld, 'IronMineBuff'), false);
});

t.test('canApply() rejects when building is upgrading / constructing / destructing', function () {
    var H = bootWithBuffs([
        buff({ name: 'IronMineBuff', amount: 1, targets: 'IronMine' })
    ]);
    var upgrading = building({ name: 'IronMine', grid: 12, upgrading: true });
    t.assert.strictEqual(H.Steward.core.buffs.canApply(upgrading, 'IronMineBuff'), false);

    var constructing = building({ name: 'IronMine', grid: 13, constructing: true });
    t.assert.strictEqual(H.Steward.core.buffs.canApply(constructing, 'IronMineBuff'), false);

    var destructing = building({ name: 'IronMine', grid: 14, destructing: true });
    t.assert.strictEqual(H.Steward.core.buffs.canApply(destructing, 'IronMineBuff'), false);
});

t.test('canApply() rejects when buff target list does not include the building name', function () {
    var H = bootWithBuffs([
        buff({ name: 'GoldMineBuff', amount: 1, targets: 'GoldMine' })
    ]);
    var bld = building({ name: 'IronMine', grid: 12 });
    t.assert.strictEqual(H.Steward.core.buffs.canApply(bld, 'GoldMineBuff'), false);
});

t.test('canApply() returns true when all gates pass', function () {
    var H = bootWithBuffs([
        buff({ name: 'IronMineBuff', amount: 3, targets: 'IronMine,GoldMine' })
    ]);
    var bld = building({ name: 'IronMine', grid: 12 });
    t.assert.strictEqual(H.Steward.core.buffs.canApply(bld, 'IronMineBuff'), true);
});

t.test('invalidate() forces a fresh inventory read', function () {
    var H = bootWithBuffs([
        buff({ name: 'IronMineBuff', amount: 1, targets: 'IronMine' })
    ]);
    t.assert.strictEqual(H.Steward.core.buffs.available().length, 1);
    // Swap inventory under the player. Without invalidate(), the cached
    // snapshot still reports the old length.
    H.host.game.gi.mCurrentPlayer.getAvailableBuffs_vector = function () { return []; };
    t.assert.strictEqual(H.Steward.core.buffs.available().length, 1);  // cached
    H.Steward.core.buffs.invalidate();
    t.assert.strictEqual(H.Steward.core.buffs.available().length, 0);
});
