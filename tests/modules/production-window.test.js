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

var UNITS = 0;
var BOOKS = 2;
var TIMED = 40;
var LOVERS = 41;

function item(name, label, extra) {
    var r = { name: name, label: label, producible: true, why: null, page: null, pageLabel: null };
    for (var k in extra || {}) r[k] = extra[k];
    return r;
}

function rowOf(S, name, type, kind, extra) {
    var r = {
        name: name, label: S.core.locale.bui(name), count: 1, level: 3, grid: 100 + type, type: type, kind: kind,
        profile: { kind: kind, orderable: true },
        items: [item(name + 'Item', name + ' item'), item(name + 'Other', name + ' other')],
        cfg: {},
        managed: false,
        costText: function (it, n) { return 'cost of ' + it + ' x' + n; },
        buffs: [{ name: 'Fish', label: 'Fish platter', amount: 3, offered: true },
                { name: 'Duck', label: 'Roasted duck', amount: 0, offered: true },
                { name: 'Salt', label: 'Salt', amount: null, offered: true },
                { name: 'Gold', label: 'Gold leaf', amount: 9, offered: false }]
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
    var names = { LoversStatue: "Lovers' Statue" };
    S.core.locale.bui = function (n) { return names[n] || n; };
    var max = {};
    max[UNITS] = 25;
    max[BOOKS] = 1;
    max[TIMED] = 25;
    max[LOVERS] = 25;
    S.core.production.orderMax = function (type) { return max[type]; };
    H.settings.write('production', { enabled: true, bookComplete: true, buildings: stored || {} });
    var rows = [
        rowOf(S, 'Bookbinder', BOOKS, K.Books),
        rowOf(S, 'Barracks', UNITS, K.Units),
        rowOf(S, 'Gingerbread', TIMED, K.Timed),
        rowOf(S, 'LoversStatue', LOVERS, K.Timed, {
            items: [item('CupidsArrow', "Cupid's Arrow"), item('Rose', 'Rose')]
        })
    ];
    var views = { calls: [] };
    S.modules.production.model.buildings = function () { return rows; };
    S.modules.production.model.status = function () {
        return { enabled: true, queues: 2, entries: 3, nextDoneAt: null,
                 orderBreaker: { open: false }, buffBreaker: { open: false } };
    };
    S.modules.production.model.queues = function () { return [{ type: TIMED, producing: true }]; };
    S.modules.production.views = {
        queues: function ($c, h, data) { views.calls.push(['queues', data]); $c.append($('<div>').text('queues view')); }
    };
    return { H: H, S: S, $: $, rig: rig, alerts: alerts, calls: calls, views: views, rows: rows,
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

function openAll(s) {
    s.win.open();
    s.rig.visible = true;
    click(body(s), s.$, 'All buildings 4');
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

function cellOf(s, label, i) { return rowEl(s, label).find('td').eq(i); }

function saveBtn(s) { return byText(footer(s), s.$, 'button', 'Save'); }

function setItems(s, label, text) {
    var $in = cellOf(s, label, 2).find('input').eq(0);
    assert.ok($in.length, 'Items input of ' + label);
    $in.val(text).trigger('input').trigger('change');
    return $in;
}

function pick(s, label, col, value) {
    cellOf(s, label, col).find('select').eq(0).val(value).trigger('change');
}

function flip(s, label, on) {
    var $sw = cellOf(s, label, 4).find('input').eq(0);
    $sw.prop('checked', on);
    $sw.trigger('change');
}

// Option texts of a drop-down, a header marked with a leading '#'.
function optionsOf(s, $sel) {
    var out = [];
    $sel.find('option').each(function () {
        var $o = s.$(this);
        out.push(($o.attr('disabled') !== undefined ? '#' : '') + $o.text());
    });
    return out;
}

function selectedOf(s, $sel) {
    var hit = null;
    $sel.find('option').each(function () {
        if (hit === null && s.$(this).attr('selected') !== undefined) hit = s.$(this).text();
    });
    return hit;
}

function tabLabels(s) {
    var out = [];
    body(s).find('.steward-chips').eq(0).children('button').each(function () { out.push(s.$(this).text()); });
    return out;
}

function capture(s) {
    var writes = [];
    var write = s.S.kernel.settings.write;
    s.S.kernel.settings.write = function (ns, v) {
        writes.push([ns, plain(v)]);
        return write.apply(this, arguments);
    };
    return writes;
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

t.test('a: three tabs, opening on Production Manager after releasing the dashboard', function () {
    var s = setup();
    s.win.open();
    assert.deepStrictEqual(s.calls, ['releaseDashboard', 'show']);
    assert.strictEqual(s.rig.made[0].id, 'StewardProduction');
    assert.strictEqual(s.rig.made[0].title, 'Steward production');
    assert.deepStrictEqual(tabLabels(s), ['Production Manager', 'Queues 1', 'Settings']);
    assert.strictEqual(body(s).find('.steward-chips').eq(0).children('button.active').text(), 'Production Manager');
    assert.ok(saveBtn(s), 'the manager footer has Save');
    assert.ok(/Auto-production on · 2 queues · 3 entries · breaker ok/.test(body(s).text()));
    s.win.open('queues');
    assert.ok(/queues view/.test(body(s).text()));
    assert.ok(byText(footer(s), s.$, 'button', 'Refresh'));
    assert.ok(/live views do not redraw/.test(footer(s).text()));
});

t.test('b: the columns are Building, Item · cost, Items, Buff, Enable', function () {
    var s = setup();
    openAll(s);
    var cols = [];
    body(s).find('th').each(function () { cols.push(s.$(this).text()); });
    assert.deepStrictEqual(cols, ['Building', 'Item · cost', 'Items', 'Buff', 'Enable']);
    assert.ok(byText(body(s), s.$, 'span', 'Production Manager'), 'card title');
    assert.ok(/Cost shown per order, from the Items value/.test(body(s).text()));
});

t.test('c: the building subtitle has no event tag', function () {
    var s = setup();
    openAll(s);
    var sub = cellOf(s, 'Gingerbread', 0).find('.steward-muted').eq(0).text();
    assert.strictEqual(sub, '×1 · level 3');
    assert.strictEqual(rowEl(s, "Lovers' Statue").text().indexOf('event'), -1);
});

t.test('d: items are sorted and unproducible ones left out; pages get header options', function () {
    var s = setup();
    s.rows[2].items = [item('Zeta', 'zeta'), item('Beta', 'Alpha'), item('Alpha', 'Alpha'),
                       item('No', 'Blocked', { producible: false, why: 'level' }),
                       item('Maybe', 'maybe', { producible: null, why: 'unreadable' })];
    openAll(s);
    assert.deepStrictEqual(optionsOf(s, cellOf(s, 'Gingerbread', 1).find('select')),
        ['(none)', 'Alpha', 'Alpha', 'maybe', 'zeta']);
    var opts = cellOf(s, 'Gingerbread', 1).find('option');
    assert.strictEqual(opts.eq(1).attr('value'), 'Alpha');

    var u = setup();
    u.rows[2].items = [item('R2', 'rare b', { page: '10', pageLabel: 'Ten' }),
                       item('C2', 'common b', { page: '2', pageLabel: 'Rare' }),
                       item('C1', 'Common a', { page: '1', pageLabel: 'Common' }),
                       item('C3', 'Common c', { page: '1', pageLabel: 'Common' }),
                       item('X', 'hidden', { page: '1', pageLabel: 'Common', producible: false })];
    openAll(u);
    assert.deepStrictEqual(optionsOf(u, cellOf(u, 'Gingerbread', 1).find('select')),
        ['(none)', '#Common', 'Common a', 'Common c', '#Rare', 'common b', '#Ten', 'rare b']);
});

t.test('e: a saved unproducible item stays selected with its note', function () {
    var s = setup({ Gingerbread: { item: 'No', items: 1, buff: '', enabled: true } });
    s.rows[2].items = [item('Yes', 'Yes'), item('No', 'Blocked', { producible: false, why: 'level' })];
    openAll(s);
    var $sel = cellOf(s, 'Gingerbread', 1).find('select');
    assert.deepStrictEqual(optionsOf(s, $sel), ['(none)', 'Yes', 'Blocked']);
    assert.strictEqual(selectedOf(s, $sel), 'Blocked');
    assert.ok(/not producible now/.test(cellOf(s, 'Gingerbread', 1).text()));
    assert.strictEqual(s.win.hasEdits(), false);
    pick(s, 'Gingerbread', 1, 'Yes');
    assert.strictEqual(cellOf(s, 'Gingerbread', 1).text().indexOf('not producible now'), -1);
});

t.test('f: the buff list leaves out not-offered and stock-0 buffs; a stored stock-0 buff shows None', function () {
    var s = setup({ Gingerbread: { item: '', items: 1, buff: 'Duck', enabled: false } });
    openAll(s);
    var $sel = cellOf(s, 'Gingerbread', 3).find('select');
    assert.deepStrictEqual(optionsOf(s, $sel), ['None', 'Fish platter (3)', 'Salt (?)']);
    assert.strictEqual(selectedOf(s, $sel), 'None');
    assert.strictEqual($sel.val(), '');
    assert.strictEqual(saveBtn(s).prop('disabled'), true);
    assert.ok(/No unsaved changes/.test(footer(s).text()));
    assert.strictEqual(s.win.hasEdits(), false);
});

t.test('g: Save clears a hidden buff once another field changed; Items alone is one change', function () {
    var s = setup({ Barracks: { item: 'BarracksItem', items: 1, buff: 'Duck', enabled: true } });
    var writes = capture(s);
    openAll(s);
    setItems(s, 'Barracks', '5');
    assert.ok(/2 changes/.test(footer(s).text()));
    click(footer(s), s.$, 'Save');
    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(writes[0][1], { buildings: { Barracks: { item: 'BarracksItem', items: 5, buff: '', enabled: true } } });
    assert.strictEqual(s.win.hasEdits(), false);
    assert.strictEqual(saveBtn(s).prop('disabled'), true);

    var u = setup({ Barracks: { item: 'BarracksItem', items: 1, buff: 'Fish', enabled: true } });
    openAll(u);
    setItems(u, 'Barracks', '5');
    assert.ok(footer(u).text().indexOf('1 change: Barracks items 1 → 5') > -1, footer(u).text());
    assert.strictEqual(cellOf(u, 'Barracks', 1).find('.steward-muted').eq(1).text(), 'cost of BarracksItem x5');
});

t.test('g: a hidden buff counts only once the draft changes, and is named in the note', function () {
    var s = setup({ Barracks: { item: 'BarracksItem', items: 1, buff: 'Duck', enabled: true } });
    s.win.open();
    s.rig.visible = true;
    flip(s, 'Barracks', false);
    assert.ok(/2 changes/.test(footer(s).text()));
    flip(s, 'Barracks', true);
    assert.ok(/No unsaved changes/.test(footer(s).text()));
    setItems(s, 'Barracks', '1');
    pick(s, 'Barracks', 1, 'BarracksOther');
    pick(s, 'Barracks', 1, 'BarracksItem');
    assert.strictEqual(s.win.hasEdits(), false);
    pick(s, 'Barracks', 3, 'Fish');
    pick(s, 'Barracks', 3, '');
    // Picking None by hand is the same draft as the hidden buff cleared.
    assert.ok(footer(s).text().indexOf('1 change: Barracks buff Roasted duck → none') > -1, footer(s).text());
});

t.test('h: picking an item names it by label in the note', function () {
    var s = setup();
    openAll(s);
    pick(s, "Lovers' Statue", 1, 'CupidsArrow');
    assert.ok(footer(s).text().indexOf("1 change: Lovers' Statue item none → Cupid's Arrow") > -1, footer(s).text());
    assert.ok(byText(body(s), s.$, 'button', 'Production Manager •'));
});

t.test('i: flipping Enable is one change', function () {
    var s = setup();
    openAll(s);
    flip(s, 'Barracks', true);
    assert.ok(footer(s).text().indexOf('1 change: Barracks enabled off → on') > -1, footer(s).text());
});

t.test('j: Bookbinder Items is a muted 1; Barracks Items clamps to 25', function () {
    var s = setup();
    openAll(s);
    var $b = cellOf(s, 'Bookbinder', 2);
    assert.strictEqual($b.find('input').length, 0);
    assert.strictEqual($b.find('.steward-muted').eq(0).text(), '1');
    assert.ok($b.find('.steward-muted').eq(0).hasClass('steward-muted'));
    assert.ok(/one book at a time/.test($b.text()));
    assert.strictEqual(cellOf(s, 'Gingerbread', 2).find('input').length, 1, 'Timed Items is editable');
    var $in = setItems(s, 'Barracks', '99');
    assert.strictEqual($in.val(), '25');
});

t.test('j2: Items 0 shows 1; the typed value goes through itemsFor; runsMax 1 fixes the cell', function () {
    var s = setup();
    openAll(s);
    assert.strictEqual(setItems(s, 'Barracks', '0').val(), '1');
    var P = s.S.modules.production;
    var seen = [];
    P.itemsFor = function (cfg, type) { seen.push([cfg.items, type]); return 9; };
    var $in = setItems(s, 'Barracks', '7');
    assert.ok(seen.some(function (c) { return c[0] === 7 && c[1] === UNITS; }), JSON.stringify(seen));
    assert.strictEqual($in.val(), '9');
});

t.test('j3: runsMax 1 on Barracks gives the muted fixed 1 with no input', function () {
    var s = setup();
    s.S.modules.production.runsMax = function () { return 1; };
    openAll(s);
    var $c = cellOf(s, 'Barracks', 2);
    assert.strictEqual($c.find('input').length, 0);
    assert.strictEqual($c.find('.steward-muted').eq(0).text(), '1');
});

t.test('k: the Settings switch writes only { bookComplete } and is not part of the draft', function () {
    var s = setup();
    var writes = capture(s);
    s.win.open('settings');
    s.rig.visible = true;
    assert.ok(/Bookbinder auto-complete/.test(body(s).text()));
    assert.ok(/Settings on this tab apply at once/.test(footer(s).text()));
    assert.strictEqual(saveBtn(s), null);
    var $sw = body(s).find('input').eq(0);
    assert.strictEqual($sw.prop('checked'), true);
    $sw.prop('checked', false);
    $sw.trigger('change');
    assert.deepStrictEqual(writes, [['production', { bookComplete: false }]]);
    assert.strictEqual(s.win.hasEdits(), false);
    click(body(s), s.$, 'Production Manager');
    assert.strictEqual(saveBtn(s).prop('disabled'), true);
});

t.test('l: no render reads the removed readers; the Queues chip counts the producing rows passed on', function () {
    var s = setup();
    var P = s.S.modules.production;
    var bad = 0;
    function boom() { bad++; throw new Error('must not be read'); }
    P.assess = boom;
    P.recent = boom;
    P.lastPass = boom;
    P.model.reservations = boom;
    P.model.onOff = boom;
    P.model.queues = function () {
        return [{ type: 1, producing: true }, { type: 2, producing: false }, { type: 3, producing: true }];
    };
    s.win.open();
    s.rig.visible = true;
    click(body(s), s.$, 'Queues 2');
    click(body(s), s.$, 'Settings');
    click(body(s), s.$, 'Production Manager');
    assert.strictEqual(bad, 0);
    var d = s.views.calls[s.views.calls.length - 1][1];
    assert.strictEqual(d.queues.length, 3);
    assert.strictEqual(d.queues.filter(function (q) { return q.producing; }).length, 2);
});

t.test('m: the notices say Automatic queues saved and changes discarded', function () {
    var s = setup();
    openAll(s);
    flip(s, 'Barracks', true);
    click(footer(s), s.$, 'Save');
    assert.ok(s.alerts.indexOf('Steward: Automatic queues saved') > -1);
    flip(s, 'Barracks', false);
    click(footer(s), s.$, 'Close');
    assert.ok(s.alerts.indexOf('Steward: Automatic queue changes discarded') > -1);
});

t.test('the edit guard is true only while visible and dirty', function () {
    var s = setup();
    openAll(s);
    assert.strictEqual(s.win.hasEdits(), false);
    setItems(s, 'Barracks', '7');
    assert.strictEqual(s.win.hasEdits(), true);
    s.rig.visible = false;
    assert.strictEqual(s.win.hasEdits(), false);
    assert.strictEqual(s.win.isOpen(), false);
});

t.test('Save is disabled until a change and writes only { buildings }; no edit writes nothing', function () {
    var s = setup({ Barracks: { item: 'BarracksItem', items: 3, buff: '', enabled: true } });
    var writes = capture(s);
    s.win.open();
    s.rig.visible = true;
    assert.strictEqual(saveBtn(s).prop('disabled'), true);
    click(footer(s), s.$, 'Save');
    assert.strictEqual(writes.length, 0);
    setItems(s, 'Barracks', '20');
    assert.strictEqual(saveBtn(s).prop('disabled'), false);
    click(footer(s), s.$, 'Save');
    assert.deepStrictEqual(Object.keys(writes[0][1]), ['buildings']);
    assert.deepStrictEqual(writes[0][1].buildings.Barracks, { item: 'BarracksItem', items: 20, buff: '', enabled: true });
    click(footer(s), s.$, 'Save');
    assert.strictEqual(writes.length, 1);
});

t.test('switching tabs keeps the draft', function () {
    var s = setup();
    openAll(s);
    setItems(s, 'Barracks', '12');
    click(body(s), s.$, 'Queues 1');
    assert.ok(/queues view/.test(body(s).text()));
    assert.strictEqual(s.win.hasEdits(), true);
    click(body(s), s.$, 'Production Manager •');
    assert.strictEqual(cellOf(s, 'Barracks', 2).find('input').eq(0).val(), '12');
});

t.test('a throwing view is contained in its tab', function () {
    var s = setup();
    s.S.modules.production.views.queues = function () { throw new Error('queues boom'); };
    s.win.open('queues');
    var text = body(s).text();
    assert.ok(/This view could not be shown: queues boom/.test(text));
    assert.ok(/Auto-production on/.test(text));
    click(body(s), s.$, 'Production Manager');
    assert.ok(rowEl(s, 'Barracks'));
});

t.test('the header is the submenu status line behind the on/off word', function () {
    var s = setup();
    s.win.open();
    var $head = body(s).find('.steward-subhead').eq(0);
    assert.strictEqual($head.text(), 'Auto-production on · 2 queues · 3 entries · breaker ok');
});

t.test('a key added to the default row is drafted and saved', function () {
    var s = setup();
    s.S.modules.production.defaultBuilding.note = 'n';
    openAll(s);
    setItems(s, 'Barracks', '5');
    assert.ok(/1 change: Barracks items 1 → 5/.test(footer(s).text()));
    click(footer(s), s.$, 'Save');
    var saved = s.H.settings.read('production').buildings.Barracks;
    assert.strictEqual(saved.note, 'n');
    assert.strictEqual(saved.items, 5);
});

t.test('window.js keeps no literal field list and no standing-order wording', function () {
    var src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'production', 'window.js'), 'utf8');
    assert.strictEqual(src.indexOf("['item', 'items'"), -1);
    assert.strictEqual(/standing order/i.test(src), false);
});

function activeChip(s) {
    var hit = null;
    body(s).find('button.steward-chip.active').each(function () {
        var txt = s.$(this).text();
        if (/^(All buildings|Automatic queues) /.test(txt)) hit = txt;
    });
    return hit;
}

t.test('the manager opens on All buildings while no automatic queue exists', function () {
    var s = setup();
    s.win.open();
    s.rig.visible = true;
    assert.strictEqual(activeChip(s), 'All buildings 4');
    assert.ok(rowEl(s, 'Gingerbread'));
});

t.test('the manager opens on Automatic queues once a row holds an item or a buff', function () {
    var s = setup({ Gingerbread: { item: 'GingerbreadItem', items: 1, buff: '', enabled: false } });
    s.win.open();
    s.rig.visible = true;
    assert.strictEqual(activeChip(s), 'Automatic queues 1');
    assert.strictEqual(body(s).find('tbody').eq(0).find('tr').length, 1);
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
    s.win.open();
    var mine = lines.filter(function (l) { return /window render/.test(l); });
    assert.strictEqual(mine.length, 1);
    assert.ok(/window render manager took \d+ ms/.test(mine[0]));
});

t.test('host: a window fading out after a hide holds no edits and is not open', function () {
    var s = hostSetup();
    s.win.open();
    click(body(s), s.$, 'All buildings 4');
    setItems(s, 'Barracks', '7');
    assert.strictEqual(s.win.hasEdits(), true);
    s.S.kernel.ui.hideModal(s.rig.made[s.rig.made.length - 1].modal);
    assert.strictEqual(s.win.hasEdits(), false);
    assert.strictEqual(s.win.isOpen(), false);
    s.rig.flushFades();
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
    s.win.open();
    assert.strictEqual(ui.screen.modal(), null);
    assert.strictEqual(ui.hasOpenEdits(), false);
    click(body(s), s.$, 'All buildings 4');
    setItems(s, 'Barracks', '7');
    click(footer(s), s.$, 'Save');
    var saved = s.H.settings.read('production').buildings;
    assert.strictEqual(saved.Barracks.items, 7);
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

t.test('k: a row with no listed buff has an empty Buff cell, not a lone None dropdown', function () {
    var s = setup();
    s.rows[1].buffs = [];
    s.rows[2].buffs = [{ name: 'Duck', label: 'Roasted duck', amount: 0, offered: true },
                       { name: 'Gold', label: 'Gold leaf', amount: 9, offered: false }];
    openAll(s);
    assert.strictEqual(cellOf(s, 'Barracks', 3).find('select').length, 0);
    assert.strictEqual(cellOf(s, 'Barracks', 3).text(), '');
    assert.strictEqual(cellOf(s, 'Gingerbread', 3).find('select').length, 0);
    assert.strictEqual(cellOf(s, 'Bookbinder', 3).find('select').length, 1);
});

t.test('k: a stored buff on a row with no listed buff is cleared once another field changed', function () {
    var s = setup({ Barracks: { item: 'BarracksItem', items: 1, buff: 'Duck', enabled: true } });
    s.rows[1].buffs = [];
    var writes = capture(s);
    openAll(s);
    assert.strictEqual(s.win.hasEdits(), false);
    setItems(s, 'Barracks', '5');
    click(footer(s), s.$, 'Save');
    assert.deepStrictEqual(writes[0][1], { buildings: { Barracks: { item: 'BarracksItem', items: 5, buff: '', enabled: true } } });
});

t.test('n3: the buff drop-down returns when the stock returns', function () {
    var s = setup({ Barracks: { item: 'BarracksItem', items: 1, buff: 'Duck', enabled: true } });
    s.rows[1].buffs = [];
    openAll(s);
    assert.strictEqual(cellOf(s, 'Barracks', 3).find('select').length, 0);
    s.rows[1].buffs = [{ name: 'Duck', label: 'Roasted duck', amount: 2, offered: true }];
    click(body(s), s.$, 'Queues 1');
    click(body(s), s.$, 'Production Manager');
    var $sel = cellOf(s, 'Barracks', 3).find('select');
    assert.strictEqual($sel.length, 1);
    assert.deepStrictEqual(optionsOf(s, $sel), ['None', 'Roasted duck (2)']);
    assert.strictEqual($sel.val(), 'Duck');
    assert.strictEqual(s.win.hasEdits(), false);
});

t.test('k: an empty buff cell leaves Item and Enable editing and dirty tracking intact', function () {
    var s = setup();
    s.rows[1].buffs = [];
    openAll(s);
    pick(s, 'Barracks', 1, 'BarracksOther');
    assert.ok(footer(s).text().indexOf('1 change') > -1, footer(s).text());
    flip(s, 'Barracks', true);
    assert.ok(/2 changes/.test(footer(s).text()), footer(s).text());
});
