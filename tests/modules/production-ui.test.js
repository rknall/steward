'use strict';

var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');

var assert = t.assert;

// The values are built in another realm, so compare by shape.
function same(a, b) { assert.strictEqual(JSON.stringify(a), JSON.stringify(b)); }

// A booted steward with the model's reads replaced by one fixed status, so
// each case states only the numbers the view shows.
function setup(o) {
    o = o || {};
    var H = harness.boot();
    jq.install(H);
    var S = H.Steward;
    H.settings.write('production', { enabled: o.enabled !== false });
    var calls = { queues: 0, buildings: 0 };
    var st = {
        enabled: true, queues: 2, types: 5, entries: 3, nextDoneAt: new Date(2026, 0, 1, 14, 5).getTime(),
        standing: 3, covered: 0, waiting: 1, shortfall: 0, held: 0,
        standingCovered: 0, standingHeld: 0, readAt: new Date(2026, 0, 1, 13, 0).getTime(),
        orderBreaker: { open: false, run: 0, nextProbeAt: 0 },
        buffBreaker: { open: false, run: 0, nextProbeAt: 0 },
        buffed: 1, buffable: 2, unreadable: 0, nextItem: null
    };
    for (var k in (o.status || {})) st[k] = o.status[k];
    var P = S.modules.production;
    // Every surface reads the snapshot; the live reads must stay unused.
    P.model.snapshot = function () { return st; };
    P.model.status = function () { throw new Error('status must not be read'); };
    P.model.queues = function () { calls.queues++; throw new Error('queues must not be read'); };
    P.model.buildings = function () { calls.buildings++; throw new Error('buildings must not be read'); };
    var opened = [];
    P.window = { open: function () { opened.push(true); } };
    return { H: H, S: S, h: S.kernel.ui.helpers, opened: opened, st: st, calls: calls };
}

function build(w, part) {
    var $el = w.H.ctx.$('<div>');
    w.S.modules.production[part]($el, w.h);
    return $el;
}

function tile(w) {
    var list = w.S.modules.production.tiles(w.h);
    assert.strictEqual(list.length, 1);
    return list[0];
}

t.test('the module registers a tab and tiles', function () {
    var w = setup();
    var mod = w.H.module('production');
    assert.strictEqual(typeof mod.ui.section.tiles, 'function');
    assert.strictEqual(typeof w.S.modules.production.side, 'function');
});

t.test('off tile', function () {
    var w = setup({ enabled: false });
    var tl = tile(w);
    assert.strictEqual(tl.title, 'Production');
    same(tl.badge, { kind: 'off', text: 'Off' });
    same(tl.lines, ['Auto-production off', 'Runs still produce their own items']);
    assert.strictEqual(tl.links[0].label, 'Manager');
});

t.test('breaker tile has the reset link', function () {
    var w = setup({ status: { orderBreaker: { open: true, run: 5, nextProbeAt: new Date(2026, 0, 1, 9, 7).getTime() } } });
    var tl = tile(w);
    assert.strictEqual(tl.badge.text, 'Breaker');
    same(tl.lines, ['Paused: 5 orders not seen', 'Opens again 09:07']);
    assert.strictEqual(tl.links[1].label, 'Reset');
    for (var i = 0; i < w.S.modules.production.orderBreaker.MISSES; i++) w.S.modules.production.orderBreaker.miss();
    assert.strictEqual(w.S.modules.production.orderBreaker.isOpen(), true);
    tl.links[1].onClick();
    assert.strictEqual(w.S.modules.production.orderBreaker.isOpen(), false);
});

t.test('idle tile when every standing row is covered or held', function () {
    var w = setup({
        status: { standing: 3, covered: 2, held: 1, standingCovered: 2, standingHeld: 1, nextItem: 'Bread' }
    });
    var tl = tile(w);
    same(tl.badge, { kind: 'ok', text: 'Idle' });
    same(tl.lines, ['3 automatic queues covered', 'Next done 14:05 · Bread']);
});

t.test('running tile', function () {
    var w = setup({ status: { waiting: 2, shortfall: 1 } });
    var tl = tile(w);
    same(tl.badge, { kind: 'busy', text: 'Running' });
    same(tl.lines, ['3 automatic queues · next done 14:05', '2 queues']);
    assert.ok(tl.lines.join(' ').indexOf('demand') < 0);
    tl.links[0].onClick();
    assert.strictEqual(w.opened.length, 1);
});

t.test('summary line', function () {
    var w = setup();
    assert.strictEqual(w.S.modules.production.summary(w.h), '3 automatic queues · next done 14:05');
});

t.test('side toggles bind their paths', function () {
    var w = setup();
    var $side = build(w, 'side');
    var names = [];
    $side.find('.steward-field-name').each(function (i, el) { names.push(w.H.ctx.$(el).text()); });
    same(names, ['Auto-production', 'Delay between actions', 'Orders per pass',
        'Buffs per pass', 'Automatic queues', 'Building buffs']);
    var $boxes = $side.find('input[type=checkbox]');
    assert.strictEqual($boxes.length, 3);
    $boxes.eq(1).prop('checked', false).trigger('change');
    assert.strictEqual(w.h.get('production', 'standing'), false);
});

t.test('side caps accept only 1 to 5', function () {
    var w = setup();
    var $side = build(w, 'side');
    var $in = $side.find('input[type=text]');
    var cap = $in.eq(1);
    cap.val('9').trigger('change');
    assert.notStrictEqual(w.h.get('production', 'ordersPerPass'), 9);
    cap.val('4').trigger('change');
    assert.strictEqual(w.h.get('production', 'ordersPerPass'), 4);
});

t.test('side stats and breaker badge', function () {
    var w = setup();
    var $stats = build(w, 'side').find('.steward-stat');
    assert.strictEqual($stats.length, 3);
    assert.strictEqual($stats.eq(0).find('.steward-stat-v').text(), '3 active');
    assert.strictEqual($stats.eq(0).find('.steward-stat-k').text(), 'Automatic queues');
    assert.strictEqual($stats.eq(1).find('.steward-stat-v').text(), '1 of 2');
    assert.strictEqual($stats.eq(2).find('.steward-badge').text(), 'closed');
    w.st.orderBreaker = { open: true, run: 5, nextProbeAt: 0 };
    $stats = build(w, 'side').find('.steward-stat');
    assert.strictEqual($stats.eq(2).find('.steward-badge').text(), 'open');
});

t.test('side has no queue stat and shows buffed N of M from the snapshot', function () {
    var w = setup({ status: { queues: 9, types: 12, buffed: 3, buffable: 4 } });
    var $side = build(w, 'side');
    assert.ok($side.text().indexOf('Queues running') < 0, $side.text());
    assert.ok($side.text().indexOf('Buildings buffed') >= 0);
    assert.strictEqual($side.find('.steward-stat').eq(1).find('.steward-stat-v').text(), '3 of 4');
});

t.test('Production now reads the snapshot', function () {
    var w = setup({ status: { queues: 9, types: 12 } });
    var $main = build(w, 'render');
    assert.strictEqual($main.find('.steward-stat').eq(0).find('.steward-stat-v').text(), '9 of 12');
    assert.strictEqual(w.S.modules.production.summary(w.h), '3 automatic queues · next done 14:05');
    assert.strictEqual(tile(w).lines[1], '9 queues');
});

t.test('main shows the card, the pointer and the open button', function () {
    var done = new Date(2026, 0, 1, 15, 30).getTime();
    var w = setup({
        status: { buffed: 2, booksItem: 'Tome', booksDoneAt: done }
    });
    var $main = build(w, 'render');
    assert.strictEqual($main.find('.steward-banner').length, 0);
    var stats = $main.find('.steward-stat');
    assert.strictEqual(stats.eq(1).find('.steward-stat-k').text(), 'Next done');
    assert.strictEqual(stats.eq(1).find('.steward-stat-v').text(), '14:05');
    assert.strictEqual(stats.length, 2, 'no Demand or Short stat');
    assert.ok(/3 automatic queues · 2 buildings buffed · Bookbinder: Tome done 15:30/.test($main.text()), $main.text());
    assert.ok($main.text().indexOf('Automatic queues and queues live in the production manager') >= 0, 'pointer card title');
    $main.find('button').trigger('click');
    assert.strictEqual(w.opened.length, 1);
});

t.test('a dashboard draw never reads the queues or the buildings', function () {
    var w = setup({ status: { booksItem: 'Tome', booksDoneAt: null } });
    build(w, 'render');
    build(w, 'side');
    w.S.modules.production.summary(w.h);
    w.S.modules.production.tiles(w.h);
    assert.strictEqual(w.calls.queues, 0);
    assert.strictEqual(w.calls.buildings, 0);
});

t.test('no Bookbinder item gives no Bookbinder text', function () {
    var w = setup({ status: { booksItem: null, booksDoneAt: null } });
    assert.ok(build(w, 'render').text().indexOf('Bookbinder:') < 0);
});

t.test('banner and Reset while a breaker is open', function () {
    var w = setup({ status: { orderBreaker: { open: true, run: 5, nextProbeAt: new Date(2026, 0, 1, 9, 7).getTime() } } });
    for (var i = 0; i < w.S.modules.production.orderBreaker.MISSES; i++) w.S.modules.production.orderBreaker.miss();
    var $main = build(w, 'render');
    var $b = $main.find('.steward-banner');
    assert.strictEqual($b.length, 1);
    assert.ok($b.text().indexOf('Production paused: 5 orders not seen. Opens again 09:07.') >= 0, $b.text());
    $b.find('a').trigger('click');
    assert.strictEqual(w.S.modules.production.orderBreaker.isOpen(), false);
});

t.test('no short banner even with Short rows', function () {
    var w = setup({ status: { shortfall: 4 } });
    assert.strictEqual(build(w, 'render').find('.steward-banner').length, 0);
});

t.test('Idle counts only automatic queues, not other owners covered or held', function () {
    var w = setup({ status: { standing: 1, standingCovered: 0, standingHeld: 0, covered: 1, held: 1 } });
    assert.strictEqual(tile(w).badge.text, 'Running');
    w = setup({ status: { standing: 1, standingCovered: 1, standingHeld: 0, covered: 1, held: 1 } });
    assert.strictEqual(tile(w).badge.text, 'Idle');
});

t.test('Production now meta is the read time of the status', function () {
    var w = setup({ status: { readAt: new Date(2026, 0, 1, 13, 7).getTime() } });
    var $main = build(w, 'render');
    assert.ok($main.text().indexOf('read 13:07') >= 0, $main.text());
    w = setup({ status: { readAt: null } });
    $main = build(w, 'render');
    assert.ok($main.text().indexOf('not read yet') >= 0, $main.text());
});

t.test('a throwing snapshot falls back to the model emptyStatus on every surface', function () {
    var w = setup({ status: { enabled: true } });
    var P = w.S.modules.production;
    P.model.snapshot = function () { throw new Error('boom'); };
    P.model.emptyStatus = function () {
        return { standing: 7, queues: 4, types: 6, waiting: 0, shortfall: 0, buffed: 0, buffable: 0,
                 standingCovered: 0, standingHeld: 0, nextDoneAt: null, readAt: null,
                 orderBreaker: null, buffBreaker: null, nextItem: null };
    };
    assert.strictEqual(P.summary(w.h), '7 automatic queues · next done none');
    assert.ok(build(w, 'render').text().indexOf('4 of 6') >= 0);
    assert.ok(build(w, 'side').text().indexOf('Automatic queues') >= 0);
    assert.strictEqual(tile(w).badge.text, 'Running');
});

t.test('ui.js keeps no hand-built empty status', function () {
    var src = require('fs').readFileSync(require('path').join(__dirname, '../../src/modules/production/ui.js'), 'utf8');
    assert.ok(src.indexOf('nextDoneAt: null') < 0);
    assert.ok(src.indexOf('bookComplete') < 0);
});
