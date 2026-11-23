'use strict';

// Star-to-store: the resource items of the star menu, the transfer rule
// (one entry, never past the warehouse capacity), the toStore def with its
// settle time and bounce rule, and the full memory of a bounced item.

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var A = require('../stubs/army');
var AC = require('../stubs/actions');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

var T0 = 1700000000000;
// How long a full mark is trusted (FULL_HOLD_MS in buffs.js).
var HOLD_MS = 1800000;

// A booted world with the star menu, the warehouse (store amounts and one
// capacity), the packet recorder, a steward folder for the ledger and a
// settable ledger clock (env.now). A buff packet moves its amount from the
// entry it names into the store unless env.apply is false. env.bounce
// ({ after, back }) takes the stack out of the entry on send and, after ms of
// ledger clock, puts back (default all) of it into the entry again with the
// store unchanged; env.partial ({ after, take }) lets the store take part at
// once and returns the rest. env.later(ms, fn) runs fn once the clock got
// there; run() advances the clock by one poll gap per queued step.
function world(o) {
    var disk = airfs.make();
    var H = harness.boot({ host: { air: disk.air } });
    var buffs = o.buffs || [];
    A.install(H, { buffs: buffs });
    var sent = AC.wire(H);
    var S = H.Steward;
    var events = [];
    var env = {
        home: true,
        apply: true,
        capacity: typeof o.capacity === 'number' || o.capacity === null ? o.capacity : 1000,
        store: o.store || {},
        onSend: null,
        bounce: null,
        partial: null,
        now: T0,
        doneAt: null
    };
    env.later = function (ms, fn) { events.push({ at: env.now + ms, fn: fn }); };
    env.tick = function (ms) {
        env.now += ms;
        var due = events.filter(function (e) { return e.at <= env.now; });
        events = events.filter(function (e) { return e.at > env.now; });
        due.forEach(function (e) { e.fn(); });
    };
    S.core.ledger.clock = function () { return env.now; };
    H.host.game.getResources = function () {
        return {
            GetResourceAmount: function (name) {
                return Object.prototype.hasOwnProperty.call(env.store, name) ? env.store[name] : null;
            },
            GetWareHouseCapacity: function () { return env.capacity; }
        };
    };
    var gi = H.host.game.gi;
    var send = gi.SendServerAction;
    gi.SendServerAction = function () {
        send.apply(this, arguments);
        var a = sent.actions[sent.actions.length - 1];
        var key = a.data.toKeyString();
        buffs.forEach(function (b) {
            if ((b.uid || b.type) !== key) return;
            var ret = env.bounce || env.partial;
            if (ret) {
                var take = env.partial ? env.partial.take : 0;
                var back = env.bounce && typeof env.bounce.back === 'number' ? env.bounce.back : a.p3 - take;
                b.amount -= a.p3;
                if (take) env.store[b.resource] = (env.store[b.resource] || 0) + take;
                env.later(ret.after, function () { b.amount += back; });
            } else if (env.apply) {
                b.amount -= a.p3;
                env.store[b.resource] = (env.store[b.resource] || 0) + a.p3;
            }
        });
        if (env.onSend) env.onSend(a);
    };
    // The real zone view reads these: a numeric viewed zone id and a mounted
    // player zone make it ok, and isOnHomzone follows env.home.
    gi.mCurrentViewedZoneID = 1;
    if (!gi.mCurrentPlayerZone) gi.mCurrentPlayerZone = {};
    gi.isOnHomzone = function () { return env.home; };
    return { H: H, S: S, buffs: S.core.buffs, sent: sent, env: env, menu: buffs };
}

function item(resource, amount, uid) {
    return { type: 'AddResource', resource: resource, amount: amount, uid: uid };
}

function drain(w) {
    var gap = w.S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS;
    AC.drive(w.H, { max: 400, onStep: function () { w.env.tick(gap); } });
}

function run(w, def) {
    var res = null;
    w.S.core.actions.attempt(def, function (r) { res = r; w.env.doneAt = w.env.now; });
    drain(w);
    return res;
}

function breakMenu(w) {
    w.H.host.game.gi.mCurrentPlayer.getAvailableBuffs_vector = function () { throw new Error('boom'); };
}

// ---- starResources ---------------------------------------------------------------

t.test('starResources lists the resource items, not population and not unbound entries', function () {
    var w = world({ buffs: [
        item('Wood', 100, 'w1'),
        item('Wood', 50, 'w2'),
        item('Coal', 0, 'c1'),
        item('Population', 500, 'p1'),
        item('', 9, 'u1'),
        item('Brick', 30, 'b1'),
        { type: 'GeneralSpeedBuff_A', amount: 2 }
    ] });
    assert.deepStrictEqual(plain(w.buffs.starResources()), [
        { name: 'Brick', total: 30, largest: 30, entries: 1 },
        { name: 'Wood', total: 150, largest: 100, entries: 2 }
    ]);
});

t.test('starResources is null on an unreadable menu or an unreadable entry', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1')] });
    w.menu.push({ type: 'AddResource', resource: 'Coal', amount: undefined, uid: 'bad' });
    assert.strictEqual(w.buffs.starResources(), null);
    w.menu.pop();
    assert.strictEqual(w.buffs.starResources().length, 1);
    breakMenu(w);
    assert.strictEqual(w.buffs.starResources(), null);
});

// ---- storeNext: the transfer rule --------------------------------------------------

t.test('storeNext sends the whole entry when the warehouse has room', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1'), item('Wood', 50, 'w2')], capacity: 1000, store: { Wood: 400 } });
    var n = w.buffs.storeNext('Wood');
    assert.strictEqual(n.amount, 100);
    assert.strictEqual(n.room, 600);
    assert.strictEqual(n.capacity, 1000);
    assert.strictEqual(n.stock, 400);
    assert.strictEqual(n.star.total, 150);
    assert.strictEqual(n.reason, null);
    assert.strictEqual(n.entry, undefined);
});

t.test('storeNext caps the amount at capacity minus stock', function () {
    var w = world({ buffs: [item('Wood', 500, 'w1')], capacity: 1000, store: { Wood: 880 } });
    var n = w.buffs.storeNext('Wood');
    assert.strictEqual(n.amount, 120);
    assert.strictEqual(n.room, 120);
});

t.test('storeNext names why nothing would be sent', function () {
    var w = world({ buffs: [item('Wood', 10, 'w1'), item('Coal', 0, 'c1')], capacity: 1000, store: { Wood: 1000, Coal: 0 } });
    assert.strictEqual(w.buffs.storeNext('Wood').reason, 'warehouse full');
    assert.strictEqual(w.buffs.storeNext('Wood').amount, 0);
    assert.strictEqual(w.buffs.storeNext('Coal').reason, 'none in star');
    assert.strictEqual(w.buffs.storeNext('Brick').reason, 'none in star');
    w.env.store.Wood = 1200;
    assert.strictEqual(w.buffs.storeNext('Wood').reason, 'warehouse full');
    w.env.store.Wood = 999.5;
    assert.strictEqual(w.buffs.storeNext('Wood').reason, 'warehouse full');
    delete w.env.store.Wood;
    assert.strictEqual(w.buffs.storeNext('Wood').reason, 'store stock unreadable');
    w.env.capacity = null;
    assert.strictEqual(w.buffs.storeNext('Wood').reason, 'capacity unreadable');
    breakMenu(w);
    var n = w.buffs.storeNext('Wood');
    assert.strictEqual(n.reason, 'star stock unreadable');
    assert.strictEqual(n.amount, 0);
});

// ---- toStore ------------------------------------------------------------------------

t.test('toStore sends min(entry, room) to the player grid and leaves the rest', function () {
    var w = world({ buffs: [item('Wood', 500, 'w1')], capacity: 1000, store: { Wood: 880 } });
    var predicted = w.buffs.storeNext('Wood').amount;
    var def = w.buffs.toStore('Wood');
    var res = run(w, def);
    assert.strictEqual(res.status, w.S.ActionResult.Verified);
    assert.strictEqual(w.sent.actions.length, 1);
    var a = w.sent.actions[0];
    assert.strictEqual(a.id, 61);
    assert.strictEqual(a.p2, 8825);
    assert.strictEqual(a.p3, 120);
    assert.strictEqual(a.p3, predicted);
    assert.strictEqual(a.data.toKeyString(), 'w1');
    assert.strictEqual(w.menu[0].amount, 380);
    assert.strictEqual(w.env.store.Wood, 1000);
    assert.strictEqual(def.sent(), 120);
    assert.strictEqual(def.retries, 0);
    assert.strictEqual(def.category, 'buffs');
    assert.strictEqual(w.buffs.toStore('Wood', { category: 'economy' }).category, 'economy');
});

t.test('toStore sends one entry only, the first in stock', function () {
    var w = world({ buffs: [item('Wood', 0, 'w0'), item('Wood', 40, 'w1'), item('Wood', 60, 'w2')], store: { Wood: 0 } });
    run(w, w.buffs.toStore('Wood'));
    assert.strictEqual(w.sent.actions.length, 1);
    assert.strictEqual(w.sent.actions[0].data.toKeyString(), 'w1');
    assert.strictEqual(w.sent.actions[0].p3, 40);
});

t.test('toStore verifies by the star stock dropping alone', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1')], store: { Wood: 0 } });
    w.env.apply = false;
    w.env.onSend = function (a) { w.menu[0].amount -= a.p3; };
    var res = run(w, w.buffs.toStore('Wood'));
    assert.strictEqual(res.status, w.S.ActionResult.Verified);
    assert.strictEqual(w.env.store.Wood, 0);
});

t.test('toStore verifies by the store rising alone', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1')], store: { Wood: 0 } });
    w.env.apply = false;
    w.env.onSend = function (a) {
        w.env.store.Wood += a.p3;
        breakMenu(w);
    };
    var res = run(w, w.buffs.toStore('Wood'));
    assert.strictEqual(res.status, w.S.ActionResult.Verified);
});

t.test('toStore that is never seen fails unseen after one send', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1')], store: { Wood: 0 } });
    w.env.apply = false;
    var res = run(w, w.buffs.toStore('Wood'));
    assert.strictEqual(res.status, w.S.ActionResult.Failed);
    assert.strictEqual(res.unseen, true);
    assert.strictEqual(w.sent.actions.length, 1);
});

t.test('toStore refuses off home, population and every unreadable read', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1'), item('Population', 50, 'p1')], store: { Wood: 0, Population: 0 } });
    w.env.home = false;
    assert.strictEqual(run(w, w.buffs.toStore('Wood')).reason, 'not on the home island');
    w.env.home = true;
    assert.strictEqual(run(w, w.buffs.toStore('Population')).reason, 'population is not a store item');
    assert.strictEqual(run(w, w.buffs.toStore('Coal')).reason, 'none in star');
    w.env.store.Wood = 1000;
    assert.strictEqual(run(w, w.buffs.toStore('Wood')).reason, 'warehouse full');
    delete w.env.store.Wood;
    assert.strictEqual(run(w, w.buffs.toStore('Wood')).reason, 'store stock unreadable');
    w.env.capacity = null;
    assert.strictEqual(run(w, w.buffs.toStore('Wood')).reason, 'capacity unreadable');
    breakMenu(w);
    var res = run(w, w.buffs.toStore('Wood'));
    assert.strictEqual(res.status, w.S.ActionResult.Refused);
    assert.strictEqual(res.reason, 'star stock unreadable');
    assert.strictEqual(w.sent.actions.length, 0);
});

t.test('toStore population refusal follows the name in core.resources', function () {
    var w = world({ buffs: [item('Coins', 100, 'c1')], store: { Coins: 0 } });
    var prev = w.S.core.resources.POPULATION;
    w.S.core.resources.POPULATION = 'Coins';
    try {
        assert.strictEqual(run(w, w.buffs.toStore('Coins')).reason, 'population is not a store item');
        assert.deepStrictEqual(plain(w.buffs.starResources()), []);
    } finally {
        w.S.core.resources.POPULATION = prev;
    }
});

t.test('toStore describes the send and both stocks', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1')], store: { Wood: 10 } });
    var def = w.buffs.toStore('Wood');
    run(w, def);
    var text = def.describe({ amount: 100, star: 100, stock: 10, at: w.env.now - 20000 });
    assert.strictEqual(text, 'sent 100; star 100 -> 0; store 10 -> 110; landed');
});

t.test('storeNext gives the same amount the def sends', function () {
    var cases = [[100, 0], [500, 880], [7, 993], [250, 750]];
    cases.forEach(function (c) {
        var w = world({ buffs: [item('Wood', c[0], 'w1')], capacity: 1000, store: { Wood: c[1] } });
        var n = w.buffs.storeNext('Wood').amount;
        run(w, w.buffs.toStore('Wood'));
        assert.strictEqual(w.sent.actions[0].p3, n, c.join('/'));
    });
});

// ---- read API: Results and read refusals -------------------------------------------

t.test('inventoryRead is ok, partial with a mid-update entry, unreadable on a broken menu', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1')] });
    var r = w.buffs.inventoryRead();
    assert.strictEqual(r.state, 'ok');
    assert.strictEqual(r.value[0].uid, 'w1');
    w.menu.push({ type: 'GeneralSpeedBuff_A', amount: undefined });
    r = w.buffs.inventoryRead();
    assert.strictEqual(r.state, 'partial');
    assert.strictEqual(r.lost, 1);
    assert.strictEqual(w.buffs.inventory().length, 2);
    breakMenu(w);
    assert.strictEqual(w.buffs.inventoryRead().state, 'unreadable');
    assert.strictEqual(w.buffs.inventory(), null);
});

t.test('the unreadable refusals are read refusals, the real ones are not', function () {
    var R = world({}).S.kernel.read;
    assert.strictEqual(R.isReadRefusal('star stock unreadable'), true);
    assert.strictEqual(R.isReadRefusal('capacity unreadable'), true);
    assert.strictEqual(R.isReadRefusal('store stock unreadable'), true);
    assert.strictEqual(R.isReadRefusal('none in star'), false);
    assert.strictEqual(R.isReadRefusal('warehouse full'), false);
});

t.test('a partial menu never proves none in star, but its present items still send', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1'), { type: 'GeneralSpeedBuff_A', amount: undefined }], store: { Wood: 0, Coal: 0 } });
    assert.strictEqual(w.buffs.storeNext('Coal').reason, 'star stock unreadable');
    assert.strictEqual(run(w, w.buffs.toStore('Coal')).reason, 'star stock unreadable');
    assert.strictEqual(w.buffs.storeNext('Wood').amount, 100);
    var res = run(w, w.buffs.toStore('Wood'));
    assert.strictEqual(res.status, w.S.ActionResult.Verified);
    assert.strictEqual(w.sent.actions.length, 1);
});

t.test('toStore waits on an unreadable zone view instead of refusing as off home', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1')], store: { Wood: 0 } });
    w.H.host.game.gi.mCurrentViewedZoneID = null;
    var res = run(w, w.buffs.toStore('Wood'));
    assert.strictEqual(res.status, w.S.ActionResult.Refused);
    assert.strictEqual(res.reason, w.S.core.zone.UNREADABLE);
    assert.strictEqual(w.S.kernel.read.isReadRefusal(res.reason), true);
    assert.strictEqual(w.sent.actions.length, 0);
});

// ---- settle time, bounce and full memory --------------------------------------------

var KEY = 'store|home|StarDust';

// toStore through the send ledger for owner 'eco'.
function viaLedger(w, name) {
    var L = w.S.core.ledger;
    L.register('eco', {
        category: 'economy',
        breaker: {
            label: 'eco breaker', missText: 'store sends in a row were not seen',
            pausedText: 'economy is paused', resumeText: 'economy resumes'
        }
    });
    var res = null;
    L.attempt(w.buffs.toStore(name, { category: 'economy' }), { key: KEY, owner: 'eco', name: name },
        function (r) { res = r; w.env.doneAt = w.env.now; });
    drain(w);
    return res;
}

// StarDust marked full: store 180 of capacity 1000, a stack of 100 bounced.
function marked() {
    var w = world({ buffs: [item('StarDust', 100, 's1')], store: { StarDust: 180 } });
    w.env.bounce = { after: 7000 };
    var res = run(w, w.buffs.toStore('StarDust'));
    assert.strictEqual(res.refuted, true);
    return w;
}

t.test('toStore lands by a store rise only after the settle time', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1')], store: { Wood: 0 } });
    w.env.apply = false;
    w.env.onSend = function (a) { w.env.later(3000, function () { w.env.store.Wood += a.p3; }); };
    var res = run(w, w.buffs.toStore('Wood'));
    assert.strictEqual(res.status, w.S.ActionResult.Verified);
    assert.ok(w.env.doneAt - T0 >= w.buffs.STORE_SETTLE_MS, String(w.env.doneAt - T0));
    assert.strictEqual(w.menu[0].amount, 100);
});

t.test('toStore lands by the star alone only after the settle time', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1')], store: { Wood: 0 } });
    w.env.apply = false;
    w.env.onSend = function (a) { w.menu[0].amount -= a.p3; };
    var res = run(w, w.buffs.toStore('Wood'));
    assert.strictEqual(res.status, w.S.ActionResult.Verified);
    assert.ok(w.env.doneAt - T0 >= w.buffs.STORE_SETTLE_MS, String(w.env.doneAt - T0));
});

t.test('a store rise from production plus a stack that came back is refuted, not verified', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1')], store: { Wood: 0 } });
    w.env.bounce = { after: 7000 };
    w.env.onSend = function () { w.env.later(3000, function () { w.env.store.Wood += 150; }); };
    var res = run(w, w.buffs.toStore('Wood'));
    assert.strictEqual(res.status, w.S.ActionResult.Failed);
    assert.strictEqual(res.refuted, true);
    assert.strictEqual(w.buffs.storeFull('Wood').back, 100);
});

t.test('a stack back in the star menu at 7 s is refuted, frees the key and counts no miss', function () {
    var w = world({ buffs: [item('StarDust', 100, 's1')], store: { StarDust: 50 } });
    w.env.bounce = { after: 7000 };
    var res = viaLedger(w, 'StarDust');
    assert.strictEqual(res.status, w.S.ActionResult.Failed);
    assert.strictEqual(res.refuted, true);
    assert.strictEqual(res.unseen, undefined);
    assert.strictEqual(res.reason, 'came back to the star menu (100 of 100); StarDust is full');
    var took = w.env.doneAt - T0;
    assert.ok(took >= 7000 && took < w.buffs.STORE_SETTLE_MS, String(took));
    assert.strictEqual(w.sent.actions.length, 1);
    assert.deepStrictEqual(plain(w.buffs.storeFull('StarDust')), { at: w.env.doneAt, back: 100, stock: 50 });
    assert.strictEqual(w.S.core.ledger.blocked(KEY), null);
    assert.strictEqual(w.S.core.ledger.breaker('eco').snapshot().run, 0);
    var logs = w.H.logs().filter(function (l) {
        return l.category === 'buffs' && /^StarDust is full: 100 came back to the star menu$/.test(l.args.join(' '));
    });
    assert.strictEqual(logs.length, 1);
});

t.test('a partial bounce marks the returned part', function () {
    var w = world({ buffs: [item('StarShards', 100, 'x1')], store: { StarShards: 0 } });
    w.env.partial = { after: 6000, take: 60 };
    var res = run(w, w.buffs.toStore('StarShards'));
    assert.strictEqual(res.refuted, true);
    assert.strictEqual(res.reason, 'came back to the star menu (40 of 100); StarShards is full');
    assert.strictEqual(w.buffs.storeFull('StarShards').back, 40);
    assert.strictEqual(w.buffs.storeFull('StarShards').stock, 60);
});

t.test('storePick gives item full while marked, none in star first when the star is empty', function () {
    var w = marked();
    var n = w.buffs.storeNext('StarDust');
    assert.strictEqual(n.reason, 'item full');
    assert.strictEqual(n.reason, w.buffs.ITEM_FULL);
    assert.strictEqual(n.amount, 0);
    assert.strictEqual(n.full.back, 100);
    assert.strictEqual(w.S.kernel.read.isReadRefusal('item full'), false);
    assert.strictEqual(run(w, w.buffs.toStore('StarDust')).reason, 'item full');
    assert.strictEqual(w.sent.actions.length, 1);
    w.menu[0].amount = 0;
    n = w.buffs.storeNext('StarDust');
    assert.strictEqual(n.reason, 'none in star');
    assert.strictEqual(n.full, null);
    w.menu[0].amount = 100;
    assert.strictEqual(w.buffs.storeNext('StarDust').reason, 'item full');
    w.env.store.Wood = 0;
    w.menu.push(item('Wood', 10, 'w1'));
    assert.strictEqual(w.buffs.storeNext('Wood').reason, null);
    assert.strictEqual(w.buffs.storeNext('Wood').full, null);
});

t.test('a full mark clears after 30 min', function () {
    var w = marked();
    var at = w.buffs.storeFull('StarDust').at;
    w.env.now = at + HOLD_MS - 1;
    assert.notStrictEqual(w.buffs.storeFull('StarDust'), null);
    w.env.now = at + HOLD_MS;
    assert.strictEqual(w.buffs.storeFull('StarDust'), null);
    assert.strictEqual(w.buffs.storeNext('StarDust').reason, null);
});

t.test('a full mark clears when the store drops by the returned stack', function () {
    var w = marked();
    w.env.store.StarDust = 81;
    assert.notStrictEqual(w.buffs.storeFull('StarDust'), null);
    w.env.store.StarDust = 80;
    assert.strictEqual(w.buffs.storeFull('StarDust'), null);
    w.env.store.StarDust = 180;
    assert.strictEqual(w.buffs.storeFull('StarDust'), null);
});

t.test('a full mark clears when the capacity rises', function () {
    var w = marked();
    w.env.capacity = 1000;
    assert.notStrictEqual(w.buffs.storeFull('StarDust'), null);
    w.env.capacity = 1001;
    assert.strictEqual(w.buffs.storeFull('StarDust'), null);
});

t.test('unreadable reads never clear a full mark', function () {
    var w = marked();
    delete w.env.store.StarDust;
    w.env.capacity = null;
    assert.notStrictEqual(w.buffs.storeFull('StarDust'), null);
    breakMenu(w);
    assert.notStrictEqual(w.buffs.storeFull('StarDust'), null);
    assert.strictEqual(w.buffs.storeFull(null), null);
});

t.test('failedProof names an unmoved stack after the settle time and nothing else', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1')], store: { Wood: 0 } });
    var def = w.buffs.toStore('Wood');
    var base = { amount: 100, star: 100, stock: 0, at: w.env.now };
    assert.strictEqual(def.failedProof(base), '');
    w.env.now += w.buffs.STORE_SETTLE_MS;
    assert.strictEqual(def.failedProof(base), 'still in the star menu after 15000 ms');
    assert.strictEqual(w.buffs.storeFull('Wood'), null);
    w.menu[0].amount = 0;
    assert.strictEqual(def.failedProof(base), '');
    w.menu[0].amount = 100;
    w.env.store.Wood = 100;
    assert.strictEqual(def.failedProof(base), '');
    assert.strictEqual(def.failedProof(null), '');
});

t.test('toStore holds its check while off home', function () {
    var w = world({ buffs: [item('Wood', 100, 'w1')], store: { Wood: 0 } });
    w.env.onSend = function () {
        w.env.home = false;
        w.env.later(30000, function () { w.env.home = true; });
    };
    var res = run(w, w.buffs.toStore('Wood'));
    assert.strictEqual(res.status, w.S.ActionResult.Verified);
    assert.ok(w.env.doneAt - T0 >= 30000, String(w.env.doneAt - T0));
    var held = w.H.logs().filter(function (l) { return /not observable, holding the check/.test(l.args.join(' ')); });
    assert.strictEqual(held.length, 1);
});
