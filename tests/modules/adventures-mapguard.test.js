'use strict';

// The map start of the adventures module is held while another module has
// game work pending or in flight in the kernel queue, and for a quiet time
// after it last saw such work at the step. The step checks it, and the
// attempt's precheck checks it again right before the send. The wait has no
// limit, never skips the start and never touches the rule that an unseen
// start is not sent again.
//
// The home world of tests/stubs/adventures.js has the kernel queue replaced,
// so no module is busy unless a test says so: w.other makes 'mining' busy.

var t = require('../runner');
var AC = require('../stubs/actions');
var W = require('../stubs/adventures');

var assert = t.assert;

var LOADOUT = W.LOADOUT;
var WAVE = 'C:/b/w1.txt';
var KEYS = { '1.1': true, '1.2': true };

var writeJson = W.writeJson;
var tick = W.tick;
var play = W.play;
var stepName = W.stepName;

// ---- world ------------------------------------------------------------------

function gen(uid, name, grid, army) {
    return AC.general({ uid: uid, name: name, grid: grid, army: army || {} });
}

// The home world with two generals and a wave file, and one other module
// that is busy while w.other is true. w.lastBusy is the test time of the last
// read that found it busy.
function homeWorld() {
    var g1 = gen('1.1', 'Anna', 10, {});
    var g2 = gen('1.2', 'Bert', 20, {});
    var w = W.world({ home: true, generals: [g1, g2], free: { Rifle: 20, Bow: 0 }, settings: { retrain: true } });
    w.g1 = g1;
    w.g2 = g2;
    writeJson(w.fs, LOADOUT, {
        '1.1': { grid: 10, army: { Rifle: 5 } },
        '1.2': { grid: 20, army: { Rifle: 3 } }
    });
    writeJson(w.fs, WAVE, {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, name: 'Bert' }
    });
    w.gi = w.H.host.game.gi;
    w.other = false;
    w.lastBusy = null;
    w.S.kernel.queue.isModuleBusy = function (id) {
        if (id === 'mining' && w.other) {
            w.lastBusy = w.t;
            return true;
        }
        return false;
    };
    return w;
}

// A run of the series at the StartMap step.
function series(w) {
    var r = w.st.newRun({
        id: 42, templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', zoneId: null,
        paths: [WAVE], loadoutPath: LOADOUT, loadoutKeys: KEYS, waveIndex: 0, speedBuff: '',
        step: w.S.RunStep.StartMap
    });
    w.st.begin({
        templateId: 't1', label: 'Black Knights', adventure: 'BlackKnights', count: 1, ended: false,
        requested: w.t, finished: 0
    }, r);
    return w.st.run();
}

// Ticks and plays pass by pass until the run is no longer Running, max
// passes are done or until(w, stepName) holds; dt is the clock step per pass
// (default 1 s).
function drive(w, o) {
    o = o || {};
    var max = o.max || 400;
    for (var i = 0; i < max; i++) {
        var r = w.st.run();
        if (!r || r.status !== w.S.RunStatus.Running) return i;
        if (o.until && o.until(w, stepName(w))) return i;
        tick(w);
        play(w);
        w.t += typeof o.dt === 'number' ? o.dt : 1000;
    }
    return i;
}

function atDepart(w, name) { return name === 'Depart'; }

function mapStarts(w) {
    return w.buffActions.filter(function (b) { return b.type === 'Adventure'; });
}

function assertStep(w, name) {
    var r = w.st.run();
    assert.strictEqual(stepName(w), name, 'step ' + stepName(w) + (r.pause ? ' (' + r.pause.message + ')' : ''));
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'status ' + r.status + (r.pause ? ': ' + r.pause.message : ''));
}

function logCount(w, re) {
    return w.H.logs().filter(function (l) { return re.test(l.args.join(' ')); }).length;
}

function quietMs(w) {
    return w.S.modules.adventures.home.OTHERS_QUIET_MS;
}

// ---- 1. another module busy ---------------------------------------------------

t.test('StartMap guard: no start while another module is busy, one wait line within a minute', function () {
    var w = homeWorld();
    series(w);
    w.other = true;
    drive(w, { max: 30 });
    assertStep(w, 'StartMap');
    assert.strictEqual(mapStarts(w).length, 0, 'nothing sent while mining is busy');
    assert.strictEqual(logCount(w, /map start waits for mining to finish/), 1);
});

// ---- 2. quiet time after the other module ---------------------------------------

t.test('StartMap guard: after the other module is idle the start waits the quiet time, then one goes out', function () {
    var w = homeWorld();
    series(w);
    w.other = true;
    drive(w, { max: 10 });
    assert.strictEqual(mapStarts(w).length, 0);
    w.other = false;
    var idleFrom = w.t;
    drive(w, { max: 5 });
    assert.strictEqual(mapStarts(w).length, 0, 'still inside the quiet time');
    assert.ok(w.t - w.lastBusy < quietMs(w), 'the test is still inside the quiet time');
    drive(w, { until: atDepart });
    assertStep(w, 'Depart');
    assert.strictEqual(mapStarts(w).length, 1);
    assert.ok(mapStarts(w)[0].t >= w.lastBusy + quietMs(w),
        'start at ' + mapStarts(w)[0].t + ', last busy at ' + w.lastBusy + ', idle from ' + idleFrom);
});

// ---- 3. nothing else busy -------------------------------------------------------

t.test('StartMap guard: another module never busy, the start goes out on the first pass', function () {
    var w = homeWorld();
    series(w);
    var t0 = w.t;
    drive(w, { until: atDepart });
    assertStep(w, 'Depart');
    assert.strictEqual(mapStarts(w).length, 1);
    assert.ok(mapStarts(w)[0].t - t0 < quietMs(w), 'no quiet time paid');
    assert.strictEqual(logCount(w, /map start waits/), 0);
});

// ---- 4. the attempt's own check ---------------------------------------------------

t.test('StartMap guard: another module busy between step and send refuses the attempt, nothing sent, no pause', function () {
    var w = homeWorld();
    series(w);
    tick(w);
    assert.ok(w.pending.length > 0, 'the attempt is queued');
    w.other = true;
    play(w);
    assert.strictEqual(mapStarts(w).length, 0, 'nothing sent');
    assert.ok(logCount(w, /another module has an action in flight/) >= 1, 'the refusal is logged');
    assertStep(w, 'StartMap');
    tick(w);
    assert.ok(!w.st.current().round, 'the round is dropped');
    assertStep(w, 'StartMap');
    w.other = false;
    drive(w, { until: atDepart });
    assertStep(w, 'Depart');
    assert.strictEqual(mapStarts(w).length, 1);
    assert.ok(mapStarts(w)[0].t >= w.lastBusy + quietMs(w), 'start after the quiet time');
});

// ---- 5. busy list unreadable ------------------------------------------------------

t.test('StartMap guard: a busy list that cannot be read holds the start, no pause, and clears when readable', function () {
    var w = homeWorld();
    var real = w.S.kernel.scheduler.busyModules;
    w.S.kernel.scheduler.busyModules = function () { return null; };
    series(w);
    drive(w, { max: 30 });
    assertStep(w, 'StartMap');
    assert.strictEqual(mapStarts(w).length, 0);
    assert.ok(logCount(w, /map start waits: busy modules not readable/) >= 1);
    w.S.kernel.scheduler.busyModules = real;
    drive(w, { until: atDepart });
    assertStep(w, 'Depart');
    assert.strictEqual(mapStarts(w).length, 1);
});

// ---- 6. an unseen start is never sent again ------------------------------------------

// The map start packet never leaves the client, so the stock stays as it was.
function dropMapPacket(w) {
    var send = w.gi.SendServerAction;
    w.gi.SendServerAction = function (id) {
        if (id === 61) return;
        return send.apply(this, arguments);
    };
}

// The start is sent and its verify is still queued, then the kernel loses
// the queue, the way a pause does.
function sendThenLose(w) {
    tick(w);
    play(w, function () { return logCount(w, /: map sent$/) === 1; });
    w.kernelPause();
}

function staleCase(busy) {
    var w = homeWorld();
    dropMapPacket(w);
    series(w);
    sendThenLose(w);
    w.other = busy;
    drive(w, { max: 200 });
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused, 'status ' + r.status);
    assert.strictEqual(r.pause.reason, w.S.RunPause.NotObserved, r.pause.reason + ': ' + r.pause.message);
    assert.strictEqual(logCount(w, /: map sent$/), 1, 'one start only');
    assert.strictEqual(mapStarts(w).length, 0, 'the dropped packet reached no one');
}

t.test('StartMap guard: an unseen start still pauses NotObserved and sends nothing, other module idle', function () {
    staleCase(false);
});

t.test('StartMap guard: an unseen start still pauses NotObserved and sends nothing, other module busy', function () {
    staleCase(true);
});
