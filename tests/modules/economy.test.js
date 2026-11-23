'use strict';

// Economy module: settings and the selection, the plan pass (what is queued,
// how many, how far apart), the transfer through the send ledger, bounces,
// the warehouse cap, unseen sends and the breaker, settling after a reload,
// the off path and the register spec (src/modules/economy/module.js).

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var t = require('../runner');
var harness = require('../harness');
var EC = require('../stubs/economy');

var assert = t.assert;
var plain = EC.plain;

var SETTLE_MS = 15000;

function star(resource, amount, uid) {
    return { resource: resource, amount: amount, uid: uid };
}

function names(q) {
    return q.map(function (e) { return e.name; });
}

// ---- settings ----------------------------------------------------------------------

t.test('boot writes the defaults; an unselected key stays false, never deleted', function () {
    var w = EC.world({ settings: false });
    assert.deepStrictEqual(w.settings(), { enabled: false, settingsVersion: 1, items: {} });
    var s = w.E.readSettings();
    assert.strictEqual(s.enabled, false);
    assert.deepStrictEqual(plain(s.items), {});
    assert.strictEqual(w.E.toggle('Wood'), true);
    assert.strictEqual(w.E.toggle('Wood'), false);
    assert.deepStrictEqual(w.settings().items, { Wood: false });
    assert.strictEqual(w.E.readSettings().items.Wood, false);
});

t.test('readSettings merges stored values over the defaults and reads items as booleans', function () {
    var w = EC.world({ items: { Wood: true, Coal: 'yes', Brick: false } });
    var s = w.E.readSettings();
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.settingsVersion, 1);
    assert.deepStrictEqual(plain(s.items), { Wood: true, Coal: false, Brick: false });
});

t.test('toggle writes only items[name] and keeps every other key', function () {
    var w = EC.world({ items: { Coal: true } });
    var writes = [];
    var write = w.S.kernel.settings.write;
    w.S.kernel.settings.write = function (id, val) {
        writes.push({ id: id, val: plain(val) });
        return write(id, val);
    };
    assert.strictEqual(w.E.toggle('Wood'), true);
    assert.deepStrictEqual(writes, [{ id: 'economy', val: { items: { Wood: true } } }]);
    assert.deepStrictEqual(w.settings().items, { Coal: true, Wood: true });
    assert.strictEqual(w.settings().enabled, true);
    assert.strictEqual(w.E.toggle(''), false);
    assert.strictEqual(writes.length, 1);
});

t.test('isReady is false while off or off the home island', function () {
    var w = EC.world({ items: { Wood: true } });
    var mod = w.H.module('economy');
    assert.strictEqual(mod.isReady({ zone: { isHome: true } }), true);
    assert.strictEqual(mod.isReady({ zone: { isHome: false } }), false);
    assert.strictEqual(mod.isReady({}), false);
    w.S.kernel.settings.write('economy', { enabled: false });
    assert.strictEqual(mod.isReady({ zone: { isHome: true } }), false);
});

// ---- plan ----------------------------------------------------------------------------

t.test('a pass queues selected, live, sendable items only, at most 3, 1.5 s apart', function () {
    var w = EC.world({
        star: [
            star('Brick', 10, 'b1'), star('Coal', 10, 'c1'), star('Egg', 10, 'e1'),
            star('Iron', 10, 'i1'), star('Marble', 10, 'm1'), star('Plank', 10, 'p1'),
            star('Wood', 10, 'w1')
        ],
        store: { Brick: 0, Coal: 1000, Egg: 0, Iron: 0, Marble: 0, Plank: 0, Wood: 0 },
        events: { Egg: 'Easter' },
        items: { Brick: true, Coal: true, Egg: true, Gold: true, Iron: true, Marble: true, Wood: true }
    });
    var q = w.plan();
    // Coal: warehouse full; Egg: event not live; Gold: none in star; Plank:
    // not selected; Wood: past the third.
    assert.deepStrictEqual(names(q), ['Brick', 'Iron', 'Marble']);
    assert.deepStrictEqual(q.map(function (e) { return e.delay; }), [0, 1500, 3000]);
    assert.deepStrictEqual(plain(w.E.lastPass()), { at: EC.T0, queued: 3, names: ['Brick', 'Iron', 'Marble'] });
    w.env.live = ['Easter_Content'];
    w.env.store.Brick = 1000;
    w.env.store.Iron = 1000;
    w.env.store.Marble = 1000;
    assert.deepStrictEqual(names(w.plan()), ['Egg', 'Wood']);
});

t.test('a pass queues nothing while off, and debugs a failed read once per item and reason', function () {
    var w = EC.world({ star: [star('Wood', 10, 'w1')], store: {}, items: { Wood: true } });
    assert.deepStrictEqual(w.plan(), []);
    assert.deepStrictEqual(w.plan(), []);
    assert.strictEqual(w.logged('debug', 'economy', /^Wood skipped: store stock unreadable$/).length, 1);
    w.env.store.Wood = 0;
    assert.deepStrictEqual(names(w.plan()), ['Wood']);
    w.S.kernel.settings.write('economy', { enabled: false });
    assert.deepStrictEqual(w.plan(), []);
});

t.test('one transfer per item is in flight across passes', function () {
    var w = EC.world({
        star: [star('Wood', 100, 'w1'), star('Wood', 50, 'w2'), star('Coal', 10, 'c1')],
        store: { Wood: 0, Coal: 0 },
        items: { Wood: true, Coal: true }
    });
    assert.deepStrictEqual(names(w.plan()), ['Coal', 'Wood']);
    w.handlers['economy.transfer'](['Wood']);
    w.drain(2);
    assert.strictEqual(w.fileEntries()['store|home|Wood'].state, 'sent');
    assert.deepStrictEqual(names(w.plan()), ['Coal']);
});

t.test('every entry of an item is moved over several passes', function () {
    var w = EC.world({
        star: [star('Wood', 100, 'w1'), star('Wood', 50, 'w2'), star('Wood', 30, 'w3')],
        store: { Wood: 0 },
        items: { Wood: true }
    });
    for (var i = 0; i < 3; i++) assert.deepStrictEqual(names(w.cycle()), ['Wood']);
    assert.deepStrictEqual(names(w.plan()), []);
    assert.strictEqual(w.env.store.Wood, 180);
    assert.deepStrictEqual(w.menu.map(function (b) { return b.amount; }), [0, 0, 0]);
    assert.deepStrictEqual(plain(w.E.moved().map(function (m) { return m.amount; })), [100, 50, 30]);
    assert.strictEqual(w.logged('log', 'economy', /^moved 100 Wood to the storehouse$/).length, 1);
    assert.deepStrictEqual(w.fileEntries(), {});
});

t.test('a bounce marks the item full with no breaker miss, and other items keep moving', function () {
    var w = EC.world({
        star: [star('StarDust', 80, 'd1'), star('StarDust', 80, 'd2'), star('Wood', 10, 'w1'), star('Wood', 10, 'w2')],
        store: { StarDust: 500, Wood: 0 },
        bounce: { StarDust: { after: 7000 } },
        items: { StarDust: true, Wood: true }
    });
    assert.deepStrictEqual(names(w.cycle()), ['StarDust', 'Wood']);
    assert.ok(w.S.core.buffs.storeFull('StarDust'));
    assert.strictEqual(w.S.core.ledger.blocked('store|home|StarDust'), null);
    assert.strictEqual(w.S.core.ledger.breaker('economy').snapshot().run, 0);
    assert.strictEqual(w.logged('debug', 'economy', /^StarDust came back: /).length, 1);
    assert.strictEqual(w.stack('d1').amount, 80);
    // Item full is a reading, not a failed read: skipped without a debug line.
    assert.deepStrictEqual(names(w.plan()), ['Wood']);
    assert.strictEqual(w.logged('debug', 'economy', /^StarDust skipped/).length, 0);
});

t.test('the warehouse cap stops the transfers and leaves the rest in the star menu', function () {
    var w = EC.world({
        star: [star('Wood', 300, 'w1'), star('Wood', 300, 'w2')],
        store: { Wood: 600 },
        capacity: 1000,
        items: { Wood: true }
    });
    w.cycle();
    assert.strictEqual(w.env.store.Wood, 900);
    w.cycle();
    assert.strictEqual(w.env.store.Wood, 1000);
    assert.strictEqual(w.stack('w2').amount, 200);
    assert.deepStrictEqual(names(w.plan()), []);
    assert.strictEqual(w.S.core.buffs.storeNext('Wood').reason, 'warehouse full');
});

t.test('an unseen send blocks its key and counts a miss; five misses pause the transfers', function () {
    var w = EC.world({
        star: ['A', 'B', 'C', 'D', 'E', 'F'].map(function (n) { return star(n, 10, n.toLowerCase() + '1'); }),
        store: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 },
        items: { A: true, B: true, C: true, D: true, E: true, F: true }
    });
    w.env.apply = false;
    assert.deepStrictEqual(names(w.cycle()), ['A', 'B', 'C']);
    var file = w.fileEntries();
    assert.deepStrictEqual(['A', 'B', 'C'].map(function (n) { return file['store|home|' + n].state; }),
        ['unseen', 'unseen', 'unseen']);
    assert.strictEqual(w.S.core.ledger.breaker('economy').snapshot().run, 3);
    // A and B are older than the resolve time and still in the star menu, so
    // their proof frees them; C is not old enough and stays blocked.
    assert.deepStrictEqual(names(w.cycle()), ['A', 'B', 'D']);
    var b = w.S.core.ledger.breaker('economy').snapshot();
    assert.strictEqual(b.open, true);
    assert.strictEqual(b.run, 6);
    w.env.apply = true;
    assert.ok(w.env.now < b.nextProbeAt);
    assert.deepStrictEqual(w.plan(), []);
});

t.test('an open breaker admits no transfer until its probe time', function () {
    var w = EC.world({
        star: [star('Wood', 10, 'w1')],
        store: { Wood: 0 },
        items: { Wood: true }
    });
    var brk = w.S.core.ledger.breaker('economy');
    for (var i = 0; i < 5; i++) brk.miss();
    assert.strictEqual(brk.isOpen(), true);
    assert.deepStrictEqual(w.plan(), []);
    w.env.now = brk.snapshot().nextProbeAt;
    assert.deepStrictEqual(names(w.plan()), ['Wood']);
});

t.test('a reload settles a sent entry by reread: landed clears it, unmoved frees it', function () {
    var disk = require('../stubs/airfs').make();
    var w = EC.world({ disk: disk, star: [star('Wood', 100, 'w1'), star('Coal', 40, 'c1')],
                       store: { Wood: 0, Coal: 0 }, items: { Wood: true, Coal: true } });
    w.env.apply = false;
    w.handlers['economy.transfer'](['Wood']);
    w.drain(2);
    w.handlers['economy.transfer'](['Coal']);
    w.drain(2);
    var file = w.fileEntries();
    assert.strictEqual(file['store|home|Wood'].state, 'sent');
    assert.strictEqual(file['store|home|Coal'].state, 'sent');

    // After the reload: Wood shows in the store, Coal is still in the star menu.
    var w2 = EC.world({ disk: disk, now: EC.T0 + 70000,
                        star: [star('Wood', 0, 'w1'), star('Wood', 5, 'w2'), star('Coal', 40, 'c1')],
                        store: { Wood: 100, Coal: 0 }, items: { Wood: true, Coal: true } });
    var q = w2.plan();
    var after = w2.fileEntries();
    assert.strictEqual(after['store|home|Wood'], undefined);
    assert.strictEqual(after['store|home|Coal'], undefined);
    // Both keys are free in the same pass, so both are queued again.
    assert.deepStrictEqual(names(q), ['Coal', 'Wood']);
});

// ---- the queued transfer -------------------------------------------------------------

t.test('a queued transfer re-checks the switch, the selection and the liveness', function () {
    var w = EC.world({
        star: [star('Wood', 10, 'w1'), star('Egg', 10, 'e1')],
        store: { Wood: 0, Egg: 0 },
        events: { Egg: 'Easter' },
        items: { Wood: true, Egg: true }
    });
    var fire = w.handlers['economy.transfer'];
    fire(['Egg']);
    assert.strictEqual(w.logged('debug', 'economy', /^Egg is not live, transfer skipped$/).length, 1);
    w.S.kernel.settings.write('economy', { items: { Wood: false } });
    fire(['Wood']);
    assert.strictEqual(w.logged('debug', 'economy', /^Wood is no longer selected/).length, 1);
    w.S.kernel.settings.write('economy', { enabled: false, items: { Wood: true } });
    fire(['Wood']);
    assert.strictEqual(w.logged('debug', 'economy', /^module is off, transfer of Wood skipped$/).length, 1);
    assert.strictEqual(w.H.queued().length, 0);
    assert.strictEqual(w.sent.actions.length, 0);
});

t.test('a transfer goes through the send ledger and lands after the settle time', function () {
    var w = EC.world({ star: [star('Wood', 100, 'w1')], store: { Wood: 0 }, items: { Wood: true } });
    var start = w.env.now;
    w.fire('Wood');
    assert.strictEqual(w.sent.actions.length, 1);
    assert.strictEqual(w.sent.actions[0].id, 61);
    var m = w.E.moved();
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].name, 'Wood');
    assert.strictEqual(m[0].amount, 100);
    assert.ok(m[0].at - start >= SETTLE_MS);
    assert.strictEqual(w.logged('log', 'economy', /^star to store Wood: observed$/).length, 1);
});

t.test('module off cancels the queued transfers', function () {
    var w = EC.world({ items: { Wood: true } });
    var cancelled = [];
    w.S.kernel.queue.cancelByModule = function (id) { cancelled.push(id); };
    var apply = w.S.kernel.lifecycle.applySettings.economy;
    apply();
    assert.deepStrictEqual(cancelled, []);
    w.S.kernel.settings.write('economy', { enabled: false });
    apply();
    assert.deepStrictEqual(cancelled, ['economy']);
    w.E.toggle('Coal');
    assert.deepStrictEqual(cancelled, ['economy', 'economy']);
});

// ---- register spec -------------------------------------------------------------------

// Kernel and core from the harness, then the economy files in bundle order,
// so the register call and its warnings land in the captured log.
function loadEconomy(before) {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var S = H.Steward;
    var raw = null;
    var reg = S.kernel.register;
    S.kernel.register = function (spec) {
        raw = spec;
        return reg.apply(this, arguments);
    };
    if (before) before(S);
    var dir = path.resolve(__dirname, '../../src/modules/economy');
    fs.readdirSync(dir).filter(function (f) { return /\.js$/.test(f); }).sort().forEach(function (f) {
        vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), H.ctx, { filename: f });
    });
    S.kernel.register = reg;
    return { H: H, S: S, raw: raw };
}

t.test('the module registers on the economy tab with its section kept and no registry warning', function () {
    var L = loadEconomy();
    var entry = L.S.kernel.registry.get('economy');
    assert.ok(entry);
    assert.strictEqual(entry.ui.tab, 'economy');
    assert.strictEqual(entry.ui.section.id, 'economy');
    assert.strictEqual(entry.ui.section.title, 'Economy');
    assert.strictEqual(entry.ui.section.icon, '⚖');
    assert.strictEqual(entry.menu.title, 'Economy');
    assert.strictEqual(L.S.kernel.registry.byTab('economy').length, 1);
    var warns = L.H.logs().filter(function (l) { return l.level === 'warn' && l.category === 'registry'; });
    assert.deepStrictEqual(warns, []);
});

t.test('the delegating section and menu return safe empties while ui.js and menu.js are absent', function () {
    var L = loadEconomy();
    var sec = L.S.kernel.registry.get('economy').ui.section;
    assert.strictEqual(sec.render({}, {}), undefined);
    assert.strictEqual(sec.side({}, {}), undefined);
    assert.strictEqual(sec.summary({}), '');
    assert.deepStrictEqual(plain(sec.tiles({})), []);
    assert.deepStrictEqual(plain(L.S.kernel.registry.get('economy').menu.items()), []);
    // Once ui.js fills the namespace, the same section reaches it.
    L.S.modules.economy.ui = {
        render:  function () { return 'r'; },
        side:    function () { return 's'; },
        summary: function () { return 'sum'; },
        tiles:   function () { return [1]; }
    };
    L.S.modules.economy.menu = { items: function () { return ['row']; } };
    assert.strictEqual(sec.render({}, {}), 'r');
    assert.strictEqual(sec.side({}, {}), 's');
    assert.strictEqual(sec.summary({}), 'sum');
    assert.deepStrictEqual(plain(sec.tiles({})), [1]);
    assert.deepStrictEqual(plain(L.S.kernel.registry.get('economy').menu.items()), ['row']);
});

t.test('ui.dashboard is set only when the economy dashboard enum exists at load time', function () {
    var none = loadEconomy();
    assert.strictEqual(Object.prototype.hasOwnProperty.call(none.raw.ui, 'dashboard'), false);
    var some = loadEconomy(function (S) { S.Dashboard = { Economy: 'DashboardEconomy' }; });
    assert.strictEqual(some.raw.ui.dashboard, 'DashboardEconomy');
});
