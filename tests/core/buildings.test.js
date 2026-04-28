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
