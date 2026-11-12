'use strict';

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

// A booted steward whose production, building and buff readers are replaced
// by a small world, so each case states only the host facts it needs.
//   world.types:   [{ type, buildings: [{ name, grid, level }] }]
//   world.entries: type -> [{ item, finished, remainingMs }]
//   world.queued:  'type|item' -> runs in the queue
//   world.costs:   item -> [{ name, amount }] per run
//   world.res:     resource -> amount
//   world.buffStock, world.block (grid -> reason), world.noMatch (buff names)
//   world.buffed:  grid -> true/false/null (hasProductionBuff; absent is false)
//   world.state:   grid -> production state (absent is 0, producing)
//   world.unproducible: 'type|item' -> true or null (isProducible's answer;
//                  absent items are producible)
// o.raw writes that settings object as is instead of the current shape, and
// o.beforeBoot(env) runs just before the module boots.
function setup(o) {
    o = o || {};
    var H = harness.boot();
    var S = H.Steward;
    var world = {
        home:      true,
        types:     o.types || [],
        entries:   o.entries || {},
        queued:    o.queued || {},
        costs:     o.costs || {},
        res:       o.res || {},
        buffStock: o.buffStock || {},
        block:     o.block || {},
        noMatch:   o.noMatch || {},
        unproducible: o.unproducible || {},
        buffed:    o.buffed || {},
        state:     o.state || {},
        attempts:  [],
        orders:    []
    };
    var P = S.core.production;
    P.queueTypes = function () {
        if (!world.home) return [];
        return world.types.map(function (tp) {
            var pr = P.profile(tp.type);
            return { type: tp.type, enumName: null, kind: pr.kind, buildings: tp.buildings.slice() };
        });
    };
    // Every world type has a readable queue.
    P.queueOf = function (type) {
        if (!world.home) return null;
        for (var t2 = 0; t2 < world.types.length; t2++) {
            if (world.types[t2].type === type) return { mProductionType: type };
        }
        return null;
    };
    P.entries = function (type) { return (world.entries[type] || []).slice(); };
    P.queuedIn = function (type, item) { return world.queued[type + '|' + item] || 0; };
    P.yieldIn = function () { return 1; };
    P.stockOf = function (type, item) { return world.res[item] || 0; };
    P.itemInfo = function (type, item) { return { costs: world.costs[item] || [], yield: 1 }; };
    P.isProducible = function (type, item) {
        var k = type + '|' + item;
        if (!Object.prototype.hasOwnProperty.call(world.unproducible, k)) return true;
        return world.unproducible[k] === null ? null : false;
    };
    P.jointShortfalls = function (list) {
        var need = {};
        for (var i = 0; i < list.length; i++) {
            var cs = world.costs[list[i].unit] || [];
            for (var j = 0; j < cs.length; j++) {
                need[cs[j].name] = (need[cs[j].name] || 0) + cs[j].amount * list[i].count;
            }
        }
        var out = [];
        for (var n in need) {
            var have = world.res[n] || 0;
            if (have < need[n]) out.push({ name: n, need: need[n], have: have });
        }
        return out;
    };
    P.orderIn = function (type, item, n, opts) {
        world.orders.push({ type: type, item: item, n: n, opts: opts });
        return { label: 'order ' + n + ' ' + item + ' (queue ' + type + ')' };
    };
    P.complete = function (type) { return { label: 'complete queue ' + type }; };

    var B = S.core.buildings;
    var byName = {};
    for (var i = 0; i < world.types.length; i++) {
        var bs = world.types[i].buildings;
        for (var j = 0; j < bs.length; j++) {
            (byName[bs[j].name] = byName[bs[j].name] || []).push(bs[j]);
        }
    }
    B.byName = function (name) { return (byName[name] || []).slice(); };
    B.grid = function (b) { return b.grid; };
    B.level = function (b) { return b.level; };
    B.name = function (b) { return b.name; };
    B.buffBlock = function (b) { return world.block[b.grid] || null; };
    B.hasProductionBuff = function (b) {
        return Object.prototype.hasOwnProperty.call(world.buffed, b.grid) ? world.buffed[b.grid] : false;
    };
    B.productionState = function (b) {
        return Object.prototype.hasOwnProperty.call(world.state, b.grid) ? world.state[b.grid] : 0;
    };
    B.PRODUCING_STATE = 0;
    S.core.buffs.buildingBuffMatch = function (buff) { return !world.noMatch[buff]; };
    S.core.buffs.stock = function (buff) {
        return Object.prototype.hasOwnProperty.call(world.buffStock, buff) ? world.buffStock[buff] : 5;
    };
    S.core.resources.amount = function (name) { return world.res[name] || 0; };
    S.core.actions.attempt = function (def, onDone) {
        world.attempts.push({ def: def, onDone: onDone });
        return true;
    };

    if (o.raw) {
        H.settings.write('production', o.raw);
    } else if (!o.fresh) {
        var s = { enabled: true, actionDelay: 100, ordersPerPass: 2, buffsPerPass: 2,
                  standing: true, buffs: true, bookComplete: false, settingsVersion: 2,
                  buildings: o.buildings || {} };
        for (var k in (o.extra || {})) s[k] = o.extra[k];
        H.settings.write('production', s);
    }

    var env = { T: 1000000, H: H, S: S, world: world };
    var mod = S.modules.production;
    mod.orderBreaker.clock = function () { return env.T; };
    mod.buffEngine.breaker.clock = function () { return env.T; };
    S.core.production.demand.clock = function () { return env.T; };
    env.mod = mod;
    env.reg = H.module('production');
    env.plan = function () {
        H.clearQueued();
        env.reg.plan({ zone: { isHome: true } });
        return H.queued();
    };
    env.handlers = {};
    var q = S.kernel.queue;
    var orig = q.action;
    q.action = function (name, fn) {
        env.handlers[name] = fn;
        return orig.apply(q, arguments);
    };
    if (o.beforeBoot) o.beforeBoot(env);
    env.reg.boot();
    q.action = orig;
    return env;
}

// One building row in the current shape, switched on unless told otherwise.
function row(item, items, buff, enabled) {
    return { item: item || '', items: items || 1, buff: buff || '', enabled: enabled !== false };
}

function named(list, name) {
    return list.filter(function (e) { return e.name === name; });
}

function logsOf(env, level, text) {
    return env.H.logs().filter(function (l) {
        return l.level === level && l.category === 'production' && l.args.join(' ').indexOf(text) >= 0;
    });
}

function debugs(env, text) {
    return logsOf(env, 'debug', text);
}

function ownNeeds(env) {
    return env.S.core.production.demand.list().filter(function (n) { return n.owner === 'production'; });
}

// Ends the last captured attempt with the given result.
function finish(env, status, extra) {
    var a = env.world.attempts[env.world.attempts.length - 1];
    var r = { status: env.S.ActionResult[status], label: a.def.label, reason: '', sends: 1 };
    for (var k in (extra || {})) r[k] = extra[k];
    a.onDone(r);
}

var BARRACKS = [{ name: 'Barracks', grid: 11, level: 3 }];
var BOOKBINDER = [{ name: 'Bookbinder', grid: 22, level: 1 }];

t.test('isReady: false when disabled or off home, true when enabled at home', function () {
    var env = setup();
    assert.strictEqual(env.reg.isReady({ zone: { isHome: true } }), true);
    assert.strictEqual(env.reg.isReady({ zone: { isHome: false } }), false);
    var s = env.H.settings.read('production');
    s.enabled = false;
    env.H.settings.write('production', s);
    assert.strictEqual(env.reg.isReady({ zone: { isHome: true } }), false);
});

t.test('phases run in order: complete, then automatic queues; the buff rides on the order', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS },
                { type: 2, buildings: BOOKBINDER },
                { type: 30, buildings: [{ name: 'Workshop', grid: 30, level: 1 }] }],
        entries: { 2: [{ item: 'Manuscript', finished: true }], 30: [{ item: 'Sword', finished: false }] },
        costs: { Rifleman: [{ name: 'Gold', amount: 1 }] },
        res: { Gold: 100 },
        buildings: { Barracks: row('Rifleman', 5, 'BarBuff'), Bookbinder: row(''),
                     Workshop: row('', 1, 'WorkBuff') },
        extra: { bookComplete: true }
    });
    var q = env.plan();
    assert.deepStrictEqual(q.map(function (e) { return e.name; }),
        ['production.complete', 'production.order']);
    assert.deepStrictEqual(plain(q[0].params), [2]);
    assert.deepStrictEqual(plain(q[1].params), [0, 'Rifleman', 5, 5, 'Barracks', 'BarBuff']);
    assert.deepStrictEqual(q.map(function (e) { return e.delay; }), [0, 100]);
});

// --- migration ---------------------------------------------------------

function oldShape(buildings, extra) {
    var s = { enabled: true, actionDelay: 100, ordersPerPass: 2, buffsPerPass: 2,
              standing: true, buffs: true, bookComplete: false, buildings: buildings };
    for (var k in (extra || {})) s[k] = extra[k];
    return s;
}

t.test('migration: old rows become items and enabled; the switch follows item+amount or a buff', function () {
    var env = setup({ raw: oldShape({
        Barracks:       { item: 'X', amount: 3, stack: 0, buff: '' },
        Workshop:       { item: '', amount: 0, stack: 0, buff: 'WorkBuff' },
        Forge:          { item: '', amount: 0, stack: 0, buff: '' },
        EliteBarracks:  { item: 'Knight', amount: 400, stack: 25, buff: '' },
        ProvisionHouse: { item: 'Fish', items: 7, buff: '', enabled: false }
    }) });
    var b = env.H.settings.read('production').buildings;
    var pick = function (r) { return { item: r.item, items: r.items, buff: r.buff, enabled: r.enabled }; };
    assert.deepStrictEqual(pick(b.Barracks), { item: 'X', items: 3, buff: '', enabled: true });
    assert.deepStrictEqual(pick(b.Workshop), { item: '', items: 1, buff: 'WorkBuff', enabled: true });
    assert.deepStrictEqual(pick(b.Forge), { item: '', items: 1, buff: '', enabled: false });
    // The amount is capped at what one order message may carry (25 without a host).
    assert.strictEqual(b.EliteBarracks.items, env.S.core.production.maxProductionAmount());
    assert.strictEqual(b.EliteBarracks.items, 25);
    // A row already in the new shape keeps its switch and Items.
    assert.deepStrictEqual(pick(b.ProvisionHouse), { item: 'Fish', items: 7, buff: '', enabled: false });
});

t.test('migration: sets bookComplete and the version, logs once, and does not run on a second boot', function () {
    var env = setup({ raw: oldShape({ Barracks: { item: 'X', amount: 3, stack: 0, buff: '' } }) });
    var s = env.H.settings.read('production');
    assert.strictEqual(s.bookComplete, true);
    assert.strictEqual(s.settingsVersion, 2);
    var moved = 'production settings moved to automatic queues: 1 rows; Bookbinder auto-complete on';
    assert.strictEqual(logsOf(env, 'info', moved).length + logsOf(env, 'log', moved).length, 1);
    var writes = 0;
    var write = env.S.kernel.settings.write;
    env.S.kernel.settings.write = function () { writes++; return write.apply(this, arguments); };
    env.reg.boot();
    assert.strictEqual(writes, 0);
    assert.strictEqual(env.H.logs().filter(function (l) { return l.args.join(' ').indexOf(moved) >= 0; }).length, 1);
});

t.test('migration: a failed write warns and leaves the version unset', function () {
    var env = setup({
        raw: oldShape({ Barracks: { item: 'X', amount: 3, stack: 0, buff: '' } }),
        beforeBoot: function (e) {
            e.S.kernel.settings.write = function () { return false; };
        }
    });
    assert.strictEqual(logsOf(env, 'warn', 'could not be moved to automatic queues').length, 1);
    var s = env.H.settings.read('production');
    assert.strictEqual(s.settingsVersion, undefined);
    assert.strictEqual(s.buildings.Barracks.enabled, undefined);
});

t.test('migration: a fresh install writes the defaults and does not migrate', function () {
    var env = setup({ fresh: true });
    var s = env.H.settings.read('production');
    assert.deepStrictEqual(plain(s), plain(env.S.modules.production.defaultSettings));
    assert.strictEqual(env.H.logs().filter(function (l) {
        return l.args.join(' ').indexOf('moved to automatic queues') >= 0;
    }).length, 0);
});

// --- enable gate, idle-only orders, clamps ------------------------------

t.test('a disabled row puts no need and no buff', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        entries: { 0: [] },
        costs: { Rifleman: [] },
        buildings: { Barracks: row('Rifleman', 5, 'BarBuff', false) }
    });
    var q = env.plan();
    assert.strictEqual(q.length, 0);
    assert.strictEqual(ownNeeds(env).length, 0);
    env.world.entries[0] = [{ item: 'Rifleman', finished: false }];
    assert.strictEqual(named(env.plan(), 'production.buff').length, 0);
});

t.test('an enabled row orders Items runs into an empty queue and nothing while it holds any entry', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [{ name: 'Gold', amount: 1 }] },
        res: { Gold: 100 },
        buildings: { Barracks: row('Rifleman', 5) }
    });
    var q = named(env.plan(), 'production.order');
    assert.strictEqual(q.length, 1);
    assert.deepStrictEqual(plain(q[0].params), [0, 'Rifleman', 5, 5, 'Barracks', '']);
    var need = ownNeeds(env)[0];
    assert.strictEqual(need.label, 'Automatic queue: ' + env.S.core.locale.bui('Barracks'));
    assert.strictEqual(need.priority, env.S.ProductionPriority.Standing);
    // Any entry, of any item, makes the building busy.
    env.world.entries[0] = [{ item: 'Swordsman', finished: false }];
    assert.strictEqual(named(env.plan(), 'production.order').length, 0);
    assert.strictEqual(env.mod.lastPass().rows[0].status, env.S.DemandStatus.Covered);
});

t.test('itemsFor clamps Items: 40 on Barracks orders 25, Bookbinder 3 orders 1', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }, { type: 2, buildings: BOOKBINDER }],
        costs: { Rifleman: [], Manuscript: [] },
        buildings: { Barracks: row('Rifleman', 40), Bookbinder: row('Manuscript', 3) }
    });
    var q = named(env.plan(), 'production.order');
    var runs = {};
    q.forEach(function (e) { runs[e.params[4]] = [e.params[2], e.params[3]]; });
    assert.deepStrictEqual(runs, { Barracks: [25, 25], Bookbinder: [1, 1] });
    var itemsFor = env.mod.itemsFor;
    assert.strictEqual(itemsFor({ items: 40 }, 0), 25);
    assert.strictEqual(itemsFor({ items: 3 }, 2), 1);
    assert.strictEqual(itemsFor({ items: 2.7 }, 0), 2);
    assert.strictEqual(itemsFor({ items: 0 }, 0), 1);
    assert.strictEqual(itemsFor({ items: 'x' }, 0), 1);
    assert.strictEqual(itemsFor(undefined, 0), 1);
});

t.test('runsMax normalizes orderMax', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }, { type: 2, buildings: BOOKBINDER }],
        costs: {},
        buildings: {}
    });
    var P = env.S.core.production;
    assert.strictEqual(env.mod.runsMax(0), 25);
    assert.strictEqual(env.mod.runsMax(2), 1);
    [undefined, 0, -3].forEach(function (v) {
        var orig = P.orderMax;
        P.orderMax = function () { return v; };
        assert.strictEqual(env.mod.runsMax(0), 1, String(v));
        P.orderMax = orig;
    });
});

t.test('a not-producible item puts no need and logs once until it was producible in between', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        unproducible: { '0|Rifleman': true },
        buildings: { Barracks: row('Rifleman', 5) }
    });
    var line = 'Barracks automatic queue Rifleman is not producible now - not ordering';
    for (var i = 0; i < 3; i++) {
        assert.strictEqual(named(env.plan(), 'production.order').length, 0);
        assert.strictEqual(ownNeeds(env).length, 0);
    }
    assert.strictEqual(debugs(env, line).length, 1);
    delete env.world.unproducible['0|Rifleman'];
    env.world.entries[0] = [{ item: 'Rifleman', finished: false }];
    env.plan();
    assert.strictEqual(ownNeeds(env).length, 1);
    env.world.unproducible['0|Rifleman'] = true;
    env.plan();
    assert.strictEqual(debugs(env, line).length, 2);
});

t.test('an unreadable producible check still orders', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        unproducible: { '0|Rifleman': null },
        buildings: { Barracks: row('Rifleman', 5) }
    });
    assert.strictEqual(named(env.plan(), 'production.order').length, 1);
});

// --- completion -----------------------------------------------------------

function bookbinder(rowOn, bookComplete) {
    return { types: [{ type: 2, buildings: BOOKBINDER }],
             entries: { 2: [{ item: 'Manuscript', finished: true }] },
             buildings: { Bookbinder: row('Manuscript', 1, '', rowOn) },
             extra: { bookComplete: bookComplete } };
}

t.test('completion runs only with bookComplete and the Bookbinder row enabled', function () {
    // An entry is queued, so no order competes with the completion.
    assert.strictEqual(named(setup(bookbinder(true, false)).plan(), 'production.complete').length, 0);
    assert.strictEqual(named(setup(bookbinder(false, true)).plan(), 'production.complete').length, 0);
    var env = setup(bookbinder(true, true));
    assert.strictEqual(named(env.plan(), 'production.complete').length, 1);
    env.handlers['production.complete']([2]);
    assert.strictEqual(env.world.attempts.length, 1);
    finish(env, 'Failed', { reason: 'check timed out', unseen: true });
    assert.strictEqual(env.mod.completeHolds()[2], env.T + 1800000);
    assert.strictEqual(named(env.plan(), 'production.complete').length, 0);
});

t.test('a queued completion skips when the Bookbinder row was disabled after queuing', function () {
    var env = setup(bookbinder(true, true));
    assert.strictEqual(named(env.plan(), 'production.complete').length, 1);
    var s = env.H.settings.read('production');
    s.buildings.Bookbinder.enabled = false;
    env.H.settings.write('production', s);
    env.handlers['production.complete']([2]);
    assert.strictEqual(env.world.attempts.length, 0);
    assert.strictEqual(debugs(env, 'is not enabled').length, 1);
});

// --- buffs ----------------------------------------------------------------

// The buff sent with each order of a pass, by building name.
function orderBuffs(q) {
    var out = {};
    named(q, 'production.order').forEach(function (e) { out[e.params[4]] = e.params[5]; });
    return out;
}

// Three idle queues, each row with an item; Workshop and Forge carry a buff.
function twoBuffWorld(stock) {
    return setup({
        types: [{ type: 0, buildings: BARRACKS },
                { type: 30, buildings: [{ name: 'Workshop', grid: 30, level: 1 }] },
                { type: 31, buildings: [{ name: 'Forge', grid: 31, level: 1 }] }],
        costs: { Rifleman: [{ name: 'Gold', amount: 1 }], Sword: [], Axe: [] },
        res: { Gold: 100 },
        buffStock: stock,
        buildings: { Barracks: row('Rifleman', 5),
                     Workshop: row('Sword', 1, 'BuffA'),
                     Forge: row('Axe', 1, 'BuffB') },
        extra: { ordersPerPass: 3 }
    });
}

t.test('an unreadable buff stock sends no buff, logs once, and later buildings still get theirs', function () {
    var env = twoBuffWorld({ BuffA: null });
    var q = env.plan();
    assert.strictEqual(named(q, 'production.buff').length, 0);
    assert.deepStrictEqual(orderBuffs(q), { Barracks: '', Forge: 'BuffB', Workshop: '' });
    assert.strictEqual(debugs(env, 'stock unreadable').length, 1);
    env.plan();
    assert.strictEqual(debugs(env, 'stock unreadable').length, 1);
});

t.test('a zero buff stock sends no buff and is not reported unreadable', function () {
    var env = twoBuffWorld({ BuffA: 0 });
    var q = env.plan();
    assert.deepStrictEqual(orderBuffs(q), { Barracks: '', Forge: 'BuffB', Workshop: '' });
    assert.strictEqual(debugs(env, 'stock unreadable').length, 0);
});

t.test('automatic queues still run when every buff stock is unreadable', function () {
    var env = twoBuffWorld({ BuffA: null, BuffB: null });
    var q = env.plan();
    assert.strictEqual(named(q, 'production.buff').length, 0);
    assert.deepStrictEqual(orderBuffs(q), { Barracks: '', Forge: '', Workshop: '' });
});

t.test('a buff choice that throws costs the buff, never the order', function () {
    var env = twoBuffWorld({});
    env.S.core.buildings.hasProductionBuff = function () { throw new Error('boom'); };
    var q = env.plan();
    assert.deepStrictEqual(orderBuffs(q), { Barracks: '', Forge: '', Workshop: '' });
    assert.ok(logsOf(env, 'error', 'buff choice threw').length >= 1);
});

t.test('ordersPerPass and buffsPerPass cap one pass', function () {
    var types = [];
    var buildings = {};
    var costs = {};
    var names = ['A', 'B', 'C'];
    for (var i = 0; i < names.length; i++) {
        types.push({ type: 30 + i, buildings: [{ name: 'W' + names[i], grid: 40 + i, level: 1 }] });
        buildings['W' + names[i]] = row('I' + names[i], 1, 'Buff');
        costs['I' + names[i]] = [];
    }
    // Every queue is idle, so all three order and each could carry the buff.
    var env = setup({ types: types, buildings: buildings, costs: costs,
                      extra: { buffsPerPass: 1, ordersPerPass: 3 } });
    var q = named(env.plan(), 'production.order');
    assert.strictEqual(q.length, 3);
    assert.strictEqual(q.filter(function (e) { return e.params[5]; }).length, 1);

    var env2 = setup({
        types: [{ type: 0, buildings: BARRACKS }, { type: 8, buildings: [{ name: 'EliteBarracks', grid: 12, level: 1 }] },
                { type: 1, buildings: [{ name: 'ProvisionHouse', grid: 13, level: 1 }] }],
        costs: { Rifleman: [], Knight: [], Fish: [] },
        buildings: { Barracks: row('Rifleman'), EliteBarracks: row('Knight'), ProvisionHouse: row('Fish') },
        extra: { ordersPerPass: 2 }
    });
    assert.strictEqual(named(env2.plan(), 'production.order').length, 2);
    var deferred = env2.mod.lastPass().rows.filter(function (r) { return r.status === env2.S.DemandStatus.Deferred; });
    assert.strictEqual(deferred.length, 1);
});

t.test('a buff only with an own order', function () {
    // A buff and no item: never buffed, even while its queue holds entries.
    var env = setup({
        types: [{ type: 30, buildings: [{ name: 'Workshop', grid: 30, level: 1 }] }],
        entries: { 30: [{ item: 'Sword', finished: false }] },
        buildings: { Workshop: row('', 1, 'WorkBuff') }
    });
    assert.strictEqual(env.plan().length, 0);

    // Item and buff into an idle queue: the order carries the buff.
    var env2 = setup({
        types: [{ type: 30, buildings: [{ name: 'Workshop', grid: 30, level: 1 }] }],
        costs: { Sword: [] },
        buildings: { Workshop: row('Sword', 1, 'WorkBuff') }
    });
    var q2 = env2.plan();
    assert.strictEqual(named(q2, 'production.buff').length, 0);
    assert.deepStrictEqual(orderBuffs(q2), { Workshop: 'WorkBuff' });
    // Once the queue holds an entry (Covered): no order and no buff.
    env2.world.entries[30] = [{ item: 'Sword', finished: false }];
    assert.strictEqual(env2.plan().length, 0);
});

t.test('no buff when one is running or its state is unreadable', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buffed: { 11: true },
        buildings: { Barracks: row('Rifleman', 5, 'BarBuff') }
    });
    assert.deepStrictEqual(orderBuffs(env.plan()), { Barracks: '' });
    assert.deepStrictEqual(orderBuffs(env.plan()), { Barracks: '' });
    assert.strictEqual(debugs(env, 'Barracks already has a production buff — no buff with this order').length, 1);
    env.world.buffed[11] = null;
    assert.deepStrictEqual(orderBuffs(env.plan()), { Barracks: '' });
    assert.strictEqual(debugs(env, 'buff state of Barracks unreadable — no buff with this order').length, 1);
    // Unbuffed again: the buff goes, and a later running buff is said again.
    env.world.buffed[11] = false;
    assert.deepStrictEqual(orderBuffs(env.plan()), { Barracks: 'BarBuff' });
    env.world.buffed[11] = true;
    env.plan();
    assert.strictEqual(debugs(env, 'Barracks already has a production buff').length, 2);
});

t.test('the buff is queued only after a verified order', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: row('Rifleman', 5, 'BarBuff') }
    });
    var run = function (params, status, extra) {
        env.H.clearQueued();
        env.handlers['production.order'](params);
        finish(env, status, extra);
        return env.H.queued();
    };
    var q = run([0, 'Rifleman', 5, 5, 'Barracks', 'BarBuff'], 'Verified');
    assert.deepStrictEqual(q.map(function (e) { return e.name; }), ['production.buff']);
    assert.deepStrictEqual(plain(q[0].params), [11, 'Barracks', 'BarBuff', 0]);
    assert.strictEqual(q[0].delay, 100);
    assert.strictEqual(run([0, 'Rifleman', 5, 5, 'Barracks', 'BarBuff'], 'Failed', { unseen: true }).length, 0);
    assert.strictEqual(run([0, 'Rifleman', 5, 5, 'Barracks', 'BarBuff'], 'Failed').length, 0);
    assert.strictEqual(run([0, 'Rifleman', 5, 5, 'Barracks', 'BarBuff'], 'Refused').length, 0);
    assert.strictEqual(run([0, 'Rifleman', 5, 5, 'Barracks'], 'Verified').length, 0);
    assert.strictEqual(run([0, 'Rifleman', 5, 5, 'Barracks', ''], 'Verified').length, 0);
});

t.test('buffAction waits one retry for producing, then asks the engine', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        state: { 11: 1 },
        block: { 11: 'not producing (state 1)' },
        buildings: { Barracks: row('Rifleman', 5, 'BarBuff') }
    });
    var buffNow = env.handlers['production.buff'];
    env.H.clearQueued();
    buffNow([11, 'Barracks', 'BarBuff', 0]);
    assert.deepStrictEqual(env.H.queued().map(function (e) { return plain(e.params); }),
        [[11, 'Barracks', 'BarBuff', 1]]);
    assert.strictEqual(env.world.attempts.length, 0);
    env.H.clearQueued();
    buffNow([11, 'Barracks', 'BarBuff', 1]);
    assert.strictEqual(env.H.queued().length, 0);
    assert.strictEqual(env.world.attempts.length, 0);
    assert.strictEqual(debugs(env, 'Barracks grid 11 cannot take BarBuff now: not producing (state 1)').length, 1);

    // Producing and the engine Ok: one apply attempt.
    env.world.state = {};
    env.world.block = {};
    buffNow([11, 'Barracks', 'BarBuff', 0]);
    assert.strictEqual(env.world.attempts.length, 1);
    // An engine Stop or Skip: no attempt.
    var S = env.S;
    [S.BuffVerdict.Stop, S.BuffVerdict.Skip].forEach(function (v) {
        env.mod.buffEngine.eligible = function () { return v; };
        buffNow([11, 'Barracks', 'BarBuff', 1]);
    });
    assert.strictEqual(env.world.attempts.length, 1);
    assert.strictEqual(debugs(env, 'cannot take BarBuff now: ' + S.BuffVerdict.Stop).length, 1);
});

t.test('a buff verdict of the shared engine is read through S.BuffVerdict', function () {
    var env = setup({
        types: [{ type: 30, buildings: [{ name: 'Workshop', grid: 30, level: 1 }] }],
        buildings: { Workshop: row('Sword', 1, 'WorkBuff') }
    });
    var S = env.S;
    var verdict = S.BuffVerdict.Ok;
    var asked = [];
    env.mod.buffEngine.eligible = function (b, assigned) { asked.push(assigned); return verdict; };
    var buffNow = env.handlers['production.buff'];
    buffNow([30, 'Workshop', 'WorkBuff', 0]);
    assert.strictEqual(env.world.attempts.length, 1);
    verdict = S.BuffVerdict.Skip;
    buffNow([30, 'Workshop', 'WorkBuff', 0]);
    verdict = S.BuffVerdict.Stop;
    buffNow([30, 'Workshop', 'WorkBuff', 0]);
    assert.strictEqual(env.world.attempts.length, 1);
    assert.deepStrictEqual(asked, [null, null, null]);
});

t.test('a configured buff on a building without a production queue is never buffed', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        buildings: { Sawmill: row('Plank', 1, 'SawBuff') }
    });
    assert.strictEqual(env.plan().length, 0);
    assert.strictEqual(env.plan().length, 0);
});

// --- holds, guards, scope -----------------------------------------------

t.test('a Units automatic queue is Held while adventures hold Units', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: row('Rifleman', 5) }
    });
    var S = env.S;
    S.core.production.demand.provide('adventures', function () {
        return { needs: [], holds: [{ key: 'troops', label: 'Adventure: wave 2/4 (troops)', kind: S.ProductionKind.Units }] };
    });
    assert.strictEqual(named(env.plan(), 'production.order').length, 0);
    assert.strictEqual(env.mod.lastPass().rows[0].status, S.DemandStatus.Held);
});

t.test('an automatic queue is short because a RunNow need reserves the resource', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [{ name: 'Gold', amount: 1 }] },
        res: { Gold: 10 },
        buildings: { Barracks: row('Rifleman', 5) }
    });
    var S = env.S;
    S.core.production.demand.put('adventures', 'wave1', {
        label: 'Run', type: 0, item: 'Rifleman', items: 8, basis: S.DemandBasis.Queue, priority: S.ProductionPriority.RunNow
    });
    assert.strictEqual(named(env.plan(), 'production.order').length, 0);
    var mine = env.mod.lastPass().rows.filter(function (r) { return r.owner === 'production'; })[0];
    assert.strictEqual(mine.status, S.DemandStatus.Short);
});

t.test('an unseen order holds the building for 30 min and counts a miss', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: row('Rifleman', 5) }
    });
    var q = named(env.plan(), 'production.order');
    env.handlers['production.order'](q[0].params);
    assert.strictEqual(env.world.orders[0].opts.grid, 11);
    assert.strictEqual(env.world.orders[0].opts.stack, 5);
    finish(env, 'Failed', { unseen: true, reason: 'not seen' });
    assert.strictEqual(env.mod.orderHolds().Barracks, env.T + 1800000);
    assert.strictEqual(env.mod.orderBreaker.snapshot().run, 1);
    assert.strictEqual(named(env.plan(), 'production.order').length, 0);
    env.T += 1800001;
    assert.strictEqual(named(env.plan(), 'production.order').length, 1);
});

t.test('a verified order clears the hold and marks the entry placed', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: row('Rifleman', 5) }
    });
    env.mod.orderHolds().Barracks = 1;
    env.handlers['production.order']([0, 'Rifleman', 5, 5, 'Barracks']);
    finish(env, 'Verified');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(env.mod.orderHolds(), 'Barracks'), false);
    assert.strictEqual(env.mod.isPlaced(0, 'Rifleman'), true);
});

t.test('five misses open the order breaker; nothing is queued until the probe', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: row('Rifleman', 5) }
    });
    var br = env.mod.orderBreaker;
    for (var i = 0; i < br.MISSES; i++) br.miss();
    assert.strictEqual(br.isOpen(), true);
    assert.strictEqual(named(env.plan(), 'production.order').length, 0);
    env.T += br.COOLDOWN_MS;
    assert.strictEqual(named(env.plan(), 'production.order').length, 1);
    assert.strictEqual(named(env.plan(), 'production.order').length, 0);
});

t.test('the order breaker texts say automatic queues', function () {
    var env = setup();
    var br = env.mod.orderBreaker;
    for (var i = 0; i < br.MISSES; i++) br.miss();
    br.verify('Barracks');
    var text = env.H.logs().map(function (l) { return l.args.join(' '); }).join('\n');
    assert.ok(text.indexOf('automatic queues are paused') >= 0, text);
    assert.ok(text.indexOf('automatic queues resume') >= 0, text);
    assert.ok(text.toLowerCase().indexOf('standing order') < 0, text);
});

t.test('mines and masons are never buffed or ordered here', function () {
    var env = setup({
        types: [{ type: 50, buildings: [{ name: 'IronMine', grid: 7, level: 1 }, { name: 'Mason', grid: 8, level: 1 }] }],
        costs: { Iron: [] },
        buildings: { IronMine: row('Iron', 5, 'MineBuff'), Mason: row('Stone', 5, 'MineBuff') }
    });
    env.world.entries[50] = [];
    assert.deepStrictEqual(plain(env.mod.queueNames()), {});
    assert.strictEqual(env.mod.ownedByMining('IronMine'), true);
    assert.strictEqual(env.mod.ownedByMining('Mason'), true);
    assert.strictEqual(env.plan().length, 0);
});

t.test('one producer: only the highest-level building is buffed and ordered into, never a lower one', function () {
    var two = [{ name: 'Barracks', grid: 5, level: 3 }, { name: 'Barracks', grid: 9, level: 5 }];
    var env = setup({
        types: [{ type: 0, buildings: two }],
        costs: { Rifleman: [] },
        buildings: { Barracks: row('Rifleman', 3, 'BarBuff') }
    });
    var q = named(env.plan(), 'production.order');
    assert.deepStrictEqual(plain(q[0].params), [0, 'Rifleman', 3, 3, 'Barracks', 'BarBuff']);
    env.H.clearQueued();
    env.handlers['production.order'](q[0].params);
    assert.strictEqual(env.world.orders[0].opts.grid, 9);
    finish(env, 'Verified');
    assert.deepStrictEqual(env.H.queued().map(function (e) { return e.params[0]; }), [9]);

    // Only the producer's running buff counts: a buffed lower building does not stop it.
    env.world.buffed[5] = true;
    assert.deepStrictEqual(orderBuffs(env.plan()), { Barracks: 'BarBuff' });
    env.world.buffed[9] = true;
    assert.deepStrictEqual(orderBuffs(env.plan()), { Barracks: '' });

    // A grid hold is judged at run time by the engine.
    var buffNow = env.handlers['production.buff'];
    env.mod.buffEngine.holds()[9] = env.T + 1000;
    buffNow([9, 'Barracks', 'BarBuff', 0]);
    assert.strictEqual(env.world.attempts.length, 1);   // only the order above
    delete env.mod.buffEngine.holds()[9];

    // The handler re-checks the producer before it applies.
    buffNow([5, 'Barracks', 'BarBuff']);
    assert.strictEqual(env.world.attempts.length, 1);
    assert.strictEqual(debugs(env, 'producer of Barracks changed').length, 1);
});

t.test('a held order takes no ordersPerPass slot', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }, { type: 1, buildings: [{ name: 'ProvisionHouse', grid: 13, level: 1 }] }],
        costs: { Rifleman: [], Fish: [] },
        buildings: { Barracks: row('Rifleman'), ProvisionHouse: row('Fish') },
        extra: { ordersPerPass: 1 }
    });
    var S = env.S;
    env.mod.orderHolds().Barracks = env.T + 1800000;
    var q = named(env.plan(), 'production.order');
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].params[4], 'ProvisionHouse');
    var rows = env.mod.lastPass().rows;
    var held = rows.filter(function (r) { return r.key === 'Barracks'; })[0];
    assert.strictEqual(held.status, S.DemandStatus.Held);
    assert.strictEqual(rows.filter(function (r) { return r.status === S.DemandStatus.Deferred; }).length, 0);
    env.T += 1800001;
    q = named(env.plan(), 'production.order');
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].params[4], 'Barracks');
});

// --- switches -------------------------------------------------------------

t.test('switching off cancels the module queue work and drops its demand', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: row('Rifleman', 5) }
    });
    env.plan();
    var demand = env.S.core.production.demand;
    assert.strictEqual(demand.list().length, 1);
    var cancelled = [];
    env.S.kernel.queue.cancelByModule = function (id) { cancelled.push(id); return 0; };
    var s = env.H.settings.read('production');
    s.enabled = false;
    env.H.settings.write('production', s);
    env.S.kernel.lifecycle.applySettings.production();
    assert.deepStrictEqual(cancelled, ['production']);
    assert.strictEqual(demand.list().length, 0);
    assert.strictEqual(env.plan().length, 0);
});

t.test('automatic queues off at Save drops the needs, cancels nothing', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: row('Rifleman', 5) }
    });
    env.plan();
    var demand = env.S.core.production.demand;
    assert.strictEqual(demand.list().length, 1);
    var cancelled = [];
    env.S.kernel.queue.cancelByModule = function (id) { cancelled.push(id); return 0; };
    var s = env.H.settings.read('production');
    s.standing = false;
    env.H.settings.write('production', s);
    env.S.kernel.lifecycle.applySettings.production();
    assert.strictEqual(demand.list().length, 0);
    assert.deepStrictEqual(cancelled, []);
});

t.test('a queued action skips when its switch is off', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }, { type: 2, buildings: BOOKBINDER }],
        costs: { Rifleman: [] },
        buildings: { Barracks: row('Rifleman', 5, 'BarBuff'), Bookbinder: row('') },
        extra: { standing: false, buffs: false, bookComplete: false }
    });
    var attempts = 0;
    env.S.core.actions.attempt = function () { attempts++; return true; };
    env.mod.buffEngine.apply = function () { attempts++; };
    env.handlers['production.order']([0, 'Rifleman', 5, 5, 'Barracks']);
    env.handlers['production.buff']([11, 'Barracks', 'BarBuff']);
    env.handlers['production.complete']([2]);
    assert.strictEqual(attempts, 0);
    assert.strictEqual(debugs(env, 'automatic queues are off - skipping order of').length, 1);
    assert.strictEqual(debugs(env, 'buffs are off').length, 1);
    assert.strictEqual(debugs(env, 'book completion is off').length, 1);
});

t.test('removed exports and the note enum are gone; itemsFor is exported', function () {
    var env = setup();
    var P = env.S.modules.production;
    ['recent', 'assess', 'completeNow', 'stackFor', 'defaultStack', 'holdLabel',
     'note', 'noteResult', 'resultText'].forEach(function (k) {
        assert.strictEqual(P[k], undefined, k);
    });
    assert.strictEqual(env.S.ProductionNote, undefined);
    assert.strictEqual(typeof P.itemsFor, 'function');
    assert.strictEqual(typeof P.runsMax, 'function');
});

// A full bundle on the counting host stub: the real core readers, so a plan
// pass shows how many host reads it costs.
var PS = require('../stubs/production');

function countingSetup() {
    var w = PS.world({
        enumNames: { 1: 'provisionhouse', 2: 'bookbinder', 11: 'winery' },
        buffs: PS.buffDefs(4, ['3', '11']),
        stock: { Gold: 100 },
        // Queues 1 and 11 are idle, so both buffed rows order and carry their buff.
        queues: {
            1:  [],
            2:  [{ type: 'Manuscript', amount: 1, produced: 1, timeMs: 1000, collectedMs: 1000, bonus: 1, producedItems: 1 }],
            11: []
        },
        buildings: [{ name: 'ProvisionHouse', grid: 31, level: 2, type: 1, state: 0 },
                    { name: 'Bookbinder', grid: 32, level: 1, type: 2, state: 0 },
                    { name: 'Winery', grid: 33, level: 1, type: 11, state: 0 }]
    });
    var H = harness.boot({ host: { swmmo: w.swmmo } });
    PS.install(H, w);
    var S = H.Steward;
    // Buff targeting and stock are not what this counts; both say yes.
    S.core.buffs.buildingBuffMatch = function () { return true; };
    S.core.buffs.stock = function () { return 5; };
    H.settings.write('production', {
        enabled: true, actionDelay: 100, ordersPerPass: 2, buffsPerPass: 2,
        standing: true, buffs: true, bookComplete: true, settingsVersion: 2,
        buildings: {
            ProvisionHouse: { item: 'BB_0', items: 2, buff: 'BB_2', enabled: true },
            Bookbinder:     { item: '', items: 1, buff: '', enabled: true },
            Winery:         { item: 'BB_1', items: 2, buff: 'BB_3', enabled: true }
        }
    });
    var reg = H.module('production');
    reg.boot();
    w.reset();
    return { H: H, S: S, w: w, reg: reg };
}

t.test('plan(): one pass reads the building vector at most twice and each queue at most once', function () {
    var b = countingSetup();
    b.H.clearQueued();
    b.reg.plan({ zone: { isHome: true } });
    var queued = b.H.queued();
    var names = queued.map(function (e) { return e.name; });
    // The pass did real work: the book completion and both orders, each with its buff.
    assert.ok(names.indexOf('production.complete') !== -1, names.join(','));
    assert.strictEqual(queued.filter(function (e) {
        return e.name === 'production.order' && e.params[5];
    }).length, 2, JSON.stringify(queued));
    // GetBuildings_vector: once for the queue types, once for the name index.
    assert.ok(b.w.counts.zoneBuildings <= 2, 'building vector reads: ' + JSON.stringify(b.w.counts));
    // The host's named lookup is asked per producer lookup: buff and need per name.
    assert.ok(b.w.counts.byNameIndex <= 4, 'named lookups: ' + JSON.stringify(b.w.counts));
    Object.keys(b.w.counts.queue).forEach(function (type) {
        assert.ok(b.w.counts.queue[type] <= 1, 'queue ' + type + ' read ' + b.w.counts.queue[type] + ' times');
    });
    assert.ok(b.w.counts.queue[2] === 1 && b.w.counts.queue[1] === 1 && b.w.counts.queue[11] === 1,
        JSON.stringify(b.w.counts.queue));
});

t.test('plan() runs in a read pass that is closed afterwards, also when a phase throws', function () {
    var b = countingSetup();
    var HR = b.S.kernel.hostRead;
    var seen = [];
    b.S.core.production.demand.dropOwner = function () {
        seen.push(HR.inPass());
        throw new Error('boom');
    };
    b.reg.plan({ zone: { isHome: true } });
    assert.deepStrictEqual(seen, [true]);
    assert.strictEqual(HR.inPass(), false);
    assert.ok(b.H.logs().some(function (l) {
        return l.level === 'error' && l.args.join(' ').indexOf('standing phase threw') !== -1;
    }));
});

t.test('a hidden-by-name row is never ordered or buffed, even when saved and enabled', function () {
    var env = setup({
        types: [{ type: 77, buildings: [{ name: 'StarfallAirship', grid: 11, level: 1 }] },
                { type: 1, buildings: [{ name: 'ProvisionHouse', grid: 12, level: 1 }] }],
        costs: { StarItem: [], Sandwich: [] },
        buildings: { StarfallAirship: row('StarItem', 5, 'StarBuff'), ProvisionHouse: row('Sandwich', 1) }
    });
    env.world.entries[77] = [];
    env.world.entries[1] = [];
    var q = env.plan();
    var keys = ownNeeds(env).map(function (n) { return n.key; });
    assert.strictEqual(keys.indexOf('StarfallAirship'), -1);
    assert.deepStrictEqual(plain(keys.filter(function (k) { return k === 'ProvisionHouse'; })), ['ProvisionHouse']);
    var orders = named(q, 'production.order');
    assert.deepStrictEqual(plain(orders.map(function (e) { return e.params[4]; })), ['ProvisionHouse']);
    // Running the queued orders reaches the host only for the shown row.
    for (var i = 0; i < orders.length; i++) env.handlers['production.order'](orders[i].params);
    assert.strictEqual(env.world.orders.filter(function (o) { return o.type === 77; }).length, 0);
    assert.strictEqual(env.world.attempts.filter(function (a) {
        return String(a.def && a.def.label).indexOf('StarfallAirship') >= 0;
    }).length, 0);
    assert.strictEqual(debugs(env, 'is hidden by name').length, 1);
    env.plan();
    assert.strictEqual(debugs(env, 'is hidden by name').length, 1);

    // The scope is unchanged: the model still sees the name to hide it.
    assert.strictEqual(env.mod.queueNames().StarfallAirship, 77);
    assert.strictEqual(env.mod.hiddenName('StarfallAirship'), true);
    assert.strictEqual(env.mod.hiddenName('ProvisionHouse'), false);
});
