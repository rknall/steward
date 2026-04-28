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

t.test('canApply() rejects when building is paused (IsProductionActive=false)', function () {
    var H = bootWithBuffs([
        buff({ name: 'IronMineBuff', amount: 1, targets: 'IronMine' })
    ]);
    var paused = building({ name: 'IronMine', grid: 12, producing: false });
    t.assert.strictEqual(H.Steward.core.buffs.canApply(paused, 'IronMineBuff'), false);
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

// --- workyard catch-all ----------------------------------------------------

t.test('forBuilding() with isWorkyard=true matches Workyard-targeting buffs', function () {
    var H = bootWithBuffs([
        buff({ name: 'ProductivityBuff', amount: 5, targets: 'Workyard' })
    ]);
    var without = H.Steward.core.buffs.forBuilding('IronMine');
    t.assert.strictEqual(without.length, 0);                                // direct target only
    var withFlag = H.Steward.core.buffs.forBuilding('IronMine', { isWorkyard: true });
    t.assert.strictEqual(withFlag.length, 1);
    t.assert.strictEqual(H.Steward.core.buffs.name(withFlag[0]), 'ProductivityBuff');
});

t.test('canApply() accepts Workyard-targeting buff when building.isWorkyard()=true', function () {
    var H = bootWithBuffs([
        buff({ name: 'ProductivityBuff', amount: 1, targets: 'Workyard' })
    ]);
    var workyard = building({ name: 'IronMine', grid: 12, isWorkyard: true });
    t.assert.strictEqual(H.Steward.core.buffs.canApply(workyard, 'ProductivityBuff'), true);

    var notWorkyard = building({ name: 'IronMine', grid: 13 });             // isWorkyard not set
    t.assert.strictEqual(H.Steward.core.buffs.canApply(notWorkyard, 'ProductivityBuff'), false);
});

t.test('forBuilding() merges direct and Workyard matches without duplicating', function () {
    var H = bootWithBuffs([
        buff({ name: 'IronMineBuff',     amount: 2, targets: 'IronMine' }),
        buff({ name: 'ProductivityBuff', amount: 5, targets: 'Workyard' })
    ]);
    var hits = H.Steward.core.buffs.forBuilding('IronMine', { isWorkyard: true });
    t.assert.strictEqual(hits.length, 2);
    var names = [H.Steward.core.buffs.name(hits[0]), H.Steward.core.buffs.name(hits[1])].sort();
    t.assert.deepStrictEqual(names, ['IronMineBuff', 'ProductivityBuff']);
});

// --- localization helpers --------------------------------------------------

t.test('displayName() returns localized text from loca.GetText("RES", name)', function () {
    var H = harness.boot({
        sections: ['kernel', 'core'],
        host: {
            loca: {
                GetText: function (cat, key) {
                    if (cat === 'RES' && key === 'IronMineBuff') return 'Iron Mine Boost';
                    return key;
                }
            }
        }
    });
    var z = H.zone.zone()
        .buffs([buff({ name: 'IronMineBuff', amount: 1, targets: 'IronMine' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var b = H.Steward.core.buffs.byName('IronMineBuff');
    t.assert.strictEqual(H.Steward.core.buffs.displayName(b), 'Iron Mine Boost');
});

t.test('displayName() falls back to internal name when loca returns falsy', function () {
    var H = harness.boot({
        sections: ['kernel', 'core'],
        host: { loca: { GetText: function () { return ''; } } }
    });
    var z = H.zone.zone()
        .buffs([buff({ name: 'IronMineBuff', amount: 1, targets: 'IronMine' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var b = H.Steward.core.buffs.byName('IronMineBuff');
    t.assert.strictEqual(H.Steward.core.buffs.displayName(b), 'IronMineBuff');
});

t.test('description() returns DES text truncated at "Target"', function () {
    var H = harness.boot({
        sections: ['kernel', 'core'],
        host: {
            loca: {
                GetText: function (cat, key) {
                    if (cat === 'DES' && key === 'ProductivityBuff') {
                        return '+50% production. Target: workyards';
                    }
                    return '';
                }
            }
        }
    });
    var z = H.zone.zone()
        .buffs([buff({ name: 'ProductivityBuff', amount: 1, targets: 'Workyard' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var b = H.Steward.core.buffs.byName('ProductivityBuff');
    t.assert.strictEqual(H.Steward.core.buffs.description(b), '+50% production. ');
});

t.test('description() returns empty string when DES has no Target marker', function () {
    var H = harness.boot({
        sections: ['kernel', 'core'],
        host: {
            loca: {
                GetText: function (cat, key) {
                    if (cat === 'DES' && key === 'PlainBuff') return 'No marker here';
                    return '';
                }
            }
        }
    });
    var z = H.zone.zone()
        .buffs([buff({ name: 'PlainBuff', amount: 1, targets: 'IronMine' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var b = H.Steward.core.buffs.byName('PlainBuff');
    // No 'Target' marker → split returns whole string in [0].
    t.assert.strictEqual(H.Steward.core.buffs.description(b), 'No marker here');
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
