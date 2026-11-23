'use strict';

// The economy dashboard tab and Overview tile, drawn into the jq fake's
// element tree. The model's snapshot is replaced by one fixed status, so
// each case states only the numbers the view shows; the menu's status words
// run as they are.

var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

var AT = new Date(2026, 0, 1, 14, 5).getTime();

function status(o) {
    var s = {
        enabled: true, selected: 0, ready: 0, pending: 0, full: 0, warehouse: 0,
        offline: 0, unknown: 0, none: 0, readable: true, lastPass: null, lastMoved: null,
        breaker: { open: false, run: 0 }, stale: [], fullItems: [], readAt: 0
    };
    for (var k in (o || {})) {
        if (Object.prototype.hasOwnProperty.call(o, k)) s[k] = o[k];
    }
    return s;
}

function setup(o) {
    o = o || {};
    var H = harness.boot();
    var $ = jq.install(H);
    var S = H.Steward;
    var M = S.modules.economy;
    S.kernel.settings.write('economy', { enabled: o.enabled !== false, items: { Wood: true } });
    var w = { H: H, S: S, $: $, h: S.kernel.ui.helpers, st: status(o.status), moved: o.moved || [],
              writes: [], applies: 0, resets: [], opened: 0, banners: [] };
    var write = S.kernel.settings.write;
    S.kernel.settings.write = function (id, val) {
        if (id === 'economy') w.writes.push(plain(val));
        // The host store deep-merges; the harness stub replaces, so merge here.
        var merged = plain(S.kernel.settings.read(id) || {});
        for (var k in val) {
            if (Object.prototype.hasOwnProperty.call(val, k)) merged[k] = val[k];
        }
        return write(id, merged);
    };
    S.kernel.lifecycle.applySettings.economy = function () { w.applies++; };
    M.model.snapshot = function () { return w.st; };
    M.model.status = function () { throw new Error('status must not be read'); };
    M.model.grid = function () { throw new Error('grid must not be read'); };
    M.model.items = function () { throw new Error('items must not be read'); };
    M.moved = function () { return w.moved.slice(); };
    S.core.locale.res = function (n) { return n === 'Iron' ? 'Iron bar' : n; };
    S.core.ledger.breaker = function (owner) {
        return { reset: function (by) { w.resets.push([owner, by]); }, snapshot: function () { return w.st.breaker; } };
    };
    M.window = { open: function () { w.opened++; } };
    var banner = M.views.breakerBanner;
    M.views.breakerBanner = function (h, st, onReset) {
        var $b = banner(h, st, onReset);
        w.banners.push($b);
        return $b;
    };
    return w;
}

function draw(w, part) {
    var $el = w.$('<div>');
    w.S.modules.economy.ui[part]($el, w.h);
    return $el;
}

function tile(w) {
    var list = w.S.modules.economy.ui.tiles(w.h);
    assert.strictEqual(list.length, 1);
    return list[0];
}

function byText($root, $, tag, label) {
    var hit = null;
    $root.find(tag).each(function () {
        if (!hit && $(this).text() === label) hit = $(this);
    });
    return hit;
}

function cardTitles(w, $root) {
    var out = [];
    $root.find('.steward-card-h').each(function () { out.push(w.$(this).text()); });
    return out;
}

function statsOf(w, $root) {
    var out = {};
    $root.find('.steward-stat').each(function () {
        out[w.$(this).find('.steward-stat-k').text()] = w.$(this).find('.steward-stat-v').text();
    });
    return out;
}

function hasCard(w, $root, title) {
    return cardTitles(w, $root).indexOf(title) !== -1;
}

// The states the approved tab page shows, plus storehouse and unreadable.
var STATES = {
    off:        status({ enabled: false, selected: 2 }),
    idle:       status({ selected: 2 }),
    moving:     status({ selected: 2, ready: 2 }),
    someFull:   status({ selected: 2, full: 1, ready: 1, fullItems: [{ name: 'Wood', label: 'Wood', back: 240, at: AT }] }),
    breaker:    status({ selected: 2, ready: 2, full: 1, breaker: { open: true, run: 5 } }),
    storehouse: status({ selected: 2, warehouse: 2 }),
    unreadable: status({ selected: 2, readable: false })
};

t.test('economy ui: the module delegates its section to ui.js', function () {
    var w = setup();
    var mod = w.H.module('economy');
    assert.strictEqual(mod.ui.tab, 'economy');
    var list = mod.ui.section.tiles(w.h);
    assert.strictEqual(list[0].title, 'Economy');
    assert.strictEqual(mod.ui.section.summary(w.h), w.S.modules.economy.menu.statusText(w.st));
});

t.test('economy ui: every part draws with emptyStatus and each tab state', function () {
    var w0 = setup();
    var M = w0.S.modules.economy;
    // No snapshot: the parts fall back to the model's own emptyStatus.
    M.model.snapshot = function () { return null; };
    draw(w0, 'render');
    draw(w0, 'side');
    assert.strictEqual(w0.S.modules.economy.ui.summary(w0.h), 'Economy off');
    assert.strictEqual(tile(w0).badge.text, 'Off');
    for (var name in STATES) {
        var w = setup();
        w.st = STATES[name];
        var $main = draw(w, 'render');
        var $side = draw(w, 'side');
        var words = w.S.modules.economy.menu.statusText(w.st);
        assert.strictEqual(w.S.modules.economy.ui.summary(w.h), words, 'summary of ' + name);
        assert.ok($side.text().indexOf(words) !== -1, 'side line of ' + name);
        assert.ok(hasCard(w, $main, 'Economy now'), 'now card of ' + name);
        assert.ok(hasCard(w, $main, 'Moved lately'), 'moved card of ' + name);
        assert.ok(hasCard(w, $main, 'Choose items in the economy manager'), 'pointer card of ' + name);
        assert.strictEqual(w.banners.length, name === 'breaker' ? 1 : 0, 'banner of ' + name);
        assert.strictEqual($main.find('.steward-store-grid').length, 0, 'no grid in the tab');
    }
});

t.test('economy ui: the main column keeps its order', function () {
    var w = setup();
    w.st = STATES.someFull;
    var $main = draw(w, 'render');
    assert.deepStrictEqual(cardTitles(w, $main),
        ['Economy now', 'Full items', 'Moved lately', 'Choose items in the economy manager']);
    assert.ok($main.text().indexOf('The grid of star items lives in the window') !== -1);
});

t.test('economy ui: Economy now stats, with Ready and Full dashed off and in breaker', function () {
    var w = setup({ status: { selected: 3, ready: 2, full: 1,
        lastMoved: { name: 'Iron', amount: 60, at: AT } } });
    var got = statsOf(w, draw(w, 'render'));
    assert.deepStrictEqual(got, { 'Selected': '3', 'Ready': '2', 'Full': '1', 'Last moved': 'Iron bar 60 · 14:05' });
    w.st = status({ enabled: false, selected: 3, ready: 2, full: 1 });
    got = statsOf(w, draw(w, 'render'));
    assert.deepStrictEqual(got, { 'Selected': '3', 'Ready': '-', 'Full': '-', 'Last moved': '-' });
    w.st = STATES.breaker;
    got = statsOf(w, draw(w, 'render'));
    assert.strictEqual(got.Ready, '-');
    assert.strictEqual(got.Full, '-');
});

t.test('economy ui: Full items only with full items, one line each', function () {
    var w = setup({ status: { selected: 2, ready: 1 } });
    assert.strictEqual(hasCard(w, draw(w, 'render'), 'Full items'), false);
    w.st = status({ selected: 2, full: 2, fullItems: [
        { name: 'Iron', label: 'Iron bar', back: 240, at: AT },
        { name: 'Wood', label: 'Wood', back: 35, at: AT }
    ] });
    var $main = draw(w, 'render');
    var lines = [];
    $main.find('.steward-card').each(function () {
        if (w.$(this).find('.steward-card-h').text() !== 'Full items') return;
        w.$(this).children('div').each(function () {
            if (!w.$(this).hasClass('steward-card-h')) lines.push(w.$(this).text());
        });
    });
    assert.deepStrictEqual(lines, ['Iron bar came back to the star menu (240)',
                                   'Wood came back to the star menu (35)']);
});

t.test('economy ui: Moved lately newest first, at most 5, empty text', function () {
    var w = setup();
    var $main = draw(w, 'render');
    assert.ok($main.find('table').text().indexOf('Nothing moved yet') !== -1);
    for (var i = 0; i < 7; i++) {
        w.moved.push({ name: i === 6 ? 'Iron' : 'Wood' + i, amount: 10 + i, at: AT });
    }
    $main = draw(w, 'render');
    var rows = [];
    $main.find('tbody tr').each(function () {
        var cells = [];
        w.$(this).children('td').each(function () { cells.push(w.$(this).text()); });
        rows.push(cells);
    });
    assert.deepStrictEqual(rows, [
        ['Iron bar', '16', '14:05'], ['Wood5', '15', '14:05'], ['Wood4', '14', '14:05'],
        ['Wood3', '13', '14:05'], ['Wood2', '12', '14:05']
    ]);
});

t.test('economy ui: the side switch writes only enabled and applies at once', function () {
    var w = setup();
    var $main = draw(w, 'render');
    var $side = draw(w, 'side');
    var $sw = $side.find('input[type=checkbox]').eq(0);
    assert.strictEqual($sw.prop('checked'), true);
    $sw.prop('checked', false);
    $sw.trigger('change');
    assert.deepStrictEqual(w.writes, [{ enabled: false }]);
    assert.strictEqual(w.applies, 1);
    assert.strictEqual(w.S.kernel.settings.read('economy').items.Wood, true, 'the selection is kept');
    w.st = status({ enabled: false, selected: 1 });
    // The model reads the switch; the fixture stands in for it here.
    $sw.prop('checked', true);
    $sw.trigger('change');
    assert.deepStrictEqual(w.writes, [{ enabled: false }, { enabled: true }]);
    assert.strictEqual(w.applies, 2);
    assert.ok($main.find('.steward-card-h').length > 0, 'the main column is redrawn in place');
});

t.test('economy ui: Reset resets the ledger breaker as the user and redraws', function () {
    var w = setup();
    w.st = STATES.breaker;
    var $main = draw(w, 'render');
    assert.strictEqual(w.banners.length, 1);
    assert.strictEqual($main.find('.steward-banner')[0], w.banners[0][0], 'the banner is the views node');
    assert.ok(w.banners[0].text().indexOf('Transfers stopped after 5 sends') !== -1);
    w.st = STATES.moving;
    var $reset = byText($main, w.$, 'button', 'Reset');
    assert.ok($reset, 'Reset button');
    $reset.trigger('click');
    assert.deepStrictEqual(w.resets, [['economy', 'the user']]);
    assert.strictEqual($main.find('.steward-banner').length, 0, 'the redraw drops the banner');
});

t.test('economy ui: every manager button opens the window', function () {
    var w = setup();
    var $side = draw(w, 'side');
    byText($side, w.$, 'button', 'Open manager').trigger('click');
    assert.strictEqual(w.opened, 1);
    var $main = draw(w, 'render');
    byText($main, w.$, 'button', 'Open economy manager…').trigger('click');
    assert.strictEqual(w.opened, 2);
    var tl = tile(w);
    assert.strictEqual(tl.links.length, 1);
    assert.strictEqual(tl.links[0].label, 'Manager');
    tl.links[0].onClick();
    assert.strictEqual(w.opened, 3);
});

t.test('economy ui: tile badge per state', function () {
    var rows = [
        { st: status({ enabled: false }),                             state: 'off',        kind: 'off',    text: 'Off' },
        { st: status({ breaker: { open: true, run: 5 } }),            state: 'breaker',    kind: 'paused', text: 'Breaker open' },
        { st: status({ readable: false }),                            state: 'unreadable', kind: 'paused', text: 'Unreadable' },
        { st: status({ selected: 2, warehouse: 2 }),                  state: 'storehouse', kind: 'paused', text: 'Some full' },
        { st: status({ selected: 2, full: 1, ready: 1 }),             state: 'full',       kind: 'paused', text: 'Some full' },
        { st: status({ selected: 2, pending: 1, ready: 1 }),          state: 'sending',    kind: 'busy',   text: 'Moving' },
        { st: status({ selected: 2, none: 2 }),                       state: 'empty',      kind: 'ok',     text: 'Idle' },
        { st: status({ selected: 2, ready: 2 }),                      state: 'ready',      kind: 'busy',   text: 'Moving' },
        { st: status({ selected: 0 }),                                state: 'idle',       kind: 'ok',     text: 'Idle' }
    ];
    var kinds = {};
    var w = setup();
    var menu = w.S.modules.economy.menu;
    for (var i = 0; i < rows.length; i++) {
        w.st = rows[i].st;
        assert.strictEqual(menu.stateOf(w.st), rows[i].state, 'fixture of row ' + i);
        var tl = tile(w);
        assert.deepStrictEqual(plain(tl.badge), { kind: rows[i].kind, text: rows[i].text }, 'badge of ' + rows[i].state);
        assert.strictEqual(tl.title, 'Economy');
        assert.strictEqual(tl.icon, '⚖');
        assert.deepStrictEqual(plain(tl.lines), [menu.statusLine(w.st)], 'line of ' + rows[i].state);
        kinds[rows[i].kind] = true;
    }
    assert.deepStrictEqual(Object.keys(kinds).sort(), ['busy', 'off', 'ok', 'paused']);
});

t.test('economy ui: the tile line carries the last pass time', function () {
    var w = setup({ status: { selected: 2, ready: 2, lastPass: { at: AT, queued: 2, names: [] } } });
    assert.deepStrictEqual(plain(tile(w).lines), ['2 selected · 2 ready · last pass 14:05']);
});

t.test('economy ui: nothing throws with every read null', function () {
    var w = setup();
    var M = w.S.modules.economy;
    M.model.snapshot = function () { throw new Error('no host'); };
    M.model.emptyStatus = function () { return null; };
    M.moved = function () { throw new Error('no module'); };
    M.readSettings = function () { throw new Error('no settings'); };
    w.S.core.locale.res = function () { throw new Error('no loca'); };
    var $main = draw(w, 'render');
    draw(w, 'side');
    assert.strictEqual(M.ui.summary(w.h), 'Economy off');
    assert.strictEqual(tile(w).badge.kind, 'off');
    assert.ok($main.find('table').text().indexOf('Nothing moved yet') !== -1);
    M.menu = null;
    M.views = null;
    w.st = STATES.breaker;
    draw(w, 'render');
    assert.strictEqual(M.ui.summary(w.h), '');
    assert.strictEqual(tile(w).badge.text, 'Off');
});
