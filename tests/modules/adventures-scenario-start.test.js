'use strict';

// Starting a scenario run from the ~Steward~ > Adventures menu, and how the
// native menu and the ~Adventures~ bar menu show scenarios. The host fakes
// are local: production.isProduceable, zone.isHome and adventures.zoneIdOf
// are replaced per test, and prompt/confirm are host globals the harness does
// not provide. Nothing ticks the run past Muster.

var fsys = require('fs');
var path = require('path');
var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var A = require('../stubs/army');

var assert = t.assert;

var DIR = 'C:/client/steward/adventures/scenarios';
var ROOT = path.join(__dirname, '..', '..');

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function builtinText(id) {
    return fsys.readFileSync(path.join(ROOT, 'scenarios', id + '.json'), 'utf8');
}

// A booted setup with the checked-in twins scenario as the one built-in
// and `maps` twins maps in the star menu. o.home (default true), o.zoneId
// (open map's zone, default none), o.known (isProduceable answer: true, false,
// null, or a function of the name).
function setup(maps, o) {
    o = o || {};
    var fs = airfs.make();
    var alerts = [];
    var H = harness.boot({ host: { air: fs.air, showGameAlert: function (m) { alerts.push(m); } } });
    var S = H.Steward;
    S.modules.adventures.builtinScenarios = { twins: builtinText('twins') };
    var rec = S.modules.adventures.scenarios.get('twins');
    var buffs = maps > 0 ? [{ type: 'Adventure', resource: rec.adventure, amount: maps }] : [];
    A.install(H, { buffs: buffs });
    var s = {
        fs: fs, H: H, S: S, rec: rec, alerts: alerts, prompts: [], confirms: [],
        run: S.modules.adventures.run, st: S.modules.adventures.state,
        home: o.home !== false, zoneId: o.zoneId === undefined ? null : o.zoneId,
        known: o.known === undefined ? true : o.known, asked: []
    };
    H.ctx.prompt = function (text, def) {
        s.prompts.push({ text: text, def: def });
        if (s.answers && s.answers.length) return s.answers.shift();
        return s.answer === undefined ? def : s.answer;
    };
    H.ctx.confirm = function (text) { s.confirms.push(text); return s.agree === true; };
    S.core.zone.isHome = function () { return s.home; };
    S.core.adventures.zoneIdOf = function () { return s.zoneId; };
    S.core.production.isProduceable = function (name) {
        s.asked.push(name);
        return typeof s.known === 'function' ? s.known(name) : s.known;
    };
    H.clearQueued();
    return s;
}

function labelOf(item, pass) {
    if (item.separator) return '---';
    return typeof item.label === 'function' ? item.label(pass || {}) : item.label;
}

function menuLabels(s) {
    var pass = {};
    return plain(s.S.modules.adventures.menu.items().map(function (it) { return labelOf(it, pass); }));
}

function lastAlert(s) {
    return s.alerts.length ? String(s.alerts[s.alerts.length - 1]).replace(/^Steward: /, '') : '';
}

// ---- native menu --------------------------------------------------------------

t.test('menu lists a built-in scenario after the templates with its map count', function () {
    var s = setup(3);
    var labels = menuLabels(s);
    assert.deepStrictEqual(labels.slice(8), ['No templates yet', '---', 'Twins ×3']);
    var items = s.S.modules.adventures.menu.items();
    var called = [];
    s.run.startScenario = function (id) { called.push(id); };
    items[10].onSelect();
    assert.deepStrictEqual(called, ['twins']);
});

t.test('menu without scenarios is the template list alone', function () {
    var s = setup(3);
    s.S.modules.adventures.builtinScenarios = {};
    assert.deepStrictEqual(menuLabels(s), ['Run templates…', '---', 'No run requested', 'Pause run',
        'Resume run', 'End repetition', 'Stop run', '---', 'No templates yet']);
});

t.test('a broken scenario file is a disabled row', function () {
    var s = setup(1);
    s.fs.disk[DIR + '/zz_bad.json'] = '{ not json';
    var items = s.S.modules.adventures.menu.items();
    var last = items[items.length - 1];
    assert.strictEqual(labelOf(last), 'zz_bad: broken scenario file');
    assert.strictEqual(last.enabled, false);
    assert.strictEqual(labelOf(items[items.length - 2]), 'Twins ×1');
});

t.test('sync rebuilds when the scenario set changes', function () {
    var s = setup(1);
    var rebuilds = 0;
    s.S.kernel.ui = s.S.kernel.ui || {};
    s.S.kernel.ui.refreshModuleMenu = function () { rebuilds++; return true; };
    var menu = s.S.modules.adventures.menu;
    menu.items();
    assert.strictEqual(menu.sync(), false);
    s.fs.disk[DIR + '/zz_bad.json'] = '{ not json';
    assert.strictEqual(menu.sync(), true);
    assert.strictEqual(rebuilds, 1);
});

// ---- startScenario: refusals ------------------------------------------------------

t.test('startScenario refuses an unknown id and a missing map', function () {
    var s = setup(1);
    assert.strictEqual(s.run.startScenario('nope'), false);
    assert.ok(/cannot be read/.test(lastAlert(s)), lastAlert(s));
    var none = setup(0);
    assert.strictEqual(none.run.startScenario('twins'), false);
    assert.ok(/map in the star menu/.test(lastAlert(none)), lastAlert(none));
    assert.strictEqual(none.prompts.length, 0);
    assert.strictEqual(none.st.run(), null);
});

t.test('startScenario refuses away from home and stores nothing', function () {
    var s = setup(2, { home: false });
    assert.strictEqual(s.run.startScenario('twins'), false);
    assert.strictEqual(lastAlert(s), 'Go home, then choose the scenario again.');
    assert.strictEqual(s.st.run(), null);
    assert.strictEqual(s.st.current().request, null);
});

t.test('startScenario refuses an item the game does not produce', function () {
    var s = setup(2, { known: function (n) { return n !== 'ChangeSkin_BuffAd_Bridge'; } });
    assert.strictEqual(s.run.startScenario('twins'), false);
    assert.ok(/1 problem\(s\)\. unknown item ChangeSkin_BuffAd_Bridge/.test(lastAlert(s)), lastAlert(s));
    assert.strictEqual(s.st.run(), null);
});

t.test('startScenario asks to retry while item definitions are unreadable', function () {
    var s = setup(2, { known: null });
    assert.strictEqual(s.run.startScenario('twins'), false);
    assert.strictEqual(lastAlert(s), 'Item definitions cannot be read right now; try again in a moment.');
    assert.strictEqual(s.st.run(), null);
});

t.test('startScenario stores nothing on a cancelled or invalid prompt', function () {
    var s = setup(2);
    s.answer = null;
    assert.strictEqual(s.run.startScenario('twins'), false);
    s.answer = 'x';
    assert.strictEqual(s.run.startScenario('twins'), false);
    assert.ok(/Not a run count/.test(lastAlert(s)), lastAlert(s));
    assert.strictEqual(s.st.run(), null);

    var open = setup(2, { zoneId: 77 });
    open.answers = ['1', null];
    assert.strictEqual(open.run.startScenario('twins'), false);
    open.answers = ['1', '9'];
    assert.strictEqual(open.run.startScenario('twins'), false);
    assert.ok(/Not a trip number: 9/.test(lastAlert(open)), lastAlert(open));
    assert.strictEqual(open.st.run(), null);
});

t.test('replacing a request needs confirm; declined keeps the old one', function () {
    var s = setup(2);
    assert.strictEqual(s.run.startScenario('twins'), true);
    var first = s.st.run().id;
    s.agree = false;
    assert.strictEqual(s.run.startScenario('twins'), false);
    assert.strictEqual(s.confirms.length, 1);
    assert.strictEqual(s.st.run().id, first);
});

// ---- startScenario: the stored run ------------------------------------------------

t.test('startScenario at home stores a scenario run at Muster, trip 0', function () {
    var s = setup(3);
    s.answer = '2';
    assert.strictEqual(s.run.startScenario('twins'), true);
    var S = s.S;
    var r = s.st.run();
    var q = s.st.current().request;
    assert.strictEqual(r.step, S.RunStep.Muster);
    assert.strictEqual(r.status, S.RunStatus.Running);
    assert.strictEqual(r.scenarioId, 'twins');
    assert.strictEqual(r.templateId, '');
    assert.strictEqual(r.label, 'Twins');
    assert.strictEqual(r.adventure, s.rec.adventure);
    assert.strictEqual(r.zoneId, null);
    assert.strictEqual(r.trip, 0);
    assert.deepStrictEqual(plain(r.trips), plain(s.rec.trips));
    assert.deepStrictEqual(plain(r.paths), []);
    assert.strictEqual(r.speedBuff, S.SpeedBuffChoice.None);
    assert.strictEqual(s.st.isScenario(r), true);
    assert.strictEqual(q.count, 2);
    assert.strictEqual(q.templateId, '');
    assert.strictEqual(q.label, 'Twins');
    assert.strictEqual(s.prompts.length, 1);
    assert.strictEqual(s.prompts[0].def, '3');
    assert.deepStrictEqual(plain(s.asked), plain(S.modules.adventures.scenarios.buffsOf(s.rec)));
    // Collect is not set up, so the start warns and still starts.
    assert.ok(/Warning: collect does not pick up on adventures/.test(lastAlert(s)), lastAlert(s));
    // The run state is written to its file.
    var saved = Object.keys(s.fs.disk).filter(function (k) { return /run\.json$/.test(k); });
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(JSON.parse(s.fs.disk[saved[0]]).run.scenarioId, 'twins');
});

t.test('startScenario on an open map asks the start trip', function () {
    var s = setup(1, { zoneId: 77 });
    s.answers = ['1', '2'];
    assert.strictEqual(s.run.startScenario('twins'), true);
    var r = s.st.run();
    assert.strictEqual(r.trip, 1);
    assert.strictEqual(r.zoneId, 77);
    assert.strictEqual(r.step, s.S.RunStep.Muster);
    assert.strictEqual(s.prompts.length, 2);
    assert.strictEqual(s.prompts[1].text, 'Start at which trip of "Twins"? 1..' + s.rec.trips.length);
    assert.strictEqual(s.prompts[1].def, '1');
});

// ---- bar menu -----------------------------------------------------------------

t.test('run menu of a scenario run: scenario rows, skipped general rows, one Waves row', function () {
    var s = setup(1);
    assert.strictEqual(s.run.startScenario('twins'), true);
    var rm = s.S.modules.adventures.runmenu;
    var st = s.st;
    var groups = rm.rows();
    var byLabel = {};
    var all = [];
    groups.forEach(function (g) {
        g.rows.forEach(function (row) { byLabel[row.label] = row.mark; all.push(row); });
    });
    assert.strictEqual(byLabel['Wait between maps'], 'now');
    ['Produce items', 'Apply items', 'Quests and pick-ups', 'Start map', 'Jump to the map'].forEach(function (l) {
        assert.strictEqual(byLabel[l], 'todo', l);
    });
    ['Check generals and files', 'Load generals', 'Send generals', 'Wait for all generals', 'Pick up items',
        'Send all to the star', 'Horseshoe'].forEach(function (l) {
        assert.strictEqual(byLabel[l], 'skip', l);
    });
    // The waves row: one skipped row named after its group, no Wave n rows.
    var wavesRow = st.stepRows().filter(function (row) { return row.waves; })[0];
    var skipped = all.filter(function (row) { return row.label === wavesRow.group; });
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0].mark, 'skip');
    assert.strictEqual(skipped[0].detail, 'not used');
    assert.strictEqual(all.filter(function (row) { return /^Wave \d/.test(row.label); }).length, 0);
    assert.strictEqual(rm.signature(), 'scenario');
});
