/*
 * Fluent zone builder for tests.
 *
 * Constructs a fake zone object shaped enough for core/zone, core/buildings,
 * core/deposits to query without throwing. The fluent API lets tests express
 * scenarios compactly:
 *
 *   var z = zone()
 *       .deposits('IronOre', [deposit({ name: 'IronOre', grid: 12 })])
 *       .building(building({ name: 'IronMine', grid: 12 }))
 *       .buildQueue(0, 4)
 *       .mountOnPlayer(host.game.gi.mCurrentPlayer);
 *
 * Each mutator returns the fluent object so calls chain.
 */

'use strict';

function deposit(opts) {
    opts = opts || {};
    return {
        GetName_string: function () { return opts.name || 'Stone'; },
        GetGrid:        function () { return typeof opts.grid === 'number' ? opts.grid : 0; },
        GetAmount:      function () { return typeof opts.amount === 'number' ? opts.amount : 0; }
    };
}

function building(opts) {
    opts = opts || {};
    var goContainer = {
        ui:               opts.ui || null,
        mIsAttackable:    !!opts.attackable,
        mIsLeaderCamp:    !!opts.leaderCamp
    };
    return {
        GetBuildingName_string: function () { return opts.name || 'Unknown'; },
        GetGrid:                function () { return typeof opts.grid === 'number' ? opts.grid : 0; },
        GetUpgradeLevel:        function () { return typeof opts.level === 'number' ? opts.level : 0; },
        getPlayerID:            function () {
            return (typeof opts.playerId === 'number') ? opts.playerId : 0;
        },
        GetGOContainer:         function () { return goContainer; },
        GetArmy:                function () {
            return opts.hasArmy ? { HasUnits: function () { return true; } } : null;
        },
        IsUpgradeAllowed:       function () { return !!opts.upgradable; },
        IsProductionActive:     function () { return opts.producing !== false; },
        // Buff-related state — see core/buffs.canApply gates.
        productionBuff:         (typeof opts.productionBuff !== 'undefined') ? opts.productionBuff : null,
        IsUpgradeInProgress:    function () { return !!opts.upgrading; },
        IsInConstructionMode:   function () { return !!opts.constructing; },
        IsInDestruction:        function () { return !!opts.destructing; },
        // Mines and masons are workyards — autoTSO's filter uses this to
        // include generic 'Workyard'-targeting buffs (e.g. productivity buffs).
        isWorkyard:             function () { return !!opts.isWorkyard; }
    };
}

// Factory for a host-shaped buff entry. Used by tests that exercise
// core/buffs and tryBuff. Mirrors the fields read by autoTSO/aBuffs.
function buff(opts) {
    opts = opts || {};
    var def = {
        GetBuffType:                function () { return typeof opts.buffType === 'number' ? opts.buffType : 0; },
        GetTargetDescription_string: function () { return opts.targets || ''; },
        GetTargetGroup_string:       function () { return opts.targetGroup || ''; },
        GetName_string:              function () { return opts.name || ''; },
        GetBuffEfficiencies_vector:  function () { return opts.efficiencies || []; }
    };
    return {
        GetType:           function () { return opts.name || 'UnnamedBuff'; },
        GetUniqueId:       function () { return opts.uniqueId || (opts.name + '_id'); },
        GetBuffDefinition: function () { return def; },
        GetResourceName_string: function () { return opts.resourceName || ''; },
        amount:            (typeof opts.amount === 'number') ? opts.amount : 1
    };
}

function makeZone() {
    var deposits          = [];
    var depositsByType    = {};
    var buildings         = [];
    var buildingsByName   = {};
    var specs             = [];
    var queue             = {
        GetTotalAvailableSlots: function () { return queue._max; },
        GetQueue_vector:        function () { return { length: queue._used }; },
        _used: 0,
        _max:  4
    };

    function rebuildBuildingsByName() {
        buildingsByName = {};
        for (var i = 0; i < buildings.length; i++) {
            var nm = buildings[i].GetBuildingName_string();
            if (!buildingsByName[nm]) buildingsByName[nm] = [];
            buildingsByName[nm].push(buildings[i]);
        }
    }

    var sdm = {
        mDepositContainer:  deposits,
        mBuildingContainer: buildings,
        getDeposits_vectorByType: function (typeName) {
            return depositsByType[typeName] || [];
        },
        GetBuildings_vector: function () { return buildings; },
        getBuildingsByName_vector: function (n) {
            return buildingsByName[n] || [];
        }
    };

    var zone = {
        mStreetDataMap:        sdm,
        mAdventureName:        'Home',
        GetSpecialists_vector: function () { return specs; },
        GetBuildingFromGridPosition: function (g) {
            for (var i = 0; i < buildings.length; i++) {
                if (buildings[i].GetGrid() === g) return buildings[i];
            }
            return null;
        },
        GetResources: function () {
            return {
                CanPlayerAffordBuilding: function () { return true; },
                GetPlayerResource:       function () { return { producedAmount: 0 }; }
            };
        }
    };

    var fluent = {
        zone: zone,

        deposits: function (typeName, list) {
            depositsByType[typeName] = list || [];
            for (var i = 0; i < list.length; i++) deposits.push(list[i]);
            return fluent;
        },

        building: function (b) {
            buildings.push(b);
            rebuildBuildingsByName();
            return fluent;
        },

        specialists: function (list) {
            specs.length = 0;
            for (var i = 0; i < (list || []).length; i++) specs.push(list[i]);
            return fluent;
        },

        buildQueue: function (used, max) {
            queue._used = used || 0;
            queue._max  = (typeof max === 'number') ? max : 4;
            return fluent;
        },

        mountOnPlayer: function (player) {
            player.mBuildQueue              = queue;
            player.mIsAdventureZone         = false;
            player.GetMaxBuildingCount      = function () { return 100; };
            player.mCurrentBuildingsCountAll = buildings.length;
            player.getAvailableBuffs_vector = function () { return buffsInventory; };
            return fluent;
        }
    };

    var buffsInventory = [];
    fluent.buffs = function (list) {
        buffsInventory = (list || []).slice();
        return fluent;
    };

    return fluent;
}

// Factory for a host-shaped resource entry. Used by tests that exercise
// core/resources and the collections inventory section.
function resource(opts) {
    opts = opts || {};
    return {
        name_string:    opts.name || 'UnknownResource',
        amount:         (typeof opts.amount === 'number') ? opts.amount : 0,
        producedAmount: (typeof opts.producedAmount === 'number') ? opts.producedAmount : 0
    };
}

module.exports = {
    zone:     makeZone,
    deposit:  deposit,
    building: building,
    buff:     buff,
    resource: resource
};
