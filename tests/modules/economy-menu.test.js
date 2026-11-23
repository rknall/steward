'use strict';

// The ~Steward~ › Economy submenu: three fixed rows that are never rebuilt,
// a switch that writes only `enabled` and then runs the module's
// applySettings, a display-only status row, and the one set of status words
// (stateOf, statusText, statusLine) every economy surface reads.

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

// A booted steward with the economy settings stored as given, the settings
// writes, queue cancels and window opens recorded, and the model snapshot
// replaced by w.status.
function setup(stored) {
    var H = harness.boot();
    var S = H.Steward;
    if (stored) S.kernel.settings.write('economy', stored);
    var w = { S: S, writes: [], cancels: [], opens: 0, status: null };
    var write = S.kernel.settings.write;
    S.kernel.settings.write = function (id, val) {
        if (id !== 'economy') return write(id, val);
        w.writes.push(JSON.parse(JSON.stringify(val)));
        // The host store deep-merges a write into the namespace; the harness
        // stub replaces it, so merge here to keep the selection.
        var merged = JSON.parse(JSON.stringify(S.kernel.settings.read(id) || {}));
        for (var k in val) {
            if (Object.prototype.hasOwnProperty.call(val, k)) merged[k] = val[k];
        }
        return write(id, merged);
    };
    S.kernel.queue.cancelByModule = function (id) { w.cancels.push(id); return 0; };
    S.modules.economy.window = { open: function () { w.opens++; } };
    S.modules.economy.model.snapshot = function () { return w.status; };
    w.M = S.modules.economy.menu;
    w.items = function () { return w.M.items(); };
    w.label = function (it, pass) {
        return typeof it.label === 'function' ? it.label(pass || {}) : it.label;
    };
    return w;
}

function labels(w) {
    var its = w.items();
    var pass = {};
    var out = [];
    for (var i = 0; i < its.length; i++) out.push(w.label(its[i], pass));
    return out;
}

// A status object as model.status() shapes it, on, with the given counts.
function st(o) {
    var s = {
        enabled: true, selected: 0, ready: 0, pending: 0, full: 0, warehouse: 0,
        offline: 0, unknown: 0, none: 0, readable: true, lastPass: null, lastMoved: null,
        breaker: { open: false, run: 0 }, stale: [], fullItems: [], readAt: 0
    };
    for (var k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k)) s[k] = o[k];
    }
    return s;
}

var AT = new Date(2026, 10, 9, 14, 2, 0).getTime();

t.test('economy menu: three rows in every state, the same rows on every call', function () {
    var cases = [
        { stored: { enabled: false }, status: null },
        { stored: { enabled: true, items: { Wood: true } }, status: st({ selected: 1, ready: 1 }) },
        { stored: null, status: st({ enabled: false }) },
        { stored: { enabled: true }, status: st({ breaker: { open: true, run: 5 } }) }
    ];
    for (var i = 0; i < cases.length; i++) {
        var w = setup(cases[i].stored);
        w.status = cases[i].status;
        var a = w.items();
        var b = w.items();
        assert.strictEqual(a.length, 3, 'case ' + i);
        for (var j = 0; j < 3; j++) assert.strictEqual(a[j], b[j], 'row ' + j + ' is not rebuilt');
        assert.strictEqual(w.S.kernel.registry.menuItems('economy', a).length, 3, 'registry keeps every row');
        assert.strictEqual(labels(w).join('|').indexOf('Transfer now'), -1, 'no Transfer now row');
    }
    var its = setup(null).items();
    assert.strictEqual(its[1].enabled, false, 'status row is display only');
    assert.strictEqual(its[1].onSelect, undefined);
    assert.strictEqual(its[2].label, 'Open economy manager…');
});

t.test('economy menu: the switch label follows enabled', function () {
    var w = setup({ enabled: true });
    assert.strictEqual(labels(w)[0], '✓ Economy');
    w.S.kernel.settings.write('economy', { enabled: false });
    assert.strictEqual(labels(w)[0], '✕ Economy');
    var none = setup(null);
    none.S.kernel.settings.write('economy', {});
    assert.strictEqual(labels(none)[0], '✕ Economy', 'a never stored switch reads as off');
});

t.test('economy menu: a flip goes through the module setEnabled once and writes only enabled', function () {
    var states = [true, false];
    for (var i = 0; i < states.length; i++) {
        var w = setup({ enabled: states[i], items: { Wood: true } });
        var E = w.S.modules.economy;
        var real = E.setEnabled;
        var calls = [];
        E.setEnabled = function (v) { calls.push(v); return real(v); };
        w.items()[0].onSelect();
        assert.deepStrictEqual(w.writes, [{ enabled: !states[i] }]);
        assert.deepStrictEqual(calls, [!states[i]]);
        assert.deepStrictEqual(w.S.kernel.settings.read('economy').items, { Wood: true }, 'selection kept');
    }
});

t.test('economy menu: off cancels the queued transfers, on cancels nothing', function () {
    var off = setup({ enabled: true });
    off.items()[0].onSelect();
    assert.deepStrictEqual(off.cancels, ['economy']);
    var on = setup({ enabled: false });
    on.items()[0].onSelect();
    assert.deepStrictEqual(on.cancels, []);
});

t.test('economy menu: without the lifecycle slot a flip still writes, cancels and does not throw', function () {
    var w = setup({ enabled: true });
    delete w.S.kernel.lifecycle.applySettings.economy;
    var errors = 0;
    var err = w.S.kernel.error;
    w.S.kernel.error = function () { errors++; return err.apply(w.S.kernel, arguments); };
    w.items()[0].onSelect();
    assert.deepStrictEqual(w.writes, [{ enabled: false }]);
    assert.deepStrictEqual(w.cancels, ['economy'], 'the module runs its own off path');
    assert.strictEqual(errors, 0);
});

t.test('economy menu: the open row opens the economy window and writes nothing', function () {
    var w = setup({ enabled: true });
    w.items()[2].onSelect();
    assert.strictEqual(w.opens, 1);
    assert.strictEqual(w.writes.length, 0);
    w.M.openWindow();
    assert.strictEqual(w.opens, 2, 'the exported opener is the row one');
});

t.test('economy menu: the status row reads one snapshot per pass and shows statusLine', function () {
    var w = setup({ enabled: true });
    var calls = 0;
    w.S.modules.economy.model.snapshot = function () {
        calls++;
        return st({ selected: 6, ready: 3, lastPass: { at: AT } });
    };
    var it = w.items()[1];
    var pass = {};
    assert.strictEqual(it.label(pass), '6 selected · 3 ready · last pass 14:02');
    it.label(pass);
    assert.strictEqual(calls, 1);
    it.label({});
    assert.strictEqual(calls, 2);
    w.S.modules.economy.model.snapshot = function () { return null; };
    assert.strictEqual(it.label({}), 'Economy off');
});

t.test('economy menu: stateOf gives each of the nine states', function () {
    var M = setup(null).M;
    assert.strictEqual(M.stateOf(st({ enabled: false, selected: 3, ready: 3 })), 'off');
    assert.strictEqual(M.stateOf(st({ breaker: { open: true, run: 5 } })), 'breaker');
    assert.strictEqual(M.stateOf(st({ readable: false })), 'unreadable');
    assert.strictEqual(M.stateOf(st({ selected: 2, warehouse: 2 })), 'storehouse');
    assert.strictEqual(M.stateOf(st({ selected: 2, full: 1, ready: 1 })), 'full');
    assert.strictEqual(M.stateOf(st({ selected: 2, pending: 1, ready: 1 })), 'sending');
    assert.strictEqual(M.stateOf(st({ selected: 2, none: 2 })), 'empty');
    assert.strictEqual(M.stateOf(st({ selected: 2, ready: 1 })), 'ready');
    assert.strictEqual(M.stateOf(st({ selected: 2 })), 'idle');
});

t.test('economy menu: stateOf follows the precedence', function () {
    var M = setup(null).M;
    assert.strictEqual(M.stateOf(st({ breaker: { open: true }, selected: 2, full: 2 })), 'breaker', 'breaker over full');
    assert.strictEqual(M.stateOf(st({ breaker: { open: true }, readable: false })), 'breaker', 'breaker over unreadable');
    assert.strictEqual(M.stateOf(st({ selected: 3, full: 1, pending: 1 })), 'full', 'full over sending');
    assert.strictEqual(M.stateOf(st({ selected: 3, warehouse: 1, ready: 1 })), 'ready', 'storehouse only with nothing ready');
    assert.strictEqual(M.stateOf(st({ selected: 3, warehouse: 1, pending: 1 })), 'sending', 'storehouse only with nothing pending');
    assert.strictEqual(M.stateOf(st({ selected: 3, warehouse: 1, full: 1 })), 'storehouse', 'storehouse over full');
    assert.strictEqual(M.stateOf(st({ selected: 3, none: 1, offline: 2 })), 'empty', 'empty counts offline');
    assert.strictEqual(M.stateOf(st({ selected: 3, offline: 3 })), 'empty');
    assert.strictEqual(M.stateOf(st({ selected: 3, none: 1, offline: 1 })), 'idle', 'empty needs every selected row');
    assert.strictEqual(M.stateOf(st({ selected: 0 })), 'idle', 'nothing selected is not empty');
    assert.strictEqual(M.stateOf(null), 'off');
    var empty = setup(null).S.modules.economy.model.emptyStatus();
    assert.strictEqual(M.stateOf(empty), 'off');
});

t.test('economy menu: statusText gives the table words', function () {
    var M = setup(null).M;
    assert.strictEqual(M.statusText(null), 'Economy off');
    assert.strictEqual(M.statusText(st({ enabled: false, selected: 6 })), 'Economy off');
    assert.strictEqual(M.statusText(st({ breaker: { open: true, run: 5 } })), 'transfers paused');
    assert.strictEqual(M.statusText(st({ readable: false })), 'star menu unreadable');
    assert.strictEqual(M.statusText(st({ selected: 6, warehouse: 2 })), '6 selected · storehouse full');
    assert.strictEqual(M.statusText(st({ selected: 6, full: 2, ready: 1 })), '6 selected · 2 full');
    assert.strictEqual(M.statusText(st({ selected: 6, pending: 1, ready: 2 })), '6 selected · 1 sending');
    assert.strictEqual(M.statusText(st({ selected: 6, none: 4, offline: 2 })), '6 selected · star menu empty');
    assert.strictEqual(M.statusText(st({ selected: 6, ready: 3 })), '6 selected · 3 ready');
    assert.strictEqual(M.statusText(st({ selected: 0 })), 'no items selected');
    assert.strictEqual(M.statusText(st({ selected: 4 })), '4 selected · nothing to move');
});

t.test('economy menu: idle names unreadable rows', function () {
    var M = setup(null).M;
    assert.strictEqual(M.statusText(st({ selected: 2, unknown: 2 })), '2 selected · 2 unreadable');
    assert.strictEqual(M.statusText(st({ selected: 2, unknown: 0 })), '2 selected · nothing to move');
});

t.test('economy menu: statusLine adds the last pass only in the listed states', function () {
    var M = setup(null).M;
    var lp = { at: AT };
    var suffix = ' · last pass 14:02';
    var withPass = [
        st({ selected: 6, full: 1, lastPass: lp }),
        st({ selected: 6, pending: 1, lastPass: lp }),
        st({ selected: 6, ready: 3, lastPass: lp }),
        st({ selected: 6, lastPass: lp }),
        st({ selected: 0, lastPass: lp }),
        st({ selected: 2, none: 2, lastPass: lp })
    ];
    for (var i = 0; i < withPass.length; i++) {
        assert.strictEqual(M.statusLine(withPass[i]), M.statusText(withPass[i]) + suffix, M.stateOf(withPass[i]));
    }
    var without = [
        st({ enabled: false, lastPass: lp }),
        st({ breaker: { open: true }, lastPass: lp }),
        st({ readable: false, lastPass: lp }),
        st({ selected: 2, warehouse: 2, lastPass: lp })
    ];
    for (var j = 0; j < without.length; j++) {
        assert.strictEqual(M.statusLine(without[j]), M.statusText(without[j]), M.stateOf(without[j]));
    }
    assert.strictEqual(M.statusLine(st({ selected: 6, ready: 3, lastPass: { at: 'x' } })), '6 selected · 3 ready');
    assert.strictEqual(M.statusLine(st({ selected: 6, ready: 3, lastPass: null })), '6 selected · 3 ready');
    assert.strictEqual(M.statusLine(null), 'Economy off');
});
