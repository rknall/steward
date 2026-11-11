'use strict';

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

// Basis values come from the enum, booted once for the whole file.
var BASIS = harness.boot({ sections: ['kernel'] }).Steward.DemandBasis;
var K_Q = BASIS.Queue;
var K_S = BASIS.Stock;

// The planner builds its results inside the vm context, so compare plain copies.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

// The planner is pure over its read argument, so every case runs on a fake
// world: profiles per type, queued runs, yields and stock per item, entry
// counts per queue and per-run costs priced against a resource pool.
function setup() {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var S = H.Steward;
    var K = S.ProductionKind;
    var world = {
        profiles: {
            0:  { kind: K.Units, orderable: true, perOrderMax: null, maxEntries: null, stackable: true },
            1:  { kind: K.Buffs, orderable: true, perOrderMax: null, maxEntries: null, stackable: true },
            2:  { kind: K.Books, orderable: true, perOrderMax: 1, maxEntries: 1, stackable: false },
            20: { kind: K.Timed, orderable: true, perOrderMax: null, maxEntries: 1, stackable: false },
            30: { kind: K.Cooldown, orderable: false, perOrderMax: null, maxEntries: 0, stackable: false }
        },
        queued: {},
        yields: { Rifleman: 1, BB_Plank: 3, Manuscript: 1, Oil: 5 },
        stock: { BB_Plank: 0, Manuscript: 0, Oil: 0 },
        entries: { 0: 0, 1: 0, 2: 0, 20: 0 },
        costs: {
            Rifleman: { Gold: 10 },
            BB_Plank: { Gold: 5 },
            Manuscript: { Gold: 100 },
            Oil: { Gold: 4 }
        },
        pool: { Gold: 1000 },
        held: {}
    };
    var read = {
        profile: function (type) { return world.profiles[type] || null; },
        queuedIn: function (type, item) {
            return world.queued.hasOwnProperty(item) ? world.queued[item] : 0;
        },
        yieldIn: function (type, item) {
            return world.yields.hasOwnProperty(item) ? world.yields[item] : null;
        },
        stockOf: function (type, item) {
            return world.stock.hasOwnProperty(item) ? world.stock[item] : null;
        },
        entryCount: function (type) {
            return world.entries.hasOwnProperty(type) ? world.entries[type] : null;
        },
        jointShortfalls: function (orders) {
            var need = {};
            var names = [];
            for (var i = 0; i < orders.length; i++) {
                var c = world.costs[orders[i].unit];
                if (!c) return null;
                for (var res in c) {
                    if (!need.hasOwnProperty(res)) { need[res] = 0; names.push(res); }
                    need[res] += c[res] * orders[i].count;
                }
            }
            var out = [];
            for (var j = 0; j < names.length; j++) {
                var have = world.pool[names[j]] || 0;
                if (have < need[names[j]]) out.push({ name: names[j], need: need[names[j]], have: have });
            }
            return out;
        }
    };
    function plan(needs, opts) {
        opts = opts || {};
        if (!opts.read) opts.read = read;
        if (!opts.hasOwnProperty('actFor')) opts.actFor = 'production';
        if (!opts.isHeld) {
            opts.isHeld = function (kind, item) { return world.held[item] || world.held[kind] || null; };
        }
        return S.core.production.plan(needs, opts);
    }
    return { S: S, D: S.DemandStatus, P: S.ProductionPriority, world: world, read: read, plan: plan };
}

function need(owner, key, type, item, items, basis, priority) {
    return { owner: owner, key: key, label: key, type: type, item: item, items: items, basis: basis, priority: priority || 4 };
}

t.test('plan: queue basis is covered by queued items, a shortfall orders the missing runs', function () {
    var T = setup();
    T.world.queued.Rifleman = 10;
    var res = T.plan([need('production', 'a', 0, 'Rifleman', 10, K_Q)]);
    assert.equal(res.rows[0].status, T.D.Covered);
    assert.equal(res.rows[0].queued, 10);
    assert.equal(res.orders.length, 0);

    T.world.queued.Rifleman = 4;
    res = T.plan([need('production', 'a', 0, 'Rifleman', 10, K_Q)]);
    assert.equal(res.rows[0].status, T.D.Order);
    assert.equal(res.rows[0].runs, 6);
    assert.deepEqual(plain(res.orders), [{ owner: 'production', key: 'a', type: 0, item: 'Rifleman', runs: 6 }]);
});

t.test('plan: stock basis is covered by stock and waiting when the queue makes up the rest', function () {
    var T = setup();
    T.world.stock.BB_Plank = 9;
    var res = T.plan([need('production', 'b', 1, 'BB_Plank', 9, K_S)]);
    assert.equal(res.rows[0].status, T.D.Covered);
    assert.equal(res.rows[0].stock, 9);

    T.world.stock.BB_Plank = 4;
    T.world.queued.BB_Plank = 2;
    res = T.plan([need('production', 'b', 1, 'BB_Plank', 9, K_S)]);
    assert.equal(res.rows[0].status, T.D.Waiting);
    assert.equal(res.rows[0].queued, 6);
    assert.equal(res.orders.length, 0);
});

t.test('plan: queue basis is waiting for another owner that orders it itself', function () {
    var T = setup();
    var res = T.plan([need('adventures', 'run', 0, 'Rifleman', 5, K_Q, 1)]);
    assert.equal(res.rows[0].status, T.D.Waiting);
    assert.equal(res.rows[0].runs, 5);
    assert.equal(res.orders.length, 0);
});

t.test('plan: missing items become whole runs rounded up by the yield', function () {
    var T = setup();
    T.world.stock.BB_Plank = 2;
    var res = T.plan([need('production', 'b', 1, 'BB_Plank', 10, K_S)]);
    assert.equal(res.rows[0].status, T.D.Order);
    assert.equal(res.rows[0].runs, 3);   // ceil(8 / 3)

    res = T.plan([need('production', 'b', 1, 'BB_Plank', 10, K_Q)]);
    assert.equal(res.rows[0].runs, 4);   // ceil(10 / 3), stock ignored
});

t.test('plan: a Standing order short only because of a RunNow reservation is marked reserved', function () {
    var T = setup();
    T.world.pool.Gold = 82;
    var res = T.plan([
        need('adventures', 'run', 0, 'Rifleman', 8, K_Q, T.P.RunNow),
        need('production', 'oil', 20, 'Oil', 5, K_Q, T.P.Standing)
    ]);
    assert.equal(res.rows[0].status, T.D.Waiting);
    assert.equal(res.rows[1].status, T.D.Short);
    assert.equal(res.rows[1].reserved, true);
    assert.deepEqual(res.rows[1].shortfall, { name: 'Gold', need: 84, have: 82 });
    assert.equal(res.orders.length, 0);
});

t.test('plan: a short owner still reserves, and a plain shortfall is not marked reserved', function () {
    var T = setup();
    T.world.pool.Gold = 50;
    var res = T.plan([
        need('adventures', 'run', 0, 'Rifleman', 8, K_Q, T.P.RunNow),
        need('production', 'oil', 20, 'Oil', 5, K_Q)
    ]);
    assert.equal(res.rows[0].status, T.D.Short);
    assert.equal(res.rows[0].reserved, false);
    assert.equal(res.rows[1].status, T.D.Short);
    assert.equal(res.rows[1].reserved, true);

    T.world.pool.Gold = 3;
    res = T.plan([need('production', 'oil', 20, 'Oil', 5, K_Q)]);
    assert.equal(res.rows[0].status, T.D.Short);
    assert.equal(res.rows[0].reserved, false);
});

t.test('plan: an order reserves for the lower needs priced after it', function () {
    var T = setup();
    T.world.pool.Gold = 52;
    var res = T.plan([
        need('production', 'r', 0, 'Rifleman', 5, K_Q, T.P.Quest),
        need('production', 'oil', 20, 'Oil', 5, K_Q)
    ]);
    assert.equal(res.rows[0].status, T.D.Order);
    assert.equal(res.rows[1].status, T.D.Short);
    assert.equal(res.rows[1].reserved, true);
    assert.equal(res.orders.length, 1);
});

t.test('plan: a held item or kind is Held and reserves nothing', function () {
    var T = setup();
    T.world.pool.Gold = 50;
    T.world.held.Rifleman = { label: 'run' };
    var res = T.plan([
        need('production', 'r', 0, 'Rifleman', 5, K_Q),
        need('production', 'oil', 20, 'Oil', 5, K_Q)
    ]);
    assert.equal(res.rows[0].status, T.D.Held);
    assert.equal(res.rows[1].status, T.D.Order);

    T.world.held = {};
    T.world.held[T.S.ProductionKind.Units] = { label: 'run' };
    res = T.plan([need('production', 'r', 0, 'Rifleman', 5, K_Q)]);
    assert.equal(res.rows[0].status, T.D.Held);
});

t.test('plan: the default isHeld asks the demand ledger, excepting actFor', function () {
    var T = setup();
    var calls = [];
    T.S.core.production.demand = {
        isHeld: function (kind, item, exceptOwner) {
            calls.push([kind, item, exceptOwner]);
            return { label: 'run' };
        }
    };
    var res = T.S.core.production.plan([need('production', 'r', 0, 'Rifleman', 5, K_Q)],
        { actFor: 'production', read: T.read });
    assert.equal(res.rows[0].status, T.D.Held);
    assert.deepEqual(calls, [[T.S.ProductionKind.Units, 'Rifleman', 'production']]);
});

t.test('plan: a queue at its entry limit is QueueFull, an unreadable count is Unreadable', function () {
    var T = setup();
    T.world.entries[20] = 1;
    var res = T.plan([need('production', 'oil', 20, 'Oil', 5, K_Q)]);
    assert.equal(res.rows[0].status, T.D.QueueFull);
    assert.equal(res.orders.length, 0);

    T.world.entries[20] = null;
    res = T.plan([need('production', 'oil', 20, 'Oil', 5, K_Q)]);
    assert.equal(res.rows[0].status, T.D.Unreadable);

    // Units have no entry limit: a long queue still orders.
    T.world.entries[0] = 50;
    res = T.plan([need('production', 'r', 0, 'Rifleman', 5, K_Q)]);
    assert.equal(res.rows[0].status, T.D.Order);
});

t.test('plan: single-shape kinds clamp the runs to stackOf, books to one run', function () {
    var T = setup();
    T.world.pool.Gold = 100000;
    var res = T.plan([need('production', 'oil', 20, 'Oil', 500, K_Q)]);
    assert.equal(res.rows[0].runs, 25);   // default stack bound
    assert.equal(res.orders[0].runs, 25);

    res = T.plan([need('production', 'oil', 20, 'Oil', 500, K_Q)],
        { stackOf: function () { return 7; } });
    assert.equal(res.orders[0].runs, 7);

    res = T.plan([need('production', 'book', 2, 'Manuscript', 3, K_S)]);
    assert.equal(res.orders[0].runs, 1);

    // Stackable kinds are not clamped.
    res = T.plan([need('production', 'r', 0, 'Rifleman', 60, K_Q)]);
    assert.equal(res.orders[0].runs, 60);
});

t.test('plan: orders past maxOrders are Deferred and reserve nothing', function () {
    var T = setup();
    var res = T.plan([
        need('production', 'r', 0, 'Rifleman', 5, K_Q),
        need('production', 'p', 1, 'BB_Plank', 3, K_Q),
        need('production', 'oil', 20, 'Oil', 5, K_Q)
    ], { maxOrders: 1 });
    assert.equal(res.rows[0].status, T.D.Order);
    assert.equal(res.rows[1].status, T.D.Deferred);
    assert.equal(res.rows[2].status, T.D.Deferred);
    assert.equal(res.orders.length, 1);
});

t.test('plan: a null read makes the row Unreadable, never Covered', function () {
    var T = setup();
    var res = T.plan([need('production', 'x', 0, 'Nobody', 5, K_Q)]);   // no yield
    assert.equal(res.rows[0].status, T.D.Unreadable);

    T.read.queuedIn = function () { return null; };
    res = T.plan([need('production', 'r', 0, 'Rifleman', 5, K_Q)]);
    assert.equal(res.rows[0].status, T.D.Unreadable);

    var T2 = setup();
    // Units have no stock reading: fine for the queue basis, not for stock.
    res = T2.plan([need('production', 'r', 0, 'Rifleman', 5, K_S)]);
    assert.equal(res.rows[0].status, T2.D.Unreadable);

    res = T2.plan([need('production', 'z', 99, 'Rifleman', 5, K_Q)]);   // no profile
    assert.equal(res.rows[0].status, T2.D.Unreadable);

    T2.read.jointShortfalls = function () { return null; };
    res = T2.plan([need('production', 'r', 0, 'Rifleman', 5, K_Q)]);
    assert.equal(res.rows[0].status, T2.D.Unreadable);
    assert.equal(res.orders.length, 0);
});

t.test('plan: an unpriceable other-owner need is Unreadable and does not poison later rows', function () {
    var T = setup();
    T.world.yields.Ghost = 1;
    var res = T.plan([
        need('adventures', 'run', 0, 'Ghost', 5, K_Q, T.P.RunNow),
        need('production', 'r', 0, 'Rifleman', 5, K_Q)
    ]);
    assert.equal(res.rows[0].status, T.D.Unreadable);
    assert.equal(res.rows[1].status, T.D.Order);
});

t.test('plan: a culture building profile is NotOrderable', function () {
    var T = setup();
    var res = T.plan([need('production', 'c', 30, 'Culture', 1, K_Q)]);
    assert.equal(res.rows[0].status, T.D.NotOrderable);
    assert.equal(res.orders.length, 0);
});

t.test('plan: other owners never produce orders and rows keep the needs order', function () {
    var T = setup();
    var res = T.plan([
        need('adventures', 'run', 0, 'Rifleman', 5, K_Q, T.P.RunNow),
        need('quests', 'q', 1, 'BB_Plank', 6, K_S, T.P.Quest),
        need('production', 'oil', 20, 'Oil', 5, K_Q)
    ]);
    assert.deepEqual(plain(res.rows.map(function (r) { return r.owner; })), ['adventures', 'quests', 'production']);
    assert.equal(res.rows[0].status, T.D.Waiting);
    assert.equal(res.rows[1].status, T.D.Waiting);
    assert.deepEqual(plain(res.orders.map(function (o) { return o.owner; })), ['production']);
    assert.equal(res.rows[2].priority, 4);
    assert.equal(res.rows[2].need, 5);
    assert.equal(res.rows[2].label, 'oil');
});

t.test('plan: an unreadable buff stock is Unreadable and flagged unknown, never ordered', function () {
    var T = setup();
    delete T.world.stock.BB_Plank;
    var res = T.plan([need('production', 'b', 1, 'BB_Plank', 9, K_S)]);
    assert.equal(res.rows[0].status, T.D.Unreadable);
    assert.strictEqual(res.rows[0].stockUnknown, true);
    assert.equal(res.orders.length, 0);
});

t.test('plan: a stock of 0 is known and orders', function () {
    var T = setup();
    T.world.stock.BB_Plank = 0;
    var res = T.plan([need('production', 'b', 1, 'BB_Plank', 9, K_S)]);
    assert.strictEqual(res.rows[0].stockUnknown, false);
    assert.equal(res.rows[0].status, T.D.Order);
    assert.equal(res.orders.length, 1);
});

t.test('plan: units are never flagged as unknown stock', function () {
    var T = setup();
    var res = T.plan([need('production', 'a', 0, 'Rifleman', 5, K_Q)]);
    assert.strictEqual(res.rows[0].stock, null);
    assert.strictEqual(res.rows[0].stockUnknown, false);
});

t.test('plan: a queue-basis buff need with a null stock plans from the queue alone', function () {
    var T = setup();
    delete T.world.stock.BB_Plank;
    T.world.queued.BB_Plank = 2;
    var res = T.plan([need('production', 'b', 1, 'BB_Plank', 9, K_Q)]);
    assert.strictEqual(res.rows[0].stockUnknown, true);
    assert.equal(res.rows[0].queued, 6);
    assert.equal(res.rows[0].status, T.D.Order);
    assert.equal(res.rows[0].runs, 1);
});
