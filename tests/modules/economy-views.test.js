'use strict';

// The builders of the economy window's grid: tiles per row state, the
// storehouse tab strip, the grid body and the shared breaker banner. Rows
// are fixtures shaped as model.items() shapes them, so each case states only
// what it shows.

var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');

var assert = t.assert;

function setup() {
    var H = harness.boot();
    var $ = jq.install(H);
    var S = H.Steward;
    H.ctx.getImageTag = function (id, size) { return '<img ' + id + ' ' + size + '>'; };
    return { H: H, S: S, $: $, h: S.kernel.ui.helpers, V: S.modules.economy.views };
}

function row(o) {
    var r = {
        name: 'Wood', label: 'Wood', tab: 'WarehouseTab1', selected: true, live: true,
        star: 100, entries: [], store: 0, room: 500, next: 100, fits: 100, full: null,
        pending: null, state: 'ready'
    };
    for (var k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k];
    }
    return r;
}

function classes($t) { return ($t.attr('class') || '').split(' ').sort(); }

function part($t, cls) { return $t.find('.' + cls); }

t.test('economy views: tile classes and badge per row state', function () {
    var s = setup();
    var cases = [
        { r: { state: 'ready' },                     cls: ['is-on'],                badge: 'ready' },
        { r: { state: 'ready', selected: false },    cls: [],                       badge: null },
        { r: { state: 'idle', selected: false },     cls: [],                       badge: null },
        { r: { state: 'pending' },                   cls: ['is-on', 'is-pending'],  badge: 'sending' },
        { r: { state: 'stale' },                     cls: ['is-on', 'is-stale'],    badge: 'stale' },
        { r: { state: 'full', fits: 0 },             cls: ['is-full', 'is-on'],     badge: 'full' },
        { r: { state: 'warehouse', fits: 0 },        cls: ['is-on', 'is-warehouse'], badge: 'no room' },
        { r: { state: 'none', star: null, fits: null }, cls: ['is-none', 'is-on'],  badge: 'none in star' },
        { r: { state: 'offline' },                   cls: ['is-offline', 'is-on'],  badge: 'event over' },
        { r: { state: 'unknown', fits: null },       cls: ['is-on', 'is-unknown'],  badge: 'unknown' }
    ];
    for (var i = 0; i < cases.length; i++) {
        var c = cases[i];
        var $t = s.V.tile(s.h, row(c.r), {}, null);
        var want = ['steward-store-item'].concat(c.cls).sort();
        assert.deepStrictEqual(classes($t), want, 'classes of case ' + i);
        var $b = part($t, 'steward-store-badge');
        if (c.badge === null) assert.strictEqual($b.length, 0, 'no badge in case ' + i);
        else assert.strictEqual($b.text(), c.badge, 'badge of case ' + i);
        assert.strictEqual(part($t, 'steward-store-name').text(), 'Wood');
    }
});

t.test('economy views: fits line only for a number, star dash when unread', function () {
    var s = setup();
    var $a = s.V.tile(s.h, row({ star: 85, fits: 60 }), {}, null);
    assert.strictEqual(part($a, 'steward-store-star').text(), '85');
    assert.strictEqual(part($a, 'steward-store-fit').text(), 'fits 60');
    var $z = s.V.tile(s.h, row({ state: 'full', fits: 0 }), {}, null);
    assert.strictEqual(part($z, 'steward-store-fit').text(), 'fits 0');
    var $n = s.V.tile(s.h, row({ state: 'none', star: null, fits: null }), {}, null);
    assert.strictEqual(part($n, 'steward-store-star').text(), '-');
    assert.strictEqual(part($n, 'steward-store-fit').text(), '', 'no fits text without a number');
    assert.strictEqual(part($n, 'steward-store-fit').length, 1, 'the line is kept so tiles line up');
});

t.test('economy views: the tile icon is the host image tag at 32px', function () {
    var s = setup();
    var $t = s.V.tile(s.h, row({ name: 'Stone', label: 'Stone' }), {}, null);
    assert.strictEqual(part($t, 'steward-store-icon').html(), '<img Stone 32px>');
});

t.test('economy views: a tile click hands its name to toggle; refill keeps the node', function () {
    var s = setup();
    var seen = [];
    var $t = s.V.tile(s.h, row({ name: 'Stone', label: 'Stone', selected: false, state: 'idle' }), {},
        { toggle: function (name, $tile) { seen.push([name, $tile]); } });
    $t.trigger('click');
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0][0], 'Stone');
    assert.strictEqual(seen[0][1][0], $t[0]);
    var out = s.V.tile(s.h, row({ name: 'Stone', label: 'Stone', selected: true, state: 'ready' }), {}, null, $t);
    assert.strictEqual(out[0], $t[0], 'the same node is refilled');
    assert.ok($t.hasClass('is-on'));
    assert.strictEqual(part($t, 'steward-store-badge').text(), 'ready');
    $t.trigger('click');
    assert.strictEqual(seen.length, 2, 'the click handler is bound once');
});

function gridData() {
    return {
        tabs: [
            { key: 'WarehouseTab1', label: 'Raw materials', rows: [row({ name: 'Wood' })] },
            { key: 'WarehouseTab2', label: 'Refined goods', rows: [] },
            { key: 'WarehouseTab3', label: 'Weapons', rows: [row({ name: 'Bow', label: 'Bow' })] }
        ],
        other: [row({ name: 'Odd', label: 'Odd', tab: null })],
        readAt: 0
    };
}

function stripTexts(s, $s) {
    var out = [];
    $s.find('a').each(function () {
        var $a = s.$(this);
        out.push(($a.hasClass('active') ? '*' : '') + $a.text());
    });
    return out;
}

t.test('economy views: strip lists non-empty tabs in order then Other, marks the active one', function () {
    var s = setup();
    var picks = [];
    var $s = s.V.strip(gridData(), 'WarehouseTab3', function (k) { picks.push(k); });
    assert.ok($s.hasClass('steward-tabs') && $s.hasClass('steward-store-strip'));
    assert.deepStrictEqual(stripTexts(s, $s), ['Raw materials', '*Weapons', 'Other']);
    $s.find('a').eq(2).trigger('click');
    assert.deepStrictEqual(picks, ['other']);
    assert.deepStrictEqual(stripTexts(s, $s), ['Raw materials', 'Weapons', '*Other']);
    var none = gridData();
    none.other = [];
    assert.deepStrictEqual(stripTexts(s, s.V.strip(none, 'WarehouseTab1')), ['*Raw materials', 'Weapons']);
});

t.test('economy views: grid renders only the given rows; null gives the unreadable note', function () {
    var s = setup();
    var $c = s.$('<div>');
    s.V.grid($c, s.h, [row({ name: 'Wood' }), row({ name: 'Stone', label: 'Stone' })], {}, null);
    var names = [];
    $c.find('.steward-store-item').each(function () { names.push(s.$(this).find('.steward-store-name').text()); });
    assert.deepStrictEqual(names, ['Wood', 'Stone']);
    assert.strictEqual($c.find('.steward-store-grid').length, 1);
    s.V.grid($c, s.h, null, {}, null);
    assert.strictEqual($c.find('.steward-store-item').length, 0);
    assert.strictEqual($c.text(),
        'The star menu or storehouse could not be read. Nothing is sent until it can; reopen the window to retry.');
});

t.test('economy views: an icon placeholder schedules exactly one redraw', function () {
    var s = setup();
    s.H.ctx.getImageTag = function () { return '<span ph></span>'; };
    var calls = [];
    var h = {};
    for (var k in s.h) h[k] = s.h[k];
    h.redrawOnce = function ($holder, fn, ms) { calls.push({ $holder: $holder, fn: fn, ms: ms }); return true; };
    var redraw = function () {};
    var $c = s.$('<div>');
    s.V.grid($c, h, [row({ name: 'Wood' }), row({ name: 'Stone', label: 'Stone' })], {}, { redraw: redraw });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].$holder, $c);
    assert.strictEqual(calls[0].fn, redraw);
    assert.strictEqual(calls[0].ms, s.S.kernel.TIMEOUTS.PORTRAIT_RETRY_MS);
    s.H.ctx.getImageTag = function (id) { return '<img ' + id + '>'; };
    calls.length = 0;
    s.V.grid($c, h, [row({ name: 'Iron', label: 'Iron' })], {}, { redraw: redraw });
    assert.strictEqual(calls.length, 0, 'no redraw once the images read');
});

t.test('economy views: breakerBanner names the run and its Reset calls back', function () {
    var s = setup();
    var resets = 0;
    var $b = s.V.breakerBanner(s.h, { breaker: { open: true, run: 5 } }, function () { resets++; });
    assert.ok($b.text().indexOf('Transfers stopped after 5 sends the game did not confirm. ' +
        'Check the star and storehouse, then reset.') >= 0, $b.text());
    var hit = null;
    $b.find('button').each(function () { if (s.$(this).text() === 'Reset') hit = s.$(this); });
    assert.ok(hit, 'Reset button');
    hit.trigger('click');
    assert.strictEqual(resets, 1);
});

t.test('economy views: note per state, none for the others', function () {
    var s = setup();
    assert.strictEqual(s.V.note(s.h, 'off').text(),
        'Economy is off. The selection is kept and nothing moves until it is switched on in Settings.');
    assert.strictEqual(s.V.note(s.h, 'storehouse').text(),
        'The storehouse is full. Nothing can move until room is freed.');
    assert.strictEqual(s.V.note(s.h, 'empty').text(),
        'No resource items in the star menu right now. Selected items stay selected and show as none in star.');
    assert.ok(s.V.note(s.h, 'unreadable').text().indexOf('could not be read') > 0);
    assert.strictEqual(s.V.note(s.h, 'ready'), null);
    assert.strictEqual(s.V.note(s.h, 'breaker'), null);
});
