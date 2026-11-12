'use strict';

// The queue hand-over at Next: an entry that has run its count hands over to
// the next entry, the queue's No map left and Retrain options, the early
// hand-over at ArriveHome and the pause of an entry that cannot begin.
//
// The setup boots the bundle with two templates (Long on BlackKnights, Short
// on Bandits) and the checked-in twins scenario, and drives home.plan() by
// hand: the run is put at the step under test and one pass is made. The
// troop read, the production queues and the star menu are plain values on
// the setup, so each test sets what the step reads.

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var A = require('../stubs/army');
var FS = require('fs');
var PATH = require('path');

var assert = t.assert;

var LOADOUT = 'C:/b/loadout.txt';
var TWINS_ADV = 'BuffAdventures_twins_easy';
var LONG_MS = 3600000;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup(o) {
    o = o || {};
    var fs = airfs.make();
    var alerts = [];
    var H = harness.boot({ host: { air: fs.air, showGameAlert: function (m) { alerts.push(m); } } });
    var S = H.Steward;
    S.modules.adventures.builtinScenarios = {
        twins: FS.readFileSync(PATH.join(__dirname, '..', '..', 'scenarios', 'twins.json'), 'utf8')
    };
    S.kernel.settings.write('adventures', { retrain: o.retrain === true });
    A.install(H, { buffs: [], adventureDefs: [A.adventureDef({ name: TWINS_ADV, type: 'Mission' })] });
    var q = {
        fs: fs, H: H, S: S, alerts: alerts,
        run: S.modules.adventures.run, st: S.modules.adventures.state, qs: S.modules.adventures.queues,
        home: S.modules.adventures.home,
        maps: { BlackKnights: 3, Bandits: 2 },
        known: true, listOk: true,
        inv: { ok: true, listOk: true, listRead: true, total: { Rifle: 5 }, generals: [] }
    };
    q.maps[TWINS_ADV] = 1;
    H.ctx.prompt = function (text, def) { return def; };
    H.ctx.confirm = function () { return true; };
    S.core.zone.isHome = function () { return true; };
    S.core.zone.id = function () { return null; };
    S.core.adventures.zoneIdOf = function () { return null; };
    S.core.adventures.ownOpen = function () { return []; };
    S.core.buffs.mapCounts = function () { return q.maps; };
    S.core.army.inventory = function () { return q.inv; };
    S.core.production.queued = function () { return 0; };
    S.core.production.isProduceable = function () { return q.known; };
    S.modules.adventures.executor.check = function () {
        if (!q.listOk) return { listOk: false };
        return { ok: true, problems: [], warnings: [], loadoutKeys: { '1.1': true } };
    };
    var tpl = S.modules.adventures.templates;
    q.long = tpl.save({ label: 'Long', adventure: 'BlackKnights', loadout: LOADOUT,
        waves: ['C:/b/w1.json', 'C:/b/w2.json'], speedBuff: 'SpeedBuffDefault' }, 1001).id;
    q.short = tpl.save({ label: 'Short', adventure: 'Bandits', loadout: LOADOUT,
        waves: ['C:/b/s1.json'], speedBuff: 'SpeedBuffDefault' }, 1002).id;
    H.clearQueued();
    return q;
}

// Saves and starts a queue of entries ([kind, id, count]).
function startQueue(q, entries, opts) {
    opts = opts || {};
    var rec = { label: opts.label || 'Mix', loop: opts.loop === true, passes: opts.passes || 0,
        noMap: opts.noMap || 'pause', retrain: opts.retrain || 'settings', early: opts.early === true,
        entries: entries.map(function (e) { return { kind: e[0], id: e[1], count: e[2] }; }) };
    var r = q.qs.save(rec, 5000);
    assert.ok(r.ok, JSON.stringify(r.problems));
    assert.strictEqual(q.run.startQueue(r.id), true, lastNotice(q));
    return r.id;
}

function lastNotice(q) {
    return q.alerts.length ? String(q.alerts[q.alerts.length - 1]).replace(/^Steward: /, '') : '';
}

function logText(q) {
    return q.H.logs().map(function (l) { return l.args.join(' '); }).join('\n');
}

function countOf(text, re) {
    var m = text.match(new RegExp(re.source, 'g'));
    return m ? m.length : 0;
}

// One home pass of the run at step.
function pass(q, step) {
    var r = q.st.run();
    if (step) r.step = step;
    q.home.plan();
    return q.st.run();
}

// One pass at Next: the run just came home from its map.
function next(q) {
    return pass(q, q.S.RunStep.Next);
}

function req(q) {
    return q.st.current().request;
}

function busyText(q) {
    var b = q.st.busyOf(q.st.run());
    return b ? b.text : '';
}

t.test('A x2, S x1, A x1 run in order through Next', function () {
    var q = setup();
    var S = q.S;
    startQueue(q, [['template', q.long, 2], ['scenario', 'twins', 1], ['template', q.short, 1]]);
    var first = q.st.run().id;

    var r = next(q);
    assert.strictEqual(req(q).queue.index, 0);
    assert.strictEqual(req(q).finished, 1);
    assert.strictEqual(req(q).count, 2);
    assert.strictEqual(r.templateId, q.long);
    assert.strictEqual(r.step, S.RunStep.Muster);
    assert.ok(r.id > first);

    r = next(q);
    assert.strictEqual(req(q).queue.index, 1);
    assert.strictEqual(req(q).finished, 0);
    assert.strictEqual(req(q).count, 1);
    assert.strictEqual(req(q).templateId, '');
    assert.strictEqual(r.scenarioId, 'twins');
    assert.strictEqual(r.templateId, '');
    assert.strictEqual(r.step, S.RunStep.Muster);
    assert.ok(/queue Mix: entry 2\/3 begins: Twins/.test(logText(q)), logText(q));

    r = next(q);
    assert.strictEqual(req(q).queue.index, 2);
    assert.strictEqual(req(q).templateId, q.short);
    assert.strictEqual(r.templateId, q.short);
    assert.ok(!r.scenarioId, 'nothing of the scenario run is copied');
    assert.ok(/entry 3\/3 begins: Short/.test(logText(q)));

    r = next(q);
    assert.strictEqual(r.status, S.RunStatus.Done);
    assert.strictEqual(req(q).finished, 1);
    assert.strictEqual(req(q).queue.index, 2);
});

t.test('a loop wraps to entry 1 with pass 1', function () {
    var q = setup();
    startQueue(q, [['template', q.long, 1], ['template', q.short, 1]], { loop: true });
    next(q);
    assert.strictEqual(req(q).queue.index, 1);
    next(q);
    assert.strictEqual(req(q).queue.index, 0);
    assert.strictEqual(req(q).queue.pass, 1);
    assert.strictEqual(req(q).templateId, q.long);
    assert.strictEqual(q.st.run().status, q.S.RunStatus.Running);
    assert.ok(/entry 1\/2 begins: Long, pass 2/.test(logText(q)), logText(q));
});

t.test('a missing record pauses with QueueEntry; Resume after restoring it counts once', function () {
    var q = setup();
    var S = q.S;
    startQueue(q, [['template', q.long, 1], ['template', q.short, 1]]);
    var path = Object.keys(q.fs.disk).filter(function (p) { return p.indexOf(q.short + '.json') !== -1; })[0];
    var saved = q.fs.disk[path];
    delete q.fs.disk[path];

    var r = next(q);
    assert.strictEqual(r.status, S.RunStatus.Paused);
    assert.strictEqual(r.step, S.RunStep.Next);
    assert.strictEqual(r.pause.reason, S.RunPause.QueueEntry);
    assert.ok(/^Short: template .* is missing/.test(r.pause.message), r.pause.message);
    assert.strictEqual(req(q).finished, 0, 'nothing counted');
    assert.strictEqual(req(q).queue.index, 0);

    q.fs.disk[path] = saved;
    assert.strictEqual(q.st.resume(), true);
    r = pass(q);
    assert.strictEqual(r.status, S.RunStatus.Running);
    assert.strictEqual(req(q).queue.index, 1);
    assert.strictEqual(r.templateId, q.short);
    assert.strictEqual(countOf(logText(q), /run 1\/1 done: Long/), 1);
});

t.test('skip 1 at that pause counts once and begins the entry after, or ends the queue', function () {
    var q = setup();
    var S = q.S;
    startQueue(q, [['template', q.long, 1], ['scenario', 'twins', 1], ['template', q.short, 1]]);
    q.known = false;
    var r = next(q);
    assert.strictEqual(r.pause.reason, S.RunPause.QueueEntry);
    assert.ok(/^Twins: /.test(r.pause.message), r.pause.message);
    assert.strictEqual(q.run.skipEntry(), true);
    r = pass(q);
    assert.strictEqual(r.status, S.RunStatus.Running);
    assert.strictEqual(req(q).queue.index, 2);
    assert.strictEqual(req(q).queue.skip, 0);
    assert.strictEqual(r.templateId, q.short);
    assert.strictEqual(countOf(logText(q), /run 1\/1 done: Long/), 1);
    assert.ok(/queue Mix: 1 entry\(ies\) skipped/.test(logText(q)), logText(q));

    var q2 = setup();
    startQueue(q2, [['template', q2.long, 1], ['scenario', 'twins', 1]]);
    q2.known = false;
    next(q2);
    assert.strictEqual(q2.run.skipEntry(), true);
    r = pass(q2);
    assert.strictEqual(r.status, S.RunStatus.Done);
    assert.strictEqual(req(q2).finished, 1);
    assert.strictEqual(req(q2).queue.skip, 0);
});

t.test('noMap skip drops the rest of an entry with no map left', function () {
    var q = setup();
    startQueue(q, [['template', q.long, 3], ['template', q.short, 1]], { noMap: 'skip' });
    q.maps.BlackKnights = 0;
    var r = next(q);
    assert.strictEqual(r.status, q.S.RunStatus.Running);
    assert.strictEqual(req(q).queue.index, 1);
    assert.strictEqual(r.templateId, q.short);
    var log = logText(q);
    assert.ok(/run 1\/3 done: Long/.test(log), log);
    assert.ok(/no map left for Long: 2 run\(s\) dropped/.test(log), log);
    assert.strictEqual(lastNotice(q), 'Skipped Long: no map left in the star menu.');
});

t.test('noMap skip steps over a following entry with no map', function () {
    var q = setup();
    startQueue(q, [['template', q.long, 1], ['scenario', 'twins', 1], ['template', q.short, 1]],
        { noMap: 'skip' });
    q.maps[TWINS_ADV] = 0;
    next(q);
    assert.strictEqual(req(q).queue.index, 2);
    assert.strictEqual(req(q).templateId, q.short);
    var log = logText(q);
    assert.ok(/no map left for Twins: 1 run\(s\) dropped/.test(log), log);
    assert.ok(/queue Mix: 1 entry\(ies\) skipped/.test(log), log);
    assert.ok(/entry 3\/3 begins: Short/.test(log), log);
    assert.strictEqual(lastNotice(q), 'Skipped Twins: no map left in the star menu.');
});

t.test('noMap skip waits on an unreadable star menu without counting', function () {
    var q = setup();
    startQueue(q, [['template', q.long, 2], ['template', q.short, 1]], { noMap: 'skip' });
    q.maps = null;
    var r = next(q);
    assert.strictEqual(r.status, q.S.RunStatus.Running);
    assert.strictEqual(r.step, q.S.RunStep.Next);
    assert.strictEqual(req(q).finished, 0);
    assert.strictEqual(busyText(q), 'star menu not readable');
});

t.test('noMap skip pauses an endless queue with no map anywhere', function () {
    var q = setup();
    var S = q.S;
    startQueue(q, [['template', q.long, 1], ['template', q.short, 1]], { noMap: 'skip', loop: true });
    q.maps.BlackKnights = 0;
    q.maps.Bandits = 0;
    var r = next(q);
    assert.strictEqual(r.status, S.RunStatus.Paused);
    assert.strictEqual(r.step, S.RunStep.Next);
    assert.strictEqual(r.pause.reason, S.RunPause.QueueEntry);
    assert.strictEqual(r.pause.message, 'no map for any queue entry');
    assert.strictEqual(req(q).finished, 0);
    assert.strictEqual(req(q).queue.index, 0);
});

t.test('noMap skip ends a queue without loop when no entry after has a map', function () {
    var q = setup();
    startQueue(q, [['template', q.long, 1], ['template', q.short, 1]], { noMap: 'skip' });
    q.maps.Bandits = 0;
    var r = next(q);
    assert.strictEqual(r.status, q.S.RunStatus.Done);
    assert.strictEqual(req(q).finished, 1);
});

t.test('scenario item definitions unreadable wait at Next', function () {
    var q = setup();
    startQueue(q, [['template', q.long, 1], ['scenario', 'twins', 1]]);
    q.known = null;
    var r = next(q);
    assert.strictEqual(r.status, q.S.RunStatus.Running);
    assert.strictEqual(r.step, q.S.RunStep.Next);
    assert.strictEqual(req(q).finished, 0);
    assert.strictEqual(req(q).queue.index, 0);
    assert.strictEqual(busyText(q), 'item definitions not readable');
    q.known = true;
    r = pass(q);
    assert.strictEqual(req(q).queue.index, 1);
    assert.strictEqual(r.scenarioId, 'twins');
});

t.test('early skips Account and Retrain before a scenario or another template only', function () {
    var S;
    function arrive(entries) {
        var q = setup({ retrain: true });
        S = q.S;
        startQueue(q, entries(q), { early: true });
        var r = q.st.run();
        r.loadoutKeys = {};
        return { q: q, r: pass(q, S.RunStep.ArriveHome) };
    }
    var a = arrive(function (q) { return [['template', q.long, 1], ['scenario', 'twins', 1]]; });
    assert.strictEqual(a.r.step, S.RunStep.Next);
    assert.ok(/early hand-over: retrain skipped/.test(logText(a.q)), logText(a.q));
    a = arrive(function (q) { return [['template', q.long, 1], ['template', q.short, 1]]; });
    assert.strictEqual(a.r.step, S.RunStep.Next);
    a = arrive(function (q) { return [['template', q.long, 1], ['template', q.long, 1]]; });
    assert.strictEqual(a.r.step, S.RunStep.Account, 'same template: gather and retrain');
    a = arrive(function (q) { return [['template', q.long, 2], ['scenario', 'twins', 1]]; });
    assert.strictEqual(a.r.step, S.RunStep.Account, 'not the last run of the entry');
});

// The run after a pass at step, with the troops unreadable and no loadout
// file, so a step that retrains holds or pauses where it is.
function retrainStep(o, step) {
    var q = setup({ retrain: o.setting });
    startQueue(q, [['template', q.long, 1], ['template', q.short, 1]], { retrain: o.queue });
    var r = q.st.run();
    // Snapshot takes one only while retraining; the later steps need one.
    if (step !== 'Snapshot') r.snapshot = { Rifle: 9 };
    q.inv = { ok: false, listOk: true, listRead: true, total: {}, generals: [] };
    return pass(q, q.S.RunStep[step]);
}

t.test('queue retrain off skips Snapshot, Account and Population with the setting on', function () {
    var q = setup();
    var RS = q.S.RunStep;
    assert.strictEqual(retrainStep({ setting: true, queue: 'off' }, 'Snapshot').step, RS.Supply);
    assert.strictEqual(retrainStep({ setting: true, queue: 'off' }, 'Account').step, RS.Next);
    assert.strictEqual(retrainStep({ setting: true, queue: 'off' }, 'Population').step, RS.Next);
});

t.test('queue retrain on retrains with the setting off', function () {
    var q = setup();
    var RS = q.S.RunStep;
    var r = retrainStep({ setting: false, queue: 'on' }, 'Snapshot');
    assert.strictEqual(r.step, RS.Snapshot, 'the snapshot is taken: it reads the loadout');
    assert.strictEqual(r.status, q.S.RunStatus.Paused);
    assert.strictEqual(retrainStep({ setting: false, queue: 'on' }, 'Account').step, RS.Account, 'waits');
    assert.strictEqual(retrainStep({ setting: false, queue: 'on' }, 'Population').step, RS.Population, 'waits');
});

t.test('queue retrain settings follows the setting', function () {
    var q = setup();
    var RS = q.S.RunStep;
    assert.strictEqual(retrainStep({ setting: true, queue: 'settings' }, 'Account').step, RS.Account);
    assert.strictEqual(retrainStep({ setting: true, queue: 'settings' }, 'Population').step, RS.Population);
    assert.strictEqual(retrainStep({ setting: false, queue: 'settings' }, 'Account').step, RS.Next);
    assert.strictEqual(retrainStep({ setting: false, queue: 'settings' }, 'Population').step, RS.Next);
});

t.test('troops on the way home are carried to the next entry', function () {
    var q = setup();
    startQueue(q, [['template', q.long, 1], ['scenario', 'twins', 1]]);
    var r = q.st.run();
    var until = q.st.now() + LONG_MS;
    r.transit = [{ from: r.id, army: { Rifle: 3 }, until: until }];
    r = next(q);
    assert.strictEqual(r.scenarioId, 'twins');
    assert.deepStrictEqual(plain(r.transit), [{ from: r.transit[0].from, army: { Rifle: 3 }, until: until }]);
    assert.deepStrictEqual(plain(r.transitBase), { Rifle: 5 });
});

t.test('a single series is unchanged', function () {
    var q = setup();
    var S = q.S;
    assert.strictEqual(q.run.start(q.long), true, lastNotice(q));
    var n = req(q).count;
    assert.ok(n >= 2, 'the prompt default asks for more than one run');
    req(q).count = 2;
    var r = next(q);
    assert.strictEqual(req(q).queue, null);
    assert.strictEqual(req(q).finished, 1);
    assert.strictEqual(r.templateId, q.long);
    assert.strictEqual(r.step, S.RunStep.Muster);
    assert.ok(/run 2\/2 begins: Long/.test(logText(q)), logText(q));
    r = next(q);
    assert.strictEqual(r.status, S.RunStatus.Done);
    assert.strictEqual(req(q).finished, 2);
});
