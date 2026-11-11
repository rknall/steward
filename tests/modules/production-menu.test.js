'use strict';

// The ~Steward~ › Production submenu: a fixed set of seven rows whose labels
// follow the production settings, flips that write only their own key at
// once and then run the module's applySettings (the same off path as a
// dashboard Save), and the status line built from the model's status.

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

// A booted steward with the production settings stored as given and the
// queue cancel, settings writes and window open recorded.
function setup(stored) {
    var H = harness.boot();
    var S = H.Steward;
    if (stored) S.kernel.settings.write('production', stored);
    var w = { S: S, writes: [], cancels: [], opens: 0, status: null };
    var write = S.kernel.settings.write;
    S.kernel.settings.write = function (id, val) {
        if (id !== 'production') return write(id, val);
        w.writes.push(JSON.parse(JSON.stringify(val)));
        // The host store deep-merges a write into the namespace; the harness
        // stub replaces it, so merge here to keep the unflipped keys, which
        // the module's applySettings reads after a flip.
        var merged = JSON.parse(JSON.stringify(S.kernel.settings.read(id) || {}));
        for (var k in val) {
            if (Object.prototype.hasOwnProperty.call(val, k)) merged[k] = val[k];
        }
        return write(id, merged);
    };
    S.kernel.queue.cancelByModule = function (id) { w.cancels.push(id); return 0; };
    S.modules.production.window = { open: function () { w.opens++; } };
    S.modules.production.model.status = function () { return w.status; };
    S.modules.production.model.snapshot = function () { return w.status; };
    w.items = function () { return S.modules.production.menu.items(); };
    w.label = function (it, pass) {
        return typeof it.label === 'function' ? it.label(pass || {}) : it.label;
    };
    return w;
}

function labels(w) {
    var its = w.items();
    var pass = {};
    var out = [];
    for (var i = 0; i < its.length; i++) out.push(its[i].separator ? '---' : w.label(its[i], pass));
    return out;
}

t.test('production menu: always seven rows, whatever the state', function () {
    var a = setup({ enabled: false, standing: false, buffs: false, bookComplete: false });
    var b = setup({ enabled: true, standing: true, buffs: true, bookComplete: true });
    var c = setup(null);
    assert.strictEqual(a.items().length, 7);
    assert.strictEqual(b.items().length, 7);
    assert.strictEqual(c.items().length, 7);
    var its = a.items();
    assert.strictEqual(its[3].separator, true);
    assert.strictEqual(its[1].enabled, false, 'status line is display-only');
    assert.strictEqual(its[1].onSelect, undefined);
    assert.strictEqual(its[2].label, 'Open production manager…');
    // The registry accepts every row, so none is dropped at build.
    assert.strictEqual(a.S.kernel.registry.menuItems('production', its).length, 7);
});

t.test('production menu: labels follow the settings', function () {
    var w = setup({ enabled: true, standing: false, buffs: true, bookComplete: false });
    var l = labels(w);
    assert.strictEqual(l[0], '✓ Auto-production');
    assert.strictEqual(l[4], '✕ Standing orders');
    assert.strictEqual(l[5], '✓ Building buffs');
    assert.strictEqual(l[6], '✕ Bookbinder auto-complete');
    w.S.kernel.settings.write('production', { enabled: false, standing: true, buffs: false, bookComplete: true });
    l = labels(w);
    assert.strictEqual(l[0], '✕ Auto-production');
    assert.strictEqual(l[4], '✓ Standing orders');
    assert.strictEqual(l[5], '✕ Building buffs');
    assert.strictEqual(l[6], '✓ Bookbinder auto-complete');
});

t.test('production menu: an unstored key reads as its default', function () {
    var w = setup({ enabled: true });
    var l = labels(w);
    assert.strictEqual(l[4], '✓ Standing orders', 'standing defaults to on');
    assert.strictEqual(l[5], '✓ Building buffs', 'buffs defaults to on');
    assert.strictEqual(l[6], '✕ Bookbinder auto-complete', 'bookComplete defaults to off');
});

t.test('production menu: each flip writes only its own key', function () {
    var keys = ['enabled', null, null, null, 'standing', 'buffs', 'bookComplete'];
    for (var i = 0; i < keys.length; i++) {
        if (!keys[i]) continue;
        var w = setup({ enabled: true, standing: true, buffs: true, bookComplete: true, actionDelay: 1500 });
        w.items()[i].onSelect();
        assert.strictEqual(w.writes.length, 1, keys[i] + ' writes once');
        var o = {};
        o[keys[i]] = false;
        assert.deepStrictEqual(w.writes[0], o, keys[i] + ' writes only its key');
    }
});

t.test('production menu: every flip runs the module\'s applySettings once', function () {
    var keys = [0, 4, 5, 6];
    var states = [true, false];
    for (var i = 0; i < keys.length; i++) {
        for (var j = 0; j < states.length; j++) {
            var v = states[j];
            var w = setup({ enabled: v, standing: v, buffs: v, bookComplete: v });
            var apply = w.S.kernel.lifecycle.applySettings;
            var real = apply.production;
            var calls = 0;
            apply.production = function () { calls++; return real.apply(this, arguments); };
            w.items()[keys[i]].onSelect();
            assert.strictEqual(calls, 1, 'row ' + keys[i] + ' from ' + v + ' applies once');
        }
    }
});

t.test('production menu: Auto-production off cancels the queue work and drops the needs', function () {
    var w = setup({ enabled: true });
    var demand = w.S.core.production.demand;
    var drop = demand.dropOwner;
    var dropped = [];
    demand.dropOwner = function (owner) { dropped.push(owner); return drop.apply(this, arguments); };
    w.items()[0].onSelect();
    assert.deepStrictEqual(w.writes, [{ enabled: false }]);
    assert.deepStrictEqual(w.cancels, ['production']);
    assert.deepStrictEqual(dropped, ['production']);
});

t.test('production menu: sub-switches off and any flip on cancel nothing', function () {
    var keys = [4, 5, 6];
    for (var i = 0; i < keys.length; i++) {
        var off = setup({ enabled: true, standing: true, buffs: true, bookComplete: true });
        off.items()[keys[i]].onSelect();
        assert.deepStrictEqual(off.cancels, [], 'row ' + keys[i] + ' off cancels nothing');
    }
    var rows = [0, 4, 5, 6];
    for (var k = 0; k < rows.length; k++) {
        var on = setup({ enabled: false, standing: false, buffs: false, bookComplete: false });
        // Each case flips one key to on; the others stay as stored.
        if (rows[k] !== 0) on.S.kernel.settings.write('production', { enabled: true });
        on.cancels.length = 0;
        on.writes.length = 0;
        on.items()[rows[k]].onSelect();
        assert.deepStrictEqual(on.cancels, [], 'row ' + rows[k] + ' on cancels nothing');
        assert.strictEqual(on.writes[0][Object.keys(on.writes[0])[0]], true);
    }
});

t.test('production menu: without applySettings a flip still writes and does not throw', function () {
    var w = setup({ enabled: true });
    delete w.S.kernel.lifecycle.applySettings.production;
    var errors = [];
    var err = w.S.kernel.error;
    w.S.kernel.error = function () { errors.push(Array.prototype.slice.call(arguments)); return err.apply(w.S.kernel, arguments); };
    w.items()[0].onSelect();
    assert.deepStrictEqual(w.writes, [{ enabled: false }]);
    assert.strictEqual(errors.length, 0);
});

t.test('production menu: a flip logs the key and value', function () {
    var w = setup({ enabled: false });
    var lines = [];
    var log = w.S.kernel.log;
    w.S.kernel.log = function () { lines.push(Array.prototype.slice.call(arguments)); return log.apply(w.S.kernel, arguments); };
    w.items()[0].onSelect();
    assert.deepStrictEqual(lines[0], ['ui', 'production', 'enabled', '→', true]);
});

t.test('production menu: open row opens the production window', function () {
    var w = setup({ enabled: true });
    w.items()[2].onSelect();
    assert.strictEqual(w.opens, 1);
    assert.strictEqual(w.writes.length, 0);
});

t.test('production menu: status line from the model status', function () {
    var w = setup({ enabled: true });
    var at = new Date(2026, 10, 9, 14, 2, 0).getTime();
    w.status = {
        queues: 5, entries: 6, nextDoneAt: at,
        orderBreaker: { open: false }, buffBreaker: { open: false }
    };
    assert.strictEqual(w.label(w.items()[1]), '5 queues · 6 entries · next done 14:02 · breaker ok');

    w.status = { queues: 0, entries: 0, nextDoneAt: null, orderBreaker: null, buffBreaker: { open: true } };
    assert.strictEqual(w.label(w.items()[1]), '0 queues · 0 entries · breaker open');

    w.status = null;
    assert.strictEqual(w.label(w.items()[1]), 'Production status unavailable');
});

t.test('production menu: one status read per pass', function () {
    var w = setup({ enabled: true });
    var calls = 0;
    w.S.modules.production.model.snapshot = function () {
        calls++;
        return { queues: 1, entries: 1, nextDoneAt: null };
    };
    var pass = {};
    var it = w.items()[1];
    it.label(pass);
    it.label(pass);
    assert.strictEqual(calls, 1);
    it.label({});
    assert.strictEqual(calls, 2);
});

t.test('production menu: the second label refresh makes no queue reads', function () {
    var PS = require('../stubs/production');
    var w = PS.world({
        enumNames: { 1: 'provisionhouse', 6: 'fishhouse' },
        queues: {
            1: [{ type: 'Bread', amount: 1, produced: 0, timeMs: 5000, collectedMs: 0, bonus: 1, producedItems: 0 }],
            6: []
        },
        buildings: [{ name: 'ProvisionHouse', type: 1 }, { name: 'Fishhouse', type: 6 }]
    });
    var H = harness.boot({ host: { swmmo: w.swmmo } });
    PS.install(H, w);
    var S = H.Steward;
    w.reset();
    var it = S.modules.production.menu.items()[1];
    var first = it.label({});
    var queueReads = function () {
        var n = 0;
        Object.keys(w.counts.queue).forEach(function (k) { n += w.counts.queue[k]; });
        return n;
    };
    assert.ok(queueReads() >= 1, 'first label reads the queues');
    var before = queueReads();
    var zone = w.counts.zoneBuildings;
    var second = it.label({});
    assert.strictEqual(queueReads(), before, 'no queue reads');
    assert.strictEqual(w.counts.zoneBuildings, zone, 'no building-vector reads');
    assert.strictEqual(second, first);
});
