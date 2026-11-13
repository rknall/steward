'use strict';

// The ~Adventures~ bar menu of the adventures module: the rows folded from the steps
// table, their marks and details, the run controls and the row-set signature.
// Runs are built in the home world of tests/stubs/adventures.js and put at the
// step a test is about; the menu only reads memory, so no game traffic is
// needed.

var t = require('../runner');
var W = require('../stubs/adventures');

var assert = t.assert;

var WAVES = ['C:/b/w1.txt', 'C:/b/w2.txt', 'C:/b/w3.txt', 'C:/b/w4.txt'];

// The value of a step named by its key: 'Pack' is a run step, 'wave Supply' a
// wave step (Supply, Load and Verify exist in both tables).
function stepValue(w, key) {
    var m = /^wave (\w+)$/.exec(key);
    return m ? w.S.WaveStep[m[1]] : w.S.RunStep[key];
}

// o.waves: wave file count (default 2); o.step: a key for stepValue; o.waveIndex; o.count and
// o.finished: the request; o.paused pauses the run at its step;
// o.run: run fields set after newRun.
function setup(o) {
    o = o || {};
    var w = W.world({ home: true });
    w.run = w.S.modules.adventures.run;
    w.rm = w.S.modules.adventures.runmenu;
    if (o.none) return w;
    // Retraining is a module setting; o.run.retrain stands for it and never lands on the run.
    w.S.kernel.settings.write('adventures', { retrain: !(o.run && o.run.retrain === false) });
    var r = w.st.newRun({
        id: 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', zoneId: null,
        paths: WAVES.slice(0, o.waves || 2), loadoutPath: W.LOADOUT, loadoutKeys: {},
        waveIndex: o.waveIndex || 0, speedBuff: o.speedBuff || 'SpeedBuffDefault',
        step: w.S.RunStep.Muster
    });
    // After newRun, which starts a wave step's run at Gate.
    r.step = stepValue(w, o.step || 'Muster');
    var k;
    for (k in (o.run || {})) {
        if (k !== 'retrain' && Object.prototype.hasOwnProperty.call(o.run, k)) r[k] = o.run[k];
    }
    w.st.begin({
        templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: o.count || 1, ended: false,
        requested: w.t, finished: o.finished || 0, closedAt: null
    }, r);
    if (o.paused) w.st.pause(w.S.RunPause.User, 'paused by you');
    return w;
}

// The run's island, viewed: the zone the steps after Pack run on.
function onIsland(w) {
    w.st.run().zoneId = W.ZONE;
    w.H.host.game.gi.visitZone(W.ZONE);
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

// Rows of every group in order: [{ group, label, file, mark, detail }].
function flat(w) {
    var out = [];
    var groups = w.rm.rows();
    for (var g = 0; g < groups.length; g++) {
        for (var n = 0; n < groups[g].rows.length; n++) {
            var row = groups[g].rows[n];
            out.push({ group: groups[g].label, label: row.label, file: row.file, mark: row.mark, detail: row.detail });
        }
    }
    return out;
}

function row(w, label) {
    var list = flat(w);
    for (var i = 0; i < list.length; i++) if (list[i].label === label) return list[i];
    throw new Error('no row ' + label);
}

function marks(w) {
    return flat(w).map(function (r) { return r.mark; });
}

function labelOf(item, pass) {
    if (item.separator) return '---';
    return typeof item.label === 'function' ? item.label(pass) : item.label;
}

function enabledOf(item, pass) {
    return typeof item.enabled === 'function' ? item.enabled(pass) : item.enabled !== false;
}

function labels(w) {
    var pass = {};
    return w.rm.items().map(function (it) { return labelOf(it, pass); });
}

// Every label depth first with one pass: an entry's label, then its children's.
function allLabels(w) {
    var pass = {};
    var out = [];
    function walk(list) {
        list.forEach(function (it) {
            out.push(labelOf(it, pass));
            if (Array.isArray(it.items)) walk(it.items);
        });
    }
    walk(w.rm.items());
    return out;
}

// The top-level items that are submenu entries.
function groupItems(w) {
    return w.rm.items().filter(function (it) { return Array.isArray(it.items); });
}

function itemByLabel(w, label) {
    var items = w.rm.items();
    for (var i = 0; i < items.length; i++) if (!items[i].separator && items[i].label === label) return items[i];
    throw new Error('no item ' + label);
}

var CONTROLS = [['Pause run', 'pause'], ['Resume run', 'resume'], ['End repetition', 'endRepetition'],
    ['Skip entry', 'skipEntry'], ['Stop run', 'stop']];

// The enabled flags of the five controls, in menu order, in one pass.
function enabledFlags(w) {
    var pass = {};
    return CONTROLS.map(function (c) { return enabledOf(itemByLabel(w, c[0]), pass); });
}

// ---- table --------------------------------------------------------------------

t.test('every run step falls in exactly one stage row with a group and a label', function () {
    var w = setup({ none: true });
    var rows = w.st.stepRows();
    Object.keys(w.S.RunStep).forEach(function (key) {
        var pos = w.st.position(w.S.RunStep[key]);
        assert.ok(pos >= 0, key + ' has a position');
        var hits = rows.filter(function (r) { return pos >= r.first && pos <= r.last; });
        assert.strictEqual(hits.length, 1, key + ' falls in ' + hits.length + ' rows');
        assert.strictEqual(hits[0].waves, false, key + ' is a stage row');
        assert.ok(hits[0].group !== '' && hits[0].label !== '', key + ' has a group and a label');
    });
    Object.keys(w.S.WaveStep).forEach(function (key) {
        var pos = w.st.position(w.S.WaveStep[key]);
        var hits = rows.filter(function (r) { return pos >= r.first && pos <= r.last; });
        assert.strictEqual(hits.length, 1, key + ' falls in ' + hits.length + ' rows');
        assert.strictEqual(hits[0].waves, true, key + ' is in the waves row');
    });
});

t.test('wave steps sit between the Horseshoe row and Place carriers', function () {
    var w = setup({ none: true });
    var rows = w.st.stepRows();
    var names = rows.map(function (r) { return r.waves ? 'waves' : r.label; });
    var i = names.indexOf('waves');
    assert.ok(i > 0, 'a waves row exists');
    assert.strictEqual(names[i - 1], 'Horseshoe');
    assert.strictEqual(names[i + 1], 'Place carriers');
    var p = w.st.position(w.S.WaveStep.Gate);
    assert.ok(p > rows[i - 1].last && p < rows[i + 1].first, 'position ' + p);
});

// ---- marks and details -----------------------------------------------------------

t.test('marks: Muster', function () {
    var w = setup({ step: 'Muster' });
    var list = flat(w);
    assert.strictEqual(list[0].label, 'Wait between maps');
    assert.strictEqual(list[0].mark, 'now');
    assert.strictEqual(list[1].label, 'Produce items');
    assert.strictEqual(list[2].label, 'Check generals and files');
    // A template run has no items to produce or apply, so those rows are skipped.
    var scenarioRows = ['Produce items', 'Apply items', 'Quests and pick-ups', 'Start buffs'];
    list.slice(1).forEach(function (r) {
        assert.strictEqual(r.mark, scenarioRows.indexOf(r.label) >= 0 ? 'skip' : 'todo', r.label);
    });
});

t.test('marks: wave 3 Attack with 2 of 4 sent', function () {
    var w = setup({ waves: 4, waveIndex: 2, step: 'wave Attack' });
    var r = w.st.run();
    assert.strictEqual(r.step, w.S.WaveStep.Attack);
    var A = w.S.BattleLine.Attack;
    w.st.current().cache = {
        runId: r.id, waveIndex: 2, path: WAVES[2],
        lines: [{ key: 'a', kind: A }, { key: 'b', kind: A }, { key: 'c', kind: A }, { key: 'd', kind: A }]
    };
    r.lines = { a: { sentAt: 5, seen: false }, b: { sentAt: null, seen: true }, c: { sentAt: null, seen: false } };
    assert.strictEqual(row(w, 'Wave 1').mark, 'done');
    assert.strictEqual(row(w, 'Wave 2').mark, 'done');
    assert.strictEqual(row(w, 'Wave 3').mark, 'now');
    assert.strictEqual(row(w, 'Wave 3').detail, 'Attack 2/4');
    assert.strictEqual(row(w, 'Wave 3').file, 'w3.txt');
    assert.strictEqual(row(w, 'Wave 4').mark, 'todo');
    assert.strictEqual(row(w, 'Horseshoe').mark, 'done');
    assert.strictEqual(row(w, 'Place carriers').mark, 'todo');
    var text = allLabels(w).filter(function (l) { return l.indexOf(w.rm.MARK.now + '  Wave 3') === 0; })[0];
    assert.strictEqual(text, w.rm.MARK.now + '  Wave 3  w3.txt   Attack 2/4');
});

t.test('marks: paused at wave 2 Supply', function () {
    var w = setup({ waves: 3, waveIndex: 1, step: 'wave Supply', paused: true });
    assert.strictEqual(row(w, 'Wave 1').mark, 'done');
    assert.strictEqual(row(w, 'Wave 2').mark, 'paused');
    assert.strictEqual(row(w, 'Wave 2').detail, 'Supply');
    assert.strictEqual(row(w, 'Wave 3').mark, 'todo');
    var text = allLabels(w).filter(function (l) { return /^\S+  Wave 2/.test(l); })[0];
    assert.strictEqual(text.indexOf(w.rm.MARK.paused + '  Wave 2'), 0, text);
});

t.test('marks: Pack', function () {
    var w = setup({ step: 'Pack' });
    assert.strictEqual(row(w, 'Place carriers').mark, 'done');
    assert.strictEqual(row(w, 'Pack leftover troops').mark, 'now');
    assert.strictEqual(row(w, 'Wait for last quest').mark, 'todo');
    assert.strictEqual(row(w, 'Wave 2').mark, 'done');
    assert.strictEqual(row(w, 'Return home').mark, 'todo');
});

t.test('marks: Done marks every row done, the not-used ones stay skipped', function () {
    var w = setup({ step: 'Next', run: { retrain: false } });
    w.st.done();
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Done);
    flat(w).forEach(function (r) {
        var skipped = r.label === 'Count lost troops' || r.label === 'Retrain' || r.label === 'Produce items' ||
            r.label === 'Apply items' || r.label === 'Quests and pick-ups' || r.label === 'Start buffs';
        if (skipped) assert.strictEqual(r.mark, 'skip', r.label);
        else assert.strictEqual(r.mark, 'done', r.label);
    });
});

t.test('a stopped run shows Stopped and the rows after its step stay todo', function () {
    var w = setup({ step: 'Pack', finished: 1 });
    w.st.stop('troops short: 5 Rifle');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Done);
    assert.strictEqual(labels(w)[1].indexOf('Stopped:'), 0, 'the status line is the second item');
    assert.strictEqual(w.st.status().indexOf('Stopped:'), 0);
    assert.strictEqual(row(w, 'Place carriers').mark, 'done');
    assert.strictEqual(row(w, 'Pack leftover troops').mark, 'paused');
    assert.strictEqual(row(w, 'Wait for last quest').mark, 'todo');
    assert.strictEqual(row(w, 'Return home').mark, 'todo');
});

t.test('marks: no run gives no rows', function () {
    var w = setup({ none: true });
    assert.strictEqual(w.rm.rows().length, 0);
    assert.strictEqual(flat(w).length, 0);
});

t.test('Verify with an open round shows Load', function () {
    var w = setup({ waveIndex: 0, step: 'wave Verify' });
    var r = w.st.run();
    var round = { runId: r.id, waveIndex: 0, step: w.S.WaveStep.Load, zoneId: 7,
        expected: { a: true, b: true }, results: { a: { status: 'ok' } } };
    w.st.current().round = round;
    assert.strictEqual(row(w, 'Wave 1').detail, 'Load 1/2');
    round.results.b = { status: 'ok' };
    assert.strictEqual(row(w, 'Wave 1').detail, 'Verify 2/2');
});

t.test('backward step Clear to PackStar reopens the row', function () {
    var w = setup({ step: 'Clear' });
    assert.strictEqual(row(w, 'Place carriers').mark, 'done');
    assert.strictEqual(row(w, 'Wait for last quest').mark, 'now');
    w.st.go(w.S.RunStep.PackStar, 'test');
    assert.strictEqual(row(w, 'Place carriers').mark, 'now');
    assert.strictEqual(row(w, 'Pack leftover troops').mark, 'todo');
    assert.strictEqual(row(w, 'Wait for last quest').mark, 'todo');
    assert.strictEqual(row(w, 'Wave 1').mark, 'done');
});

t.test('horseshoe None and retrain off show not used', function () {
    var w = setup({ speedBuff: 'SpeedBuffNone', run: { retrain: false }, step: 'Muster' });
    ['Horseshoe', 'Count lost troops', 'Retrain'].forEach(function (label) {
        assert.strictEqual(row(w, label).mark, 'skip', label);
        assert.strictEqual(row(w, label).detail, 'not used', label);
    });
    var text = allLabels(w).filter(function (l) { return /^\S+  Horseshoe/.test(l); })[0];
    assert.strictEqual(text, w.rm.MARK.skip + '  Horseshoe   not used');
    assert.notStrictEqual(row(w, 'Send generals').mark, 'skip');
    var on = setup({ run: { retrain: true } });
    assert.notStrictEqual(row(on, 'Horseshoe').mark, 'skip');
    assert.notStrictEqual(row(on, 'Retrain').detail, 'not used');
});

t.test('a run started on an open map shows retraining not used', function () {
    var w = setup({ step: 'Validate', run: { snapshot: null } });
    assert.notStrictEqual(row(w, 'Retrain').mark, 'skip', 'still before the snapshot step');
    w.st.go(w.S.RunStep.Jump, 'test');
    assert.strictEqual(row(w, 'Count lost troops').mark, 'skip');
    assert.strictEqual(row(w, 'Retrain').detail, 'not used');
    var snap = setup({ step: 'Jump', run: { snapshot: { Rifle: 5 } } });
    assert.notStrictEqual(row(snap, 'Retrain').mark, 'skip');
});

t.test('rows read no file', function () {
    var w = setup({ waves: 3, waveIndex: 1, step: 'wave Attack' });
    var reads = 0;
    var files = w.S.kernel.files;
    var readText = files.readText;
    files.readText = function () { reads++; return readText.apply(this, arguments); };
    var load = w.S.core.battles.load;
    w.S.core.battles.load = function () { reads++; return load.apply(this, arguments); };
    w.rm.rows();
    allLabels(w);
    enabledFlags(w);
    assert.strictEqual(reads, 0);
    assert.ok(Object.keys(w.fs.disk).length > 0);
});

// ---- busy wait -------------------------------------------------------------------

// A memory-only busy record for the run's current step, started `ago` ms back.
function setBusy(w, ago, step) {
    var r = w.st.run();
    w.st.current().busy = { runId: r.id, step: step === undefined ? r.step : step, key: 'g1',
        text: 'The Smuggler (325505.0) busy', since: w.t - ago, noted: null };
}

t.test('busy: the stage row shows who and how long, ahead of the round count', function () {
    var w = setup({ step: 'Arrive' });
    var r = w.st.run();
    w.st.current().round = { runId: r.id, waveIndex: 0, step: r.step, zoneId: 7,
        expected: { a: true, b: true }, results: { a: { status: 'ok' } } };
    setBusy(w, 1000);
    assert.strictEqual(row(w, 'Wait for all generals').detail, 'The Smuggler (325505.0) busy');
    setBusy(w, 150000);
    assert.strictEqual(row(w, 'Wait for all generals').detail, 'The Smuggler (325505.0) busy, 2 min');
    w.st.current().busy = null;
    assert.notStrictEqual(row(w, 'Wait for all generals').detail.indexOf('busy'), 0);
});

t.test('busy: the wave row shows it after the step name', function () {
    var w = setup({ waves: 2, waveIndex: 0, step: 'wave Gate' });
    setBusy(w, 61000);
    assert.strictEqual(row(w, 'Wave 1').detail, 'Gate, The Smuggler (325505.0) busy, 1 min');
    assert.strictEqual(row(w, 'Wave 2').detail, '');
});

t.test('busy: the status line picks it up', function () {
    var w = setup({ step: 'Arrive' });
    onIsland(w);
    setBusy(w, 120000);
    assert.strictEqual(labels(w)[1], 'Now: Wait for all generals, The Smuggler (325505.0) busy, 2 min');
});

t.test('busy: a record of another step shows nothing', function () {
    var w = setup({ step: 'Arrive' });
    setBusy(w, 120000, w.S.RunStep.Muster);
    assert.ok(row(w, 'Wait for all generals').detail.indexOf('busy') < 0);
    var r = w.st.run();
    w.st.current().busy = { runId: r.id + 1, step: r.step, key: 'g1', text: 'x busy', since: w.t, noted: null };
    assert.ok(row(w, 'Wait for all generals').detail.indexOf('busy') < 0);
    delete w.st.current().busy;
    assert.doesNotThrow(function () { labels(w); });
});

// ---- view hint ------------------------------------------------------------------

t.test('hint: a step that runs on the island names it when home is viewed', function () {
    var w = setup({ step: 'Arrive' });
    assert.strictEqual(labels(w)[1], 'Now: Wait for all generals, view the island');
    w = setup({ waves: 2, waveIndex: 1, step: 'wave Attack' });
    assert.strictEqual(labels(w)[1], 'Now: Wave 2, Attack, view the island');
});

t.test('hint: the hint follows the busy text', function () {
    var w = setup({ step: 'Arrive' });
    setBusy(w, 120000);
    assert.strictEqual(labels(w)[1], 'Now: Wait for all generals, The Smuggler (325505.0) busy, 2 min, view the island');
});

t.test('hint: a home step viewed on the island says go home', function () {
    var w = setup({ step: 'Muster' });
    onIsland(w);
    assert.ok(/, go home$/.test(labels(w)[1]), labels(w)[1]);
});

t.test('hint: no hint on the right zone, on an any-zone step, paused or done', function () {
    var w = setup({ step: 'Arrive' });
    onIsland(w);
    assert.ok(!/view the island|go home/.test(labels(w)[1]), labels(w)[1]);
    w = setup({ step: 'Muster' });
    assert.ok(!/view the island|go home/.test(labels(w)[1]), labels(w)[1]);
    w = setup({ step: 'Arrive', paused: true });
    assert.strictEqual(labels(w)[1], 'paused by you');
    w.st.resume();
    w.st.done();
    assert.strictEqual(labels(w)[1], 'Series done; use Stop run to clear');
});

// ---- controls --------------------------------------------------------------------

// The states of the investigation's table: [name, setup options, mutate, can()].
var STATES = [
    ['no request', { none: true }, null, [false, false, false, false, false]],
    ['request without a run', { count: 3 }, function (w) { w.st.current().run = null; }, [false, false, false, false, true]],
    ['running, one run', { count: 1 }, null, [true, false, false, false, true]],
    ['running, run 1 of 3', { count: 3 }, null, [true, false, true, false, true]],
    ['running, last of 3', { count: 3, finished: 2 }, null, [true, false, false, false, true]],
    ['paused, run 1 of 3', { count: 3, paused: true }, null, [false, true, true, false, true]],
    ['paused, one run', { count: 1, paused: true }, null, [false, true, false, false, true]],
    ['done', { count: 1 }, function (w) { w.st.done(); }, [false, false, false, false, true]]
];

function fresh(state) {
    var w = setup(state[1]);
    if (state[2]) state[2](w);
    return w;
}

t.test('can table', function () {
    STATES.forEach(function (state) {
        var w = fresh(state);
        var can = w.run.can();
        assert.deepStrictEqual(Object.keys(can).sort(), ['endRepetition', 'pause', 'resume', 'skipEntry', 'stop'], state[0]);
        var got = CONTROLS.map(function (c) { return can[c[1]]; });
        assert.deepStrictEqual(got, state[3], state[0]);
        got.forEach(function (v) { assert.strictEqual(typeof v, 'boolean', state[0]); });
        assert.deepStrictEqual(enabledFlags(w), state[3], state[0] + ' menu flags');
    });
});

t.test('a control enabled by can() runs its command', function () {
    STATES.forEach(function (state) {
        CONTROLS.forEach(function (c) {
            var name = c[1];
            var w = fresh(state);
            var rs = w.st.current();
            // A request without a run can still be ended, the one place the
            // table is stricter than the command: the control stays grey.
            if (name === 'endRepetition' && rs.request && !rs.run) return;
            var enabled = w.run.can()[name];
            var result = w.run[name]();
            assert.strictEqual(result, enabled, state[0] + ': ' + name);
        });
    });
    var w = fresh(STATES[1]);
    assert.strictEqual(w.run.can().endRepetition, false);
    assert.strictEqual(w.run.endRepetition(), true);
});

t.test('controls exist once', function () {
    var w = setup({ count: 3 });
    var calls = [];
    CONTROLS.forEach(function (c) {
        w.run[c[1]] = function () { calls.push(c[1]); return true; };
    });
    var items = w.rm.items();
    CONTROLS.forEach(function (c) {
        var found = items.filter(function (it) { return it.label === c[0]; });
        assert.strictEqual(found.length, 1, c[0]);
        assert.strictEqual(typeof found[0].onSelect, 'function', c[0]);
        found[0].onSelect();
    });
    assert.deepStrictEqual(calls, ['pause', 'resume', 'endRepetition', 'skipEntry', 'stop']);
    assert.strictEqual(items.filter(function (it) { return typeof it.onSelect === 'function'; }).length, 5);
});

// ---- title and status line ------------------------------------------------------------

t.test('title per status', function () {
    var w = setup({ none: true });
    assert.strictEqual(labels(w)[0], 'No run');
    w = setup({ count: 3, finished: 1 });
    assert.strictEqual(labels(w)[0], 'Running: Black Knights, run 2/3');
    w.st.pause(w.S.RunPause.User, 'paused by you');
    assert.strictEqual(labels(w)[0], 'Paused: Black Knights, run 2/3');
    w.st.resume();
    w.st.done();
    assert.strictEqual(labels(w)[0], w.st.status());
    assert.ok(/^Done: /.test(labels(w)[0]), labels(w)[0]);
});

t.test('status line paused, running and done', function () {
    var w = setup({ waves: 2, waveIndex: 1, step: 'wave Attack' });
    onIsland(w);
    assert.strictEqual(labels(w)[1], 'Now: Wave 2, Attack');
    w.st.pause(w.S.RunPause.User, 'paused by you');
    assert.strictEqual(labels(w)[1], 'paused by you');
    w.st.resume();
    w.st.done();
    assert.strictEqual(labels(w)[1], 'Series done; use Stop run to clear');
});

// ---- item set ------------------------------------------------------------------------

t.test('idle items are title and controls only', function () {
    var w = setup({ none: true });
    assert.deepStrictEqual(plain(labels(w)), ['No run', '---', 'Pause run', 'Resume run', 'End repetition', 'Skip entry', 'Stop run']);
    assert.strictEqual(w.rm.signature(), 'idle');
});

t.test('the top level is fixed whatever the wave count', function () {
    var two = setup({ waves: 2 });
    var four = setup({ waves: 4 });
    assert.strictEqual(two.rm.signature(), 'waves:2');
    assert.strictEqual(four.rm.signature(), 'waves:4');
    [two, four].forEach(function (w) {
        var items = w.rm.items();
        var groups = w.rm.rows();
        assert.strictEqual(items.length, 14);
        assert.strictEqual(items[8].separator, true);
        assert.strictEqual(groups.length, 5);
        for (var g = 0; g < groups.length; g++) {
            assert.ok(Array.isArray(items[9 + g].items), 'entry ' + g);
            assert.ok(items[9 + g].label({}).indexOf(groups[g].label) > 0, 'entry text ' + g);
        }
        assert.strictEqual(groupItems(w).length, groups.length);
    });
});

t.test('the Waves submenu has one row per wave', function () {
    function wavesGroup(w) {
        var groups = w.rm.rows();
        for (var g = 0; g < groups.length; g++) {
            if (groups[g].rows.some(function (r) { return /^Wave \d+$/.test(r.label); })) return groupItems(w)[g];
        }
        throw new Error('no waves group');
    }
    var two = wavesGroup(setup({ waves: 2 }));
    var four = wavesGroup(setup({ waves: 4 }));
    assert.strictEqual(four.items.length - two.items.length, 2);
});

t.test('every row is in its group submenu in order', function () {
    var w = setup({ waves: 3, waveIndex: 1, step: 'wave Attack' });
    var groups = w.rm.rows();
    var entries = groupItems(w);
    var pass = {};
    assert.strictEqual(entries.length, groups.length);
    entries.forEach(function (entry, g) {
        assert.strictEqual(entry.onSelect, undefined, 'entry ' + g);
        assert.strictEqual(entry.items.length, groups[g].rows.length, groups[g].label);
        entry.items.forEach(function (child, n) {
            var row = groups[g].rows[n];
            assert.ok(labelOf(child, pass).indexOf(w.rm.MARK[row.mark] + '  ' + row.label) === 0, row.label);
            assert.strictEqual(child.enabled, false, row.label);
            assert.strictEqual(child.onSelect, undefined, row.label);
        });
    });
});

t.test('group marks follow the rows', function () {
    function entryTexts(w) {
        var pass = {};
        return groupItems(w).map(function (it) { return labelOf(it, pass); });
    }
    function expected(w, marks) {
        var M = w.rm.MARK;
        return w.rm.rows().map(function (g, i) { return M[marks[i]] + '  ' + g.label; });
    }
    var w = setup({ waves: 4, waveIndex: 2, step: 'wave Attack' });
    var at = w.rm.rows().map(function (g) {
        return g.rows.some(function (r) { return /^Wave \d+$/.test(r.label); });
    }).indexOf(true);
    var marks = w.rm.rows().map(function (g, i) { return i < at ? 'done' : (i === at ? 'now' : 'todo'); });
    assert.deepStrictEqual(entryTexts(w), expected(w, marks));

    w = setup({ waves: 3, waveIndex: 1, step: 'wave Supply', paused: true });
    marks = w.rm.rows().map(function (g, i) { return i < at ? 'done' : (i === at ? 'paused' : 'todo'); });
    assert.deepStrictEqual(entryTexts(w), expected(w, marks));

    w = setup({ step: 'Next', run: { retrain: false } });
    w.st.done();
    marks = w.rm.rows().map(function () { return 'done'; });
    assert.deepStrictEqual(entryTexts(w), expected(w, marks));
});

t.test('sync does not rebuild across a series, rebuilds on start and only hides on stop', function () {
    var w = setup({ none: true });
    var calls = [];
    w.S.kernel.ui = w.S.kernel.ui || {};
    w.S.kernel.ui.refreshBarMenu = function (id) { calls.push(id); return true; };
    var shown = [];
    w.S.kernel.ui.showBarMenu = function (id, show) { shown.push([id, show]); return true; };
    w.rm.items();
    assert.strictEqual(w.rm.sync(), false);
    assert.strictEqual(calls.length, 0, 'no run builds nothing');
    assert.deepStrictEqual(shown, [['adventures', false]]);

    var r = w.st.newRun({
        id: 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', zoneId: null,
        paths: WAVES.slice(0, 2), loadoutPath: W.LOADOUT, loadoutKeys: {}, step: w.S.RunStep.Muster
    });
    var req = { templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: 2, ended: false,
        requested: w.t, finished: 0, closedAt: null };
    w.st.begin(req, r);
    assert.deepStrictEqual(calls, ['adventures'], 'start rebuilds');
    assert.deepStrictEqual(shown[shown.length - 1], ['adventures', true], 'and shows');
    w.rm.items();
    shown.length = 0;

    // The next run of the series has the same wave count.
    req.finished = 1;
    w.st.begin(req, w.st.newRun({
        id: 43, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', zoneId: null,
        paths: WAVES.slice(0, 2), loadoutPath: W.LOADOUT, loadoutKeys: {}, step: w.S.RunStep.Muster
    }));
    assert.strictEqual(calls.length, 1, 'a series rebuilds nothing');
    assert.ok(shown.every(function (s) { return s[1] === true; }), 'and never hides');

    shown.length = 0;
    w.st.clear();
    assert.strictEqual(calls.length, 1, 'stop rebuilds nothing');
    assert.deepStrictEqual(shown[shown.length - 1], ['adventures', false], 'it hides the entry');
});

t.test('no label throws with the core buffs throwing', function () {
    var w = setup({ waves: 2, waveIndex: 1, step: 'wave Attack' });
    w.S.core.buffs.speedBuffs = function () { throw new Error('game not loaded'); };
    var list;
    assert.doesNotThrow(function () { list = allLabels(w); });
    assert.ok(list.length > 6);
    assert.doesNotThrow(function () { enabledFlags(w); });
    assert.strictEqual(row(w, 'Horseshoe').detail, '');
    assert.deepStrictEqual(plain(marks(w)).length, flat(w).length);
});

t.test('the todo mark is two no-break spaces', function () {
    var w = setup({ waves: 2 });
    assert.strictEqual(w.rm.MARK.todo, '  ');
    assert.strictEqual(w.rm.MARK.todo.length, 2);
});

t.test('both menus take the five run commands from one table', function () {
    var w = setup({ waves: 2 });
    var table = w.S.modules.adventures.menu.COMMANDS;
    assert.deepStrictEqual(plain(table.map(function (c) { return c.name; })),
        ['pause', 'resume', 'endRepetition', 'skipEntry', 'stop']);
    table.forEach(function (c) {
        assert.ok(itemByLabel(w, c.label), c.label);
    });
});

// ---- Template steps and the StarAll row ------------------------------------

var STEP_PATHS = [WAVES[0], { step: 'home', generals: ['g1'] }, { step: 'pause', message: 'Heal up' }, WAVES[1]];

t.test('step rows sit between the waves and only files take a Wave number', function () {
    var w = setup({ waves: 2, step: 'wave Attack', run: { paths: STEP_PATHS, loadoutNames: { g1: 'Alpha' } } });
    var labels = flat(w).map(function (r) { return r.label; });
    var first = labels.indexOf('Wave 1');
    assert.ok(first > -1);
    assert.strictEqual(labels[first + 1].indexOf('Wave'), -1, 'the step row is not a wave');
    assert.strictEqual(labels.indexOf('Wave 2') - first, 3, 'two step rows between the files');
    assert.strictEqual(labels.indexOf('Wave 3'), -1, 'steps are not numbered');
    var home = flat(w)[first + 1];
    assert.strictEqual(home.file, 'Alpha', 'the file part names the general');
    assert.strictEqual(flat(w)[first + 2].file, 'Heal up', 'a pause shows its message');
});

t.test('a planned pause row says its sound played', function () {
    var w = setup({ waves: 2, step: 'wave Attack', waveIndex: 2, run: { paths: STEP_PATHS } });
    w.st.pause(w.S.RunPause.Planned, 'Heal up');
    var labels = flat(w).map(function (r) { return r.label; });
    var pause = flat(w)[labels.indexOf('Wave 1') + 2];
    assert.strictEqual(pause.detail, 'sound played');
    assert.strictEqual(pause.mark, 'paused');
});

t.test('the StarAll row reads not used when the template switch is off, and is a plain row when on', function () {
    var w = setup({ waves: 2 });
    var on = row(w, 'Send all to the star');
    assert.notStrictEqual(on.detail, 'not used');
    w = setup({ waves: 2, run: { starAll: false } });
    var off = row(w, 'Send all to the star');
    assert.strictEqual(off.mark, 'skip');
    assert.strictEqual(off.detail, 'not used');
});

t.test('a Pause x min row counts its minutes from the state clock and names no file', function () {
    var w = setup({ waves: 2, step: 'wave Attack', waveIndex: 1,
        run: { paths: [WAVES[0], { step: 'wait', minutes: 5 }, WAVES[1]] } });
    w.st.run().marks = { 'wait:1': { sentAt: w.st.now() - 120000 } };
    var list = flat(w);
    var at = -1;
    list.forEach(function (r, i) { if (r.label === 'Wave 1') at = i; });
    var wait = list[at + 1];
    assert.strictEqual(wait.detail, '3 min left');
    assert.strictEqual(wait.file, '');
});

// ---- queue runs ----------------------------------------------------------------------

// A queue run of o.waves waves, in a queue whose widest template entry has `width` waves.
function queueWorld(o) {
    var w = setup(o);
    w.st.current().request.queue = {
        id: 'q1', label: 'Long and short', index: 0, pass: 0, loop: false, passes: 0, early: false,
        retrain: 'settings', noMap: 'pause', width: o.width, skip: 0,
        entries: [{ kind: 'template', id: 't1', templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: 1 }]
    };
    return w;
}

function counts(w) {
    return w.rm.rows().map(function (g) { return g.rows.length; });
}

t.test('a queue run has one signature for the whole queue', function () {
    var w = queueWorld({ waves: 2, width: 3 });
    assert.strictEqual(w.rm.signature(), 'queue:3');
    assert.strictEqual(setup({ waves: 2 }).rm.signature(), 'waves:2');
});

t.test('the waves group pads to the queue width with skip rows', function () {
    var w = queueWorld({ waves: 2, width: 4 });
    var group = w.rm.rows().filter(function (g) { return g.rows.some(function (r) { return /^Wave \d/.test(r.label); }); })[0];
    assert.strictEqual(group.rows.length, 4);
    assert.deepStrictEqual(plain(group.rows.map(function (r) { return r.mark; })).slice(2), ['skip', 'skip']);
    assert.strictEqual(group.rows[3].detail, 'not used');
});

t.test('a queue run drops wave rows past its width', function () {
    var w = queueWorld({ waves: 4, width: 2 });
    var group = w.rm.rows().filter(function (g) { return g.rows.some(function (r) { return /^Wave \d/.test(r.label); }); })[0];
    assert.strictEqual(group.rows.length, 2);
});

t.test('a hand-over from a 3-wave template to a scenario and a 1-wave template keeps the row set', function () {
    var w = queueWorld({ waves: 3, width: 3 });
    var calls = [];
    w.S.kernel.ui = w.S.kernel.ui || {};
    w.S.kernel.ui.refreshBarMenu = function (id) { calls.push(id); return true; };
    w.S.kernel.ui.showBarMenu = function () { return true; };
    var items = w.rm.items();
    var before = counts(w);
    var childCounts = function (list) { return list.filter(function (it) { return it.items; }).map(function (it) { return it.items.length; }); };
    var itemChildren = childCounts(items);

    var r = w.st.run();
    r.scenarioId = 'twins';
    r.paths = [];
    assert.strictEqual(w.rm.signature(), 'queue:3');
    assert.deepStrictEqual(counts(w), before);
    assert.strictEqual(w.rm.sync(), false);

    r.scenarioId = '';
    r.paths = WAVES.slice(0, 1);
    assert.strictEqual(w.rm.signature(), 'queue:3');
    assert.deepStrictEqual(counts(w), before);
    assert.strictEqual(w.rm.sync(), false);
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(childCounts(w.rm.items()), itemChildren);
    var padded = w.rm.rows().filter(function (g) { return g.rows.length === 3; })[0].rows;
    assert.strictEqual(padded[1].mark, 'skip');
    assert.strictEqual(padded[2].mark, 'skip');
});
