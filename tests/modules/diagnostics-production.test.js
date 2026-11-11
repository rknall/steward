'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var AC = require('../stubs/actions');
var Z = require('../stubs/zone');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function costLine(name, amount) {
    return { GetName_string: function () { return name; }, GetAmount: function () { return amount; } };
}

function entry(o) {
    return {
        GetType:             function () { return o.type; },
        GetType_string:      function () { return o.type; },
        GetAmount:           function () { return o.amount; },
        GetProducedItems:    function () { return o.produced; },
        GetProductionTime:   function () { return 1000; },
        GetCollectedTime:    function () { return 10; },
        GetProductionOrder:  function () {
            return {
                GetTimeBonus:     function () { return 1; },
                GetProductionVO:  function () {
                    return { type_string: o.type, amount: o.amount, stacks: 1,
                             producedItems: o.vo, productionType: o.pt, buildingGrid: o.grid };
                }
            };
        }
    };
}

// A building that carries a production queue the way the host's does.
function qbuilding(opts, queue) {
    var b = Z.building(opts);
    b.productionQueue = queue;
    b.IsProductionActive = function () { return true; };
    return b;
}

function setup(opts) {
    opts = opts || {};
    var fs = airfs.make();
    var swmmoStub = {
        getDefinitionByName: function () {
            return { toString: function (n) { return n === 5 ? 'culturebuilding' : 'enum' + n; } };
        }
    };
    var H = harness.boot({ host: { air: fs.air, swmmo: swmmoStub } });
    var sent = AC.wire(H);

    var timedQueue = {
        mProductionType: 3,
        maxSlots: 4,
        label: 'q',
        getMaxEntries: function () { return 6; },
        productionBuilding: { GetGrid: function () { return 11; } },
        mTimedProductions_vector: [entry({ type: 'Plank', amount: 3, produced: 1, vo: 0, pt: 3, grid: 11 })]
    };
    var cultureQueue = {
        mProductionType: 5,
        productionBuilding: { GetGrid: function () { return 12; }, getRemainingCooldown: function () { return 777; } },
        mTimedProductions_vector: []
    };
    var z = H.zone.zone();
    z.building(qbuilding({ name: 'Sawmill', grid: 11, level: 2 }, timedQueue));
    z.building(qbuilding({ name: 'Theater', grid: 12 }, cultureQueue));
    z.building(Z.building({ name: 'Plain', grid: 13 }));
    H.installZone(z);
    H.Steward.core.zone.isHome = function () { return true; };
    H.host.game.zone.GetProductionQueue = undefined;
    H.host.game.gi.mCurrentPlayerZone.GetProductionQueue = function (type) {
        return type === 3 ? timedQueue : (type === 5 ? cultureQueue : null);
    };

    var unitBase = { GetType: function () { return 'Recruit'; } };
    var globalDef = {
        timedProductions_vector: { 3: [{ name_string: 'Plank', GetProductionAmount: function () { return 2; },
                                         GetCosts_vector: function () { return [costLine('Wood', 5)]; } }] },
        skillPoints_vector: [{ id_string: 'Manuscript',
                               levels_vector: [{ amountProduced: 0, GetCosts_vector: function () { return [costLine('Paper', 1)]; } }] }]
    };
    H.host.game.def = function (name) {
        if (name === 'global') return opts.noGlobal ? null : globalDef;
        if (name === 'MilitarySystem::cMilitaryUnitBase') {
            return { GetUnitBaseForType: function (n) { return n === 'Recruit' ? unitBase : null; } };
        }
        if (name === 'MilitarySystem::cMilitaryUnitData') {
            return { GetAllUnitDataByTier: function (a, tier) {
                return tier === 3 ? [{ GetProductionName_string: function () { return 'Recruit'; } }] : [];
            } };
        }
        if (name === 'MilitarySystem::cMilitaryUnitDescription') {
            return { GetAllUnitDescriptions: function () {
                return [{ GetIsElite: function () { return false; }, GetProductionName_string: function () { return 'Recruit'; } },
                        { GetIsElite: function () { return true; }, GetProductionName_string: function () { return 'Ghost'; } }];
            } };
        }
        if (name === 'BuffSystem::cBuff') {
            return { GetProduceableBuffDefinitions: function () {
                return [{ GetName_string: function () { return 'Tonic'; }, GetGroup_string: function () { return '5'; },
                          GetProductionAmount: function () { return 3; }, GetCosts_vector: function () { return []; } }];
            } };
        }
        return null;
    };
    H.host.game.getResources = function () {
        return { GetPlayerResource: function () { return { producedAmount: 42 }; } };
    };
    return { H: H, fs: fs, sent: sent, dg: H.Steward.modules.diagnostics.production };
}

function typeOf(doc, type) {
    for (var i = 0; i < doc.types.length; i++) if (doc.types[i].type === type) return doc.types[i];
    return null;
}

t.test('record lists each queue type with enum name, buildings and entries', function () {
    var s = setup();
    var doc = plain(s.dg.record());
    assert.deepStrictEqual(doc.types.map(function (x) { return x.type; }), [3, 5]);
    var timed = typeOf(doc, 3);
    assert.strictEqual(timed.enumName, 'enum3');
    assert.strictEqual(timed.buildings[0].name, 'Sawmill');
    assert.strictEqual(timed.buildings[0].level, 2);
    assert.strictEqual(timed.queue.buildingGrid, 11);
    assert.strictEqual(timed.queue.entries.length, 1);
    var e = timed.queue.entries[0];
    assert.strictEqual(e.typeString, 'Plank');
    assert.strictEqual(e.amount, 3);
    assert.strictEqual(e.produced, 1);
    assert.strictEqual(e.timeBonus, 1);
    assert.strictEqual(e.vo.producedItems, 0);
    assert.strictEqual(e.vo.buildingGrid, 11);
    assert.strictEqual(timed.items[0].name, 'Plank');
    assert.strictEqual(timed.items[0].yield, 2);
    assert.strictEqual(timed.items[0].costs[0].name, 'Wood');
});

t.test('record keeps queue fields and calls capacity-looking getters', function () {
    var s = setup();
    var q = typeOf(plain(s.dg.record()), 3).queue;
    assert.strictEqual(q.fields.maxSlots, 4);
    assert.strictEqual(q.fields.label, 'q');
    assert.strictEqual(q.fields.productionBuilding, 'object');
    assert.strictEqual(q.fields.getMaxEntries, 'function');
    assert.strictEqual(q.capacityCalls.getMaxEntries, 6);
    assert.strictEqual(q.mProductionType, 3);
});

t.test('record reads the culture cooldown and the enum name', function () {
    var s = setup();
    var c = typeOf(plain(s.dg.record()), 5);
    assert.strictEqual(c.enumName, 'culturebuilding');
    assert.strictEqual(c.buildings[0].cooldown, 777);
    assert.strictEqual(c.queue.entries.length, 0);
});

t.test('record covers units, books and buffs once per document', function () {
    var s = setup();
    var doc = plain(s.dg.record());
    assert.deepStrictEqual(doc.unitsByTier['3'], [{ name: 'Recruit', resolves: true }]);
    assert.deepStrictEqual(doc.unitsByTier['1'], []);
    var elite = doc.unitDescriptions.filter(function (u) { return u.elite; })[0];
    assert.strictEqual(elite.prodName, 'Ghost');
    assert.strictEqual(elite.resolves, false);
    assert.strictEqual(doc.skillPoints[0].id, 'Manuscript');
    assert.strictEqual(doc.skillPoints[0].produced, 42);
    assert.strictEqual(doc.skillPoints[0].levels[0].costs[0].name, 'Paper');
    assert.strictEqual(doc.produceableBuffs[0].name, 'Tonic');
    assert.strictEqual(doc.produceableBuffs[0].group, '5');
    assert.strictEqual(doc.produceableBuffs[0].yield, 3);
    assert.strictEqual(doc.produceableBuffs[0].stock, s.H.Steward.core.buffs.stock('Tonic', ''));
});

t.test('throwing accessors become error fields, not exceptions', function () {
    var s = setup({ noGlobal: true });
    s.H.Steward.core.army.unitBase = function () { throw new Error('ub'); };
    s.H.host.game.getResources = function () { throw new Error('res'); };
    var doc = plain(s.dg.record());
    assert.ok(/no global definition/.test(doc.skillPoints.error));
    assert.ok(/no global definition/.test(typeOf(doc, 3).items.error));
    assert.ok(/ub/.test(doc.unitsByTier['3'][0].resolves.error));
    s.H.host.game.gi.mCurrentPlayerZone.GetProductionQueue = function () { throw new Error('zone'); };
    var doc2 = plain(s.dg.record());
    assert.ok(/zone/.test(typeOf(doc2, 3).queue.error));
});

t.test('dump writes production-<zone>-<epoch>.json through writeDump', function () {
    var s = setup();
    var calls = [];
    var army = s.H.Steward.modules.diagnostics.army;
    var real = army.writeDump;
    army.writeDump = function (name, text) { calls.push(name); return real(name, text); };
    s.dg.dump();
    assert.strictEqual(calls.length, 1);
    assert.ok(/^production-[A-Za-z0-9_-]+-\d+\.json$/.test(calls[0]));
    var found = Object.keys(s.fs.disk).filter(function (k) { return /\/steward\/dumps\/production-/.test(k); });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(JSON.parse(s.fs.disk[found[0]]).types.length, 2);
});

t.test('dump logs chunks when no folder is writable and never sends', function () {
    var s = setup();
    s.H.Steward.kernel.files.stewardDir = function () { return null; };
    s.H.clearLogs();
    s.dg.dump();
    var logs = s.H.logs().filter(function (l) { return l.category === 'diag:production'; });
    assert.ok(logs.some(function (l) { return /^type 3 1\/\d+: /.test(String(l.args[0])); }));
    assert.strictEqual(s.sent.actions.length, 0);
    assert.strictEqual(s.sent.messages.length, 0);
    assert.strictEqual(s.H.queued().length, 0);
});
