'use strict';

var t = require('../runner');
var harness = require('../harness');
var AC = require('../stubs/actions');

var assert = t.assert;

// A home zone with one queue per production type the profiles know:
// units 0/7/8, buffs 1/6/11, books 2, a culture building 20, a workshop 30,
// and two types without an enum name (40 with a cooldown, 41 without).
// world.queues[type] = { entries: [...], grid, cooldown? }, where an entry is
// { type, amount, produced, timeMs, collectedMs, bonus, producedItems }.
function setup() {
    var world = {
        enumNames: { 0: 'barracks', 1: 'provisionhouse', 2: 'bookbinder', 6: 'fishhouse', 7: 'tier3',
            8: 'elitebarracks', 11: 'winery', 20: 'culturebuilding', 30: 'workshop' },
        enumCalls: 0,
        queues: {},
        unreadable: {},
        home: true,
        elite: { Rifleman: false, Marksman: true, Knight: false },
        costs: {
            Rifleman: [{ name_string: 'Population', amount: 1 }],
            Marksman: [{ name_string: 'Population', amount: 2 }],
            Knight:   [{ name_string: 'Population', amount: 3 }]
        },
        unitDescs: [
            { prod: 'Rifleman', elite: false },
            { prod: 'Marksman', elite: true },
            { prod: 'Ghost', elite: false }
        ],
        tier3: ['Knight', 'Phantom'],
        buffs: [
            { name: 'BB_Plank', group: '3', yield: 3, costs: [{ name_string: 'Gold', amount: 5 }] },
            { name: 'BB_Fish', group: '5', yield: 2, costs: [{ name_string: 'Gold', amount: 7 }] }
        ],
        books: [
            { id_string: 'Manuscript', levels_vector: [
                { amountProduced: 0, costs: [{ name_string: 'Gold', amount: 10 }] },
                { amountProduced: 5, costs: [{ name_string: 'Gold', amount: 20 }] },
                { amountProduced: 10, costs: [{ name_string: 'Gold', amount: 40 }] }
            ] },
            { id_string: 'Tome', levels_vector: [] }
        ],
        producedBooks: { Manuscript: 7 },
        timed: {
            30: [{ name: 'SteelSword', yield: 1, costs: [{ name_string: 'Iron', amount: 5 }] }]
        },
        stock: { Gold: 1000, Iron: 12, Manuscript: 0 },
        free: 1000,
        buildings: []
    };
    var ids = [0, 1, 2, 6, 7, 8, 11, 20, 30, 40, 41];
    for (var i = 0; i < ids.length; i++) world.queues[ids[i]] = { entries: [], grid: 1000 + ids[i] };
    world.queues[20].cooldown = 5000;
    world.queues[40].cooldown = 7000;

    var swmmo = {
        getDefinitionByName: function (name) {
            if (name !== 'Enums::TIMED_PRODUCTION_TYPE') return null;
            return {
                toString: function (type) {
                    world.enumCalls++;
                    if (!(type in world.enumNames)) throw new Error('no enum name');
                    return world.enumNames[type];
                }
            };
        }
    };
    var H = harness.boot({ sections: ['kernel', 'core'], host: { swmmo: swmmo } });
    var sent = AC.wire(H);

    function entryFake(e) {
        return {
            GetType_string:    function () { return e.type; },
            GetAmount:         function () { return e.amount; },
            GetProducedItems:  function () { return e.produced; },
            GetProductionTime: function () { return e.timeMs; },
            GetCollectedTime:  function () { return e.collectedMs; },
            GetProductionOrder: function () {
                return {
                    GetTimeBonus:      function () { return e.bonus; },
                    GetProductionVO:   function () { return { producedItems: e.producedItems }; }
                };
            }
        };
    }

    function queueFake(id) {
        var q = world.queues[id];
        var pb = { GetGrid: function () { return q.grid; } };
        if (typeof q.cooldown === 'number') pb.getRemainingCooldown = function () { return q.cooldown; };
        return {
            mProductionType: id,
            productionBuilding: pb,
            get mTimedProductions_vector() {
                if (world.unreadable[id]) throw new Error('queue read failed');
                return q.entries.map(entryFake);
            }
        };
    }

    var gi = H.host.game.gi;
    gi.mCurrentPlayerZone = {
        GetProductionQueue: function (id) { return world.queues[id] ? queueFake(id) : null; }
    };
    gi.mCurrentViewedZoneID = 77;
    gi.isOnHomzone = function () { return world.home; };
    H.host.game.getResources = function () {
        return {
            GetResourceAmount: function (name) { return world.stock[name]; },
            GetFree: function () { return world.free; },
            GetPlayerResource: function (name) { return { producedAmount: world.producedBooks[name] }; }
        };
    };
    sent.registerDef('MilitarySystem::cMilitaryUnitBase', {
        GetUnitBaseForType: function (name) {
            if (!(name in world.elite)) return null;
            return {
                GetIsElite: function () { return world.elite[name]; },
                GetCosts_vector: function () { return world.costs[name]; }
            };
        }
    });
    sent.registerDef('MilitarySystem::cMilitaryUnitDescription', {
        GetAllUnitDescriptions: function () {
            return world.unitDescs.map(function (u) {
                return {
                    GetIsElite: function () { return u.elite; },
                    GetProductionName_string: function () { return u.prod; }
                };
            });
        }
    });
    sent.registerDef('MilitarySystem::cMilitaryUnitData', {
        GetAllUnitDataByTier: function (all, tier) {
            return tier === 3 ? world.tier3.map(function (n) {
                return { GetProductionName_string: function () { return n; } };
            }) : [];
        }
    });
    sent.registerDef('BuffSystem::cBuff', {
        GetProduceableBuffDefinitions: function () {
            return world.buffs.map(function (d) {
                return {
                    GetName_string: function () { return d.name; },
                    GetGroup_string: function () { return d.group; },
                    GetProductionAmount: function () { return d.yield; },
                    GetCosts_vector: function () { return d.costs; }
                };
            });
        }
    });
    sent.registerDef('global', {
        skillPoints_vector: world.books,
        timedProductions_vector: (function () {
            var v = {};
            Object.keys(world.timed).forEach(function (k) {
                v[k] = world.timed[k].map(function (d) {
                    return {
                        name_string: d.name,
                        GetProductionAmount: function () { return d.yield; },
                        GetCosts_vector: function () { return d.costs; }
                    };
                });
            });
            return v;
        }())
    });

    var S = H.Steward;
    S.core.buildings.list = function () {
        if (world.buildingsThrow) throw new Error('list failed');
        return world.buildings;
    };
    return { H: H, S: S, P: S.core.production, sent: sent, world: world };
}

function building(name, grid, level, queueType, fallbackType) {
    var b = {
        GetBuildingName_string: function () { return name; },
        GetGrid: function () { return grid; },
        GetUpgradeLevel: function () { return level; }
    };
    if (queueType !== undefined) b.productionQueue = { mProductionType: queueType };
    if (fallbackType !== undefined) {
        b.productionQueue = {};
        b.productionType = fallbackType;
    }
    return b;
}

function run(b, def, onStep) {
    var results = [];
    var ok = b.S.core.actions.attempt(def, function (r) { results.push(r); });
    AC.drive(b.H, { onStep: onStep });
    return { ok: ok, results: results };
}

function names(list) {
    return list.map(function (x) { return x.name; }).join(',');
}

t.test('profile per kind', function () {
    var b = setup();
    var K = b.S.ProductionKind;
    var p0 = b.P.profile(0);
    assert.strictEqual(p0.kind, K.Units);
    assert.strictEqual(p0.confirmed, true);
    assert.strictEqual(p0.stackable, true);
    assert.strictEqual(p0.maxEntries, null);
    assert.strictEqual(p0.enumName, 'barracks');
    assert.strictEqual(b.P.profile(8).kind, K.Units);
    var p7 = b.P.profile(7);
    assert.strictEqual(p7.kind, K.Units);
    assert.strictEqual(p7.confirmed, false);
    assert.strictEqual(p7.stackable, false);
    assert.strictEqual(p7.maxEntries, 1);
    [1, 6, 11].forEach(function (id) {
        var p = b.P.profile(id);
        assert.strictEqual(p.kind, K.Buffs);
        assert.strictEqual(p.confirmed, true);
        assert.strictEqual(p.stackable, true);
    });
    var p2 = b.P.profile(2);
    assert.strictEqual(p2.kind, K.Books);
    assert.strictEqual(p2.perOrderMax, 1);
    assert.strictEqual(p2.maxEntries, 1);
    assert.strictEqual(p2.needsComplete, true);
    assert.strictEqual(p2.confirmed, false);
    var p20 = b.P.profile(20);
    assert.strictEqual(p20.kind, K.Cooldown);
    assert.strictEqual(p20.orderable, false);
    assert.strictEqual(p20.maxEntries, 0);
    var p30 = b.P.profile(30);
    assert.strictEqual(p30.kind, K.Timed);
    assert.strictEqual(p30.orderable, true);
    assert.strictEqual(p30.maxEntries, 1);
    assert.strictEqual(p30.confirmed, false);
    assert.strictEqual(p30.needsComplete, false);
    assert.strictEqual(b.P.profile('2'), null);
    assert.strictEqual(JSON.stringify(b.P.BUFF_QUEUES), '[1,6,11]');
    assert.strictEqual(b.P.QUEUE_BOOKS, 2);
    assert.strictEqual(b.P.QUEUE_TIER3, 7);
});

t.test('an unreadable enum name falls back on the cooldown, and a later name wins', function () {
    var b = setup();
    var K = b.S.ProductionKind;
    assert.strictEqual(b.P.typeName(40), null);
    assert.strictEqual(b.P.profile(40).kind, K.Cooldown);
    assert.strictEqual(b.P.profile(41).kind, K.Timed);
    b.world.enumNames[40] = 'workshop';
    b.world.enumNames[41] = 'culturebuilding';
    assert.strictEqual(b.P.profile(40).kind, K.Timed);
    assert.strictEqual(b.P.profile(41).kind, K.Cooldown);
});

t.test('typeName is read once per type', function () {
    var b = setup();
    b.P.typeName(30);
    var calls = b.world.enumCalls;
    b.P.typeName(30);
    b.P.profile(30);
    assert.strictEqual(b.world.enumCalls, calls);
});

t.test('keepMax: 1 for books, 9999 for units, buffs and workshops', function () {
    var b = setup();
    assert.strictEqual(b.P.keepMax(2), 1);
    assert.strictEqual(b.P.keepMax(0), 9999);
    assert.strictEqual(b.P.keepMax(8), 9999);
    assert.strictEqual(b.P.keepMax(1), 9999);
    assert.strictEqual(b.P.keepMax(30), 9999);
});

t.test('itemsOf 0 and 8 split by GetIsElite and use the production name', function () {
    var b = setup();
    b.H.clearLogs();
    assert.strictEqual(names(b.P.itemsOf(0)), 'Rifleman');
    assert.strictEqual(names(b.P.itemsOf(8)), 'Marksman');
    assert.strictEqual(b.P.itemsOf(0)[0].label, 'Rifleman');
    var skipped = b.H.logs().filter(function (l) {
        return l.category === 'production' && String(l.args[0]).indexOf('unit item Ghost') === 0;
    });
    assert.strictEqual(skipped.length, 1);
});

t.test('itemsOf per kind, with unresolvable units dropped', function () {
    var b = setup();
    assert.strictEqual(names(b.P.itemsOf(7)), 'Knight');
    assert.strictEqual(names(b.P.itemsOf(1)), 'BB_Plank');
    assert.strictEqual(names(b.P.itemsOf(6)), 'BB_Fish');
    assert.strictEqual(names(b.P.itemsOf(2)), 'Manuscript,Tome');
    assert.strictEqual(names(b.P.itemsOf(30)), 'SteelSword');
    assert.strictEqual(b.P.itemsOf(20).length, 0);
    assert.strictEqual(b.P.itemsOf(41), null);
});

t.test('producer picks the higher level, then the lower grid, and skips bad grids', function () {
    var b = setup();
    var list = [building('Workshop', 50, 2, 30), building('Workshop', 60, 5, 30),
        building('Workshop', 40, 5, 30), building('Workshop', 'x', 9, 30)];
    b.S.core.buildings.byName = function () { return list; };
    assert.strictEqual(b.S.core.buildings.grid(b.P.producer('Workshop')), 40);
    list = [building('Workshop', 50, 2, 30), building('Workshop', 30, 2, 30)];
    assert.strictEqual(b.S.core.buildings.grid(b.P.producer('Workshop')), 30);
});

t.test('producer is null for an unknown name and warns when byName throws', function () {
    var b = setup();
    b.S.core.buildings.byName = function () { return []; };
    assert.strictEqual(b.P.producer('Nope'), null);
    b.S.core.buildings.byName = function () { throw new Error('boom'); };
    b.H.clearLogs();
    assert.strictEqual(b.P.producer('Nope'), null);
    var w = b.H.logs().filter(function (l) { return l.level === 'warn' && l.category === 'production'; });
    assert.strictEqual(w.length, 1);
});

t.test('queueTypes first building equals the producer of the name', function () {
    var b = setup();
    b.world.buildings = [building('Workshop', 50, 2, 30), building('Workshop', 60, 5, 30),
        building('Workshop', 40, 5, 30)];
    b.S.core.buildings.byName = function () { return b.world.buildings; };
    var first = b.P.queueTypes()[0].buildings[0];
    assert.strictEqual(first.grid, b.S.core.buildings.grid(b.P.producer('Workshop')));
});

t.test('queueTypes groups by type, highest level first, and is [] off home', function () {
    var b = setup();
    b.world.buildings = [
        building('Workshop', 50, 2, 30),
        building('Workshop', 60, 5, 30),
        building('Workshop', 40, 5, 30),
        building('Barracks', 10, 1, undefined, 0),
        building('Sawmill', 70, 3)
    ];
    var list = b.P.queueTypes();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].type, 0);
    assert.strictEqual(list[0].kind, b.S.ProductionKind.Units);
    assert.strictEqual(list[1].type, 30);
    assert.strictEqual(list[1].enumName, 'workshop');
    assert.strictEqual(list[1].buildings.map(function (x) { return x.grid; }).join(','), '40,60,50');
    assert.strictEqual(list[1].buildings[0].level, 5);
    assert.strictEqual(list[1].buildings[0].name, 'Workshop');

    b.world.buildingsThrow = true;
    assert.strictEqual(b.P.queueTypes(), null);
    b.world.home = false;
    assert.strictEqual(b.P.queueTypes().length, 0);
});

t.test('entries: time left, finished, and null on a throwing vector', function () {
    var b = setup();
    b.world.queues[30].entries.push({ type: 'SteelSword', amount: 3, produced: 1, timeMs: 1000, collectedMs: 500, bonus: 2 });
    b.world.queues[30].entries.push({ type: 'SteelSword', amount: 3, produced: 3, timeMs: 1000, collectedMs: 500, bonus: 2 });
    var list = b.P.entries(30);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].item, 'SteelSword');
    assert.strictEqual(list[0].remainingMs, 750);
    assert.strictEqual(list[0].finished, false);
    assert.strictEqual(list[0].producedItems, null);
    assert.strictEqual(list[1].remainingMs, 0);
    assert.strictEqual(list[1].finished, true);
    assert.strictEqual(b.P.remainingMs(30), 750);

    b.world.queues[2].entries.push({ type: 'Manuscript', amount: 1, produced: 0, timeMs: 1, collectedMs: 0, bonus: 1, producedItems: 1 });
    assert.strictEqual(b.P.entries(2)[0].finished, true);

    b.world.unreadable[30] = true;
    assert.strictEqual(b.P.entries(30), null);
    assert.strictEqual(b.P.remainingMs(30), null);
    assert.strictEqual(b.P.cooldownMs(20), 5000);
    assert.strictEqual(b.P.cooldownMs(30), null);
});

t.test('timed itemInfo matches the exact name only', function () {
    var b = setup();
    var info = b.P.itemInfo(30, 'SteelSword');
    assert.strictEqual(JSON.stringify(info), '{"costs":[{"name":"Iron","amount":5}],"yield":1}');
    assert.strictEqual(b.P.itemInfo(30, 'Sword'), null);
    assert.strictEqual(b.P.itemInfo(30, 'Steel'), null);
    assert.strictEqual(b.P.yieldIn(30, 'SteelSword'), 1);
    assert.strictEqual(b.P.yieldIn(1, 'BB_Plank'), 3);
    assert.strictEqual(b.P.yieldIn(0, 'Rifleman'), 1);
});

t.test('bookInfo takes the highest level the produced amount reached', function () {
    var b = setup();
    var info = b.P.bookInfo('Manuscript');
    assert.strictEqual(info.level, 1);
    assert.strictEqual(info.produced, 7);
    assert.strictEqual(JSON.stringify(info.costs), '[{"name":"Gold","amount":20}]');
    b.world.producedBooks.Manuscript = 10;
    assert.strictEqual(b.P.bookInfo('Manuscript').level, 2);
    assert.strictEqual(b.P.bookInfo('Tome'), null);
    assert.strictEqual(b.P.bookInfo('Codex'), null);
    assert.strictEqual(JSON.stringify(b.P.itemInfo(2, 'Manuscript').costs), '[{"name":"Gold","amount":40}]');
});

t.test('stockOf by kind, and capacity is unknown', function () {
    var b = setup();
    assert.strictEqual(b.P.stockOf(0, 'Rifleman'), null);
    assert.strictEqual(b.P.stockOf(30, 'Iron'), 12);
    assert.strictEqual(b.P.capacity(30), null);
});

t.test('stockOf passes an unreadable buff stock on as null, not 0', function () {
    var b = setup();
    var real = b.S.core.buffs.stock;
    b.S.core.buffs.stock = function () { return null; };
    try {
        assert.strictEqual(b.P.stockOf(1, 'BB_Fish'), null);
    } finally {
        b.S.core.buffs.stock = real;
    }
});

t.test('a timed order sends one message with stacks 1 and is refused when the queue has an entry', function () {
    var b = setup();
    var def = b.P.orderIn(30, 'SteelSword', 2);
    assert.strictEqual(def.retries, 0);
    assert.strictEqual(def.label, 'order 2 SteelSword (queue 30)');
    var r = run(b, def);
    var m = b.sent.messages;
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].id, 91);
    assert.strictEqual(m[0].data.type_string, 'SteelSword');
    assert.strictEqual(m[0].data.amount, 2);
    assert.strictEqual(m[0].data.stacks, 1);
    assert.strictEqual(m[0].data.productionType, 30);
    assert.strictEqual(m[0].data.buildingGrid, 1030);

    b.world.queues[30].entries.push({ type: 'Other', amount: 1 });
    var full = run(b, b.P.orderIn(30, 'SteelSword', 1));
    assert.strictEqual(full.results[0].status, b.S.ActionResult.Refused);
    assert.strictEqual(full.results[0].reason, 'queue full');
});

t.test('a timed order is refused when unaffordable and honours opts.grid', function () {
    var b = setup();
    var r = run(b, b.P.orderIn(30, 'SteelSword', 3));
    assert.strictEqual(r.results[0].reason, 'cannot afford: Iron');
    run(b, b.P.orderIn(30, 'SteelSword', 1, { grid: 4242 }));
    assert.strictEqual(b.sent.messages[0].data.buildingGrid, 4242);
});

t.test('a books order refuses n = 2 and sends one book', function () {
    var b = setup();
    var two = run(b, b.P.orderIn(2, 'Manuscript', 2));
    assert.strictEqual(two.results[0].status, b.S.ActionResult.Refused);
    assert.strictEqual(two.results[0].reason, 'one run per order');
    run(b, b.P.orderIn(2, 'Manuscript', 1));
    assert.strictEqual(b.sent.messages.length, 1);
    assert.strictEqual(b.sent.messages[0].data.stacks, 1);
    assert.strictEqual(b.sent.messages[0].data.amount, 1);
});

t.test('a cooldown building is not orderable', function () {
    var b = setup();
    var r = run(b, b.P.orderIn(20, 'Anything', 1));
    assert.strictEqual(r.results[0].reason, 'not orderable');
    assert.strictEqual(b.sent.messages.length, 0);
});

t.test('unit orders keep full stacks and the remainder; tier 3 is one unconfirmed message', function () {
    var b = setup();
    var def = b.P.orderIn(0, 'Rifleman', 60);
    assert.strictEqual(def.retries, undefined);
    // Nothing lands, so the confirmed order retries once: 2 messages a send.
    run(b, def);
    var m = b.sent.messages;
    assert.strictEqual(m.length, 4);
    assert.strictEqual(m[0].data.amount, 25);
    assert.strictEqual(m[0].data.stacks, 2);
    assert.strictEqual(m[1].data.amount, 10);
    assert.strictEqual(m[1].data.stacks, 1);

    var c = setup();
    run(c, c.P.orderIn(0, 'Rifleman', 30, { stack: 10 }));
    assert.strictEqual(c.sent.messages.length, 2);
    assert.strictEqual(c.sent.messages[0].data.amount, 10);
    assert.strictEqual(c.sent.messages[0].data.stacks, 3);

    var d = setup();
    var t3 = d.P.orderIn(7, 'Knight', 30);
    assert.strictEqual(t3.retries, 0);
    run(d, t3);
    assert.strictEqual(d.sent.messages.length, 1);
    assert.strictEqual(d.sent.messages[0].data.amount, 30);
    assert.strictEqual(d.sent.messages[0].data.stacks, 1);
});

t.test('order keeps its short label and refuses an unknown item', function () {
    var b = setup();
    assert.strictEqual(b.P.order('Rifleman', 5).label, 'order 5 Rifleman');
    var r = run(b, b.P.order('Ghost', 5));
    assert.strictEqual(r.results[0].reason, 'unknown item');
    assert.strictEqual(b.P.queuedIn(30, 'SteelSword'), 0);
});

t.test('complete is verified by the count dropping', function () {
    var b = setup();
    b.world.queues[2].entries.push({ type: 'Manuscript', amount: 1, produced: 1, timeMs: 1, collectedMs: 1, bonus: 1, producedItems: 1 });
    var def = b.P.complete(2);
    assert.strictEqual(def.retries, 0);
    assert.strictEqual(def.label, 'complete queue 2');
    var r = run(b, def, function (n) { if (n === 1) b.world.queues[2].entries.length = 0; });
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(b.sent.messages[0].id, 141);
    assert.strictEqual(b.sent.messages[0].data, 2);
});

t.test('complete verifies on a stock rise and fails unseen without retrying', function () {
    var b = setup();
    b.world.queues[2].entries.push({ type: 'Manuscript', amount: 1, produced: 1, timeMs: 1, collectedMs: 1, bonus: 1, producedItems: 1 });
    var up = run(b, b.P.complete(2), function (n) { if (n === 1) b.world.stock.Manuscript = 1; });
    assert.strictEqual(up.results[0].status, b.S.ActionResult.Verified);

    var c = setup();
    c.world.queues[2].entries.push({ type: 'Manuscript', amount: 1, produced: 1, timeMs: 1, collectedMs: 1, bonus: 1, producedItems: 1 });
    var r = run(c, c.P.complete(2));
    assert.strictEqual(r.results[0].status, c.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(c.sent.messages.length, 1);
});

t.test('complete refuses an unfinished head and a type without completion', function () {
    var b = setup();
    b.world.queues[2].entries.push({ type: 'Manuscript', amount: 1, produced: 0, timeMs: 1, collectedMs: 0, bonus: 1, producedItems: 0 });
    assert.strictEqual(run(b, b.P.complete(2)).results[0].reason, 'head entry not finished');
    assert.strictEqual(run(b, b.P.complete(30)).results[0].reason, 'not completable');
    b.world.queues[2].entries.length = 0;
    assert.strictEqual(run(b, b.P.complete(2)).results[0].reason, 'queue empty');
    assert.strictEqual(b.sent.messages.length, 0);
});

t.test('jointShortfalls with a type prices a timed item', function () {
    var b = setup();
    assert.strictEqual(b.P.jointShortfalls([{ unit: 'SteelSword', count: 2, type: 30 }]).length, 0);
    var short = b.P.jointShortfalls([{ unit: 'SteelSword', count: 3, type: 30 }]);
    assert.strictEqual(short.length, 1);
    assert.strictEqual(short[0].name, 'Iron');
    assert.strictEqual(short[0].need, 15);
    assert.strictEqual(short[0].have, 12);
    assert.strictEqual(b.P.jointShortfalls([{ unit: 'SteelSword', count: 1 }]), null);
    assert.strictEqual(JSON.stringify(b.P.costs('SteelSword', 30)), '[{"name":"Iron","amount":5}]');
    assert.strictEqual(JSON.stringify(b.P.costs('Rifleman', 0)), '[{"name":"Population","amount":1}]');
    assert.strictEqual(b.P.queuedItemsIn(1, 'BB_Plank'), 0);
});

t.test('cooldownMs reads the cooldown member once', function () {
    var b = setup();
    var reads = 0;
    var present = true;
    var zone = b.H.host.game.gi.mCurrentPlayerZone;
    var pb = { GetGrid: function () { return 1020; } };
    Object.defineProperty(pb, 'getRemainingCooldown', {
        get: function () {
            reads++;
            return present ? function () { return 4321; } : undefined;
        }
    });
    zone.GetProductionQueue = function (id) {
        if (id !== 20) return null;
        return { mProductionType: 20, productionBuilding: pb, mTimedProductions_vector: [] };
    };
    assert.strictEqual(b.P.cooldownMs(20), 4321);
    assert.strictEqual(reads, 1);

    present = false;
    assert.strictEqual(b.P.cooldownMs(20), null);
});
