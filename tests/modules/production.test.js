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
        return {
            label: 'order ' + n + ' ' + item + ' (queue ' + type + ')',
            baseline: function () { return 0; },
            describe: function (base) { return 'queued ' + base + ' -> ' + n; }
        };
    };

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
    S.core.buffs.buildingBuffMatch = function (buff) { return !world.noMatch[buff]; };
    S.core.buffs.stock = function (buff) {
        return Object.prototype.hasOwnProperty.call(world.buffStock, buff) ? world.buffStock[buff] : 5;
    };
    S.core.resources.amount = function (name) { return world.res[name] || 0; };
    S.core.actions.attempt = function (def, onDone) {
        world.attempts.push({ def: def, onDone: onDone });
        return true;
    };

    var s = { enabled: true, actionDelay: 100, ordersPerPass: 2, buffsPerPass: 2,
              standing: true, buffs: true, bookComplete: false, buildings: o.buildings || {} };
    for (var k in (o.extra || {})) s[k] = o.extra[k];
    H.settings.write('production', s);

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
    env.reg.boot();
    q.action = orig;
    return env;
}

function named(list, name) {
    return list.filter(function (e) { return e.name === name; });
}

function debugs(env, text) {
    return env.H.logs().filter(function (l) {
        return l.level === 'debug' && l.category === 'production' && l.args.join(' ').indexOf(text) >= 0;
    });
}

// Ends the last captured attempt with the given result.
function finish(env, status, extra) {
    var a = env.world.attempts[env.world.attempts.length - 1];
    var r = { status: env.S.ActionResult[status], label: a.def.label, reason: '', sends: 1 };
    for (var k in (extra || {})) r[k] = extra[k];
    a.onDone(r);
}

var BARRACKS = [{ name: 'Barracks', grid: 11, level: 3 }];

t.test('isReady: false when disabled or off home, true when enabled at home', function () {
    var env = setup();
    assert.strictEqual(env.reg.isReady({ zone: { isHome: true } }), true);
    assert.strictEqual(env.reg.isReady({ zone: { isHome: false } }), false);
    var s = env.H.settings.read('production');
    s.enabled = false;
    env.H.settings.write('production', s);
    assert.strictEqual(env.reg.isReady({ zone: { isHome: true } }), false);
});

t.test('phases run in order: complete, then buffs, then standing orders', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS },
                { type: 2, buildings: [{ name: 'Bookbinder', grid: 22, level: 1 }] },
                { type: 30, buildings: [{ name: 'Workshop', grid: 30, level: 1 }] }],
        entries: { 2: [{ item: 'Manuscript', finished: true }], 30: [{ item: 'Sword', finished: false }] },
        costs: { Rifleman: [{ name: 'Gold', amount: 1 }] },
        res: { Gold: 100 },
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 0, buff: '' },
                     Workshop: { item: '', amount: 0, stack: 0, buff: 'WorkBuff' } },
        extra: { bookComplete: true }
    });
    var q = env.plan();
    assert.deepStrictEqual(q.map(function (e) { return e.name; }),
        ['production.complete', 'production.buff', 'production.order']);
    assert.deepStrictEqual(plain(q[0].params), [2]);
    assert.deepStrictEqual(plain(q[1].params), [30, 'Workshop', 'WorkBuff']);
    assert.deepStrictEqual(plain(q[2].params), [0, 'Rifleman', 5, 25, 'Barracks']);
    assert.deepStrictEqual(q.map(function (e) { return e.delay; }), [0, 100, 100]);
});

function twoBuffWorld(stock) {
    return setup({
        types: [{ type: 0, buildings: BARRACKS },
                { type: 30, buildings: [{ name: 'Workshop', grid: 30, level: 1 }] },
                { type: 31, buildings: [{ name: 'Forge', grid: 31, level: 1 }] }],
        entries: { 30: [{ item: 'x', finished: false }], 31: [{ item: 'y', finished: false }] },
        costs: { Rifleman: [{ name: 'Gold', amount: 1 }] },
        res: { Gold: 100 },
        buffStock: stock,
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 0, buff: '' },
                     Workshop: { item: '', amount: 0, stack: 0, buff: 'BuffA' },
                     Forge: { item: '', amount: 0, stack: 0, buff: 'BuffB' } }
    });
}

t.test('an unreadable buff stock buffs nothing, logs once, and later buildings still run', function () {
    var env = twoBuffWorld({ BuffA: null });
    var q = env.plan();
    var buffs = named(q, 'production.buff');
    assert.strictEqual(buffs.length, 1);
    assert.deepStrictEqual(plain(buffs[0].params), [31, 'Forge', 'BuffB']);
    assert.strictEqual(debugs(env, 'stock unreadable').length, 1);
    env.plan();
    assert.strictEqual(debugs(env, 'stock unreadable').length, 1);
});

t.test('a zero buff stock buffs nothing and is not reported unreadable', function () {
    var env = twoBuffWorld({ BuffA: 0 });
    var q = env.plan();
    assert.strictEqual(named(q, 'production.buff').length, 1);
    assert.strictEqual(debugs(env, 'stock unreadable').length, 0);
});

t.test('standing orders still run when every buff stock is unreadable', function () {
    var env = twoBuffWorld({ BuffA: null, BuffB: null });
    var q = env.plan();
    assert.strictEqual(named(q, 'production.buff').length, 0);
    assert.strictEqual(named(q, 'production.order').length, 1);
});

t.test('ordersPerPass and buffsPerPass cap one pass', function () {
    var types = [];
    var buildings = {};
    var entries = {};
    var costs = {};
    var names = ['A', 'B', 'C'];
    for (var i = 0; i < names.length; i++) {
        types.push({ type: 30 + i, buildings: [{ name: 'W' + names[i], grid: 40 + i, level: 1 }] });
        buildings['W' + names[i]] = { item: 'I' + names[i], amount: 1, stack: 0, buff: 'Buff' };
        entries[30 + i] = [{ item: 'x', finished: false }];
        costs['I' + names[i]] = [];
    }
    // Every queue has an entry, so all three could be buffed.
    var env = setup({ types: types, buildings: buildings, entries: entries, costs: costs,
                      extra: { buffsPerPass: 1 } });
    var q = env.plan();
    assert.strictEqual(named(q, 'production.buff').length, 1);

    var env2 = setup({
        types: [{ type: 0, buildings: BARRACKS }, { type: 8, buildings: [{ name: 'EliteBarracks', grid: 12, level: 1 }] },
                { type: 1, buildings: [{ name: 'ProvisionHouse', grid: 13, level: 1 }] }],
        costs: { Rifleman: [], Knight: [], Fish: [] },
        buildings: { Barracks: { item: 'Rifleman', amount: 1, stack: 0, buff: '' },
                     EliteBarracks: { item: 'Knight', amount: 1, stack: 0, buff: '' },
                     ProvisionHouse: { item: 'Fish', amount: 1, stack: 0, buff: '' } },
        extra: { ordersPerPass: 2 }
    });
    assert.strictEqual(named(env2.plan(), 'production.order').length, 2);
    var deferred = env2.mod.lastPass().rows.filter(function (r) { return r.status === env2.S.DemandStatus.Deferred; });
    assert.strictEqual(deferred.length, 1);
});

t.test('a standing order tops up to amount and is not re-ordered while covered', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        queued: { '0|Rifleman': 4 },
        costs: { Rifleman: [{ name: 'Gold', amount: 1 }] },
        res: { Gold: 100 },
        buildings: { Barracks: { item: 'Rifleman', amount: 10, stack: 0, buff: '' } }
    });
    var q = named(env.plan(), 'production.order');
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].params[2], 6);
    env.world.queued['0|Rifleman'] = 10;
    assert.strictEqual(named(env.plan(), 'production.order').length, 0);
    assert.strictEqual(env.mod.lastPass().rows[0].status, env.S.DemandStatus.Covered);
});

t.test('a Units standing order is Held while adventures hold Units; the Skip is noted once', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 0, buff: '' } }
    });
    var S = env.S;
    S.core.production.demand.provide('adventures', function () {
        return { needs: [], holds: [{ key: 'troops', label: 'Adventure: wave 2/4 (troops)', kind: S.ProductionKind.Units }] };
    });
    assert.strictEqual(named(env.plan(), 'production.order').length, 0);
    assert.strictEqual(env.mod.lastPass().rows[0].status, S.DemandStatus.Held);
    env.plan();
    var skips = env.mod.recent().filter(function (e) { return e.kind === 'Skip'; });
    assert.strictEqual(skips.length, 1);
    assert.strictEqual(skips[0].name, 'Barracks');
    assert.ok(skips[0].text.indexOf('Adventure: wave 2/4 (troops)') >= 0);
});

t.test('a Standing order is short because a RunNow need reserves the resource', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [{ name: 'Gold', amount: 1 }] },
        res: { Gold: 10 },
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 0, buff: '' } }
    });
    var S = env.S;
    S.core.production.demand.put('adventures', 'wave1', {
        label: 'Run', type: 0, item: 'Rifleman', items: 8, basis: S.DemandBasis.Queue, priority: S.ProductionPriority.RunNow
    });
    assert.strictEqual(named(env.plan(), 'production.order').length, 0);
    var mine = env.mod.lastPass().rows.filter(function (r) { return r.owner === 'production'; })[0];
    assert.strictEqual(mine.status, S.DemandStatus.Short);
    assert.strictEqual(mine.reserved, true);
    var res = S.modules.production.model.reservations();
    assert.strictEqual(res.length, 1);
    assert.deepStrictEqual([res[0].name, res[0].reserved, res[0].free], ['Gold', 8, 2]);
});

t.test('an unseen order holds the building for 30 min and counts a miss', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 0, buff: '' } }
    });
    var q = named(env.plan(), 'production.order');
    env.handlers['production.order'](q[0].params);
    assert.strictEqual(env.world.orders[0].opts.grid, 11);
    finish(env, 'Failed', { unseen: true, reason: 'not seen' });
    assert.strictEqual(env.mod.orderHolds().Barracks, env.T + 1800000);
    assert.strictEqual(env.mod.orderBreaker.snapshot().run, 1);
    assert.strictEqual(env.mod.recent()[0].text, 'failed: not seen');
    assert.strictEqual(named(env.plan(), 'production.order').length, 0);
    env.T += 1800001;
    assert.strictEqual(named(env.plan(), 'production.order').length, 1);
});

t.test('a verified order clears the hold, marks the entry placed and notes it', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 0, buff: '' } }
    });
    env.mod.orderHolds().Barracks = 1;
    env.handlers['production.order']([0, 'Rifleman', 5, 25, 'Barracks']);
    env.world.attempts[0].def.baseline();
    finish(env, 'Verified');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(env.mod.orderHolds(), 'Barracks'), false);
    assert.strictEqual(env.mod.isPlaced(0, 'Rifleman'), true);
    assert.strictEqual(env.mod.recent()[0].text, 'Order verified: queued 0 -> 5');
    var row = env.S.modules.production.model.queues()[0];
    assert.strictEqual(row.source({ item: 'Rifleman' }), 'Standing order');
    assert.strictEqual(row.source({ item: 'Swordsman' }), 'Other');
});

t.test('five misses open the order breaker; nothing is queued until the probe', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 0, buff: '' } }
    });
    var br = env.mod.orderBreaker;
    for (var i = 0; i < br.MISSES; i++) br.miss();
    assert.strictEqual(br.isOpen(), true);
    assert.strictEqual(named(env.plan(), 'production.order').length, 0);
    env.T += br.COOLDOWN_MS;
    assert.strictEqual(named(env.plan(), 'production.order').length, 1);
    assert.strictEqual(named(env.plan(), 'production.order').length, 0);
});

t.test('mines and masons are never buffed or ordered here', function () {
    var env = setup({
        types: [{ type: 50, buildings: [{ name: 'IronMine', grid: 7, level: 1 }, { name: 'Mason', grid: 8, level: 1 }] }],
        costs: { Iron: [] },
        buildings: { IronMine: { item: 'Iron', amount: 5, stack: 0, buff: 'MineBuff' },
                     Mason: { item: 'Stone', amount: 5, stack: 0, buff: 'MineBuff' } }
    });
    env.world.entries[50] = [];
    assert.deepStrictEqual(plain(env.mod.queueNames()), {});
    assert.strictEqual(env.mod.ownedByMining('IronMine'), true);
    assert.strictEqual(env.mod.ownedByMining('Mason'), true);
    var q = env.plan();
    assert.strictEqual(q.length, 0);
    assert.strictEqual(env.S.modules.production.model.buildings().length, 0);
});

t.test('buffs only while the queue has entries', function () {
    var env = setup({
        types: [{ type: 30, buildings: [{ name: 'Workshop', grid: 30, level: 1 }] }],
        buildings: { Workshop: { item: '', amount: 0, stack: 0, buff: 'WorkBuff' } }
    });
    assert.strictEqual(named(env.plan(), 'production.buff').length, 0);
    env.world.entries[30] = [{ item: 'Sword', finished: false }];
    assert.strictEqual(named(env.plan(), 'production.buff').length, 1);
});

t.test('one producer: only the highest-level building is buffed and ordered into, never a lower one', function () {
    var two = [{ name: 'Barracks', grid: 5, level: 3 }, { name: 'Barracks', grid: 9, level: 5 }];
    var env = setup({
        types: [{ type: 0, buildings: two }],
        entries: { 0: [{ item: 'Rifleman', finished: false }] },
        costs: { Rifleman: [] },
        buildings: { Barracks: { item: 'Rifleman', amount: 3, stack: 0, buff: 'BarBuff' } }
    });
    var q = env.plan();
    assert.deepStrictEqual(named(q, 'production.buff').map(function (e) { return e.params[0]; }), [9]);
    env.handlers['production.order'](named(q, 'production.order')[0].params);
    assert.strictEqual(env.world.orders[0].opts.grid, 9);

    env.mod.buffEngine.holds()[9] = env.T + 1000;
    assert.strictEqual(named(env.plan(), 'production.buff').length, 0);
    delete env.mod.buffEngine.holds()[9];
    env.world.block[9] = 'already buffed';
    assert.strictEqual(named(env.plan(), 'production.buff').length, 0);

    // The handler re-checks the producer before it applies.
    env.world.block = {};
    env.handlers['production.buff']([5, 'Barracks', 'BarBuff']);
    assert.strictEqual(env.world.attempts.length, 1);   // only the order above
    assert.strictEqual(debugs(env, 'producer of Barracks changed').length, 1);
});

t.test('a configured buff on a building without a production queue is never buffed (debug once)', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        buildings: { Sawmill: { item: '', amount: 0, stack: 0, buff: 'SawBuff' } }
    });
    assert.strictEqual(named(env.plan(), 'production.buff').length, 0);
    env.plan();
    assert.strictEqual(debugs(env, 'Sawmill has no production queue').length, 1);
});

t.test('keep clamp: a Bookbinder amount of 5 puts a need of 1 item', function () {
    var env = setup({
        types: [{ type: 2, buildings: [{ name: 'Bookbinder', grid: 22, level: 1 }] }],
        costs: { Manuscript: [] },
        buildings: { Bookbinder: { item: 'Manuscript', amount: 5, stack: 0, buff: '' } }
    });
    env.plan();
    var needs = env.S.core.production.demand.list().filter(function (n) { return n.owner === 'production'; });
    assert.strictEqual(needs.length, 1);
    assert.strictEqual(needs[0].items, 1);
    assert.strictEqual(needs[0].basis, env.S.DemandBasis.Queue);
    assert.strictEqual(needs[0].priority, env.S.ProductionPriority.Standing);
});

t.test('Bookbinder: no completion while bookComplete is off', function () {
    var o = {
        types: [{ type: 2, buildings: [{ name: 'Bookbinder', grid: 22, level: 1 }] }],
        entries: { 2: [{ item: 'Manuscript', finished: true }] }
    };
    assert.strictEqual(named(setup(o).plan(), 'production.complete').length, 0);
    o.extra = { bookComplete: true };
    var env = setup(o);
    assert.strictEqual(named(env.plan(), 'production.complete').length, 1);
    env.handlers['production.complete']([2]);
    finish(env, 'Failed', { reason: 'check timed out', unseen: true });
    assert.strictEqual(env.mod.completeHolds()[2], env.T + 1800000);
    assert.strictEqual(named(env.plan(), 'production.complete').length, 0);
    var b = env.S.modules.production.model.books();
    assert.strictEqual(b.grid, 22);
    assert.strictEqual(b.finished, true);
});

t.test('switching off cancels the module queue work and drops its demand', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 0, buff: '' } }
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

t.test('model status counts the last pass, the queues and the breakers', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }, { type: 30, buildings: [{ name: 'Workshop', grid: 30, level: 1 }] }],
        entries: { 30: [{ item: 'Sword', finished: false, remainingMs: 60000 }] },
        queued: { '0|Rifleman': 5 },
        costs: { Rifleman: [] },
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 0, buff: '' } }
    });
    env.plan();
    var st = env.S.modules.production.model.status();
    assert.strictEqual(st.enabled, true);
    assert.strictEqual(st.types, 2);
    assert.strictEqual(st.queues, 1);
    assert.strictEqual(st.entries, 1);
    assert.strictEqual(typeof st.nextDoneAt, 'number');
    assert.strictEqual(st.standing, 1);
    assert.strictEqual(st.covered, 1);
    assert.strictEqual(st.shortfall, 0);
    assert.strictEqual(st.orderBreaker.open, false);
    assert.strictEqual(st.buffBreaker.open, false);
});

function bookbinder() {
    return { types: [{ type: 2, buildings: [{ name: 'Bookbinder', grid: 22, level: 1 }] }],
             entries: { 2: [{ item: 'Manuscript', finished: true }] },
             extra: { bookComplete: true } };
}

t.test('completeNow failure holds the queue', function () {
    var env = setup(bookbinder());
    assert.strictEqual(env.mod.completeNow(2, ''), true);
    finish(env, 'Failed', { reason: 'check timed out' });
    assert.strictEqual(env.mod.completeHolds()[2], env.T + 1800000);
    assert.strictEqual(named(env.plan(), 'production.complete').length, 0);
    var n = env.mod.recent()[0];
    assert.deepStrictEqual([n.kind, n.name, n.status, n.text],
        [env.S.ProductionNote.Complete, 'queue 2', env.S.ActionResult.Failed, 'failed: check timed out']);
});

t.test('a completeNow that does not start notes failed: could not start', function () {
    var env = setup(bookbinder());
    env.S.core.actions.attempt = function () { return false; };
    assert.strictEqual(env.mod.completeNow(2, 'Manuscript'), false);
    var n = env.mod.recent()[0];
    assert.strictEqual(n.text, 'failed: could not start');
    assert.strictEqual(n.status, env.S.ActionResult.Failed);
    assert.strictEqual(n.item, 'Manuscript');
});

t.test('order notes carry status, detail and unseen; texts are unchanged', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 0, buff: '' } }
    });
    var S = env.S;
    env.handlers['production.order']([0, 'Rifleman', 5, 25, 'Barracks']);
    env.world.attempts[0].def.baseline();
    finish(env, 'Verified');
    var n = env.mod.recent()[0];
    assert.deepStrictEqual([n.kind, n.status, n.detail, n.text, n.unseen],
        [S.ProductionNote.Order, S.ActionResult.Verified, 'queued 0 -> 5', 'Order verified: queued 0 -> 5', false]);
    env.handlers['production.order']([0, 'Rifleman', 5, 25, 'Barracks']);
    finish(env, 'Failed', { unseen: true, reason: 'not seen' });
    n = env.mod.recent()[0];
    assert.deepStrictEqual([n.status, n.unseen, n.detail, n.text],
        [S.ActionResult.Failed, true, '', 'failed: not seen']);
    assert.strictEqual(env.mod.resultText({ status: S.ActionResult.Refused, reason: 'busy' }, 'ok'), 'refused: busy');
    assert.strictEqual(env.mod.resultText(null, 'ok'), 'failed: could not start');
});

t.test('defaultStack: 25 for a stackable type, 1 otherwise; stackFor prefers the configured stack', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 7, buff: '' } }
    });
    assert.strictEqual(env.mod.defaultStack(0), 25);
    assert.strictEqual(env.mod.defaultStack(2), 1);
    assert.strictEqual(env.mod.stackFor('Barracks', 0), 7);
    assert.strictEqual(env.mod.stackFor('Other', 0), 25);
});

t.test('a buff verdict of the shared engine is read through S.BuffVerdict', function () {
    var env = setup({
        types: [{ type: 30, buildings: [{ name: 'Workshop', grid: 30, level: 1 }] }],
        entries: { 30: [{ item: 'Sword', finished: false }] },
        buildings: { Workshop: { item: '', amount: 0, stack: 0, buff: 'WorkBuff' } }
    });
    var S = env.S;
    var verdict = S.BuffVerdict.Ok;
    env.mod.buffEngine.eligible = function () { return verdict; };
    assert.strictEqual(named(env.plan(), 'production.buff').length, 1);
    verdict = S.BuffVerdict.Skip;
    assert.strictEqual(named(env.plan(), 'production.buff').length, 0);
    verdict = S.BuffVerdict.Stop;
    assert.strictEqual(named(env.plan(), 'production.buff').length, 0);
});

t.test('a Skip entry carries the Skip kind and the held-by detail', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 0, buff: '' } }
    });
    var S = env.S;
    S.core.production.demand.provide('adventures', function () {
        return { needs: [], holds: [{ key: 'troops', label: 'Adventure: wave 2/4 (troops)', kind: S.ProductionKind.Units }] };
    });
    env.plan();
    var n = env.mod.recent()[0];
    assert.deepStrictEqual([n.kind, n.status, n.detail, n.text],
        [S.ProductionNote.Skip, null, 'held by Adventure: wave 2/4 (troops)', 'held by Adventure: wave 2/4 (troops)']);
    var row = env.mod.lastPass().rows[0];
    assert.strictEqual(env.mod.holdLabel(row), 'Adventure: wave 2/4 (troops)');
    assert.strictEqual(env.mod.holdLabel({ status: S.DemandStatus.Covered, owner: 'production', key: 'Barracks' }), null);
});

t.test('a held order takes no ordersPerPass slot', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }, { type: 1, buildings: [{ name: 'ProvisionHouse', grid: 13, level: 1 }] }],
        costs: { Rifleman: [], Fish: [] },
        buildings: { Barracks: { item: 'Rifleman', amount: 1, stack: 0, buff: '' },
                     ProvisionHouse: { item: 'Fish', amount: 1, stack: 0, buff: '' } },
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
    assert.strictEqual(env.mod.holdLabel(held), 'an unseen order');
    var skip = env.mod.recent().filter(function (e) { return e.kind === S.ProductionNote.Skip; })[0];
    assert.strictEqual(skip.text, 'held by an unseen order');
    env.T += 1800001;
    q = named(env.plan(), 'production.order');
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].params[4], 'Barracks');
});

t.test('standing off at Save drops the needs, cancels nothing', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS }],
        costs: { Rifleman: [] },
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 0, buff: '' } }
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

t.test('a queued action skips when its switch is off; completeNow is not gated', function () {
    var env = setup({
        types: [{ type: 0, buildings: BARRACKS },
                { type: 2, buildings: [{ name: 'Bookbinder', grid: 22, level: 1 }] }],
        costs: { Rifleman: [] },
        buildings: { Barracks: { item: 'Rifleman', amount: 5, stack: 0, buff: 'BarBuff' } },
        extra: { standing: false, buffs: false, bookComplete: false }
    });
    var attempts = 0;
    env.S.core.actions.attempt = function () { attempts++; return true; };
    env.mod.buffEngine.apply = function () { attempts++; };
    env.handlers['production.order']([0, 'Rifleman', 5, 25, 'Barracks']);
    env.handlers['production.buff']([11, 'Barracks', 'BarBuff']);
    env.handlers['production.complete']([2]);
    assert.strictEqual(attempts, 0);
    assert.strictEqual(debugs(env, 'standing orders are off').length, 1);
    assert.strictEqual(debugs(env, 'buffs are off').length, 1);
    assert.strictEqual(debugs(env, 'book completion is off').length, 1);
    var s = env.H.settings.read('production');
    s.enabled = false;
    env.H.settings.write('production', s);
    assert.strictEqual(env.mod.completeNow(2, ''), true);
    assert.strictEqual(attempts, 1);
});

// A full bundle on the counting host stub: the real core readers, so a plan
// pass shows how many host reads it costs.
var PS = require('../stubs/production');

function countingSetup() {
    var w = PS.world({
        enumNames: { 1: 'provisionhouse', 2: 'bookbinder', 11: 'winery' },
        buffs: PS.buffDefs(4, ['3', '11']),
        queues: {
            1:  [{ type: 'BB_0', amount: 1, produced: 0, timeMs: 1000, collectedMs: 0, bonus: 1, producedItems: 0 }],
            2:  [{ type: 'Manuscript', amount: 1, produced: 1, timeMs: 1000, collectedMs: 1000, bonus: 1, producedItems: 1 }],
            11: [{ type: 'BB_1', amount: 1, produced: 0, timeMs: 1000, collectedMs: 0, bonus: 1, producedItems: 0 }]
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
        standing: true, buffs: true, bookComplete: true,
        buildings: {
            ProvisionHouse: { item: 'BB_0', amount: 2, stack: 0, buff: 'BB_2' },
            Winery:         { item: 'BB_1', amount: 2, stack: 0, buff: 'BB_3' }
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
    var names = b.H.queued().map(function (e) { return e.name; });
    // The pass did real work: the book completion and both buffs were queued.
    assert.ok(names.indexOf('production.complete') !== -1, names.join(','));
    assert.strictEqual(names.filter(function (n) { return n === 'production.buff'; }).length, 2, names.join(','));
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

t.test('plan() and assess() run in a read pass that is closed afterwards, also when a phase throws', function () {
    var b = countingSetup();
    var HR = b.S.kernel.hostRead;
    var seen = [];
    var dropOwner = b.S.core.production.demand.dropOwner;
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

    b.S.core.production.demand.dropOwner = dropOwner;
    var inAssess = null;
    var list = b.S.core.production.demand.list;
    b.S.core.production.demand.list = function () { inAssess = HR.inPass(); return list.apply(this, arguments); };
    b.S.modules.production.assess();
    assert.strictEqual(inAssess, true);
    assert.strictEqual(HR.inPass(), false);

    b.S.core.production.demand.list = function () { throw new Error('boom'); };
    assert.throws(function () { b.S.modules.production.assess(); });
    assert.strictEqual(HR.inPass(), false);
});
