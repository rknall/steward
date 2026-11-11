'use strict';

// The production window is driven through the element tree the jq fake
// builds: the Modal stand-in hands out real Body and Footer elements, so a
// case clicks and types into the same controls a user would. The read
// model is replaced by fixture rows, so each case states only what it shows.

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');
var hostStubs = require('../stubs/host');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

var BOOKS = 2;
var TIMED = 40;
var CULT = 50;

function rowOf(S, name, type, kind, extra) {
    var r = {
        name: name, label: name, count: 1, level: 3, grid: 100 + type, type: type, kind: kind,
        profile: { kind: kind, stackable: false },
        items: [{ name: name + 'Item', label: name + ' item' }, { name: name + 'Other', label: name + ' other' }],
        cfg: {},
        costText: function (item) { return 'cost of ' + item; },
        buffs: [{ name: 'Fish', label: 'Fish platter', amount: 3, offered: true },
                { name: 'Duck', label: 'Roasted duck', amount: 0, offered: true }]
    };
    for (var k in extra || {}) r[k] = extra[k];
    return r;
}

function setup(stored, hostMode) {
    var alerts = [];
    var H = harness.boot({ host: { showGameAlert: function (m) { alerts.push(m); } } });
    var $ = jq.install(H);
    var rig = hostStubs.installModal(H, hostMode ? { host: true } : undefined);
    var S = H.Steward;
    var K = S.ProductionKind;
    var calls = [];
    S.kernel.ui.ensureStyle = function () {};
    if (!hostMode) {
        var realRelease = S.kernel.ui.releaseDashboard;
        S.kernel.ui.releaseDashboard = function () {
            calls.push('releaseDashboard');
            return realRelease.apply(this, arguments);
        };
        S.kernel.ui.closeDashboard = function () { calls.push('closeDashboard'); };
        H.ctx.Modal.prototype.show = function () { calls.push('show'); };
        H.ctx.Modal.prototype.hide = function () { calls.push('hide'); };
    }
    var keep = { };
    keep[BOOKS] = 1;
    S.core.production.keepMax = function (type) { return keep[type] || 9999; };
    S.core.production.cooldownMs = function () { return null; };
    H.settings.write('production', { enabled: true, buildings: stored || {} });
    var rows = [
        rowOf(S, 'Bookbinder', BOOKS, K.Books),
        rowOf(S, 'Gingerbread', TIMED, K.Timed),
        rowOf(S, 'Temple', CULT, K.Cooldown)
    ];
    var views = { calls: [] };
    S.modules.production.model.buildings = function () { return rows; };
    S.modules.production.model.status = function () {
        return { enabled: true, queues: 2, entries: 3, nextDoneAt: null,
                 orderBreaker: { open: false }, buffBreaker: { open: false } };
    };
    S.modules.production.model.queues = function () { return [{ type: TIMED }]; };
    S.modules.production.views = {
        queues: function ($c, h, data) { views.calls.push(['queues', data]); $c.append($('<div>').text('queues view')); },
        demand: function () { throw new Error('demand boom'); },
        books:  function ($c) { $c.append($('<div>').text('books view')); },
        recent: function ($c) { $c.append($('<div>').text('recent view')); }
    };
    return { H: H, S: S, $: $, rig: rig, alerts: alerts, calls: calls, views: views,
             win: S.modules.production.window };
}

// The same fixtures on the host Modal model: real swap counting, fades and
// the host show that hides every other displayed dialog.
function hostSetup(stored) { return setup(stored, true); }

function body(s) { return s.rig.made[s.rig.made.length - 1].modal.Body(); }
function footer(s) { return s.rig.made[s.rig.made.length - 1].modal.Footer(); }

function byText($root, $, tag, label) {
    var hit = null;
    $root.find(tag).each(function () {
        if (!hit && $(this).text() === label) hit = $(this);
    });
    return hit;
}

function click($root, $, label) {
    var hit = byText($root, $, 'button', label);
    assert.ok(hit, 'button "' + label + '" exists');
    hit.trigger('click');
}

function openOrders(s) {
    s.win.open('orders');
    s.rig.visible = true;
    click(body(s), s.$, 'All 3');
}

// The table row whose first cell starts with the building label.
function rowEl(s, label) {
    var hit = null;
    body(s).find('tr').each(function () {
        var $td = s.$(this).find('td').eq(0);
        if (!hit && $td.length && $td.find('b').eq(0).text() === label) hit = s.$(this);
    });
    assert.ok(hit, 'row ' + label + ' exists');
    return hit;
}

function saveBtn(s) { return byText(footer(s), s.$, 'button', 'Save'); }

function setKeep(s, label, text) {
    var $in = rowEl(s, label).find('input').eq(0);
    $in.val(text).trigger('input').trigger('change');
    return $in;
}

t.test('window.js loads without the edit-guard API and registers it when present', function () {
    var H = harness.boot();
    var src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'production', 'window.js'), 'utf8');
    delete H.Steward.kernel.ui.addEditGuard;
    vm.runInContext(src, H.ctx);
    assert.strictEqual(typeof H.Steward.modules.production.window.open, 'function');
    var ids = [];
    H.Steward.kernel.ui.addEditGuard = function (id) { ids.push(id); };
    vm.runInContext(src, H.ctx);
    assert.deepStrictEqual(plain(ids), ['production-window']);
});

t.test('open is refused over open edits and leaves the dashboard alone', function () {
    var s = setup();
    s.S.kernel.ui.hasOpenEdits = function () { return true; };
    s.win.open();
    assert.strictEqual(s.rig.made.length, 0);
    assert.deepStrictEqual(s.calls, []);
    assert.ok(/Save or close/.test(s.alerts[0]));
});

t.test('open from a clean state releases the dashboard without a hide, then shows, on Queues', function () {
    var s = setup();
    s.win.open();
    assert.deepStrictEqual(s.calls, ['releaseDashboard', 'show']);
    assert.strictEqual(s.rig.made[0].id, 'StewardProduction');
    assert.strictEqual(s.rig.made[0].title, 'Steward production');
    assert.ok(/queues view/.test(body(s).text()));
    assert.ok(/Auto-production on · 2 queues · 3 entries · breaker ok/.test(body(s).text()));
    assert.ok(byText(footer(s), s.$, 'button', 'Refresh'));
    assert.ok(/live views do not redraw/.test(footer(s).text()));
});

t.test('Keep of a Books row clamps 5 to 1; a Timed row keeps 150', function () {
    var s = setup();
    openOrders(s);
    var $b = setKeep(s, 'Bookbinder', '5');
    assert.strictEqual($b.val(), '1');
    setKeep(s, 'Gingerbread', '150');
    click(footer(s), s.$, 'Save');
    var saved = s.H.settings.read('production').buildings;
    assert.strictEqual(saved.Bookbinder.amount, 1);
    assert.strictEqual(saved.Gingerbread.amount, 150);
    assert.ok(/one book at a time/.test(rowEl(s, 'Bookbinder').text()));
});

t.test('the edit guard is true only while visible and dirty', function () {
    var s = setup();
    openOrders(s);
    assert.strictEqual(s.win.hasEdits(), false);
    setKeep(s, 'Gingerbread', '7');
    assert.strictEqual(s.win.hasEdits(), true);
    s.rig.visible = false;
    assert.strictEqual(s.win.hasEdits(), false);
    assert.strictEqual(s.win.isOpen(), false);
});

t.test('Save is disabled until a change, writes { buildings } and resets dirty', function () {
    var s = setup({ Gingerbread: { item: 'GingerbreadItem', amount: 150, stack: 0, buff: '' } });
    s.win.open('orders');
    s.rig.visible = true;
    assert.strictEqual(saveBtn(s).prop('disabled'), true);
    assert.ok(/No unsaved changes/.test(footer(s).text()));
    setKeep(s, 'Gingerbread', '200');
    assert.strictEqual(saveBtn(s).prop('disabled'), false);
    click(footer(s), s.$, 'Save');
    var stored = s.H.settings.read('production');
    assert.deepStrictEqual(Object.keys(stored), ['buildings']);
    assert.strictEqual(stored.buildings.Gingerbread.amount, 200);
    assert.strictEqual(stored.buildings.Gingerbread.item, 'GingerbreadItem');
    assert.strictEqual(s.win.hasEdits(), false);
    assert.strictEqual(saveBtn(s).prop('disabled'), true);
    assert.ok(s.alerts.indexOf('Steward: Standing orders saved') > -1);
});

t.test('the change note names one change and counts several', function () {
    var s = setup({ Gingerbread: { item: 'GingerbreadItem', amount: 150, stack: 0, buff: '' } });
    s.S.core.locale.bui = function (n) { return n === 'Gingerbread' ? 'Gingerbread house' : n; };
    s.win.open('orders');
    s.rig.visible = true;
    setKeep(s, 'Gingerbread', '200');
    assert.ok(footer(s).text().indexOf('1 change: Gingerbread house keep 150 → 200') > -1);
    var $sel = rowEl(s, 'Gingerbread').find('select').eq(1);
    $sel.val('Fish').trigger('change');
    assert.ok(/2 changes/.test(footer(s).text()));
    assert.ok(byText(body(s), s.$, 'button', 'Standing orders •'));
});

t.test('Stack is hidden for Books and shown for Timed', function () {
    var s = setup();
    openOrders(s);
    assert.strictEqual(rowEl(s, 'Bookbinder').find('td').eq(3).text(), '–');
    assert.strictEqual(rowEl(s, 'Bookbinder').find('input').length, 1);
    assert.strictEqual(rowEl(s, 'Gingerbread').find('input').length, 2);
});

t.test('Cooldown rows are read-only', function () {
    var s = setup();
    openOrders(s);
    var $r = rowEl(s, 'Temple');
    assert.strictEqual($r.find('input').length, 0);
    assert.strictEqual($r.find('select').length, 0);
    assert.ok(/cooldown/.test($r.text()));
});

t.test('the buff choice marks an empty stock and keeps an unlisted choice', function () {
    var s = setup({ Gingerbread: { item: '', amount: 0, stack: 0, buff: 'Gone' } });
    s.win.open('orders');
    s.rig.visible = true;
    var text = rowEl(s, 'Gingerbread').find('select').eq(1).text();
    assert.ok(text.indexOf('Roasted duck (0) - out of stock') > -1);
    assert.ok(text.indexOf('Gone (not offered)') > -1);
    assert.strictEqual(s.win.hasEdits(), false);
});

t.test('an unreadable buff stock reads (?) and is not called out of stock', function () {
    var s = setup({ Gingerbread: { item: '', amount: 0, stack: 0, buff: '' } });
    s.S.modules.production.model.buildings = function () {
        return [rowOf(s.S, 'Gingerbread', TIMED, s.S.ProductionKind.Timed, {
            buffs: [{ name: 'Duck', label: 'Roasted duck', amount: null, offered: true }]
        })];
    };
    s.win.open('orders');
    s.rig.visible = true;
    var text = rowEl(s, 'Gingerbread').find('select').eq(1).text();
    assert.ok(text.indexOf('Roasted duck (?)') > -1);
    assert.strictEqual(text.indexOf('out of stock'), -1);
});

t.test('host: a window fading out after a hide holds no edits and is not open', function () {
    var s = hostSetup();
    s.win.open('orders');
    click(body(s), s.$, 'All 3');
    setKeep(s, 'Gingerbread', '7');
    assert.strictEqual(s.win.hasEdits(), true);
    s.S.kernel.ui.hideModal(s.rig.made[s.rig.made.length - 1].modal);
    assert.strictEqual(s.win.hasEdits(), false);
    assert.strictEqual(s.win.isOpen(), false);
    s.rig.flushFades();
});

t.test('switching tabs keeps the draft', function () {
    var s = setup();
    openOrders(s);
    setKeep(s, 'Gingerbread', '42');
    click(body(s), s.$, 'Queues 2');
    assert.ok(/queues view/.test(body(s).text()));
    assert.strictEqual(s.win.hasEdits(), true);
    click(body(s), s.$, 'Standing orders •');
    click(body(s), s.$, 'All 3');
    assert.strictEqual(rowEl(s, 'Gingerbread').find('input').eq(0).val(), '42');
});

t.test('a throwing view is contained in its tab', function () {
    var s = setup();
    s.S.modules.production.assess = function () { return { rows: [] }; };
    s.win.open('demand');
    var text = body(s).text();
    assert.ok(/This view could not be shown: demand boom/.test(text));
    assert.ok(/Auto-production on/.test(text));
    click(body(s), s.$, 'Recent');
    assert.ok(/recent view/.test(body(s).text()));
});

t.test('Close with a dirty draft says the changes were discarded', function () {
    var s = setup();
    openOrders(s);
    setKeep(s, 'Gingerbread', '9');
    click(footer(s), s.$, 'Close');
    assert.ok(s.alerts.indexOf('Steward: Standing-order changes discarded') > -1);
});

t.test('the header is the submenu status line behind the on/off word', function () {
    var s = setup();
    s.win.open();
    var $head = body(s).find('.steward-subhead').eq(0);
    assert.strictEqual($head.text(), 'Auto-production on · 2 queues · 3 entries · breaker ok');
});

t.test('the stack field defaults to the module default stack', function () {
    var s = setup();
    s.S.modules.production.defaultStack = function () { return 7; };
    openOrders(s);
    assert.strictEqual(String(rowEl(s, 'Gingerbread').find('input').eq(1).val()), '7');
});

t.test('a key added to the default row is drafted and saved', function () {
    var s = setup();
    s.S.modules.production.defaultBuilding.note = 'n';
    openOrders(s);
    setKeep(s, 'Gingerbread', '5');
    assert.ok(/1 change: Gingerbread keep 0 → 5/.test(footer(s).text()));
    click(footer(s), s.$, 'Save');
    var saved = s.H.settings.read('production').buildings.Gingerbread;
    assert.strictEqual(saved.note, 'n');
    assert.strictEqual(saved.amount, 5);
});

t.test('Save writes item, keep, stack and buff of one row; no edit writes nothing', function () {
    var s = setup();
    var writes = 0;
    var write = s.S.kernel.settings.write;
    s.S.kernel.settings.write = function () { writes++; return write.apply(this, arguments); };
    openOrders(s);
    click(footer(s), s.$, 'Save');
    assert.strictEqual(writes, 0);
    var $r = rowEl(s, 'Gingerbread');
    $r.find('select').eq(0).val('GingerbreadOther').trigger('change');
    setKeep(s, 'Gingerbread', '12');
    rowEl(s, 'Gingerbread').find('input').eq(1).val('4').trigger('input').trigger('change');
    rowEl(s, 'Gingerbread').find('select').eq(1).val('Duck').trigger('change');
    assert.ok(/4 changes/.test(footer(s).text()));
    click(footer(s), s.$, 'Save');
    assert.strictEqual(writes, 1);
    assert.deepStrictEqual(plain(s.H.settings.read('production').buildings.Gingerbread),
        { item: 'GingerbreadOther', amount: 12, stack: 4, buff: 'Duck' });
    click(footer(s), s.$, 'Save');
    assert.strictEqual(writes, 1);
});

t.test('window.js keeps no literal field list', function () {
    var src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'production', 'window.js'), 'utf8');
    assert.strictEqual(src.indexOf("['item', 'amount'"), -1);
});

function activeChip(s) {
    var hit = null;
    body(s).find('button.steward-chip.active').each(function () {
        var txt = s.$(this).text();
        if (/^(All|Managed) /.test(txt)) hit = txt;
    });
    return hit;
}

t.test('orders tab opens on All while no standing order exists', function () {
    var s = setup();
    s.win.open('orders');
    s.rig.visible = true;
    assert.ok(/^All /.test(activeChip(s) || ''), 'All chip selected');
    assert.ok(rowEl(s, 'Gingerbread'));
});

t.test('orders tab opens on Managed once a standing order exists', function () {
    var s = setup({ Gingerbread: { item: 'GingerbreadItem', amount: 5 } });
    s.win.open('orders');
    s.rig.visible = true;
    assert.ok(/^Managed /.test(activeChip(s) || ''), 'Managed chip selected');
});

t.test('render reads the model inside a read pass and leaves it afterwards', function () {
    var s = setup();
    var seen = [];
    var status = s.S.modules.production.model.status;
    s.S.modules.production.model.status = function () {
        seen.push(s.S.kernel.hostRead.inPass());
        return status();
    };
    s.win.open();
    assert.deepStrictEqual(seen, [true]);
    assert.strictEqual(s.S.kernel.hostRead.inPass(), false);
});

t.test('each render logs one debug line naming the tab', function () {
    var s = setup();
    var lines = [];
    s.S.kernel.debug = function () { lines.push(Array.prototype.join.call(arguments, ' ')); };
    s.win.open('orders');
    var mine = lines.filter(function (l) { return /window render/.test(l); });
    assert.strictEqual(mine.length, 1);
    assert.ok(/window render orders took \d+ ms/.test(mine[0]));
});

t.test('one render reads assess once and the chip equals the Demand tab', function () {
    var s = setup();
    var P = s.S.modules.production;
    var reads = 0;
    P.assess = function () { reads++; return { rows: [{ id: 1 }, { id: 2 }] }; };
    P.lastPass = function () { throw new Error('lastPass must not be read'); };
    P.model.reservations = function (rows) { return { n: rows.length }; };
    var seen = null;
    P.views.demand = function ($c, h, data) { seen = data; $c.append(s.$('<div>').text('demand view')); };
    s.win.open();
    s.rig.visible = true;
    assert.strictEqual(reads, 1);
    assert.ok(byText(body(s), s.$, 'button', 'Demand 2'), 'chip reads Demand 2');
    click(body(s), s.$, 'Demand 2');
    assert.strictEqual(reads, 2);
    assert.strictEqual(seen.rows.length, 2);
    assert.strictEqual(seen.reservations.n, 2);
});

t.test('the queues view gets the window rows with its queues', function () {
    var s = setup();
    s.S.modules.production.assess = function () { return { rows: [{ id: 1 }] }; };
    s.win.open();
    s.rig.visible = true;
    var d = s.views.calls[s.views.calls.length - 1][1];
    assert.strictEqual(d.queues.length, 1);
    assert.strictEqual(d.rows.length, 1);
});

t.test('the Books tab reads onOff once and passes its counts', function () {
    var s = setup();
    var P = s.S.modules.production;
    var reads = 0;
    P.model.onOff = function () { reads++; return { rows: [{ n: 1 }], counts: { stopped: 2, miningOwned: 1 } }; };
    P.model.onOffCounts = function () { throw new Error('onOffCounts must not be called'); };
    P.model.books = function () { return []; };
    var seen = null;
    P.views.books = function ($c, h, data) { seen = data; };
    s.win.open();
    s.rig.visible = true;
    click(body(s), s.$, 'Bookbinder & on/off');
    assert.strictEqual(reads, 1);
    assert.strictEqual(seen.counts.stopped, 2);
    assert.strictEqual(seen.onOff.length, 1);
});

// ---- Host Modal model ------------------------------------------------------

function dashClose(s) {
    s.rig.element('StewardDashboard').find('.steward-foot-right').trigger('click');
}

function prodClose(s) {
    var $c = byText(s.rig.element('StewardProduction'), s.$, 'button', 'Close');
    assert.ok($c, 'production Close exists');
    $c.trigger('click');
}

function hideEvents(s, id) {
    var n = 0;
    s.rig.element(id).on('hide.bs.modal', function () { n++; });
    return function () { return n; };
}

t.test('host: opening over the visible dashboard swaps the layers evenly', function () {
    var s = hostSetup();
    s.S.kernel.ui.openDashboard();
    assert.strictEqual(s.rig.isShown('StewardDashboard'), true);
    s.win.open();
    assert.strictEqual(s.rig.balanced(), true);
    assert.strictEqual(s.rig.isShown('StewardProduction'), true);
    assert.strictEqual(s.rig.isShown('StewardDashboard'), false);
    assert.strictEqual(s.rig.swaps, 3);
    s.rig.flushFades();
    assert.strictEqual(s.rig.balanced(), true);
    assert.strictEqual(s.rig.element('StewardDashboard'), null);
});

t.test('host: the dashboard and the window can alternate', function () {
    var s = hostSetup();
    s.S.kernel.ui.openDashboard();
    s.win.open();
    s.rig.flushFades();
    s.S.kernel.ui.openDashboard();
    assert.strictEqual(s.rig.balanced(), true);
    assert.strictEqual(s.rig.isShown('StewardDashboard'), true);
    assert.strictEqual(s.rig.isShown('StewardProduction'), false);
    // The host ignores a show of a window that is still fading, so the user's
    // next open lands after the fade.
    s.rig.flushFades();
    s.win.open();
    assert.strictEqual(s.rig.balanced(), true);
    assert.strictEqual(s.rig.isShown('StewardProduction'), true);
});

t.test('host: the production Close clicked twice before the flush hides once', function () {
    var s = hostSetup();
    s.win.open();
    var hides = hideEvents(s, 'StewardProduction');
    prodClose(s);
    prodClose(s);
    assert.strictEqual(hides(), 1);
    assert.strictEqual(s.rig.balanced(), true);
    s.rig.flushFades();
    assert.strictEqual(s.rig.balanced(), true);
});

t.test('host: opening after a dashboard Close stays balanced, flushed or not', function () {
    var s = hostSetup();
    s.S.kernel.ui.openDashboard();
    dashClose(s);
    s.win.open();
    assert.strictEqual(s.rig.balanced(), true);
    assert.strictEqual(s.rig.isShown('StewardProduction'), true);
    s.rig.flushFades();
    assert.strictEqual(s.rig.balanced(), true);

    var u = hostSetup();
    u.S.kernel.ui.openDashboard();
    u.rig.dismiss('StewardDashboard');
    u.rig.flushFades();
    u.win.open();
    assert.strictEqual(u.rig.balanced(), true);
    assert.strictEqual(u.rig.isShown('StewardProduction'), true);
});

t.test('host: opening still resets the dashboard buffer so a Save is not overwritten', function () {
    var s = hostSetup();
    var ui = s.S.kernel.ui;
    ui.openDashboard();
    ui.bufferedSettings('production');
    s.win.open('orders');
    assert.strictEqual(ui.screen.modal(), null);
    assert.strictEqual(ui.hasOpenEdits(), false);
    click(body(s), s.$, 'All 3');
    setKeep(s, 'Gingerbread', '7');
    click(footer(s), s.$, 'Save');
    var saved = s.H.settings.read('production').buildings;
    assert.strictEqual(saved.Gingerbread.amount, 7);
    ui.openDashboard();
    assert.deepStrictEqual(plain(ui.bufferedSettings('production').buildings), plain(saved));
});

t.test('host: a throwing create leaves the dashboard shown and tracked', function () {
    var s = hostSetup();
    var ui = s.S.kernel.ui;
    ui.openDashboard();
    var dash = ui.screen.modal();
    assert.ok(dash);
    var real = s.H.ctx.Modal.prototype.create;
    s.H.ctx.Modal.prototype.create = function () {
        if (this.rawId === 'StewardProduction') throw new Error('create boom');
        return real.apply(this, arguments);
    };
    s.win.open();
    var errs = s.H.logs().filter(function (l) { return l.level === 'error'; });
    assert.ok(errs.length > 0);
    assert.strictEqual(s.rig.isShown('StewardDashboard'), true);
    assert.strictEqual(ui.screen.modal(), dash);
    assert.strictEqual(s.rig.balanced(), true);
});
