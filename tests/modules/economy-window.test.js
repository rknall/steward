'use strict';

// The Steward economy window, driven through the element tree the jq fake
// builds: the Modal stand-in hands out real Body and Footer elements, so a
// case clicks the same controls a user would. The read model is replaced by
// fixture rows that follow the stored selection, so each case states only
// what it shows; the module's own toggle and the menu's status words run.

var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');
var hostStubs = require('../stubs/host');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

var TABS = [
    { key: 'WarehouseTab1', label: 'Raw materials' },
    { key: 'WarehouseTab2', label: 'Refined goods' }
];

function status(o) {
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

function setup(stored) {
    var H = harness.boot();
    var $ = jq.install(H);
    var rig = hostStubs.installModal(H);
    var S = H.Steward;
    H.ctx.getImageTag = function (id) { return '<img ' + id + '>'; };
    S.kernel.ui.ensureStyle = function () {};
    var w = { H: H, S: S, $: $, rig: rig, writes: [], applies: 0, resets: [], resolves: [],
              st: status({}), gridNull: false, base: [] };
    H.ctx.Modal.prototype.show = function () {};
    H.ctx.Modal.prototype.hide = function () {};
    S.kernel.settings.write('economy', stored || { enabled: true, items: {} });
    var write = S.kernel.settings.write;
    S.kernel.settings.write = function (id, val) {
        if (id !== 'economy') return write(id, val);
        w.writes.push(plain(val));
        // The host store deep-merges; the harness stub replaces, so merge here.
        var merged = plain(S.kernel.settings.read(id) || {});
        for (var k in val) {
            if (!Object.prototype.hasOwnProperty.call(val, k)) continue;
            if (k === 'items') {
                merged.items = merged.items || {};
                for (var n in val.items) merged.items[n] = val.items[n];
            } else merged[k] = val[k];
        }
        return write(id, merged);
    };
    S.kernel.lifecycle.applySettings.economy = function () { w.applies++; };
    S.kernel.queue.cancelByModule = function () { return 0; };
    // Rows as the model shapes them; selected follows the stored settings.
    w.base = [
        { name: 'Wood',  label: 'Wood',  tab: 'WarehouseTab1', star: 100, fits: 100, state: 'ready' },
        { name: 'Stone', label: 'Stone', tab: 'WarehouseTab1', star: 85,  fits: 60,  state: 'ready' },
        { name: 'Iron',  label: 'Iron bar', tab: 'WarehouseTab2', star: 45, fits: 45, state: 'ready' }
    ];
    var M = S.modules.economy;
    M.model.items = function () {
        var sel = M.readSettings().items;
        var out = [];
        for (var i = 0; i < w.base.length; i++) {
            var r = plain(w.base[i]);
            r.selected = sel[r.name] === true;
            if (!r.selected && r.state === 'ready') r.state = 'idle';
            out.push(r);
        }
        return out;
    };
    M.model.grid = function () {
        if (w.gridNull) return null;
        var rows = M.model.items();
        var tabs = [];
        var other = [];
        for (var i = 0; i < TABS.length; i++) tabs.push({ key: TABS[i].key, label: TABS[i].label, rows: [] });
        for (var j = 0; j < rows.length; j++) {
            var hit = null;
            for (var k = 0; k < tabs.length; k++) if (tabs[k].key === rows[j].tab) hit = tabs[k];
            if (hit) hit.rows.push(rows[j]);
            else other.push(rows[j]);
        }
        var kept = [];
        for (var m = 0; m < tabs.length; m++) if (tabs[m].rows.length) kept.push(tabs[m]);
        return { tabs: kept, other: other, readAt: 0 };
    };
    M.model.status = function () { return w.st; };
    S.core.ledger.breaker = function (owner) {
        return { reset: function (by) { w.resets.push([owner, by]); }, snapshot: function () { return w.st.breaker; } };
    };
    S.core.ledger.resolve = function (key, by) { w.resolves.push([key, by]); return true; };
    w.win = M.window;
    w.open = function (tab) { w.win.open(tab); rig.visible = true; };
    return w;
}

function body(w) { return w.rig.made[w.rig.made.length - 1].modal.Body(); }
function footer(w) { return w.rig.made[w.rig.made.length - 1].modal.Footer(); }

function byText($root, $, tag, label) {
    var hit = null;
    $root.find(tag).each(function () {
        if (!hit && $(this).text() === label) hit = $(this);
    });
    return hit;
}

function click(w, tag, label) {
    var hit = byText(body(w), w.$, tag, label);
    assert.ok(hit, tag + ' "' + label + '" exists');
    hit.trigger('click');
}

function chipLabels(w) {
    var out = [];
    body(w).find('.steward-chips').eq(0).children('button').each(function () {
        var $b = w.$(this);
        out.push(($b.hasClass('active') ? '*' : '') + $b.text());
    });
    return out;
}

function stripLabels(w) {
    var out = [];
    body(w).find('.steward-store-strip a').each(function () {
        var $a = w.$(this);
        out.push(($a.hasClass('active') ? '*' : '') + $a.text());
    });
    return out;
}

function tileNames(w) {
    var out = [];
    body(w).find('.steward-store-item').each(function () {
        out.push(w.$(this).find('.steward-store-name').text());
    });
    return out;
}

function tileOf(w, label) {
    var hit = null;
    body(w).find('.steward-store-item').each(function () {
        if (!hit && w.$(this).find('.steward-store-name').text() === label) hit = w.$(this);
    });
    assert.ok(hit, 'tile ' + label);
    return hit;
}

t.test('economy window: opens on Star to store with two tabs and no Advisor', function () {
    var w = setup();
    w.open();
    assert.strictEqual(w.rig.made[0].id, 'StewardEconomy');
    assert.strictEqual(w.rig.made[0].title, 'Steward economy');
    assert.deepStrictEqual(chipLabels(w), ['*Star to store', 'Settings']);
    assert.strictEqual(byText(body(w), w.$, 'button', 'Advisor'), null);
    var w2 = setup();
    w2.open('advisor');
    assert.deepStrictEqual(chipLabels(w2), ['*Star to store', 'Settings'], 'an unknown tab falls back to store');
    assert.strictEqual(footer(w).text().indexOf('Click a tile to select it; changes apply at once'), 0);
    assert.ok(byText(footer(w), w.$, 'button', 'Close'));
});

t.test('economy window: header badge per state', function () {
    var rows = [
        { st: status({ enabled: false }),                                  kind: 'off',    text: 'Economy off' },
        { st: status({ breaker: { open: true, run: 5 } }),                 kind: 'paused', text: 'Breaker open' },
        { st: status({ readable: false }),                                 kind: 'paused', text: 'Unreadable' },
        { st: status({ selected: 2, warehouse: 2 }),                       kind: 'paused', text: 'Storehouse full' },
        { st: status({ selected: 2, pending: 1, ready: 1 }),               kind: 'busy',   text: 'Sending' },
        { st: status({ selected: 2, full: 1, ready: 1 }),                  kind: 'ok',     text: 'Economy on' },
        { st: status({ selected: 2, ready: 2 }),                           kind: 'ok',     text: 'Economy on' },
        { st: status({ selected: 2, none: 2 }),                            kind: 'ok',     text: 'Economy on' },
        { st: status({ selected: 0 }),                                     kind: 'ok',     text: 'Economy on' }
    ];
    var kinds = {};
    for (var i = 0; i < rows.length; i++) {
        var w = setup();
        w.st = rows[i].st;
        w.open();
        var $head = body(w).find('.steward-subhead').eq(0);
        var $badge = $head.find('.steward-badge').eq(0);
        assert.strictEqual($badge.text(), rows[i].text, 'badge text of row ' + i);
        assert.ok($badge.hasClass('steward-b-' + rows[i].kind), 'badge kind of row ' + i);
        kinds[rows[i].kind] = true;
        var words = w.S.modules.economy.menu.statusText(rows[i].st);
        assert.strictEqual($head.text(), rows[i].text + ' ' + words, 'status line of row ' + i);
    }
    assert.deepStrictEqual(Object.keys(kinds).sort(), ['busy', 'off', 'ok', 'paused']);
});

t.test('economy window: each state note under the status line', function () {
    var cases = [
        { st: status({ enabled: false }), text: 'Economy is off. The selection is kept and nothing moves until it is switched on in Settings.' },
        { st: status({ selected: 2, warehouse: 2 }), text: 'The storehouse is full. Nothing can move until room is freed.' },
        { st: status({ selected: 2, none: 2 }), text: 'No resource items in the star menu right now. Selected items stay selected and show as none in star.' },
        { st: status({ readable: false }), text: 'The star menu or storehouse could not be read. Nothing is sent until it can; reopen the window to retry.' }
    ];
    for (var i = 0; i < cases.length; i++) {
        var w = setup();
        w.st = cases[i].st;
        w.open();
        assert.ok(byText(body(w), w.$, 'div', cases[i].text), 'note of case ' + i);
    }
    var r = setup();
    r.open();
    assert.strictEqual(byText(body(r), r.$, 'div', cases[0].text), null, 'no note while ready');
});

t.test('economy window: breaker banner and its Reset reset the ledger breaker', function () {
    var w = setup();
    w.st = status({ breaker: { open: true, run: 5 } });
    w.open();
    var $banner = body(w).find('.steward-banner').eq(0);
    assert.ok($banner.text().indexOf('Transfers stopped after 5 sends') >= 0);
    click(w, 'button', 'Reset');
    assert.deepStrictEqual(w.resets, [['economy', 'the user']]);
});

t.test('economy window: an unreadable grid gives the note and no strip', function () {
    var w = setup();
    w.gridNull = true;
    w.open();
    assert.strictEqual(body(w).find('.steward-store-strip').length, 0);
    assert.strictEqual(body(w).find('.steward-store-item').length, 0);
    assert.ok(byText(body(w), w.$, 'div',
        'The star menu or storehouse could not be read. Nothing is sent until it can; reopen the window to retry.'));
});

t.test('economy window: storeTab defaults to the first tab, survives a redraw, falls back when empty', function () {
    var w = setup({ enabled: true, items: { Wood: true } });
    w.open();
    assert.deepStrictEqual(stripLabels(w), ['*Raw materials', 'Refined goods']);
    assert.deepStrictEqual(tileNames(w), ['Wood', 'Stone']);
    click(w, 'a', 'Refined goods');
    assert.deepStrictEqual(tileNames(w), ['Iron bar']);
    w.win.redraw();
    assert.deepStrictEqual(stripLabels(w), ['Raw materials', '*Refined goods'], 'kept across a redraw');
    assert.deepStrictEqual(tileNames(w), ['Iron bar']);
    w.base.pop();
    w.win.redraw();
    assert.deepStrictEqual(stripLabels(w), ['*Raw materials'], 'falls back to the first');
    assert.deepStrictEqual(tileNames(w), ['Wood', 'Stone']);
});

t.test('economy window: a strip click swaps only the grid body', function () {
    var w = setup();
    w.open();
    var $head = body(w).find('.steward-subhead').eq(0);
    var $strip = body(w).find('.steward-store-strip').eq(0);
    click(w, 'a', 'Refined goods');
    assert.strictEqual(body(w).find('.steward-subhead').eq(0)[0], $head[0], 'header stays');
    assert.strictEqual(body(w).find('.steward-store-strip').eq(0)[0], $strip[0], 'strip stays');
    assert.deepStrictEqual(tileNames(w), ['Iron bar']);
});

t.test('economy window: a tile click writes one items key and refills only that tile', function () {
    var w = setup({ enabled: true, items: { Wood: true } });
    w.open();
    var $wood = tileOf(w, 'Wood');
    var $stone = tileOf(w, 'Stone');
    var woodKids = $wood[0].children.slice();
    assert.ok($wood.hasClass('is-on'));
    assert.ok(!$stone.hasClass('is-on'));
    w.writes.length = 0;
    $stone.trigger('click');
    assert.deepStrictEqual(w.writes, [{ items: { Stone: true } }]);
    assert.strictEqual(w.S.modules.economy.readSettings().items.Wood, true, 'other keys kept');
    assert.ok(tileOf(w, 'Stone').hasClass('is-on'), 'is-on flipped');
    assert.strictEqual(tileOf(w, 'Stone')[0], $stone[0], 'the same tile node');
    assert.strictEqual(tileOf(w, 'Wood')[0], $wood[0], 'the other tile is the same node');
    assert.deepStrictEqual($wood[0].children, woodKids, 'and its children are untouched');
    assert.strictEqual($stone.find('.steward-store-badge').text(), 'ready');
    $stone.trigger('click');
    assert.deepStrictEqual(w.writes[1], { items: { Stone: false } });
    assert.ok(!tileOf(w, 'Stone').hasClass('is-on'));
});

t.test('economy window: the Settings switch writes enabled at once', function () {
    var w = setup({ enabled: true, items: { Wood: true } });
    w.open('settings');
    assert.deepStrictEqual(chipLabels(w), ['Star to store', '*Settings']);
    var $sw = body(w).find('.steward-field').eq(0).find('input').eq(0);
    $sw.prop('checked', false);
    $sw.trigger('change');
    assert.deepStrictEqual(w.writes, [{ enabled: false }]);
    assert.strictEqual(w.applies, 1);
    assert.strictEqual(w.S.modules.economy.readSettings().items.Wood, true);
});

t.test('economy window: Settings breaker badge and Reset', function () {
    var w = setup();
    w.open('settings');
    var $f = body(w).find('.steward-field').eq(1);
    assert.strictEqual($f.find('.steward-badge').text(), 'Closed');
    assert.ok($f.find('.steward-badge').hasClass('steward-b-ok'));
    var o = setup();
    o.st = status({ breaker: { open: true, run: 5 } });
    o.open('settings');
    var $g = body(o).find('.steward-field').eq(1);
    assert.strictEqual($g.find('.steward-badge').text(), 'Open');
    assert.ok($g.find('.steward-badge').hasClass('steward-b-paused'));
    $g.find('button').eq(0).trigger('click');
    assert.deepStrictEqual(o.resets, [['economy', 'the user']]);
});

t.test('economy window: stale sends line and Clear', function () {
    var w = setup();
    var sentAt = new Date(2026, 10, 9, 14, 2, 0).getTime();
    w.S.core.locale.res = function (n) { return n === 'Wood' ? 'Wood' : n; };
    w.st = status({ stale: [{ key: 'store|home|Wood', name: 'Wood', label: 'star to store Wood 100',
        state: 'stale', sentAt: sentAt }] });
    w.open('settings');
    var line = 'Wood · sent 14:02, never seen';
    assert.ok(byText(body(w), w.$, 'span', line), 'stale line');
    assert.ok(body(w).text().indexOf('100') < 0, 'no amount and not the def label');
    click(w, 'button', 'Clear');
    assert.deepStrictEqual(w.resolves, [['store|home|Wood', 'the user']]);
    var e = setup();
    e.open('settings');
    assert.ok(byText(body(e), e.$, 'div', 'No stale sends.'));
    var n = setup();
    n.st = status({ stale: [{ key: 'k', name: 'Wood', state: 'stale', sentAt: null }] });
    n.open('settings');
    assert.ok(byText(body(n), n.$, 'span', 'Wood · sent -, never seen'));
});

t.test('economy window: a throwing view leaves the failure line', function () {
    var w = setup();
    w.S.modules.economy.model.grid = function () { throw new Error('boom'); };
    w.open();
    var hit = null;
    body(w).find('.steward-bad').each(function () { hit = w.$(this).text(); });
    assert.strictEqual(hit, 'This view could not be shown: boom (details in the console log)');
    assert.strictEqual(body(w).find('.steward-chips').length, 1, 'the tab bar is still there');
});
