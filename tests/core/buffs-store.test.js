'use strict';

// Star-to-store: the resource items of the star menu, the transfer rule
// (one entry, never past the warehouse capacity) and the toStore def.

var t = require('../runner');
var harness = require('../harness');
var A = require('../stubs/army');
var AC = require('../stubs/actions');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

// A booted world with the star menu, the warehouse (store amounts and one
// capacity) and the packet recorder. A buff packet moves its amount from the
// entry it names into the store unless env.apply is false.
function world(o) {
    var H = harness.boot();
    var buffs = o.buffs || [];
    A.install(H, { buffs: buffs });
    var sent = AC.wire(H);
    var S = H.Steward;
    var env = {
        home: true,
        apply: true,
        capacity: typeof o.capacity === 'number' || o.capacity === null ? o.capacity : 1000,
        store: o.store || {},
        onSend: null
    };
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
        if (env.apply) {
            var key = a.data.toKeyString();
            for (var i = 0; i < buffs.length; i++) {
                if ((buffs[i].uid || buffs[i].type) !== key) continue;
                buffs[i].amount -= a.p3;
                env.store[buffs[i].resource] = (env.store[buffs[i].resource] || 0) + a.p3;
            }
        }
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

function run(w, def) {
    var res = null;
    w.S.core.actions.attempt(def, function (r) { res = r; });
    AC.drive(w.H, { max: 200 });
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
    var text = def.describe({ amount: 100, star: 100, stock: 10 });
    assert.strictEqual(text, 'sent 100; star 100 -> 0; store 10 -> 110');
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
