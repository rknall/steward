'use strict';

var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');
var hostStubs = require('../stubs/host');

var assert = t.assert;

function setup() {
    var H = harness.boot({ sections: ['kernel'] });
    var $ = jq.install(H);
    var ui = H.Steward.kernel.ui;
    return { H: H, $: $, ui: ui, h: ui.helpers };
}

function errorLogs(H) {
    return H.logs().filter(function (l) { return l.level === 'error'; })
        .map(function (l) { return l.args.join(' '); });
}

// ---- Time -------------------------------------------------------------------

t.test('duration is null unless the time is a positive number', function () {
    var s = setup();
    assert.strictEqual(s.h.duration(0), null);
    assert.strictEqual(s.h.duration(null), null);
    assert.strictEqual(s.h.duration(undefined), null);
    assert.strictEqual(s.h.duration(-5), null);
    assert.strictEqual(s.h.duration('65000'), null);
    assert.strictEqual(typeof s.h.duration(65000), 'string');
    assert.ok(s.h.duration(65000).length > 0);
});

t.test('clock formats local HH:MM and gives empty for an invalid date', function () {
    var s = setup();
    assert.strictEqual(s.h.clock(new Date(2024, 0, 2, 7, 5)), '07:05');
    assert.ok(/^\d\d:\d\d$/.test(s.h.clock()));
    assert.strictEqual(s.h.clock(new Date(NaN)), '');
});

t.test('statusBadge is ok when idle and busy with the remaining time otherwise', function () {
    var s = setup();
    var idle = s.h.statusBadge(true, 5);
    assert.ok(idle.hasClass('steward-b-ok'));
    assert.strictEqual(idle.text(), 'Idle');
    var busy = s.h.statusBadge(false, 3900000);
    assert.ok(busy.hasClass('steward-b-busy'));
    assert.strictEqual(busy.text(), 'Busy ' + s.h.duration(3900000));
    assert.strictEqual(s.h.statusBadge(false, null).text(), 'Busy');
    assert.strictEqual(s.h.statusBadge(false, 0).text(), 'Busy');
});

// ---- Parsers ----------------------------------------------------------------

t.test('settingsParse sizeKB, whole and tickMs', function () {
    var K = harness.boot({ sections: ['kernel'] }).Steward.kernel;
    var p = K.ui.settingsParse;
    var min = K.TIMEOUTS.TICK_INTERVAL_MIN_MS;

    assert.strictEqual(p.sizeKB('2'), 2048);
    assert.strictEqual(p.sizeKB(' 1.5 '), 1536);
    assert.strictEqual(p.sizeKB('0'), 0);
    assert.strictEqual(p.sizeKB(''), null);
    assert.strictEqual(p.sizeKB('   '), null);
    assert.strictEqual(p.sizeKB('-1'), null);
    assert.strictEqual(p.sizeKB('abc'), null);

    assert.strictEqual(p.whole('3'), 3);
    assert.strictEqual(p.whole('2.7'), 2);
    assert.strictEqual(p.whole('0'), 0);
    assert.strictEqual(p.whole(''), null);
    assert.strictEqual(p.whole('-1'), null);
    assert.strictEqual(p.whole('many'), null);
    assert.strictEqual(p.keep, undefined);

    assert.strictEqual(p.tickMs('20'), 20000);
    assert.strictEqual(p.tickMs('12.5'), 12500);
    assert.strictEqual(p.tickMs('5'), min);
    assert.strictEqual(p.tickMs('0'), min);
    assert.strictEqual(p.tickMs(''), null);
    assert.strictEqual(p.tickMs('-3'), null);
    assert.strictEqual(p.tickMs('soon'), null);
});

t.test('settingsShow converts the stored unit back', function () {
    var show = harness.boot({ sections: ['kernel'] }).Steward.kernel.ui.settingsShow;
    assert.strictEqual(show.mb(2048), 2);
    assert.strictEqual(show.mb(1536), 1.5);
    assert.strictEqual(show.seconds(30000), 30);
});

// ---- Buffer paths -----------------------------------------------------------

t.test('set creates the missing objects on the way and get reads them back', function () {
    var s = setup();
    s.h.set('logger', 'a.b.c', 4);
    assert.strictEqual(s.h.get('logger', 'a.b.c'), 4);
    assert.strictEqual(s.h.settings('logger').a.b.c, 4);
    assert.strictEqual(s.h.get('logger', 'a.x.c'), undefined);
    assert.strictEqual(s.h.get('logger', 'a.b.c.d'), undefined);
});

t.test('set replaces a non-object on the path', function () {
    var s = setup();
    s.h.set('logger', 'a', 1);
    s.h.set('logger', 'a.b', 2);
    assert.strictEqual(s.h.get('logger', 'a.b'), 2);
});

// ---- Bound toggle -----------------------------------------------------------

t.test('a bound toggle writes the nested path and marks itself dirty, then clean on revert', function () {
    var s = setup();
    s.h.baseline('logger', { zz: { flag: false } });
    var $t = s.h.toggle({ ns: 'logger', path: 'zz.flag' });
    var $in = $t.find('input');
    assert.ok($t.hasClass('switch'));
    assert.strictEqual($in.prop('checked'), false);
    assert.ok(!$t.hasClass('steward-dirty'));

    $in.prop('checked', true).trigger('change');
    assert.strictEqual(s.h.get('logger', 'zz.flag'), true);
    assert.ok($t.hasClass('steward-dirty'));

    $in.prop('checked', false).trigger('change');
    assert.strictEqual(s.h.get('logger', 'zz.flag'), false);
    assert.ok(!$t.hasClass('steward-dirty'));
});

t.test('a bound toggle starts dirty when the buffer already differs', function () {
    var s = setup();
    s.h.baseline('logger', { zz: { flag: false } });
    s.h.set('logger', 'zz.flag', true);
    var $t = s.h.toggle({ ns: 'logger', path: 'zz.flag' });
    assert.ok($t.hasClass('steward-dirty'));
    assert.strictEqual($t.find('input').prop('checked'), true);
});

t.test('a bound toggle uses opts.write instead of the buffer and then calls onChange', function () {
    var s = setup();
    var seen = [];
    var $t = s.h.toggle({
        ns: 'logger', path: 'zz.flag',
        write: function (v) { seen.push('write:' + v); },
        onChange: function (v) { seen.push('change:' + v); }
    });
    $t.find('input').prop('checked', true).trigger('change');
    assert.deepStrictEqual(seen, ['write:true', 'change:true']);
    assert.strictEqual(s.h.get('logger', 'zz.flag'), undefined);
});

t.test('a disabled toggle is marked and carries its label as a title', function () {
    var s = setup();
    var $t = s.h.toggle({ checked: true, disabled: true, label: 'Why' });
    assert.ok($t.hasClass('steward-disabled'));
    assert.strictEqual($t.attr('title'), 'Why');
    assert.strictEqual($t.find('input').attr('disabled'), 'disabled');
    assert.strictEqual($t.find('.slider').length, 1);
});

// ---- number -----------------------------------------------------------------

t.test('number marks steward-invalid while typing junk and reverts on change', function () {
    var s = setup();
    s.h.baseline('logger', { zz: { n: 3 } });
    s.h.set('logger', 'zz.n', 3);
    var $w = s.h.number({ ns: 'logger', path: 'zz.n', unit: 'items' });
    var $i = $w.find('input');
    assert.strictEqual($i.val(), '3');
    assert.strictEqual($w.find('.steward-unit').text(), 'items');

    $i.val('abc').trigger('input');
    assert.ok($i.hasClass('steward-invalid'));
    $i.trigger('change');
    assert.strictEqual($i.val(), '3');
    assert.ok(!$i.hasClass('steward-invalid'));
    assert.strictEqual(s.h.get('logger', 'zz.n'), 3);
    assert.ok(!$i.hasClass('steward-dirty'));
});

t.test('number commits a valid entry, shows the parsed value and marks itself dirty', function () {
    var s = setup();
    s.h.baseline('logger', { zz: { n: 3 } });
    s.h.set('logger', 'zz.n', 3);
    var $i = s.h.number({ ns: 'logger', path: 'zz.n' }).find('input');
    $i.val('5.9').trigger('input');
    assert.ok(!$i.hasClass('steward-invalid'));
    $i.trigger('change');
    assert.strictEqual(s.h.get('logger', 'zz.n'), 5);
    assert.strictEqual($i.val(), '5');
    assert.ok($i.hasClass('steward-dirty'));

    $i.val('3').trigger('change');
    assert.strictEqual(s.h.get('logger', 'zz.n'), 3);
    assert.ok(!$i.hasClass('steward-dirty'));
});

t.test('number without a path only reports the value', function () {
    var s = setup();
    var got = [];
    var $i = s.h.number({ value: 2, onChange: function (v) { got.push(v); } }).find('input');
    $i.val('7').trigger('change');
    assert.deepStrictEqual(got, [7]);
});

t.test('number uses a custom parse and show', function () {
    var s = setup();
    var $i = s.h.number({
        ns: 'logger', path: 'zz.sec', value: 20000,
        parse: s.ui.settingsParse.tickMs, show: s.ui.settingsShow.seconds
    }).find('input');
    assert.strictEqual($i.val(), '20');
    $i.val('30').trigger('change');
    assert.strictEqual(s.h.get('logger', 'zz.sec'), 30000);
    assert.strictEqual($i.val(), '30');
});

// ---- input ------------------------------------------------------------------

t.test('typing in an input with onChange enables Save before the change fires', function () {
    var s = setup();
    var $i = s.h.input({ onChange: function () {} });
    assert.strictEqual(s.ui.canSave(), false);
    $i.trigger('input');
    assert.strictEqual(s.ui.canSave(), true);
});

t.test('input takes a class and a title', function () {
    var s = setup();
    var $i = s.h.input({ value: 4, cls: 'extra', title: 'tip' });
    assert.ok($i.hasClass('steward-input'));
    assert.ok($i.hasClass('extra'));
    assert.strictEqual($i.attr('title'), 'tip');
    assert.strictEqual($i.val(), '4');
});

// ---- dropdown, button, link -------------------------------------------------

t.test('a bound dropdown commits the option value with its own type', function () {
    var s = setup();
    s.h.baseline('logger', { zz: { pick: 1 } });
    var $d = s.h.dropdown([{ label: 'One', value: 1 }, { label: 'Two', value: 2 }],
        { ns: 'logger', path: 'zz.pick' });
    assert.strictEqual($d.find('option').length, 2);
    $d.val('2').trigger('change');
    assert.strictEqual(s.h.get('logger', 'zz.pick'), 2);
    assert.ok($d.hasClass('steward-dirty'));
    $d.val('1').trigger('change');
    assert.ok(!$d.hasClass('steward-dirty'));
});

t.test('button classes follow the options and the click handler runs', function () {
    var s = setup();
    var clicks = 0;
    var $b = s.h.button('Go', { size: 'sm', primary: true, title: 'tip', onClick: function () { clicks++; } });
    assert.ok($b.hasClass('btn'));
    assert.ok($b.hasClass('steward-btn'));
    assert.ok($b.hasClass('steward-btn-sm'));
    assert.ok($b.hasClass('steward-primary'));
    assert.strictEqual($b.text(), 'Go');
    assert.strictEqual($b.attr('title'), 'tip');
    $b.trigger('click');
    assert.strictEqual(clicks, 1);

    var $plain = s.h.button('Plain', { disabled: true });
    assert.ok(!$plain.hasClass('steward-btn-sm'));
    assert.ok(!$plain.hasClass('steward-primary'));
    assert.strictEqual($plain.attr('disabled'), 'disabled');
});

t.test('a throwing button handler is logged, not thrown', function () {
    var s = setup();
    var $b = s.h.button('Go', { onClick: function () { throw new Error('boom'); } });
    $b.trigger('click');
    assert.ok(errorLogs(s.H).some(function (l) { return /button onClick threw/.test(l); }));
});

t.test('link classes follow danger and confirm', function () {
    var s = setup();
    var hit = 0;
    var $a = s.h.link('Delete', function () { hit++; }, { danger: true, confirm: true });
    assert.ok($a.hasClass('steward-link'));
    assert.ok($a.hasClass('steward-danger'));
    assert.ok($a.hasClass('steward-confirm'));
    $a.trigger('click');
    assert.strictEqual(hit, 1);
    assert.ok(!s.h.link('x', null).hasClass('steward-danger'));
});

// ---- Table ------------------------------------------------------------------

t.test('table puts a title on text cells and escapes the text', function () {
    var s = setup();
    var $t = s.h.table({
        cols: [{ label: 'A', width: '40px' }, { label: 'B', cls: 'steward-num' }],
        rows: [['a<b', 5], [{ text: 'x', title: 'tip' }, 7]]
    });
    assert.ok($t.is('table'));
    assert.ok($t.hasClass('steward-tbl'));
    var $rows = $t.find('tbody tr');
    assert.strictEqual($rows.length, 2);
    var $c0 = $rows.eq(0).children('td').eq(0);
    assert.strictEqual($c0.text(), 'a<b');
    assert.strictEqual($c0.html(), '');
    assert.strictEqual($c0.attr('title'), 'a<b');
    var $c1 = $rows.eq(0).children('td').eq(1);
    assert.strictEqual($c1.text(), '5');
    assert.strictEqual($c1.attr('title'), '5');
    assert.ok($c1.hasClass('steward-num'));
    assert.strictEqual($rows.eq(1).children('td').eq(0).attr('title'), 'tip');
});

t.test('table takes an html cell as is and an element cell untouched', function () {
    var s = setup();
    var $el = s.$('<b>').text('el');
    var $t = s.h.table({
        cols: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        rows: [[{ html: '<i>x</i>', title: 'h' }, $el, { $: s.$('<u>'), cls: 'k' }]]
    });
    var $cells = $t.find('tbody tr').eq(0).children('td');
    assert.strictEqual($cells.eq(0).html(), '<i>x</i>');
    assert.strictEqual($cells.eq(0).attr('title'), 'h');
    assert.strictEqual($cells.eq(1).find('b').text(), 'el');
    assert.strictEqual($cells.eq(2).find('u').length, 1);
    assert.ok($cells.eq(2).hasClass('k'));
});

t.test('table builds a colgroup from the widths and a header from the labels', function () {
    var s = setup();
    var $t = s.h.table({
        cols: [{ label: 'A', width: '40px' }, { label: 'B' }],
        rows: [['x', 'y']]
    });
    var $cols = $t.find('col');
    assert.strictEqual($cols.length, 2);
    assert.strictEqual($cols.eq(0).css('width'), '40px');
    assert.deepStrictEqual($t.find('th').length, 2);
    assert.strictEqual($t.find('th').eq(1).text(), 'B');
});

t.test('table with no rows shows one muted row with the empty text', function () {
    var s = setup();
    var $t = s.h.table({ cols: [{ label: 'A' }, { label: 'B' }], rows: [], emptyText: 'Nothing here' });
    var $rows = $t.find('tbody tr');
    assert.strictEqual($rows.length, 1);
    var $td = $rows.eq(0).children('td');
    assert.strictEqual($td.length, 1);
    assert.strictEqual($td.text(), 'Nothing here');
    assert.ok($td.hasClass('steward-muted'));
    assert.strictEqual($td.attr('colspan'), '2');
});

t.test('table with fill keeps the header apart from the scrolling body', function () {
    var s = setup();
    var $w = s.h.table({
        fill: true,
        cols: [{ label: 'A', width: '40px' }],
        rows: [['x'], ['y']],
        foot: ['total']
    });
    assert.ok(!$w.hasClass('steward-tbl'));
    assert.strictEqual($w.children('table').length, 1);
    assert.strictEqual($w.children('table').find('tbody').length, 0);
    assert.strictEqual($w.children('table').find('th').length, 1);
    var $fill = $w.children('.steward-fill');
    assert.strictEqual($fill.length, 1);
    assert.strictEqual($fill.find('tbody tr').length, 2);
    assert.strictEqual($fill.find('tfoot').length, 1);
    assert.strictEqual($fill.find('col').length, 1);
    assert.strictEqual($w.children('table').find('col').length, 1);
});

t.test('table rowCls takes a string or a function', function () {
    var s = setup();
    var $a = s.h.table({ cols: [{ label: 'A' }], rows: [['x']], rowCls: 'mark' });
    assert.ok($a.find('tbody tr').eq(0).hasClass('mark'));
    var $b = s.h.table({
        cols: [{ label: 'A' }], rows: [['x'], ['y']],
        rowCls: function (row, i) { return i === 1 ? 'second' : ''; }
    });
    assert.ok(!$b.find('tbody tr').eq(0).hasClass('second'));
    assert.ok($b.find('tbody tr').eq(1).hasClass('second'));
});

// ---- Small shapes -----------------------------------------------------------

t.test('card, field and badge emit the contract classes', function () {
    var s = setup();
    var $card = s.h.card({ icon: 'I', title: 'Title', meta: 'meta', cls: 'wide' });
    assert.ok($card.hasClass('steward-card'));
    assert.ok($card.hasClass('wide'));
    assert.strictEqual($card.find('.steward-card-h').length, 1);
    assert.strictEqual($card.find('.steward-card-meta').text(), 'meta');
    assert.strictEqual($card.find('.steward-icon').text(), 'I');

    var $f = s.h.field('Label', 'help', s.$('<i>'), { sub: true, disabled: true, wide: true });
    assert.ok($f.hasClass('steward-field'));
    assert.ok($f.hasClass('steward-sub'));
    assert.ok($f.hasClass('steward-dis'));
    assert.ok($f.find('.steward-field-ctl').hasClass('steward-wide'));
    assert.strictEqual($f.find('.steward-field-name').text(), 'Label');
    assert.strictEqual($f.find('.steward-field-help').text(), 'help');
    // The floated control comes first in the markup.
    assert.ok($f.children().eq(0).hasClass('steward-field-ctl'));

    var $wrap = s.h.field('L', null, s.$('<i>'), { wrap: true });
    assert.ok($wrap.hasClass('steward-wrap'));
    assert.ok($wrap.children().eq(1).hasClass('steward-field-ctl'));

    var $b = s.h.badge('busy', 'Busy');
    assert.ok($b.hasClass('steward-badge'));
    assert.ok($b.hasClass('steward-b-busy'));
    assert.strictEqual($b.text(), 'Busy');
});

t.test('stats size each item by the item count', function () {
    var s = setup();
    var $s = s.h.stats([{ k: 'A', v: 1 }, { k: 'B', v: 2, small: 'x' }, { k: 'C', v: 3 }]);
    var $items = $s.children('.steward-stat');
    assert.strictEqual($items.length, 3);
    assert.ok($items.eq(0).hasClass('steward-stat-w3'));
    assert.strictEqual($items.eq(1).find('.steward-stat-v').text(), '2 x');
    assert.strictEqual($items.eq(1).find('.steward-stat-k').text(), 'B');
});

t.test('chips mark the active one and report a pick', function () {
    var s = setup();
    var picked = [];
    var $c = s.h.chips([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], 'b',
        function (id) { picked.push(id); });
    var $chips = $c.children('.steward-chip');
    assert.strictEqual($chips.length, 2);
    assert.ok(!$chips.eq(0).hasClass('active'));
    assert.ok($chips.eq(1).hasClass('active'));
    $chips.eq(0).trigger('click');
    assert.deepStrictEqual(picked, ['a']);
});

t.test('grid, empty, banner and toolRow keep the structure the sheet styles', function () {
    var s = setup();
    var $g = s.h.grid(3, [s.$('<i>'), s.$('<b>')]);
    assert.strictEqual($g.children('.steward-cell.steward-cell-3').length, 2);
    assert.strictEqual(s.h.grid(5, [s.$('<i>')]).children('.steward-cell-2').length, 1);

    var $e = s.h.empty('Title', 'Text');
    assert.strictEqual($e.find('.steward-empty-title').text(), 'Title');

    var $bn = s.h.banner('Careful', { icon: '!', $action: s.$('<a>') });
    assert.ok($bn.hasClass('steward-banner'));
    assert.strictEqual($bn.find('a').length, 1);

    var $tool = s.h.toolRow('Label', 'small', s.h.button('Run'));
    assert.ok($tool.hasClass('steward-tool'));
    assert.strictEqual($tool.find('button').length, 1);
    assert.strictEqual($tool.find('small').text(), 'small');
});

t.test('text goes in as text, never as markup', function () {
    var s = setup();
    var $card = s.h.card({ title: '<b>x</b>' });
    assert.strictEqual($card.find('b').length, 0);
    assert.ok($card.text().indexOf('<b>x</b>') >= 0);
});

// ---- Stub acceptance --------------------------------------------------------

t.test('jq.install and installModal share one document in either order', function () {
    var a = harness.boot({ sections: ['kernel'] });
    jq.install(a);
    var docA = a.ctx.document;
    hostStubs.installModal(a);
    assert.strictEqual(a.ctx.document, docA);

    var b = harness.boot({ sections: ['kernel'] });
    hostStubs.installModal(b);
    var docB = b.ctx.document;
    jq.install(b);
    assert.strictEqual(b.ctx.document, docB);
    assert.strictEqual(typeof b.ctx.document.createTextNode, 'function');
});

t.test('jq.install keeps a preset window and creates one when absent', function () {
    var a = harness.boot({ sections: ['kernel'] });
    var win = { nativeWindow: { menu: 1 } };
    a.ctx.window = win;
    jq.install(a);
    assert.strictEqual(a.ctx.window, win);
    assert.strictEqual(a.ctx.window.nativeWindow.menu, 1);

    var b = harness.boot({ sections: ['kernel'] });
    assert.strictEqual(b.ctx.window, undefined);
    jq.install(b);
    assert.strictEqual(typeof b.ctx.window, 'object');
});

t.test('the jq fake finds elements by id, class, tag and attribute inside a context', function () {
    var s = setup();
    var $root = s.$('<div>', { id: 'root' })
        .append(s.$('<p>', { 'class': 'a b', 'data-x': 'y' }).text('one'))
        .append(s.$('<p>').text('two'));
    assert.strictEqual($root.find('p').length, 2);
    assert.strictEqual($root.find('.b').text(), 'one');
    assert.strictEqual($root.find('[data-x="y"]').length, 1);
    assert.strictEqual($root.find('div p.a').length, 1);
    assert.strictEqual($root.find('span p.a').length, 0);
    assert.strictEqual($root.find('p').eq(1).closest('#root').length, 1);
    assert.strictEqual($root.find('p').eq(1).parent()[0], $root[0]);
    assert.strictEqual(s.$.fn.sortable, undefined);
});

// ---- Window height (compact screens) ---------------------------------------

t.test('opening both screens with the default $ and no window neither throws nor is compact', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var rig = hostStubs.installModal(H);
    var ui = H.Steward.kernel.ui;
    H.clearLogs();
    ui.openDashboard();
    ui.openSettings();
    assert.strictEqual(rig.made.length, 2);
    assert.strictEqual(ui.screen.compact(), false);
    assert.strictEqual(ui.screen.panelHeight('dashboard'), null);
    var threw = errorLogs(H).filter(function (l) { return /threw/.test(l); });
    assert.deepStrictEqual(threw, []);
});

t.test('a short window makes the screen compact and the panel height follows the layout', function () {
    var H = harness.boot({ sections: ['kernel'] });
    jq.install(H);
    hostStubs.installModal(H);
    jq.setWindowHeight(640);
    var ui = H.Steward.kernel.ui;
    ui.openDashboard();
    var layout = ui.layout;
    assert.strictEqual(ui.screen.compact(), true);
    assert.strictEqual(ui.screen.panelHeight('dashboard'),
        Math.max(layout.minPanel, 640 - layout.chrome.dashboard));

    ui.closeDashboard(false);
    jq.setWindowHeight(860);
    ui.openDashboard();
    assert.strictEqual(ui.screen.compact(), false);
    assert.strictEqual(ui.screen.panelHeight('dashboard'), null);
});

// ---- redrawOnce -------------------------------------------------------------

function timerSetup() {
    var timers = [];
    var H = harness.boot({
        sections: ['kernel'],
        timers: { setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; } }
    });
    var $ = jq.install(H);
    timers.length = 0;   // drop the boot timer; only the helper's timers count
    return { H: H, $: $, h: H.Steward.kernel.ui.helpers, timers: timers };
}

t.test('redrawOnce schedules one call per holder', function () {
    var s = timerSetup();
    var $root = s.$('<div></div>');
    var $holder = s.$('<div></div>');
    $root.append($holder);
    var calls = 0;
    function draw() { calls++; }
    assert.strictEqual(s.h.redrawOnce($holder, draw, 1000), true);
    assert.strictEqual(s.h.redrawOnce($holder, draw, 1000), false);
    assert.strictEqual(s.timers.length, 1);
    assert.strictEqual(s.timers[0].ms, 1000);
    assert.strictEqual(calls, 0);
    s.timers[0].fn();
    assert.strictEqual(calls, 1);
});

t.test('redrawOnce skips a detached holder', function () {
    var s = timerSetup();
    var $root = s.$('<div></div>');
    var $holder = s.$('<div></div>');
    $root.append($holder);
    var calls = 0;
    s.h.redrawOnce($holder, function () { calls++; }, 1000);
    $holder.remove();
    s.timers[0].fn();
    assert.strictEqual(calls, 0);
});

t.test('redrawOnce returns false without a holder', function () {
    var s = timerSetup();
    assert.strictEqual(s.h.redrawOnce(null, function () {}, 1000), false);
    assert.strictEqual(s.h.redrawOnce(s.$('.nothing-here'), function () {}, 1000), false);
    assert.strictEqual(s.timers.length, 0);
});
