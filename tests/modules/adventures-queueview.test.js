'use strict';

// The queue editor views, driven through the jq element-tree fake with a
// stand-in for the window's ctx (render, backToList, notify, helpers).

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var jq = require('../stubs/jq');

var assert = t.assert;

var ROOT = 'C:/client/steward/adventures';
var SDIR = ROOT + '/scenarios';

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup() {
    var afs = airfs.make();
    var notes = [];
    var H = harness.boot({ host: { air: afs.air } });
    var $ = jq.install(H);
    var S = H.Steward;
    var w = {
        H: H, $: $, S: S, fs: afs, notes: notes,
        qv: S.modules.adventures.queueview,
        q: S.modules.adventures.queues,
        tp: S.modules.adventures.templates,
        $body: $('<div>'),
        mode: 'list',
        editId: null,
        synced: 0
    };
    w.ctx = {
        btn: function (label, onClick) { return S.kernel.ui.helpers.button(label, { size: 'sm', onClick: onClick }); },
        iconBtn: function (text, title, disabled, onClick) {
            var $b = $('<button>', { type: 'button', title: title }).text(text);
            if (disabled) $b.attr('disabled', 'disabled');
            $b.on('click', function () { onClick(); });
            return $b;
        },
        textEl: function (tag, cls, text) {
            var $e = $('<' + tag + '>');
            if (cls) $e.addClass(cls);
            return $e.text(text);
        },
        act: function (fn) { return fn; },
        notify: function (m) { notes.push(m); },
        syncMenu: function () { w.synced++; },
        render: function () {
            w.$body.empty();
            var $p = $('<div>');
            if (w.mode === 'edit') w.qv.renderEdit($p, w.ctx, w.editId);
            else w.qv.renderList($p, w.ctx);
            w.$body.append($p);
        },
        backToList: function () { w.mode = 'list'; w.ctx.render(); }
    };
    return w;
}

function template(w, label) {
    var r = w.tp.save({
        label: label, adventure: 'Adv_' + label.replace(/\s/g, ''),
        loadout: 'C:/b/l.json', waves: ['C:/b/w1.json'], speedBuff: 'SpeedBuffDefault'
    }, 1000 + label.length);
    assert.ok(r.ok, JSON.stringify(r.problems));
    return r.id;
}

function scenario(w, id, label) {
    w.fs.dirs[SDIR] = true;
    w.fs.disk[SDIR + '/' + id + '.json'] = JSON.stringify({
        version: 1, label: label, adventure: 'Scen_' + id, trips: [{}]
    });
    return id;
}

function click($root, $, label) {
    var hit = null;
    $root.find('button').each(function () {
        if (!hit && $(this).text() === label) hit = $(this);
    });
    assert.ok(hit, 'button "' + label + '" exists');
    hit.trigger('click');
}

function openEdit(w, id) {
    w.mode = 'edit';
    w.editId = id || null;
    w.ctx.render();
}

function rowNames(w) {
    var out = [];
    w.$body.find('tbody tr').each(function () {
        out.push(w.$(this).find('b').eq(0).text());
    });
    return out;
}

function saveBtn(w) {
    var hit = null;
    w.$body.find('button').each(function () {
        if (w.$(this).text() === 'Save queue') hit = w.$(this);
    });
    return hit;
}

function pick(w, value) {
    var $sel = w.$body.find('select').eq(0);
    $sel.val(value).trigger('change');
    click(w.$body, w.$, 'Add entry');
}

function footerText(w) {
    return w.$body.find('.steward-card-foot').last().text();
}

t.test('saving a new mixed queue writes a file with kinds and options', function () {
    var w = setup();
    var a = template(w, 'Long map');
    var s = scenario(w, 'chain', 'Chain');
    openEdit(w, null);
    w.$body.find('input').eq(0).val('Mixed').trigger('input');
    pick(w, 'template:' + a);
    pick(w, 'scenario:' + s);
    // Loop toggle, retrain off, no map skip, early on.
    w.$body.find('input[type=checkbox]').eq(0).prop('checked', true).trigger('change');
    var $sels = w.$body.find('select');
    $sels.eq(1).val('off').trigger('change');
    $sels.eq(2).val('skip').trigger('change');
    w.$body.find('input[type=checkbox]').eq(1).prop('checked', true).trigger('change');
    assert.strictEqual(saveBtn(w).prop('disabled'), false);
    saveBtn(w).trigger('click');

    var recs = w.q.list();
    assert.strictEqual(recs.length, 1);
    assert.deepStrictEqual(plain(recs[0].entries), [
        { kind: 'template', id: a, count: 1 }, { kind: 'scenario', id: s, count: 1 }
    ]);
    assert.strictEqual(recs[0].loop, true);
    assert.strictEqual(recs[0].retrain, 'off');
    assert.strictEqual(recs[0].noMap, 'skip');
    assert.strictEqual(recs[0].early, true);
    assert.strictEqual(w.mode, 'list');
    assert.strictEqual(w.synced, 1);
    assert.deepStrictEqual(w.notes, ['Queue Mixed saved.']);
    assert.strictEqual(w.qv.isDirty(), false);
});

t.test('reorder and remove change the draft', function () {
    var w = setup();
    var a = template(w, 'Long map');
    var b = template(w, 'Short');
    var s = scenario(w, 'chain', 'Chain');
    var r = w.q.save({ label: 'Q', entries: [
        { kind: 'template', id: a, count: 1 }, { kind: 'scenario', id: s, count: 1 },
        { kind: 'template', id: b, count: 1 }
    ] }, 5000);
    assert.ok(r.ok);
    openEdit(w, r.id);
    // Rows: Long map, Chain, Short. Move Chain down, then remove the first.
    var $btns = w.$body.find('button');
    var down = [];
    $btns.each(function () { if (w.$(this).attr('title') === 'Move down') down.push(w.$(this)); });
    down[1].trigger('click');
    assert.deepStrictEqual(rowNames(w).slice(0, 3), ['Long map', 'Short', 'Chain']);
    assert.strictEqual(w.qv.isDirty(), true);
    var rm = [];
    w.$body.find('button').each(function () { if (w.$(this).attr('title') === 'Remove') rm.push(w.$(this)); });
    rm[0].trigger('click');
    assert.deepStrictEqual(rowNames(w).slice(0, 2), ['Short', 'Chain']);
});

t.test('Save is disabled with a missing scenario and the footer names it', function () {
    var w = setup();
    var a = template(w, 'Long map');
    var s = scenario(w, 'chain', 'Chain');
    var r = w.q.save({ label: 'Q', entries: [
        { kind: 'template', id: a, count: 1 }, { kind: 'scenario', id: s, count: 1 }
    ] }, 5000);
    delete w.fs.disk[SDIR + '/chain.json'];
    openEdit(w, r.id);
    w.$body.find('input').eq(0).val('Renamed').trigger('input');
    assert.strictEqual(saveBtn(w).prop('disabled'), true);
    assert.ok(/Still needs readable entry 2/.test(footerText(w)), footerText(w));
    assert.ok(w.$body.text().indexOf('Entry 2: scenario chain is missing or unreadable') > -1);
});

t.test('the running-queue warning shows only for the running id', function () {
    var w = setup();
    var a = template(w, 'Long map');
    var s = scenario(w, 'chain', 'Chain');
    var one = w.q.save({ label: 'One', entries: [{ kind: 'template', id: a, count: 1 }] }, 5000);
    var two = w.q.save({ label: 'Two', entries: [{ kind: 'scenario', id: s, count: 1 }] }, 6000);
    var copy = w.q.toRun(w.q.get(one.id));
    copy.index = 0;
    w.S.modules.adventures.state.current().request = { queue: copy };
    openEdit(w, two.id);
    assert.strictEqual(w.$body.text().indexOf('is running now') > -1, false);
    w.mode = 'list';
    w.ctx.render();
    assert.ok(w.$body.text().indexOf('running now') > -1, 'list row tagged');
    openEdit(w, one.id);
    var text = w.$body.text();
    assert.ok(text.indexOf('One is running now (entry 1/1: Long map)') > -1, text);
    assert.ok(text.indexOf('apply at the next start') > -1);
    // Save repeats it.
    w.$body.find('input').eq(0).val('One b').trigger('input');
    saveBtn(w).trigger('click');
    assert.ok(/The running queue is not changed.*entry 1\/1: Long map/.test(w.notes[0]), w.notes[0]);
});

t.test('isDirty is true after an edit and false after Save', function () {
    var w = setup();
    var a = template(w, 'Long map');
    var r = w.q.save({ label: 'Q', entries: [{ kind: 'template', id: a, count: 1 }] }, 5000);
    openEdit(w, r.id);
    assert.strictEqual(w.qv.isDirty(), false);
    w.$body.find('input').eq(0).val('Q2').trigger('input');
    assert.strictEqual(w.qv.isDirty(), true);
    saveBtn(w).trigger('click');
    assert.strictEqual(w.qv.isDirty(), false);
    assert.strictEqual(w.q.get(r.id).label, 'Q2');
});

t.test('an unknown kind stays in the draft, marked, and blocks Save', function () {
    var w = setup();
    var a = template(w, 'Long map');
    w.fs.dirs[ROOT + '/queues'] = true;
    w.fs.disk[ROOT + '/queues/qx.json'] = JSON.stringify({ version: 1, label: 'Future', entries: [
        { kind: 'template', id: a, count: 1 }, { kind: 'venture', id: 'v1', count: 1 }
    ] });
    openEdit(w, 'qx');
    assert.ok(w.$body.text().indexOf('Unknown kind: venture') > -1);
    assert.ok(w.$body.text().indexOf('unknown kind venture') > -1);
    w.$body.find('input').eq(0).val('Future 2').trigger('input');
    assert.strictEqual(saveBtn(w).prop('disabled'), true);
});

t.test('the list shows broken files and deletes in two steps', function () {
    var w = setup();
    var a = template(w, 'Long map');
    var r = w.q.save({ label: 'Q', entries: [{ kind: 'template', id: a, count: 2 }] }, 5000);
    w.fs.disk[ROOT + '/queues/bad.json'] = '{nope';
    w.ctx.render();
    assert.ok(w.$body.text().indexOf('bad.json') > -1);
    var del = null;
    w.$body.find('a').each(function () { if (!del && w.$(this).text() === 'Delete') del = w.$(this); });
    del.trigger('click');
    assert.strictEqual(w.q.get(r.id) !== null, true);
    var sure = null;
    w.$body.find('a').each(function () { if (w.$(this).text() === 'Delete for good') sure = w.$(this); });
    assert.ok(sure, 'confirmation shown');
    sure.trigger('click');
    assert.strictEqual(w.synced, 1);
});

t.test('a label is shown as text, never as HTML', function () {
    var w = setup();
    var a = template(w, 'Long map');
    w.q.save({ label: '<b>x</b>', entries: [{ kind: 'template', id: a, count: 1 }] }, 5000);
    w.ctx.render();
    assert.ok(w.$body.text().indexOf('<b>x</b>') > -1);
});
