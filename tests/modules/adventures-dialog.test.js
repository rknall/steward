'use strict';

// The template window is driven through the element tree the jq fake builds:
// the Modal stand-in hands out real Body and Footer elements, so a case
// clicks the same buttons a user would.

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var jq = require('../stubs/jq');
var hostStubs = require('../stubs/host');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup() {
    var afs = airfs.make();
    var alerts = [];
    var H = harness.boot({ host: {
        air: afs.air,
        showGameAlert: function (m) { alerts.push(m); }
    } });
    var $ = jq.install(H);
    var rig = hostStubs.installModal(H);
    return {
        H: H, $: $, rig: rig, fs: afs, alerts: alerts,
        S: H.Steward,
        dialog: H.Steward.modules.adventures.dialog,
        tpl: H.Steward.modules.adventures.templates
    };
}

function body(s) { return s.rig.made[s.rig.made.length - 1].modal.Body(); }
function footer(s) { return s.rig.made[s.rig.made.length - 1].modal.Footer(); }

// The first button under `$root` whose text equals `label`, clicked.
function click($root, $, label) {
    var hit = null;
    $root.find('button').each(function () {
        if (!hit && $(this).text() === label) hit = $(this);
    });
    assert.ok(hit, 'button "' + label + '" exists');
    hit.trigger('click');
}

function openEdit(s) {
    s.dialog.open();
    s.rig.visible = true;
    click(body(s), s.$, 'New template');
}

function typeLabel(s, text) {
    var $in = body(s).find('input').eq(0);
    $in.val(text).trigger('input');
}

t.test('dialog.js loads without the edit-guard API on the kernel UI', function () {
    var H = harness.boot();
    delete H.Steward.kernel.ui.addEditGuard;
    delete H.Steward.modules.adventures.dialog;
    var src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'adventures', 'dialog.js'), 'utf8');
    vm.runInContext(src, H.ctx);
    assert.strictEqual(typeof H.Steward.modules.adventures.dialog.open, 'function');
});

t.test('dialog.js registers its edit guard with the kernel UI', function () {
    var H = harness.boot();
    var ids = [];
    H.Steward.kernel.ui.addEditGuard = function (id) { ids.push(id); };
    var src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'adventures', 'dialog.js'), 'utf8');
    vm.runInContext(src, H.ctx);
    assert.deepStrictEqual(plain(ids), ['adventures']);
});

t.test('open shows the list view in the Steward adventures window', function () {
    var s = setup();
    s.dialog.open();
    assert.strictEqual(s.rig.made.length, 1);
    assert.strictEqual(s.rig.made[0].id, 'StewardAdventures');
    assert.strictEqual(body(s).find('.steward-card-h').eq(0).text().indexOf('Run templates') > -1, true);
    assert.strictEqual(body(s).find('button').length > 0, true);
});

t.test('open is refused while another window has open edits', function () {
    var s = setup();
    s.S.kernel.ui.hasOpenEdits = function () { return true; };
    s.dialog.open();
    assert.strictEqual(s.rig.made.length, 0);
    assert.strictEqual(s.alerts.length, 1);
    assert.ok(/Save or close/.test(s.alerts[0]));
});

t.test('Back to list with a changed draft says the changes were discarded', function () {
    var s = setup();
    openEdit(s);
    typeLabel(s, 'Changed');
    click(footer(s), s.$, 'Back to list');
    assert.deepStrictEqual(s.alerts, ['Steward: Template changes discarded']);
    assert.strictEqual(s.dialog.hasEdits(), false);
});

t.test('Back to list without changes says nothing', function () {
    var s = setup();
    openEdit(s);
    click(footer(s), s.$, 'Back to list');
    assert.deepStrictEqual(s.alerts, []);
});

t.test('hasEdits needs a changed draft in a visible window', function () {
    var s = setup();
    openEdit(s);
    assert.strictEqual(s.dialog.hasEdits(), false);
    typeLabel(s, 'Changed');
    assert.strictEqual(s.dialog.hasEdits(), true);
    s.rig.visible = false;
    assert.strictEqual(s.dialog.hasEdits(), false);
});

t.test('needs names what the draft still lacks, including a taken label', function () {
    var s = setup();
    var draft = s.tpl.normalize({});
    assert.deepStrictEqual(plain(s.dialog.needs(draft, [])),
        ['a label', 'an adventure', 'a loadout', 'at least one wave']);

    draft = s.tpl.normalize({ label: 'Knights', adventure: 'BlackKnights', loadout: 'l.json',
        waves: ['a.json', ''] });
    assert.deepStrictEqual(plain(s.dialog.needs(draft, [])), ['a file for every wave']);

    draft.waves = ['a.json'];
    assert.deepStrictEqual(plain(s.dialog.needs(draft, [])), []);
    var taken = [{ id: 't1', label: ' KNIGHTS ' }];
    assert.deepStrictEqual(plain(s.dialog.needs(draft, taken)), ['a label no other template uses']);
    draft.id = 't1';
    assert.deepStrictEqual(plain(s.dialog.needs(draft, taken)), []);
});

// The same window on the host Modal model: stage swaps, Bootstrap's
// hide-fires-first rule and the fade are all counted.
function setupHost() {
    var afs = airfs.make();
    var H = harness.boot({ host: {
        air: afs.air,
        showGameAlert: function () {}
    } });
    var $ = jq.install(H);
    var rig = hostStubs.installModal(H, { host: true });
    H.Steward.kernel.ui.ensureStyle = function () {};
    return {
        H: H, $: $, rig: rig, S: H.Steward,
        dialog: H.Steward.modules.adventures.dialog
    };
}

t.test('a window fading out after a hide holds no edits', function () {
    var s = setupHost();
    s.dialog.open();
    click(s.rig.made[s.rig.made.length - 1].modal.Body(), s.$, 'New template');
    s.rig.made[s.rig.made.length - 1].modal.Body().find('input').eq(0).val('Changed').trigger('input');
    assert.strictEqual(s.dialog.hasEdits(), true);
    s.S.kernel.ui.hideModal(s.rig.made[s.rig.made.length - 1].modal);
    assert.strictEqual(s.dialog.hasEdits(), false);
    s.rig.flushFades();
    assert.strictEqual(s.dialog.hasEdits(), false);
});

t.test('without the shell probe a dirty draft reads no edits and does not throw', function () {
    var s = setup();
    openEdit(s);
    typeLabel(s, 'Changed');
    delete s.S.kernel.ui.isModalShown;
    assert.strictEqual(s.dialog.hasEdits(), false);
});

t.test('Close clicked twice before the fade ends fires one hide event and stays balanced', function () {
    var s = setupHost();
    s.dialog.open();
    assert.strictEqual(s.rig.isShown('StewardAdventures'), true);
    assert.strictEqual(s.rig.balanced(), true);
    var before = s.rig.swaps;
    var $foot = s.rig.element('StewardAdventures').children().eq(1);
    click($foot, s.$, 'Close');
    click($foot, s.$, 'Close');
    assert.strictEqual(s.rig.swaps - before, 1);
    s.rig.flushFades();
    assert.strictEqual(s.rig.shownIds().length, 0);
    assert.strictEqual(s.rig.balanced(), true);
});

t.test('opening the template dialog right after the dashboard Close stays balanced', function () {
    var s = setupHost();
    s.S.kernel.ui.openDashboard();
    s.rig.element('StewardDashboard').find('.steward-foot-right').trigger('click');
    // No flush: the dashboard is still fading out.
    s.dialog.open();
    assert.deepStrictEqual(s.rig.shownIds(), ['StewardAdventures']);
    assert.strictEqual(s.rig.balanced(), true);
    s.rig.flushFades();
    assert.deepStrictEqual(s.rig.shownIds(), ['StewardAdventures']);
    assert.strictEqual(s.rig.balanced(), true);
});

// ---- Template steps and the star switch ------------------------------------

var LOADOUT = 'C:/b/loadout.txt';

// Battle files by path: a general line per key. The loadout brings g1 and g2.
function fakeFiles(s, files) {
    s.S.core.battles.load = function (p) {
        var keys = files[p];
        if (!keys) return { ok: false, path: p, lines: [], problems: [] };
        var lines = keys.map(function (k) {
            return { kind: s.S.BattleLine.Attack, key: k, name: k === 'g1' ? 'Alpha' : 'Beta', army: [] };
        });
        return { ok: true, path: p, lines: lines, problems: [] };
    };
}

// A saved template opened for editing, the sortable fake capturing the
// options the window hands it.
function editSaved(s, waves, extra) {
    fakeFiles(s, { 'C:/b/loadout.txt': ['g1', 'g2'], 'C:/b/w1.txt': ['g2'], 'C:/b/w2.txt': ['g1'] });
    var rec = { label: 'Steps', adventure: 'BlackKnights', loadout: LOADOUT, waves: waves };
    var k;
    for (k in (extra || {})) rec[k] = extra[k];
    var saved = s.tpl.save(s.tpl.normalize(rec), 1);
    assert.ok(saved.ok, 'template saved');
    s.sortOpts = null;
    s.$.fn.sortable = function (o) { s.sortOpts = o; return this; };
    s.dialog.open();
    s.rig.visible = true;
    click(body(s), s.$, 'Edit');
}

function rowNumbers(s) {
    var out = [];
    body(s).find('.steward-waves li').each(function () {
        out.push(s.$(this).find('.steward-wave-n').text());
    });
    return out;
}

// Moves the rows as a drag would, to stand in `order` (current positions),
// then fires the sortable update.
function drag(s, order) {
    var $ol = body(s).find('.steward-waves');
    var byIdx = {};
    $ol.children('li').each(function () { byIdx[s.$(this).attr('data-idx')] = s.$(this); });
    for (var i = 0; i < order.length; i++) $ol.append(byIdx[String(order[i])]);
    s.sortOpts.update();
}

// The dropdown that offers `value`, set to it.
function choose(s, offers, value) {
    var hit = null;
    body(s).find('select').each(function () {
        var $sel = s.$(this);
        $sel.find('option').each(function () {
            if (s.$(this).attr('value') === offers) hit = $sel;
        });
    });
    assert.ok(hit, 'dropdown offering ' + offers);
    hit.val(value).trigger('change');
}

function toggleByTitle(s, title) {
    var hit = null;
    body(s).find('label').each(function () {
        if (!hit && s.$(this).attr('title') === title) hit = s.$(this);
    });
    assert.ok(hit, 'switch "' + title + '" exists');
    hit.find('input').prop('checked', !hit.find('input').prop('checked')).trigger('change');
}

var HOME_G1 = { step: 'home', generals: ['g1'] };

t.test('a step row shows a bullet and the waves keep their own numbers', function () {
    var s = setup();
    editSaved(s, ['C:/b/w1.txt', HOME_G1, 'C:/b/w2.txt']);
    assert.deepStrictEqual(plain(rowNumbers(s)), ['1', '\u2022', '2']);
});

t.test('needs names the row of a sequence problem by its step', function () {
    var s = setup();
    var draft = s.tpl.normalize({ label: 'K', adventure: 'BlackKnights', loadout: 'l.json',
        waves: ['a.json', HOME_G1, 'b.json'] });
    assert.deepStrictEqual(plain(s.dialog.needs(draft, [], [{ index: 1, message: 'x' }, { index: 1, message: 'y' }])),
        ['a fix in row 2 (Send home)']);
    assert.deepStrictEqual(plain(s.dialog.needs(draft, [], [])), []);
});

t.test('dragging a wave above the Send home row that sent its general home adds no fix; the other way does', function () {
    var s = setup();
    editSaved(s, ['C:/b/w1.txt', HOME_G1, 'C:/b/w2.txt']);
    // w2 uses g1 after the Send home row: the window already says so.
    assert.ok(footer(s).text().indexOf('a fix in row 2 (Send home)') > -1);

    // w2 above the Send home row.
    drag(s, [0, 2, 1]);
    assert.ok(footer(s).text().indexOf('a fix in row') === -1, footer(s).text());
    assert.deepStrictEqual(plain(rowNumbers(s)), ['1', '2', '\u2022']);

    // And back below it: the problem returns, filed under the step's new row.
    drag(s, [0, 2, 1]);
    assert.ok(footer(s).text().indexOf('a fix in row 2 (Send home)') > -1, footer(s).text());
});

t.test('Add step puts the step at the chosen place and marks the draft changed', function () {
    var s = setup();
    editSaved(s, ['C:/b/w1.txt', 'C:/b/w2.txt']);
    assert.strictEqual(s.dialog.hasEdits(), false);
    click(body(s), s.$, 'Add step\u2026');
    choose(s, 'pause', 'pause');
    var $msg = null;
    body(s).find('input').each(function () {
        if (s.$(this).attr('title') === 'Message') $msg = s.$(this);
    });
    assert.ok($msg, 'message input');
    $msg.val('Heal up').trigger('input');
    choose(s, 'end', '1');
    click(body(s), s.$, 'Add step');
    assert.deepStrictEqual(plain(rowNumbers(s)), ['1', '\u2022', '2']);
    assert.strictEqual(s.dialog.hasEdits(), true);
});

t.test('the On arrival switch sets starAll false and Save writes it', function () {
    var s = setup();
    editSaved(s, ['C:/b/w1.txt']);
    assert.strictEqual(s.tpl.list()[0].starAll, true);
    toggleByTitle(s, 'Send all to the star on arrival');
    assert.strictEqual(s.dialog.hasEdits(), true);
    click(footer(s), s.$, 'Save template');
    assert.strictEqual(s.tpl.list()[0].starAll, false);
});

// ---- Picker follows the start check, Pause x min ----------------------------

// The disabled flag and help of the toggle titled `name` in the Add a step card.
function generalToggle(s, name) {
    var hit = null;
    body(s).find('label').each(function () {
        if (!hit && s.$(this).attr('title') === name) hit = s.$(this);
    });
    assert.ok(hit, 'toggle ' + name);
    return hit;
}

t.test('the Unload picker disables a general sent home at an earlier row, by place', function () {
    var s = setup();
    editSaved(s, ['C:/b/w1.txt', 'C:/b/w2.txt', HOME_G1, 'C:/b/w1.txt']);
    click(body(s), s.$, 'Add step\u2026');
    choose(s, 'unload', 'unload');
    choose(s, 'end', '1');
    assert.strictEqual(generalToggle(s, 'Alpha').find('input').prop('disabled') === true, false);
    assert.strictEqual(body(s).text().indexOf('Sent home at an earlier row'), -1);
    choose(s, 'end', 'end');
    assert.ok(generalToggle(s, 'Alpha').find('input').prop('disabled'), 'g1 disabled at the end');
    assert.ok(body(s).text().indexOf('Sent home at an earlier row') > -1);
});

t.test('a Send home row at index 0 still counts as sent home', function () {
    var s = setup();
    editSaved(s, [HOME_G1, 'C:/b/w1.txt', 'C:/b/w2.txt']);
    click(body(s), s.$, 'Add step\u2026');
    choose(s, 'unload', 'unload');
    choose(s, 'end', 'end');
    assert.ok(generalToggle(s, 'Alpha').find('input').prop('disabled'), 'g1 disabled');
    assert.ok(body(s).text().indexOf('Sent home at an earlier row') > -1);
});

t.test('Pause x min shows its minutes in the new row and in the help', function () {
    var s = setup();
    editSaved(s, ['C:/b/w1.txt', 'C:/b/w2.txt']);
    click(body(s), s.$, 'Add step\u2026');
    choose(s, 'wait', 'wait');
    var $min = null;
    body(s).find('input').each(function () {
        if (s.$(this).attr('title') === 'Minutes') $min = s.$(this);
    });
    assert.ok($min, 'minutes input');
    assert.ok(body(s).text().indexOf('from 1 to 120') > -1);
    $min.val('5').trigger('input');
    choose(s, 'end', '1');
    click(body(s), s.$, 'Add step');
    assert.ok(body(s).find('.steward-waves li').eq(1).text().indexOf('Pause 5 min') > -1,
        body(s).find('.steward-waves li').eq(1).text());
});

t.test('needs names a bad Pause x min row by its minutes', function () {
    var s = setup();
    var draft = s.tpl.normalize({ label: 'K', adventure: 'BlackKnights', loadout: 'l.json',
        waves: ['a.json', { step: 'wait', minutes: 121 }, 'b.json'] });
    assert.ok(plain(s.dialog.needs(draft, [])).indexOf('a fix in row 2 (Pause 121 min)') > -1,
        JSON.stringify(s.dialog.needs(draft, [])));
});

// ---- Queues views -----------------------------------------------------------

function clickTab(s, label) {
    var hit = null;
    body(s).find('a').each(function () {
        if (!hit && s.$(this).text() === label) hit = s.$(this);
    });
    assert.ok(hit, 'tab "' + label + '" exists');
    hit.trigger('click');
}

t.test('the Queues tab shows the queue list and Templates returns to the template list', function () {
    var s = setup();
    s.dialog.open();
    s.rig.visible = true;
    clickTab(s, 'Queues');
    assert.ok(body(s).find('.steward-card-h').eq(0).text().indexOf('Run queues') > -1);
    clickTab(s, 'Templates');
    assert.ok(body(s).find('.steward-card-h').eq(0).text().indexOf('Run templates') > -1);
});

t.test('New queue opens the queue editor, and a changed queue draft blocks a close', function () {
    var s = setup();
    s.dialog.open();
    s.rig.visible = true;
    clickTab(s, 'Queues');
    click(body(s), s.$, 'New queue');
    assert.strictEqual(body(s).find('.steward-crumb').length, 1);
    assert.strictEqual(s.dialog.hasEdits(), false);
    body(s).find('input').eq(0).val('Changed').trigger('input');
    assert.strictEqual(s.dialog.hasEdits(), true);
    click(footer(s), s.$, 'Close');
    assert.deepStrictEqual(s.alerts, ['Steward: Queue changes discarded']);
    assert.strictEqual(s.H.Steward.modules.adventures.queueview.isDirty(), false);
});

t.test('opening the window again drops a queue draft left behind', function () {
    var s = setup();
    s.dialog.open();
    s.rig.visible = true;
    clickTab(s, 'Queues');
    click(body(s), s.$, 'New queue');
    body(s).find('input').eq(0).val('Changed').trigger('input');
    s.rig.visible = false;
    s.dialog.open();
    assert.strictEqual(s.H.Steward.modules.adventures.queueview.isDirty(), false);
    assert.ok(body(s).find('.steward-card-h').eq(0).text().indexOf('Run templates') > -1);
});

t.test('a failed queue Edit stays on the list and shows why', function () {
    var s = setup();
    var tr = s.tpl.save({
        label: 'Long map', adventure: 'Adv_Long', loadout: 'C:/b/l.json',
        waves: ['C:/b/w1.json'], speedBuff: 'SpeedBuffDefault'
    }, 1000);
    assert.ok(tr.ok, JSON.stringify(tr.problems));
    var qr = s.S.modules.adventures.queues.save({
        label: 'Gone', entries: [{ kind: 'template', id: tr.id, count: 1 }]
    }, 5000);
    assert.ok(qr.ok, JSON.stringify(qr.problems));
    s.dialog.open();
    s.rig.visible = true;
    clickTab(s, 'Queues');
    delete s.fs.disk[s.S.modules.adventures.queues.pathOf(qr.id)];
    click(body(s), s.$, 'Edit');
    assert.strictEqual(body(s).find('.steward-crumb').length, 0);
    assert.ok(body(s).text().indexOf('Could not open ' + qr.id) > -1, body(s).text());
    assert.strictEqual(body(s).text().indexOf('New queue') > -1, true);
    assert.strictEqual(s.H.Steward.modules.adventures.queueview.editing(), false);
});

t.test('Edit on a queue opens that queue, and Back to list returns to the queue list', function () {
    var s = setup();
    var tr = s.tpl.save({
        label: 'Long map', adventure: 'Adv_Long', loadout: 'C:/b/l.json',
        waves: ['C:/b/w1.json'], speedBuff: 'SpeedBuffDefault'
    }, 1000);
    var qr = s.S.modules.adventures.queues.save({
        label: 'Mine', entries: [{ kind: 'template', id: tr.id, count: 1 }]
    }, 5000);
    s.dialog.open();
    s.rig.visible = true;
    clickTab(s, 'Queues');
    click(body(s), s.$, 'Edit');
    assert.ok(body(s).find('.steward-crumb').text().indexOf('Mine') > -1);
    var back = null;
    body(s).find('a').each(function () { if (!back && s.$(this).text() === 'Back to list') back = s.$(this); });
    back.trigger('click');
    assert.strictEqual(body(s).find('.steward-crumb').length, 0);
    assert.ok(body(s).find('.steward-card-h').eq(0).text().indexOf('Run queues') > -1);
    assert.ok(qr.ok);
});
