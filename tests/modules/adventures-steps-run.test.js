'use strict';

// Template steps at run time: the shared step driver (loader.runStep) with a
// fake contract, then each kind through the executor on the test world of
// tests/stubs/adventures.js (Pause with its sound, Pause x min, Unload, Send
// home), the StarAll switch, a start at a later wave, the run file and the
// start check of a list that mixes battle files with step entries.

var t = require('../runner');
var AC = require('../stubs/actions');
var W = require('../stubs/adventures');

var assert = t.assert;

var HOME = W.HOME;
var ZONE = W.ZONE;
var RUN_FILE = W.RUN_FILE;
var LOADOUT = W.LOADOUT;
var W1 = 'C:/b/w1.txt';
var W2 = 'C:/b/w2.txt';

var plain = W.plain;
var writeJson = W.writeJson;
var tick = W.tick;
var play = W.play;
var stepName = W.stepName;

// ---- worlds -------------------------------------------------------------------

function gen(uid, name, grid, army) {
    return AC.general({ uid: uid, name: name, grid: grid, army: army || {} });
}

// Records each pause sound the run plays, on the booted harness only.
function countSounds(w) {
    w.sounds = 0;
    w.S.core.sound.alert = function () {
        w.sounds++;
        return true;
    };
}

// Anna (1.1) and Bert (1.2) on the viewed island. Wave 1 names both, wave 2
// only Anna, so a Send home of Bert between them passes the start check.
function islandWorld(o) {
    o = o || {};
    var g1 = gen('1.1', 'Anna', 10, { Rifle: 5 });
    var g2 = gen('1.2', 'Bert', 20, { Rifle: 3 });
    var w = W.world({ generals: [g1, g2], fs: o.fs, settings: o.settings });
    w.g1 = g1;
    w.g2 = g2;
    writeJson(w.fs, LOADOUT, {
        '1.1': { grid: 10, army: { Rifle: 5 }, name: 'Anna' },
        '1.2': { grid: 20, army: { Rifle: 3 }, name: 'Bert' }
    });
    writeJson(w.fs, W1, {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, name: 'Bert' }
    });
    writeJson(w.fs, W2, {
        '1.1': { grid: 10, target: 300, army: { Rifle: 5 }, order: 1, name: 'Anna' }
    });
    countSounds(w);
    return w;
}

// The home world with the run on the island: the map open and viewed, both
// generals there. Sends to a zone travel through the world's service manager.
function homeIsland() {
    var g1 = gen('1.1', 'Anna', 10, { Rifle: 5 });
    var g2 = gen('1.2', 'Bert', 20, { Rifle: 3 });
    var w = W.world({ home: true, generals: [g1, g2], free: { Rifle: 20, Bow: 0 }, settings: { retrain: true } });
    w.g1 = g1;
    w.g2 = g2;
    w.gi = w.H.host.game.gi;
    writeJson(w.fs, LOADOUT, {
        '1.1': { grid: 10, army: { Rifle: 5 } },
        '1.2': { grid: 20, army: { Rifle: 3 } }
    });
    writeJson(w.fs, W1, {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, name: 'Bert' }
    });
    writeJson(w.fs, W2, { '1.1': { grid: 10, target: 300, army: { Rifle: 5 }, order: 1, name: 'Anna' } });
    w.adventures = [{ adventureName: 'BlackKnights', zoneID: ZONE }];
    w.lists[HOME].length = 0;
    w.place(g1, ZONE);
    w.place(g2, ZONE);
    w.frees[ZONE] = {};
    w.gi.visitZone(ZONE);
    countSounds(w);
    return w;
}

// A run of the home world's series at o.step over o.paths.
function series(w, o) {
    var r = w.st.newRun({
        id: 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights',
        zoneId: o.zoneId === undefined ? ZONE : o.zoneId,
        paths: o.paths || [W1], loadoutPath: LOADOUT, loadoutKeys: { '1.1': true, '1.2': true },
        waveIndex: o.waveIndex || 0, speedBuff: '', starAll: o.starAll, step: o.step
    });
    var k;
    for (k in (o.run || {})) if (Object.prototype.hasOwnProperty.call(o.run, k)) r[k] = o.run[k];
    w.st.begin({
        templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: o.count || 1, ended: false,
        requested: w.t, finished: 0, closedAt: null
    }, r);
    return w.st.run();
}

// Ticks and plays until fn() holds or max passes went by.
function passUntil(w, fn, max) {
    for (var i = 0; i < (max || 30); i++) {
        if (fn()) return true;
        tick(w);
        play(w);
        w.t += 1000;
    }
    return fn();
}

function logged(w, re, level) {
    return w.H.logs().some(function (l) {
        return l.category === 'adventures' && (!level || l.level === level) && re.test(l.args.join(' '));
    });
}

function assertRunning(w, step) {
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'status ' + r.status + (r.pause ? ': ' + r.pause.message : ''));
    if (step) assert.strictEqual(stepName(w), step);
}

function assertPaused(w, reason, re) {
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused, 'status ' + r.status + ' at ' + stepName(w));
    assert.strictEqual(r.pause.reason, reason, 'reason ' + r.pause.reason + ': ' + r.pause.message);
    if (re) assert.ok(re.test(r.pause.message), r.pause.message);
}

// Counts the writes of the run file from now on.
function countSaves(w) {
    var files = w.S.kernel.files;
    var write = files.writeText;
    var c = { n: 0 };
    files.writeText = function (path) {
        if (path === RUN_FILE) c.n++;
        return write.apply(files, arguments);
    };
    return c;
}

function stored(w) {
    return JSON.parse(w.fs.disk[RUN_FILE]).run;
}

// ---- the driver with a fake contract --------------------------------------------

// A contract whose hooks answer from o and count their calls.
function fakeDef(w, o) {
    var calls = { done: 0, blocked: 0, orders: 0, next: 0 };
    var def = {
        label: 'Fake',
        calls: calls,
        fail: o.fail || { reason: w.S.RunPause.UnloadFailed, what: 'unload' },
        done: function () { calls.done++; return o.done === undefined ? false : o.done; },
        blocked: function () { calls.blocked++; return o.blocked || null; },
        orders: function () { calls.orders++; return o.orders ? o.orders() : []; },
        next: function () { calls.next++; }
    };
    if (o.reads) def.reads = o.reads;
    if (o.skip) def.skip = o.skip;
    return def;
}

function driverWorld() {
    var w = islandWorld();
    W.startRun(w, [W1, W2], { step: w.S.WaveStep.Gate });
    w.ld = w.S.modules.adventures.loader;
    return w;
}

// One pass of the driver under the module tag, its queue captured.
function drive(w, def, item) {
    var r = w.st.run();
    w.st.current().busySeen = false;
    w.S.kernel._currentModule = 'adventures';
    try { w.ld.runStep(r, r.step, def, item || null, w.S.core.army.inventory()); }
    finally { w.S.kernel._currentModule = null; }
    W.drain(w);
}

t.test('runStep: done true calls next once and nothing else', function () {
    var w = driverWorld();
    var def = fakeDef(w, { done: true });
    drive(w, def);
    assert.deepStrictEqual(def.calls, { done: 1, blocked: 0, orders: 0, next: 1 });
    assertRunning(w);
});

t.test('runStep: done null waits on the read named by reads, generals by default', function () {
    var w = driverWorld();
    var def = fakeDef(w, { done: null });
    drive(w, def);
    var b = w.st.current().busy;
    assert.ok(b && b.read === true && b.text === 'generals not readable', b ? b.text : 'no wait');
    assert.strictEqual(def.calls.blocked, 0);
    var w2 = driverWorld();
    drive(w2, fakeDef(w2, { done: null, reads: 'army' }));
    assert.strictEqual(w2.st.current().busy.text, 'army not readable');
});

t.test('runStep: a busy result waits on the general with no orders', function () {
    var w = driverWorld();
    var def = fakeDef(w, { blocked: { key: '1.1', text: 'Anna (1.1) busy' } });
    drive(w, def);
    var b = w.st.current().busy;
    assert.strictEqual(b.key, '1.1');
    assert.strictEqual(b.text, 'Anna (1.1) busy');
    assert.strictEqual(def.calls.orders, 0);
    assertRunning(w);
});

t.test('runStep: an absent result waits through the grace, then pauses GeneralMissing', function () {
    var w = driverWorld();
    var def = fakeDef(w, { blocked: { key: '1.2', text: 'Bert (1.2) is not on the island', absent: true } });
    var grace = w.ld.MISSING_GRACE_MS;
    var start = w.t;
    drive(w, def);
    assertRunning(w);
    assert.strictEqual(w.st.current().busy.text, 'Bert (1.2) is not on the island');
    while (w.t - start < grace - 10000) {
        w.t += 10000;
        drive(w, def);
        assertRunning(w);
    }
    w.t = start + grace;
    drive(w, def);
    assertPaused(w, w.S.RunPause.GeneralMissing, /^Bert \(1\.2\) is not on the island$/);
    assert.strictEqual(w.st.run().pause.general, '1.2');
});

t.test('runStep: a read result waits on that read', function () {
    var w = driverWorld();
    drive(w, fakeDef(w, { blocked: { read: 'home zone id' } }));
    var b = w.st.current().busy;
    assert.ok(b && b.read === true && b.text === 'home zone id not readable', b ? b.text : 'no wait');
    assertRunning(w);
});

t.test('runStep: a hold writes its mark once, logs once and feeds no busy record', function () {
    var w = driverWorld();
    var def = fakeDef(w, { blocked: { hold: 'pause 2 min started', mark: 'wait:0' } });
    var saves = countSaves(w);
    var t0 = w.t;
    drive(w, def);
    var rec = w.st.run().marks['wait:0'];
    assert.strictEqual(rec.sentAt, t0);
    assert.strictEqual(rec.sentOnce, true);
    assert.strictEqual(rec.seen, false);
    assert.strictEqual(saves.n, 1);
    assert.strictEqual(w.st.current().busy, null);
    assert.ok(w.st.current().busySeen !== true, 'the pass kept no wait going');
    w.t += 10000;
    drive(w, def);
    assert.strictEqual(w.st.run().marks['wait:0'].sentAt, t0, 'the start stays');
    assert.strictEqual(saves.n, 1, 'no second save');
    assert.strictEqual(w.st.current().busy, null);
    var lines = w.H.logs().filter(function (l) { return /pause 2 min started/.test(l.args.join(' ')); });
    assert.strictEqual(lines.length, 1);
});

t.test('runStep: a pause result marks the row seen and pauses in one save', function () {
    var w = driverWorld();
    var saves = countSaves(w);
    drive(w, fakeDef(w, { blocked: { pause: w.S.RunPause.Planned, text: 'Pause step: look', mark: 'pause:0' } }));
    assertPaused(w, w.S.RunPause.Planned, /^Pause step: look$/);
    assert.strictEqual(w.st.run().marks['pause:0'].seen, true);
    assert.strictEqual(saves.n, 1);
    var disk = stored(w);
    assert.strictEqual(disk.status, w.S.RunStatus.Paused);
    assert.strictEqual(disk.marks['pause:0'].seen, true);
});

function refusing() {
    return { label: 'fake order', timeoutMs: 1000, retries: 0,
        precheck: function () { return 'nope'; },
        send: function () { return true; },
        check: function () { return false; } };
}

t.test('runStep: a marked order sent but not seen waits, then pauses NotObserved', function () {
    var w = driverWorld();
    var def = fakeDef(w, { orders: function () { return [{ key: '1.1', mark: 'fake:1.1', def: refusing() }]; } });
    var r = w.st.run();
    r.marks = { 'fake:1.1': { sentAt: w.t, seen: false, sentOnce: true } };
    drive(w, def);
    assertRunning(w);
    assert.ok(/unload of Anna \(1\.1\) sent, waiting to see it/.test(w.st.current().busy.text));
    assert.strictEqual(w.pending.length, 0, 'nothing sent again');
    w.t += w.ld.ORDER_WAIT_MS;
    drive(w, def);
    assertPaused(w, w.S.RunPause.NotObserved,
        /^unload of Anna \(1\.1\) sent but not seen; check the general, then Resume$/);
    assert.strictEqual(w.st.run().pause.general, '1.1');
});

t.test('runStep: a failed round pauses with fail.reason and the general', function () {
    var w = driverWorld();
    var def = fakeDef(w, { orders: function () { return [{ key: '1.1', mark: '', def: refusing() }]; } });
    drive(w, def);
    assert.ok(w.pending.length > 0, 'the round was started');
    play(w);
    drive(w, def);
    assertPaused(w, w.S.RunPause.UnloadFailed, /^unload of Anna \(1\.1\) failed: nope$/);
    assert.strictEqual(w.st.run().pause.general, '1.1');
});

t.test('runStep: a skip text logs the skip and moves on without done', function () {
    var w = driverWorld();
    var def = fakeDef(w, { skip: function () { return 'not wanted'; } });
    drive(w, def);
    assert.deepStrictEqual(def.calls, { done: 0, blocked: 0, orders: 0, next: 1 });
    assert.ok(logged(w, /Fake skipped: not wanted/));
    var plainDef = fakeDef(w, { done: true, skip: function () { return null; } });
    drive(w, plainDef);
    assert.strictEqual(plainDef.calls.done, 1, 'a null skip runs the step');
});

// ---- Pause ----------------------------------------------------------------------

var PAUSE = { step: 'pause', message: 'Check the boss camp' };

t.test('Pause: pauses once with Planned and the message, plays the sound once; Resume goes on', function () {
    var w = islandWorld();
    W.startRun(w, [W1, PAUSE, W2], { waveIndex: 1, step: w.S.WaveStep.Gate });
    tick(w);
    assertPaused(w, w.S.RunPause.Planned, /^Pause step: Check the boss camp; Resume run goes on with wave 2$/);
    assert.strictEqual(w.sounds, 1);
    assert.strictEqual(w.st.run().marks['pause:1'].seen, true);
    tick(w);
    assert.strictEqual(w.sounds, 1, 'a paused run plays nothing more');
    assert.strictEqual(w.S.modules.adventures.run.resume(), true);
    tick(w);
    var r = w.st.run();
    assertRunning(w, 'Gate');
    assert.strictEqual(r.waveIndex, 2, 'the run went on to wave 2');
    assert.strictEqual(w.sounds, 1, 'no second pause, no second sound');
});

t.test('Pause: a fresh load keeps the entries, the seen mark and Planned, and plays no sound', function () {
    var w = islandWorld();
    W.startRun(w, [W1, PAUSE, W2], { waveIndex: 1, step: w.S.WaveStep.Gate });
    tick(w);
    assertPaused(w, w.S.RunPause.Planned);
    var w2 = islandWorld({ fs: w.fs });
    assert.ok(w2.st.current().loaded !== true, 'nothing loaded before boot');
    w2.mod.boot();
    var r = w2.st.run();
    assert.strictEqual(w2.st.current().loaded, true);
    assert.deepStrictEqual(plain(r.paths), [W1, PAUSE, W2]);
    assert.strictEqual(r.waveIndex, 1);
    assert.strictEqual(r.marks['pause:1'].seen, true);
    assert.strictEqual(r.status, w2.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w2.S.RunPause.Planned);
    assert.strictEqual(w2.sounds, 0, 'loading a paused run plays nothing');
});

t.test('Pause: the user Pause plays no sound, a problem pause plays it', function () {
    var w = islandWorld();
    W.startRun(w, [W1], { step: w.S.WaveStep.Gate });
    w.st.pause(w.S.RunPause.User, 'paused by you');
    assert.strictEqual(w.sounds, 0);
    w.st.resume();
    w.st.pause(w.S.RunPause.GeneralMissing, 'Bert (1.2) is not on the island', { general: '1.2' });
    assert.strictEqual(w.sounds, 1);
});

// ---- Pause x min ------------------------------------------------------------------

t.test('Wait: goes on after its minutes with no busy record and no zone trip; waitsLong while on it', function () {
    var w = islandWorld({ settings: { stuckMinutes: 1 } });
    W.startRun(w, [W1, { step: 'wait', minutes: 2 }, W2], { waveIndex: 1, step: w.S.WaveStep.Gate });
    var t0 = w.t;
    tick(w);
    var r = w.st.run();
    assert.strictEqual(r.marks['wait:1'].sentAt, t0);
    assert.ok(logged(w, /pause 2 min started/));
    assert.strictEqual(w.st.waitsLong(r), true);
    W.ticksFor(w, 110000);
    r = w.st.run();
    assertRunning(w, 'Gate');
    assert.strictEqual(r.waveIndex, 1, 'still waiting');
    assert.strictEqual(w.st.current().busy, null, 'no busy record');
    assert.strictEqual(r.resolve, null, 'no zone trip');
    assert.strictEqual(r.stuck, null);
    assert.ok(!logged(w, /zone trip/), 'no trip logged');
    assert.strictEqual(w.sounds, 0, 'a timed wait plays no sound');
    W.ticksFor(w, 10000);
    r = w.st.run();
    assertRunning(w, 'Gate');
    assert.strictEqual(r.waveIndex, 2);
    assert.strictEqual(r.marks['wait:1'].seen, true);
    assert.ok(logged(w, /pause 2 min over/));
    assert.strictEqual(w.st.waitsLong(r), false, 'a wave step is no long wait');
});

// ---- Unload -------------------------------------------------------------------------

t.test('Unload: unloads the named general, he keeps his grid, the run goes on', function () {
    var w = islandWorld();
    W.startRun(w, [W1, { step: 'unload', generals: ['1.1'] }, W2], { waveIndex: 1, step: w.S.WaveStep.Gate });
    assert.ok(passUntil(w, function () { return w.st.run().waveIndex === 2; }), 'the run went on');
    assertRunning(w, 'Gate');
    assert.deepStrictEqual(w.unloads, ['1.1']);
    assert.deepStrictEqual(plain(w.g1.state.army), {});
    assert.strictEqual(w.g1.state.grid, 10);
    assert.strictEqual(w.free.Rifle, 105);
    assert.deepStrictEqual(plain(w.g2.state.army), { Rifle: 3 }, 'Bert keeps his troops');
});

// ---- Send home ------------------------------------------------------------------------

var HOME_BERT = { step: 'home', generals: ['1.2'] };

t.test('Send home: sends him home once and marks him seen; fieldKeys drops him, keysOf keeps him', function () {
    var w = homeIsland();
    series(w, { step: w.S.WaveStep.Gate, paths: [W1, HOME_BERT, W2], waveIndex: 1 });
    assert.ok(passUntil(w, function () { return w.st.run().waveIndex === 2; }), 'the run went on');
    assertRunning(w, 'Gate');
    var sends = w.zoneSends.filter(function (s) { return s.key === '1.2'; });
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].zoneId, HOME);
    assert.strictEqual(w.zoneSends.length, 1, 'only Bert');
    var r = w.st.run();
    assert.strictEqual(r.marks['home:1.2'].seen, true);
    var ld = w.S.modules.adventures.loader;
    assert.deepStrictEqual(plain(ld.fieldKeys(r)), ['1.1']);
    assert.deepStrictEqual(plain(ld.keysOf(r)), ['1.1', '1.2']);
});

t.test('Send home: fieldKeys keeps a general whose send was never seen', function () {
    var w = homeIsland();
    var r = series(w, { step: w.S.WaveStep.Gate, paths: [W1, HOME_BERT, W2], waveIndex: 2,
        run: { marks: { 'home:1.2': { sentAt: 5, seen: false, sentOnce: true } } } });
    assert.deepStrictEqual(plain(w.S.modules.adventures.loader.fieldKeys(r)), ['1.1', '1.2']);
});

t.test('Send home: Clear does not wait on him while he is listed travelling', function () {
    [true, false].forEach(function (sent) {
        var w = homeIsland();
        series(w, { step: w.S.RunStep.Clear, paths: [W1, HOME_BERT, W2], waveIndex: 3,
            run: { marks: sent ? { 'home:1.2': { sentAt: 5, seen: true, sentOnce: true } } : {} } });
        w.quests.forEach(function (q) { if (q.last) q.finished = true; });
        w.g2.state.task = { type: w.code.travel, remaining: 600000 };
        w.g2.state.travelling = true;
        tick(w);
        if (sent) {
            assertRunning(w, 'LastQuest');
            assert.ok(!logged(w, /Bert \(1\.2\) busy/), 'no busy wait on him');
        } else {
            assertRunning(w, 'Clear');
            assert.ok(logged(w, /Bert \(1\.2\) busy/), 'without the mark he holds Clear');
        }
    });
});

t.test('Send home: ArriveHome waits for him until he is listed home and idle, then goes on', function () {
    var w = homeIsland();
    series(w, { step: w.S.WaveStep.Gate, paths: [W1, HOME_BERT, W2], waveIndex: 1 });
    assert.ok(passUntil(w, function () { return w.st.run().waveIndex === 2; }), 'Bert was sent home');
    // The map is over: Anna is home and idle, Bert is still on his way and
    // not listed yet.
    w.adventures = [];
    w.lists[ZONE].splice(w.lists[ZONE].indexOf(w.g1), 1);
    w.lists[HOME].push(w.g1);
    var bertHome = w.lists[HOME].indexOf(w.g2);
    assert.ok(bertHome >= 0, 'the send put him on the home list');
    w.lists[HOME].splice(bertHome, 1);
    w.gi.visitZone(HOME);
    w.st.go(w.S.RunStep.ArriveHome, 'test');
    tick(w);
    assertRunning(w, 'ArriveHome');
    assert.ok(/^1\.2 not here yet/.test(w.st.current().busy.text), w.st.current().busy.text);
    w.lists[HOME].push(w.g2);
    w.t += 10000;
    tick(w);
    assertRunning(w, 'ArriveHome');
    assert.ok(/Bert \(1\.2\) busy/.test(w.st.current().busy.text), w.st.current().busy.text);
    w.arrive();
    w.t += 10000;
    tick(w);
    assertRunning(w, 'Account');
});

// ---- StarAll switch -----------------------------------------------------------------

t.test('StarAll: off goes to Horseshoe with no star order, and optionOff reports the row off', function () {
    var w = homeIsland();
    var r = series(w, { step: w.S.RunStep.StarAll, starAll: false });
    assert.strictEqual(r.starAll, false);
    tick(w);
    play(w);
    assertRunning(w, 'Horseshoe');
    assert.strictEqual(w.orders.filter(function (o) { return o.code === w.code.star; }).length, 0);
    assert.ok(logged(w, /send all to the star not used/));
    var row = w.st.stepRows().filter(function (x) { return x.label === 'Send all to the star'; })[0];
    assert.ok(row, 'the StarAll row');
    assert.strictEqual(w.st.optionOff(w.st.run(), row.option), true);
    var on = homeIsland();
    assert.strictEqual(on.st.optionOff(series(on, { step: on.S.RunStep.StarAll }), row.option), false,
        'a run without the field sends to the star');
});

t.test('StarAll: the next run of a series keeps starAll false', function () {
    var w = homeIsland();
    w.adventures = [];
    w.lists[ZONE].length = 0;
    w.lists[HOME].push(w.g1, w.g2);
    w.gi.visitZone(HOME);
    series(w, { step: w.S.RunStep.Next, count: 2, starAll: false, zoneId: null });
    tick(w);
    var r = w.st.run();
    assert.strictEqual(r.step, w.S.RunStep.Muster, 'the next run begins');
    assert.strictEqual(r.starAll, false);
});

// ---- Start at wave -------------------------------------------------------------------

// A saved template of the given list; the count prompt answers 1, the start
// wave prompt answers wave.
function startTemplate(waves, wave) {
    var w = islandWorld();
    var tpl = w.S.modules.adventures.templates.save({
        label: 'Black Knights', adventure: 'BlackKnights', loadout: LOADOUT,
        waves: waves, speedBuff: 'SpeedBuffDefault'
    }, 1000);
    assert.strictEqual(tpl.ok, true, tpl.message);
    var answers = ['1', wave];
    w.prompts = [];
    w.H.ctx.prompt = function (text, def) {
        w.prompts.push(text);
        return answers.length ? answers.shift() : def;
    };
    w.H.ctx.confirm = function () { return true; };
    assert.strictEqual(w.S.modules.adventures.run.start(tpl.id), true, w.alerts.join(' | '));
    return w;
}

t.test('Start at wave: 2 on [w1, Send home, w2] starts at the second file and sends nobody home', function () {
    var w = startTemplate([W1, HOME_BERT, W2], '2');
    assert.ok(/1\.\.2$/.test(w.prompts[1]), w.prompts[1]);
    var r = w.st.run();
    assert.strictEqual(r.waveIndex, 2);
    assert.strictEqual(r.step, w.S.WaveStep.Gate);
    assert.deepStrictEqual(plain(r.paths), [W1, HOME_BERT, W2]);
    tick(w);
    play(w);
    assert.strictEqual(w.zoneSends.length, 0);
    assert.ok(!r.marks || !r.marks['home:1.2'], 'no Send home mark');
});

t.test('Start at wave: 1 on [Pause, w1] starts at the top and the pause runs', function () {
    var w = startTemplate([PAUSE, W1], '1');
    assert.ok(/1\.\.1$/.test(w.prompts[1]), w.prompts[1]);
    assert.strictEqual(w.st.run().waveIndex, 0);
    tick(w);
    assertPaused(w, w.S.RunPause.Planned, /Resume run goes on with wave 1$/);
    assert.strictEqual(w.sounds, 1);
});

// ---- Run file, camps and start check -----------------------------------------------------

t.test('normRun: an unknown step entry pauses WaveFile on load, without a sound', function () {
    var w = islandWorld();
    W.startRun(w, [W1, { step: 'bogus' }, W2], { step: w.S.WaveStep.Gate });
    w.st.save();
    var w2 = islandWorld({ fs: w.fs });
    w2.mod.boot();
    var r = w2.st.run();
    assert.strictEqual(r.status, w2.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w2.S.RunPause.WaveFile);
    assert.ok(/template step this build cannot run/.test(r.pause.message), r.pause.message);
    assert.deepStrictEqual(plain(r.paths), [W1, W2]);
    assert.strictEqual(w2.sounds, 0);
});

t.test('campsOf: step entries add no camps and do not stop the files after them', function () {
    var w = islandWorld();
    var r = W.startRun(w, [W1, PAUSE, W2], { step: w.S.WaveStep.Gate });
    var grids = plain(w.S.modules.adventures.loader.campsOf(r).map(function (c) { return c.grid; }).sort());
    assert.deepStrictEqual(grids, [100, 200, 300]);
});

t.test('executor.check refuses a wave naming a general sent home earlier', function () {
    var w = islandWorld();
    var rec = { label: 'Black Knights', adventure: 'BlackKnights', loadout: LOADOUT, waves: [W1, HOME_BERT, W1] };
    var chk = w.ex.check(rec);
    assert.strictEqual(chk.ok, false);
    var hit = chk.problems.filter(function (p) { return /wave 2 \(w1\.txt\) uses Bert after this step/.test(p.message); });
    assert.strictEqual(hit.length, 1, chk.problems.map(function (p) { return p.message; }).join(' | '));
    assert.strictEqual(hit[0].fatal, true);
    var good = w.ex.check({ label: 'Black Knights', adventure: 'BlackKnights', loadout: LOADOUT, waves: [W1, HOME_BERT, W2] });
    assert.strictEqual(good.ok, true, good.problems.map(function (p) { return p.message; }).join(' | '));
    assert.deepStrictEqual(plain(good.loadoutNames), { '1.1': 'Anna', '1.2': 'Bert' });
});
