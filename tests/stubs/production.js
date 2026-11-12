/*
 * Shared production host stub with read counters.
 *
 * Builds the world the core and module production tests read: produceable
 * buff defs, the buff definition map, target groups, the star menu, the
 * production queues and the building list. Every host read that costs a bridge
 * round trip in the real client is counted in w.counts, so a test can assert
 * how many reads a code path makes.
 *
 *   var PS = require('../stubs/production');
 *   var w = PS.world({ buffs: PS.buffDefs(40, ['3', '5']), buildings: [...] });
 *   var H = harness.boot({ sections: ['kernel', 'core'], host: { swmmo: w.swmmo } });
 *   PS.install(H, w);
 *   w.reset();                      // zero w.counts after setup reads
 *   w.counts.buffVector;            // GetProduceableBuffDefinitions calls
 *
 * Options of world():
 *   enumNames   { type: name } for Enums::TIMED_PRODUCTION_TYPE
 *   queues      { type: [entry, ...] }, an entry is { type, amount, produced,
 *               timeMs, collectedMs, bonus, producedItems }
 *   buffs       produceable defs { name, group, yield, costs }
 *   buffMap     { name: { target, group, type } } for map_BuffName_BuffDefinition
 *   groups      { group: [buildingName, ...] } for targetGroups.groupContains
 *   star        [{ type, amount }] star-menu buffs
 *   buildings   [{ name, grid, level, type, buff, state }]; type is the queue
 *               type (omit for continuous producers), buff a running buff
 *               name, state a GetProductionState number
 *   books, timed, home, stock, free   as in the production queue tests; a
 *               timed def is { name, yield, costs } plus, optionally, group
 *               (served by GetGroup()), requiresEvent, requiresQuest,
 *               requiresUpgradeLevelMin, requiresUpgradeLevelMax, typeKey
 *               (served by GetType(), default the name) and prodName
 *               (GetProductionName_string(), default the name)
 *   events      started event names; Utils::RequirementsHelper's
 *               checkRequirements(gi, event, quest) is true when the event is
 *               empty or started and the quest is empty or in quests
 *   quests      quest names checkRequirements accepts
 *   adventureBuffs  { name: active } for BuffAdventureController's
 *               isActiveBuffAdventureBuffOrNormalBuff; absent names are
 *               normal buffs (true)
 *   requirements    { key: bool | 'throw' } for
 *               gi.mRequirements.timedProductionRequirements_vector; a key's
 *               isFulfilledForSkillList returns the value or throws; absent
 *               keys have no lock
 *   skills      what gi.mCurrentPlayer.getSkills() returns (default [])
 *   labels      { key: text } served by loca.GetText('LAB', key); other keys
 *               fall through to the harness loca
 *
 * Counters beyond the reads above: requirement (isFulfilledForSkillList
 * calls), adventure (isActiveBuffAdventureBuffOrNormalBuff calls), events
 * (checkRequirements calls) and skills (getSkills calls).
 */

'use strict';

var AC = require('./actions');

function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

// n produceable buff defs BB_0..BB_n-1 with groups cycled from the array.
function buffDefs(n, groups) {
    var out = [];
    for (var i = 0; i < n; i++) {
        out.push({
            name: 'BB_' + i,
            group: groups && groups.length ? groups[i % groups.length] : '3',
            yield: 1,
            costs: [{ name_string: 'Gold', amount: 1 }]
        });
    }
    return out;
}

// Defines a getter on obj that returns fn on the first read and undefined on
// every later one, and counts the reads in obj.__reads[name]. Mirrors a host
// member that vanishes between two reads.
function flaky(obj, name, fn) {
    if (!obj.__reads) {
        Object.defineProperty(obj, '__reads', { value: {}, enumerable: false, writable: true });
    }
    obj.__reads[name] = 0;
    Object.defineProperty(obj, name, {
        enumerable: true,
        configurable: true,
        get: function () {
            obj.__reads[name]++;
            return obj.__reads[name] === 1 ? fn : undefined;
        }
    });
    return obj;
}

function world(opts) {
    opts = opts || {};
    var w = {
        enumNames: opts.enumNames || {},
        queues: opts.queues || {},
        buffs: opts.buffs || [],
        buffMap: opts.buffMap || {},
        groups: opts.groups || {},
        star: opts.star || [],
        buildings: opts.buildings || [],
        books: opts.books || [],
        timed: opts.timed || {},
        home: opts.home !== false,
        stock: opts.stock || {},
        free: typeof opts.free === 'number' ? opts.free : 1000,
        events: opts.events || [],
        quests: opts.quests || [],
        adventureBuffs: opts.adventureBuffs || {},
        requirements: opts.requirements || {},
        skills: opts.skills || [],
        labels: opts.labels || {},
        counts: null,
        reset: null,
        set: null,
        swmmo: null
    };

    function zero() {
        w.counts = {
            buffVector: 0, buffName: 0, buffGroup: 0,
            queue: {},
            zoneBuildings: 0, byNameIndex: 0,
            targetDesc: 0, groupContains: 0, starMenu: 0,
            requirement: 0, adventure: 0, events: 0, skills: 0
        };
    }
    zero();
    w.reset = zero;

    // set('buffs', [...]) or set('star.0.amount', 3): walks the dotted path.
    w.set = function (path, value) {
        var parts = String(path).split('.');
        var o = w;
        for (var i = 0; i < parts.length - 1; i++) o = o[parts[i]];
        o[parts[parts.length - 1]] = value;
    };

    w.swmmo = {
        getDefinitionByName: function (name) {
            if (name !== 'Enums::TIMED_PRODUCTION_TYPE') return null;
            return {
                toString: function (type) {
                    if (!has(w.enumNames, type)) throw new Error('no enum name');
                    return w.enumNames[type];
                }
            };
        }
    };
    return w;
}

function entryFake(e) {
    return {
        GetType_string:    function () { return e.type; },
        GetAmount:         function () { return e.amount; },
        GetProducedItems:  function () { return e.produced; },
        GetProductionTime: function () { return e.timeMs; },
        GetCollectedTime:  function () { return e.collectedMs; },
        GetProductionOrder: function () {
            return {
                GetTimeBonus:    function () { return e.bonus; },
                GetProductionVO: function () { return { producedItems: e.producedItems }; }
            };
        }
    };
}

function buildingFake(spec, index) {
    var b = {
        GetBuildingName_string: function () { return spec.name; },
        GetGrid:                function () { return typeof spec.grid === 'number' ? spec.grid : index; },
        GetUpgradeLevel:        function () { return typeof spec.level === 'number' ? spec.level : 1; },
        IsProductionActive:     function () { return spec.active !== false; }
    };
    if (typeof spec.type === 'number') b.productionQueue = { mProductionType: spec.type };
    if (spec.buff) {
        b.productionBuff = {
            GetBuffDefinition: function () { return { GetName_string: function () { return spec.buff; } }; }
        };
    }
    if (typeof spec.state === 'number') {
        b.GetResourceCreation = function () {
            return { GetProductionState: function () { return spec.state; } };
        };
    }
    return b;
}

// The building fakes of the world's current spec list.
function buildingVector(w) {
    var out = [];
    for (var i = 0; i < w.buildings.length; i++) out.push(buildingFake(w.buildings[i], i));
    return out;
}

// Wires a booted harness (booted with host.swmmo = w.swmmo) to the world.
function install(H, w) {
    var sent = AC.wire(H);
    var gi = H.host.game.gi;

    function queueFake(type) {
        var list = w.queues[type];
        return {
            mProductionType: type,
            productionBuilding: { GetGrid: function () { return 1000 + type; } },
            get mTimedProductions_vector() { return list.map(entryFake); }
        };
    }

    gi.mCurrentPlayerZone = {
        GetProductionQueue: function (type) {
            w.counts.queue[type] = (w.counts.queue[type] || 0) + 1;
            return w.queues[type] ? queueFake(type) : null;
        },
        mStreetDataMap: {
            GetBuildings_vector: function () {
                w.counts.zoneBuildings++;
                return buildingVector(w);
            },
            getBuildingsByName_vector: function (name) {
                w.counts.byNameIndex++;
                return buildingVector(w).filter(function (b) { return b.GetBuildingName_string() === name; });
            }
        }
    };
    gi.mCurrentViewedZoneID = 77;
    gi.isOnHomzone = function () { return w.home; };
    gi.mCurrentPlayer = gi.mCurrentPlayer || {};
    gi.mCurrentPlayer.getAvailableBuffs_vector = function () {
        w.counts.starMenu++;
        return w.star.map(function (s) {
            return {
                GetType: function () { return s.type; },
                GetResourceName_string: function () { return s.resource || ''; },
                GetUniqueId: function () { return { id: s.type }; },
                amount: s.amount
            };
        });
    };
    H.host.game.getResources = function () {
        return {
            GetResourceAmount: function (name) { return w.stock[name]; },
            GetFree: function () { return w.free; },
            GetPlayerResource: function () { return { producedAmount: 0 }; }
        };
    };

    sent.registerDef('BuffSystem::cBuff', {
        GetProduceableBuffDefinitions: function () {
            w.counts.buffVector++;
            return w.buffs.map(function (d) {
                return {
                    GetName_string:      function () { w.counts.buffName++; return d.name; },
                    GetGroup_string:     function () { w.counts.buffGroup++; return d.group; },
                    GetProductionAmount: function () { return d.yield; },
                    GetCosts_vector:     function () { return d.costs; }
                };
            });
        }
    });

    var map = {};
    Object.keys(w.buffMap).forEach(function (name) {
        var d = w.buffMap[name];
        map[name] = {
            GetTargetDescription_string: function () { w.counts.targetDesc++; return d.target; },
            GetTargetGroup_string:       function () { return d.group; },
            GetBuffType:                 function () { return d.type; }
        };
    });
    sent.registerDef('global', {
        map_BuffName_BuffDefinition: map,
        skillPoints_vector: w.books,
        timedProductions_vector: (function () {
            var v = {};
            Object.keys(w.timed).forEach(function (k) {
                v[k] = w.timed[k].map(timedDefFake);
            });
            return v;
        }())
    });
    sent.registerDef('BuffSystem.cBuffDefinition', {
        targetGroups: {
            groupContains: function (group, building) {
                w.counts.groupContains++;
                return has(w.groups, group) && w.groups[group].indexOf(building) !== -1;
            }
        }
    });
    installAvailability(H, w, sent);
    return sent;
}

function timedDefFake(d) {
    var def = {
        name_string: d.name,
        GetProductionAmount: function () { return d.yield; },
        GetCosts_vector: function () { return d.costs; },
        GetType: function () { return has(d, 'typeKey') ? d.typeKey : d.name; },
        GetProductionName_string: function () { return d.prodName || d.name; }
    };
    if (has(d, 'group')) def.GetGroup = function () { return d.group; };
    ['requiresEvent', 'requiresQuest', 'requiresUpgradeLevelMin', 'requiresUpgradeLevelMax'].forEach(function (k) {
        if (has(d, k)) def[k] = d[k];
    });
    return def;
}

// The host reads behind item availability: the two static classes, the
// recipe locks, the player's skills and the LAB page titles. Every value is
// read live from w, so a test can change it between reads.
function installAvailability(H, w, sent) {
    var gi = H.host.game.gi;
    sent.registerDef('Utils::RequirementsHelper', {
        checkRequirements: function (g, ev, qu) {
            w.counts.events++;
            return (!ev || w.events.indexOf(ev) !== -1) && (!qu || w.quests.indexOf(qu) !== -1);
        }
    });
    sent.registerDef('BuffSystem::BuffAdventureController', {
        isActiveBuffAdventureBuffOrNormalBuff: function (name) {
            w.counts.adventure++;
            return has(w.adventureBuffs, name) ? !!w.adventureBuffs[name] : true;
        }
    });
    gi.mRequirements = {
        get timedProductionRequirements_vector() {
            var v = {};
            Object.keys(w.requirements).forEach(function (key) {
                v[key] = {
                    isFulfilledForSkillList: function () {
                        w.counts.requirement++;
                        if (w.requirements[key] === 'throw') throw new Error('bridge');
                        return w.requirements[key];
                    }
                };
            });
            return v;
        }
    };
    gi.mCurrentPlayer.getSkills = function () {
        w.counts.skills++;
        return w.skills;
    };
    var loca = H.host.loca;
    var base = loca.GetText;
    loca.GetText = function (cat, key) {
        if (cat === 'LAB' && has(w.labels, key)) return w.labels[key];
        return base.call(loca, cat, key);
    };
}

module.exports = {
    world: world,
    install: install,
    buffDefs: buffDefs,
    flaky: flaky,
    entryFake: entryFake
};
