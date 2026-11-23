'use strict';

// Economy read models: the grid rows and their states, the grouping by
// storehouse tab, the status counts and their reuse, and null-safety
// (src/modules/economy/model.js).

var t = require('../runner');
var EC = require('../stubs/economy');

var assert = t.assert;
var plain = EC.plain;

function star(resource, amount, uid) {
    return { resource: resource, amount: amount, uid: uid };
}

function model(w) { return w.S.modules.economy.model; }

function byName(rows) {
    var out = {};
    rows.forEach(function (r) { out[r.name] = r; });
    return out;
}

function stateMap(w) {
    var out = {};
    model(w).items().forEach(function (r) { out[r.name] = r.state; });
    return out;
}

// ---- items: rows and states ------------------------------------------------------

t.test('a row carries the star, store, room, next send, full mark and ledger state', function () {
    var w = EC.world({
        star: [star('Wood', 100, 'w1'), star('Wood', 50, 'w2')],
        store: { Wood: 400 },
        capacity: 1000,
        groups: { Wood: 'CL1' },
        items: { Wood: true }
    });
    var r = plain(model(w).items()[0]);
    assert.deepStrictEqual(r, {
        name: 'Wood', label: 'Wood', tab: 'WarehouseTab1', selected: true, live: true,
        star: 150, entries: 2, store: 400, room: 600, next: 100, fits: 100,
        full: null, pending: null, state: 'ready'
    });
});

t.test('every row state, one item each', function () {
    var w = EC.world({
        star: [
            star('Brick', 10, 'b1'), star('Coal', 10, 'c1'), star('Dust', 10, 'd1'),
            star('Egg', 10, 'e1'), star('Iron', 10, 'i1'), star('Plank', 10, 'p1'),
            star('Stone', 10, 's1'), star('Wood', 10, 'w1')
        ],
        store: { Brick: 0, Coal: 1000, Dust: 0, Egg: 0, Iron: 0, Plank: 0, Wood: 0, Gold: 0 },
        bounce: { Dust: { after: 7000 } },
        events: { Egg: 'Easter' },
        items: { Brick: true, Coal: true, Dust: true, Egg: true, Gold: true, Iron: true, Stone: true, Wood: true }
    });
    w.fire('Dust');                                   // bounced: item full
    w.env.apply = false;
    w.fire('Iron');                                   // unseen: pending
    // Stone: its store stock does not read.
    assert.deepStrictEqual(stateMap(w), {
        Brick: 'ready', Coal: 'warehouse', Dust: 'full', Egg: 'offline', Gold: 'none',
        Iron: 'pending', Plank: 'idle', Stone: 'unknown', Wood: 'ready'
    });
});

t.test('a stale send reads stale, an unread ledger unknown', function () {
    var w = EC.world({ star: [star('Wood', 10, 'w1')], store: { Wood: 0 }, items: { Wood: true } });
    w.env.apply = false;
    w.fire('Wood');
    // Past the expire time with no proof either way: the star menu does not read.
    var player = w.H.host.game.gi.mCurrentPlayer;
    var menu = player.getAvailableBuffs_vector;
    player.getAvailableBuffs_vector = function () { throw new Error('gone'); };
    w.env.now += 22000000;
    w.S.core.ledger.reread('store|home|Wood', w.S.core.buffs.toStore('Wood'));
    player.getAvailableBuffs_vector = menu;
    assert.strictEqual(w.S.core.ledger.blocked('store|home|Wood'), 'stale');
    assert.strictEqual(stateMap(w).Wood, 'stale');
    w.S.core.ledger.blocked = function () { return 'unread'; };
    assert.strictEqual(stateMap(w).Wood, 'unknown');
});

t.test('state precedence: unknown over offline over pending over full', function () {
    var w = EC.world({
        star: [star('Egg', 10, 'e1'), star('Dust', 10, 'd1')],
        store: { Egg: 0, Dust: 0 },
        bounce: { Dust: { after: 7000 } },
        events: { Egg: 'Easter' },
        items: { Egg: true, Dust: true }
    });
    w.fire('Dust');
    assert.deepStrictEqual(stateMap(w), { Dust: 'full', Egg: 'offline' });
    // A pending send of a full item reads pending.
    var blocked = w.S.core.ledger.blocked;
    w.S.core.ledger.blocked = function (k) { return k === 'store|home|Dust' ? 'unseen' : blocked(k); };
    assert.strictEqual(stateMap(w).Dust, 'pending');
    // An offline item with a pending send reads offline.
    w.S.core.ledger.blocked = function () { return 'sent'; };
    assert.strictEqual(stateMap(w).Egg, 'offline');
    // A failed read wins over offline.
    delete w.env.store.Egg;
    w.S.core.ledger.blocked = blocked;
    w.env.capacity = null;
    assert.strictEqual(stateMap(w).Egg, 'unknown');
});

t.test('selected names outside the star menu are kept; Population is never a row', function () {
    var w = EC.world({
        star: [star('Wood', 10, 'w1'), star('Population', 500, 'p1')],
        store: { Wood: 0, Gold: 5 },
        items: { Gold: true, Population: true, Coal: false }
    });
    var rows = byName(plain(model(w).items()));
    assert.deepStrictEqual(Object.keys(rows).sort(), ['Gold', 'Wood']);
    assert.strictEqual(rows.Gold.selected, true);
    assert.strictEqual(rows.Gold.star, 0);
    assert.strictEqual(rows.Gold.state, 'none');
    assert.strictEqual(rows.Wood.selected, false);
    assert.strictEqual(rows.Wood.state, 'idle');
});

t.test('items is null when the star menu does not read and nothing is selected', function () {
    var w = EC.world({ star: [star('Wood', 10, 'w1')], store: { Wood: 0 } });
    w.H.host.game.gi.mCurrentPlayer.getAvailableBuffs_vector = function () { throw new Error('gone'); };
    assert.strictEqual(model(w).items(), null);
    assert.strictEqual(model(w).grid(), null);
    w.S.kernel.settings.write('economy', { items: { Wood: true } });
    var rows = plain(model(w).items());
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].star, null);
    assert.strictEqual(rows[0].state, 'unknown');
});

// ---- grid ----------------------------------------------------------------------------

t.test('the grid groups rows in tab order, rows by label, other last, empty tabs left out', function () {
    var w = EC.world({
        star: [
            star('Wood', 10, 'w1'), star('Brick', 10, 'b1'), star('Egg', 10, 'e1'),
            star('Sword', 10, 's1'), star('Relic', 10, 'r1'), star('Barrel', 10, 'a1')
        ],
        store: {},
        groups: { Wood: 'CL1', Brick: 'CL1', Egg: 'Event', Sword: 'CL5', Relic: 'DEF_MODE', Barrel: '' }
    });
    var g = plain(model(w).grid());
    assert.deepStrictEqual(g.tabs.map(function (tab) { return tab.key; }),
        ['WarehouseTab1', 'WarehouseTab8', 'WarehouseTab6', 'WarehouseTab7']);
    assert.deepStrictEqual(g.tabs.map(function (tab) { return tab.label; }),
        ['WarehouseTab1', 'WarehouseTab8', 'WarehouseTab6', 'WarehouseTab7']);
    assert.deepStrictEqual(g.tabs[0].rows.map(function (r) { return r.name; }), ['Brick', 'Wood']);
    assert.deepStrictEqual(g.other.map(function (r) { return r.name; }), ['Relic']);
    assert.strictEqual(g.readAt, EC.T0);
});

// ---- status --------------------------------------------------------------------------

t.test('status counts the selected rows by state and carries pass, moved, breaker and stale', function () {
    var w = EC.world({
        star: [
            star('Brick', 10, 'b1'), star('Coal', 10, 'c1'), star('Dust', 10, 'd1'),
            star('Egg', 10, 'e1'), star('Plank', 10, 'p1'), star('Stone', 10, 's1'),
            star('Wood', 10, 'w1'), star('Wood', 10, 'w2')
        ],
        store: { Brick: 0, Coal: 1000, Dust: 0, Egg: 0, Plank: 0, Wood: 0 },
        bounce: { Dust: { after: 7000 } },
        events: { Egg: 'Easter' },
        items: { Brick: true, Coal: true, Dust: true, Egg: true, Stone: true, Wood: true }
    });
    w.fire('Dust');
    w.fire('Wood');
    w.plan();
    var st = plain(model(w).status());
    assert.strictEqual(st.enabled, true);
    assert.strictEqual(st.selected, 6);
    assert.strictEqual(st.ready, 2);
    assert.strictEqual(st.full, 1);
    assert.strictEqual(st.warehouse, 1);
    assert.strictEqual(st.offline, 1);
    assert.strictEqual(st.unknown, 1);
    assert.strictEqual(st.pending, 0);
    assert.deepStrictEqual(st.lastPass.names, ['Brick', 'Wood']);
    assert.strictEqual(st.lastMoved.name, 'Wood');
    assert.deepStrictEqual(st.breaker, { open: false, run: 0, nextProbeAt: 0 });
    assert.deepStrictEqual(st.stale, []);
    assert.strictEqual(st.readAt, w.env.now);
});

t.test('status reuses a fresh host part and snapshot gives one object per read pass', function () {
    var w = EC.world({ star: [star('Wood', 10, 'w1')], store: { Wood: 0 }, items: { Wood: true } });
    var M = model(w);
    assert.strictEqual(M.status(30000).ready, 1);
    w.env.store.Wood = 1000;
    assert.strictEqual(M.status(30000).ready, 1);
    assert.strictEqual(M.status().warehouse, 1);
    w.env.store.Wood = 0;
    assert.strictEqual(M.snapshot().warehouse, 1);
    w.env.now += 31000;
    assert.strictEqual(M.snapshot().ready, 1);
    w.S.kernel.hostRead.pass(function () {
        assert.strictEqual(M.snapshot(), M.snapshot());
    });
    assert.strictEqual(M.SNAPSHOT_MAX_AGE_MS, 30000);
});

t.test('emptyStatus has the status shape with nothing read', function () {
    var w = EC.world({});
    var e = plain(model(w).emptyStatus());
    var s = plain(model(w).status());
    assert.deepStrictEqual(Object.keys(e).sort(), Object.keys(s).sort());
    assert.strictEqual(e.enabled, false);
    assert.strictEqual(e.selected, 0);
    assert.strictEqual(e.readAt, null);
});

t.test('every function returns with every read null', function () {
    var w = EC.world({ items: { Wood: true } });
    var S = w.S;
    S.core.buffs.storeNext = function () { throw new Error('x'); };
    S.core.buffs.storeFull = function () { throw new Error('x'); };
    S.core.buffs.starResources = function () { return null; };
    S.core.events.resourceLive = function () { throw new Error('x'); };
    S.core.resources.tabOf = function () { throw new Error('x'); };
    S.core.resources.tabs = function () { throw new Error('x'); };
    S.core.locale.res = function () { throw new Error('x'); };
    S.core.ledger.blocked = function () { throw new Error('x'); };
    S.core.ledger.snapshot = function () { throw new Error('x'); };
    S.core.ledger.breaker = function () { return null; };
    var M = model(w);
    var rows = plain(M.items());
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].label, 'Wood');
    assert.strictEqual(rows[0].tab, null);
    assert.strictEqual(rows[0].state, 'unknown');
    var g = plain(M.grid());
    assert.deepStrictEqual(g.tabs, []);
    assert.strictEqual(g.other.length, 1);
    var st = plain(M.status());
    assert.strictEqual(st.selected, 1);
    assert.strictEqual(st.unknown, 1);
    assert.strictEqual(st.breaker, null);
    assert.deepStrictEqual(st.stale, []);
    assert.ok(M.snapshot());
    S.modules.economy.readSettings = function () { throw new Error('x'); };
    assert.strictEqual(M.items(), null);
    assert.strictEqual(M.status().enabled, false);
});
