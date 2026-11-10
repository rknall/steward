'use strict';

var t = require('../runner');
var harness = require('../harness');

t.test('byName finds buildings via host getBuildingsByName_vector fast-path', function () {
    // Scenario: the host returns masons via getBuildingsByName_vector but
    // does NOT include them in mStreetDataMap.GetBuildings_vector(). This
    // mirrors the live AIR client where some building categories (masons)
    // are queryable by name yet absent from the all-buildings vector.
    var H = harness.boot();
    var mason = H.zone.building({ name: 'Mason', grid: 99 });

    var customZone = {
        mStreetDataMap: {
            mDepositContainer:  [],
            mBuildingContainer: [],                              // empty — snapshot would return 0
            GetBuildings_vector: function () { return []; },     // empty
            getDeposits_vectorByType: function () { return []; },
            getBuildingsByName_vector: function (n) {
                return n === 'Mason' ? [mason] : [];             // host knows Mason
            }
        },
        GetBuildingFromGridPosition: function () { return null; },
        GetResources: function () { return { CanPlayerAffordBuilding: function () { return true; } }; }
    };
    H.host.game.gi.mCurrentPlayer = { mBuildQueue: { GetTotalAvailableSlots: function () { return 0; }, GetQueue_vector: function () { return { length: 0 }; } } };
    H.host.game.gi.mCurrentPlayerZone = customZone;

    var found = H.Steward.core.buildings.byName('Mason');
    t.assert.strictEqual(found.length, 1);
    t.assert.strictEqual(found[0].GetBuildingName_string(), 'Mason');
});

t.test('byName falls back to snapshot when host API absent', function () {
    var H = harness.boot();
    var mine = H.zone.building({ name: 'IronMine', grid: 12 });
    var z = H.zone.zone()
        .building(mine)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    var found = H.Steward.core.buildings.byName('IronMine');
    t.assert.strictEqual(found.length, 1);
});

// The host name index can omit a whole type or return only part of it while
// GetBuildings_vector holds every building; byName must return the union.
function gridsOf(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i].GetGrid());
    return out.sort(function (a, b) { return a - b; });
}

t.test('byName adds buildings the name index omits for a whole type', function () {
    var H = harness.boot();
    var z = H.zone.zone();
    for (var g = 1; g <= 3; g++) z.building(H.zone.building({ name: 'FieldC', grid: g }));
    H.installZone(z);
    z.zone.mStreetDataMap.getBuildingsByName_vector = function () { return []; };

    var found = H.Steward.core.buildings.byName('FieldC');
    t.assert.strictEqual(found.length, 3);
    t.assert.deepEqual(gridsOf(found), [1, 2, 3]);
});

t.test('byName fills a short name-index result without duplicates', function () {
    var H = harness.boot();
    var z = H.zone.zone();
    var placed = [];
    for (var g = 4; g <= 6; g++) {
        var b = H.zone.building({ name: 'FieldB', grid: g });
        placed.push(b);
        z.building(b);
    }
    H.installZone(z);
    z.zone.mStreetDataMap.getBuildingsByName_vector = function () { return [placed[1]]; };

    var found = H.Steward.core.buildings.byName('FieldB');
    t.assert.strictEqual(found.length, 3);
    t.assert.deepEqual(gridsOf(found), [4, 5, 6]);
    var count = 0;
    for (var i = 0; i < found.length; i++) if (found[i] === placed[1]) count++;
    t.assert.strictEqual(count, 1);
});

t.test('byName counts a building present in both sources once', function () {
    var H = harness.boot();
    var z = H.zone.zone();
    z.building(H.zone.building({ name: 'IronMine', grid: 10 }));
    z.building(H.zone.building({ name: 'IronMine', grid: 11 }));
    H.installZone(z);

    t.assert.strictEqual(H.Steward.core.buildings.byName('IronMine').length, 2);
});

t.test('byName reads the building list fresh, not a stale snapshot', function () {
    var H = harness.boot();
    var z = H.zone.zone();
    z.building(H.zone.building({ name: 'FieldA', grid: 1 }));
    H.installZone(z);
    H.Steward.core.buildings.list();   // primes the cached snapshot with one field

    z.building(H.zone.building({ name: 'FieldA', grid: 2 }));
    z.building(H.zone.building({ name: 'FieldA', grid: 3 }));
    z.zone.mStreetDataMap.getBuildingsByName_vector = function () { return []; };

    t.assert.strictEqual(H.Steward.core.buildings.byName('FieldA').length, 3);
});

// Production buff reads. The host clock is a mutable value so a test can move
// time without rebooting.
function bootClock(startAt) {
    var clock = { now: startAt };
    var H = harness.boot({
        host: {
            swmmo: { application: { mGameInterface: { GetClientTime: function () { return clock.now; } } } }
        }
    });
    H.clock = clock;
    return H;
}

var HOUR = 3600000;

t.test('outputFactor and baseOutputFactor return host values', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    var b = H.zone.building({ name: 'pumpkinfield_01', outputFactor: 10, exactOutputFactor: 1.9 });
    t.assert.strictEqual(B.outputFactor(b), 10);
    t.assert.strictEqual(B.baseOutputFactor(b), 1);   // truncated like the host
});

t.test('outputFactor and baseOutputFactor are null when missing or throwing', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    var plain = H.zone.building({ name: 'pumpkinfield_01' });
    t.assert.strictEqual(B.outputFactor(plain), null);
    t.assert.strictEqual(B.baseOutputFactor(plain), null);
    t.assert.strictEqual(B.outputFactor(null), null);
    t.assert.strictEqual(B.baseOutputFactor(null), null);

    var bad = {
        GetResourceOutputFactor: function () { throw new Error('boom'); },
        GetExactOutputFactor:    function () { throw new Error('boom'); }
    };
    t.assert.strictEqual(B.outputFactor(bad), null);
    t.assert.strictEqual(B.baseOutputFactor(bad), null);

    var zero = H.zone.building({ outputFactor: 0, exactOutputFactor: 0 });
    t.assert.strictEqual(B.outputFactor(zero), null);
    t.assert.strictEqual(B.baseOutputFactor(zero), null);
});

t.test('buffRemainingMs is duration minus elapsed time', function () {
    var H = bootClock(100 * HOUR);
    var b = H.zone.building({
        buffs: [H.zone.buff({ pct: 1000, duration: 32400000, start: 100 * HOUR - HOUR })]
    });
    t.assert.strictEqual(H.Steward.core.buildings.buffRemainingMs(b), 28800000);
});

t.test('buffRemainingMs takes the shortest output buff and ignores pct 100', function () {
    var H = bootClock(100 * HOUR);
    var b = H.zone.building({
        buffs: [
            H.zone.buff({ pct: 1000, duration: 10 * HOUR, start: 100 * HOUR }),
            H.zone.buff({ pct: 500,  duration: 4 * HOUR,  start: 100 * HOUR }),
            H.zone.buff({ pct: 100,  duration: 1 * HOUR,  start: 100 * HOUR })
        ]
    });
    t.assert.strictEqual(H.Steward.core.buildings.buffRemainingMs(b), 4 * HOUR);
});

t.test('buffRemainingMs is null for an expired buff', function () {
    var H = bootClock(100 * HOUR);
    var b = H.zone.building({
        buffs: [H.zone.buff({ pct: 1000, duration: HOUR, start: 98 * HOUR })]
    });
    t.assert.strictEqual(H.Steward.core.buildings.buffRemainingMs(b), null);
});

t.test('buffRemainingMs falls back to productionBuff', function () {
    var H = bootClock(100 * HOUR);
    var b = H.zone.building({
        buffs: [],
        productionBuff: H.zone.buff({ pct: 1000, duration: 5 * HOUR, start: 99 * HOUR })
    });
    t.assert.strictEqual(H.Steward.core.buildings.buffRemainingMs(b), 4 * HOUR);
});

t.test('buffRemainingMs is null without a host clock or a buff', function () {
    var H = harness.boot();   // no swmmo
    var b = H.zone.building({
        buffs: [H.zone.buff({ pct: 1000, duration: HOUR, start: 0 })]
    });
    t.assert.strictEqual(H.Steward.core.buildings.buffRemainingMs(b), null);

    var C = bootClock(100 * HOUR);
    t.assert.strictEqual(C.Steward.core.buildings.buffRemainingMs(C.zone.building({})), null);
    t.assert.strictEqual(C.Steward.core.buildings.buffRemainingMs(null), null);
});

t.test('buffBlock: eligible mine with state 0 and no buff', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    var b = H.zone.building({ name: 'IronMine', productionState: 0, upgrading: false,
        constructing: false, destroying: false });
    t.assert.strictEqual(B.buffBlock(b), null);
    t.assert.strictEqual(B.hasProductionBuff(b), false);
    t.assert.strictEqual(B.buffBlock(null), 'no building');
});

t.test('buffBlock: already buffed / not producing / unreadable state', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    var buffed = H.zone.building({ productionState: 0, productionBuff: H.zone.buff({}) });
    t.assert.strictEqual(B.buffBlock(buffed), 'already buffed');
    t.assert.strictEqual(B.hasProductionBuff(buffed), true);
    t.assert.strictEqual(B.buffBlock(H.zone.building({ productionState: 2 })), 'not producing (state 2)');
    t.assert.strictEqual(B.buffBlock(H.zone.building({})), 'production state unreadable');
    var throwing = { GetResourceCreation: function () { throw new Error('boom'); } };
    t.assert.strictEqual(B.buffBlock(throwing), 'production state unreadable');
    var badBuff = {};
    Object.defineProperty(badBuff, 'productionBuff', { get: function () { throw new Error('boom'); } });
    t.assert.strictEqual(B.buffBlock(badBuff), 'buff state unreadable');
    t.assert.strictEqual(B.hasProductionBuff(badBuff), null);
});

t.test('buffBlock: each present blocker blocks, an absent one is skipped', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    t.assert.strictEqual(B.buffBlock(H.zone.building({ productionState: 0, upgrading: true })), 'upgrading');
    t.assert.strictEqual(B.buffBlock(H.zone.building({ productionState: 0, constructing: true })),
        'under construction');
    t.assert.strictEqual(B.buffBlock(H.zone.building({ productionState: 0, destroying: true })),
        'being destroyed');
    // No blocker methods at all: eligible on state 0 alone.
    t.assert.strictEqual(B.buffBlock(H.zone.building({ productionState: 0 })), null);
});

t.test('buffBlock: a throwing blocker blocks', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    var b = H.zone.building({ productionState: 0 });
    b.IsInDestruction = function () { throw new Error('boom'); };
    t.assert.strictEqual(B.buffBlock(b), 'IsInDestruction unreadable');
});

t.test('buffState reports presence and mBuffs_vector length', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    var b = H.zone.building({ productionState: 0, upgrading: false, buffs: [H.zone.buff({}), H.zone.buff({})] });
    var st = B.buffState(b);
    t.assert.strictEqual(st.buffsVector, 2);
    t.assert.strictEqual(st.productionState, 0);
    t.assert.strictEqual(st.productionBuff, false);
    t.assert.strictEqual(st.blockers.length, B.BUFF_BLOCKERS.length);
    t.assert.strictEqual(st.blockers[0].present, true);
    t.assert.strictEqual(st.blockers[0].value, false);
    t.assert.strictEqual(st.blockers[1].present, false);
    t.assert.strictEqual(st.blockers[1].value, null);
    t.assert.strictEqual(B.buffState(H.zone.building({})).buffsVector, null);
    t.assert.strictEqual(B.buffState(null), null);
});

t.test('productionBuffInfo: name and remaining time, null without buff', function () {
    var H = bootClock(100 * HOUR);
    var B = H.Steward.core.buildings;
    var b = H.zone.building({
        productionBuff: H.zone.buff({ name: 'BuffMine', pct: 1000, duration: 5 * HOUR, start: 99 * HOUR })
    });
    var info = B.productionBuffInfo(b);
    t.assert.strictEqual(info.name, 'BuffMine');
    t.assert.strictEqual(info.remainingMs, 4 * HOUR);
    t.assert.strictEqual(B.productionBuffInfo(H.zone.building({})), null);
    t.assert.strictEqual(B.productionBuffInfo(null), null);
});

t.test('amountPerCycle reads amountRemoved from the economy definition', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    H.host.game.def = function () {
        return {
            GetResourcesCreationDefinitionForBuilding: function (n) {
                if (n === 'a') return { amountRemoved: 2 };
                if (n === 'b') return { workTime: 100 };
                return null;
            }
        };
    };
    t.assert.strictEqual(B.amountPerCycle('a'), 2);
    t.assert.strictEqual(B.amountPerCycle('b'), null);
    t.assert.strictEqual(B.amountPerCycle('c'), null);
});

// ---- readable ----------------------------------------------------------------

t.test('readable is false with no street map and on an empty vector', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    H.host.game.gi.mCurrentPlayerZone = {};
    B.invalidate();
    t.assert.strictEqual(B.readable(), false);
    H.host.game.gi.mCurrentPlayerZone = H.zone.zone().zone;
    B.invalidate();
    t.assert.strictEqual(B.readable(), false);
});

t.test('readable is true once the zone lists a building', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    H.host.game.gi.mCurrentPlayerZone = H.zone.zone()
        .building(H.zone.building({ name: 'IronMine', grid: 12 })).zone;
    B.invalidate();
    t.assert.strictEqual(B.readable(), true);
});

// ---- isSelectable --------------------------------------------------------------

t.test('isSelectable reads mIsSelectable strictly', function () {
    var H = harness.boot();
    var B = H.Steward.core.buildings;
    t.assert.strictEqual(B.isSelectable(H.zone.building({ selectable: true })), true);
    t.assert.strictEqual(B.isSelectable(H.zone.building({ selectable: false })), false);
    t.assert.strictEqual(B.isSelectable(H.zone.building({})), false);
    t.assert.strictEqual(B.isSelectable({ mIsSelectable: 1 }), false);
    t.assert.strictEqual(B.isSelectable(null), false);
});

t.test('isSelectable is false when the read throws', function () {
    var H = harness.boot();
    var bad = {};
    Object.defineProperty(bad, 'mIsSelectable', { get: function () { throw new Error('boom'); } });
    t.assert.strictEqual(H.Steward.core.buildings.isSelectable(bad), false);
});

// ---- name index in a read pass ----

function nameIndexZone(H, counter) {
    var z = H.zone.zone();
    for (var g = 1; g <= 4; g++) z.building(H.zone.building({ name: g % 2 ? 'A' : 'B', grid: g }));
    H.installZone(z);
    var sdm = z.zone.mStreetDataMap;
    var orig = sdm.GetBuildings_vector;
    sdm.GetBuildings_vector = function () { counter.n++; return orig.apply(sdm, arguments); };
    sdm.getBuildingsByName_vector = function () { return []; };
    return z;
}

t.test('byName in a pass scans the zone once for all names', function () {
    var H = harness.boot();
    var counter = { n: 0 };
    nameIndexZone(H, counter);
    var B = H.Steward.core.buildings;
    var outsideA = B.byName('A').length;
    var outsideB = B.byName('B').length;
    t.assert.strictEqual(counter.n, 2);
    counter.n = 0;
    var inA, inB;
    H.Steward.kernel.hostRead.pass(function () {
        inA = B.byName('A');
        inB = B.byName('B');
    });
    t.assert.strictEqual(counter.n, 1);
    t.assert.strictEqual(inA.length, outsideA);
    t.assert.strictEqual(inB.length, outsideB);
});

t.test('byName outside a pass reads the zone on every call', function () {
    var H = harness.boot();
    var counter = { n: 0 };
    nameIndexZone(H, counter);
    var B = H.Steward.core.buildings;
    B.byName('A');
    B.byName('A');
    t.assert.strictEqual(counter.n, 2);
});

t.test('byName in a pass still returns a mason only the host index holds', function () {
    var H = harness.boot();
    var counter = { n: 0 };
    var z = nameIndexZone(H, counter);
    var mason = H.zone.building({ name: 'Mason', grid: 99 });
    z.zone.mStreetDataMap.getBuildingsByName_vector = function (n) {
        return n === 'Mason' ? [mason] : [];
    };
    var found;
    H.Steward.kernel.hostRead.pass(function () {
        found = H.Steward.core.buildings.byName('Mason');
    });
    t.assert.strictEqual(found.length, 1);
    t.assert.strictEqual(found[0].GetGrid(), 99);
});
