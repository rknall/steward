'use strict';

// A Buff line (battle file key buff_*, type "buff", target = camp grid) that
// kills a camp works in a wave run. A buff line counts as seen on its own
// verification (the stock dropped), not on the camp dying, so a buff that only
// weakens a camp still lets the wave go on. A later line on a camp a buff
// killed is dropped like any beaten camp. A wave that mixes Buff and Attack
// lines on different camps sends them in parsed order and keeps each gap.

var t = require('../runner');
var W = require('../stubs/adventures');
var AC = require('../stubs/actions');

var assert = t.assert;

var world = W.world;
var tick = W.tick;
var play = W.play;
var startRun = W.startRun;
var stepName = W.stepName;
var writeJson = W.writeJson;

// Past this much quiet time Settle pauses Unreachable; read from the module.
function quietMs(w) { return w.ex.SETTLE_QUIET_MS; }

function attacksOf(w, key) {
    return w.orders.filter(function (o) { return o.code === w.code.attack && (!key || o.key === key); });
}

function assertHandedOver(w) {
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'status ' + r.status + (r.pause ? ' (' + r.pause.message + ')' : ''));
    assert.strictEqual(r.step, w.S.RunStep.PackStar, 'step ' + stepName(w));
}

// The world's camp buff, then the camp falls at the send: the stub keeps the
// send log and the verification, only the camp is removed on top.
function killingBuffs(w) {
    var base = w.S.core.buffs.camp;
    w.S.core.buffs.camp = function (name, grid) {
        var def = base(name, grid);
        var send = def.send;
        def.send = function () {
            var ok = send();
            delete w.camps[grid];
            return ok;
        };
        return def;
    };
}

// A buff that goes out but whose stock never drops, so it is never seen.
function unseenBuffs(w) {
    var base = w.S.core.buffs.camp;
    w.S.core.buffs.camp = function (name, grid) {
        var def = base(name, grid);
        def.check = function () { return false; };
        return def;
    };
}

// Ticks and plays like runOut and records waveIndex:Step after every tick, up
// to `max` ticks; stops when the run is not Running or has left the wave steps.
function trace(w, max) {
    var steps = [];
    for (var i = 0; i < (max || 60); i++) {
        var r = w.st.run();
        if (!r || r.status !== w.S.RunStatus.Running || !w.st.isWaveStep(r.step)) break;
        tick(w);
        r = w.st.run();
        steps.push(r.waveIndex + ':' + stepName(w));
        play(w);
    }
    return steps;
}

function hasStep(steps, suffix) {
    return steps.some(function (s) { return s.split(':')[1] === suffix; });
}

// Anna (grid 10) and Bert (grid 20) stand on their line grids with their line
// armies. Wave 1 is a buff-only wave on camp 100; wave 2 names 100 (Anna) and
// 200 (Bert).
function buffWorld(o) {
    o = o || {};
    var g1 = AC.general({ uid: '1.1', name: 'Anna', grid: 10, army: { Rifle: 5 } });
    var g2 = AC.general({ uid: '1.2', name: 'Bert', grid: 20, army: { Rifle: 3 } });
    var w = world({ generals: [g1, g2], camps: o.camps || { 100: true, 200: true, 300: true } });
    writeJson(w.fs, 'C:/b/w1.txt', {
        buff_fire: { type: 'buff', name: 'Fire', target: 100, order: 1 }
    });
    writeJson(w.fs, 'C:/b/w2.txt', {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 2, time: 60000, name: 'Bert' }
    });
    w.g1 = g1;
    w.g2 = g2;
    return w;
}

// Ticks and plays until the run sits at the named step of the wave index, in
// at most `max` rounds; returns whether it got there.
function until(w, waveIndex, step, max) {
    for (var i = 0; i < (max || 60); i++) {
        var r = w.st.run();
        if (r.status !== w.S.RunStatus.Running) return false;
        if (r.waveIndex === waveIndex && stepName(w) === step) return true;
        tick(w);
        play(w);
    }
    return false;
}

// ---- buff-only wave before the attack waves ---------------------------------

t.test('buff-only wave: the buff kills camp 100, wave 2 drops its 100 line and attacks 200', function () {
    var w = buffWorld();
    killingBuffs(w);
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt']);
    var steps = trace(w);
    assertHandedOver(w);
    assert.strictEqual(w.buffs.length, 1, 'one buff send');
    assert.strictEqual(w.buffs[0].name, 'Fire');
    assert.strictEqual(w.buffs[0].grid, 100);
    assert.strictEqual(attacksOf(w, '1.1').length, 0, 'the beaten camp is not attacked');
    var b = attacksOf(w, '1.2');
    assert.strictEqual(b.length, 1);
    assert.strictEqual(b[0].grid, 200);
    assert.ok(!hasStep(steps, 'Settle'), 'never waited in Settle: ' + steps.join(' '));
    var confirm = steps.indexOf('0:Confirm');
    var gate = steps.indexOf('1:Gate');
    assert.ok(confirm >= 0, 'wave 1 confirmed: ' + steps.join(' '));
    assert.ok(gate >= 0 && confirm < gate, 'Confirm of wave 1 before Gate of wave 2: ' + steps.join(' '));
    assert.strictEqual(w.st.run().waveIndex, 2, 'both waves counted');
});

t.test('buff-only wave: camp 100 falls only after wave 2\'s Gate, the line is dropped at Reach', function () {
    var w = buffWorld();
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt']);
    // Past Gate of wave 2: the camp still stands there, so the line is kept.
    var got = false;
    for (var i = 0; i < 60 && !got; i++) {
        var r = w.st.run();
        if (r.waveIndex === 1 && stepName(w) !== 'Gate') got = true;
        else {
            tick(w);
            play(w);
        }
    }
    assert.ok(got, 'reached wave 2 past Gate');
    assert.ok(w.camps[100], 'camp 100 still stands');
    var rec = w.st.run().lines['1.1'];
    assert.ok(!rec || !rec.seen, 'line 1.1 not dropped at Gate');
    delete w.camps[100];
    var steps = trace(w);
    assertHandedOver(w);
    assert.strictEqual(attacksOf(w, '1.1').length, 0, 'dropped at Reach');
    assert.strictEqual(attacksOf(w, '1.2').length, 1);
    assert.strictEqual(attacksOf(w, '1.2')[0].grid, 200);
    assert.strictEqual(w.st.run().pause, null, 'no pause');
    assert.ok(!hasStep(steps, 'Settle'), 'no Settle after the fall: ' + steps.join(' '));
});

t.test('buff-only wave: the path to 200 opens only after the kill reads, Settle clears without a pause', function () {
    var w = buffWorld();
    killingBuffs(w);
    w.sent.pathLen = 0;
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt']);
    assert.ok(until(w, 1, 'Settle'), 'reached Settle of wave 2, at ' + stepName(w));
    var settleAt = w.t;
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    W.ticksFor(w, 30000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'still waiting in Settle');
    assert.strictEqual(stepName(w), 'Settle');
    w.sent.pathLen = 1;
    trace(w);
    assertHandedOver(w);
    assert.strictEqual(attacksOf(w, '1.2').length, 1);
    assert.strictEqual(attacksOf(w, '1.2')[0].grid, 200);
    assert.strictEqual(w.st.run().pause, null);
    assert.ok(w.t - settleAt < quietMs(w), 'cleared in ' + (w.t - settleAt) + ' ms');
});

t.test('buff-only wave: a path that never opens pauses Unreachable at the quiet limit', function () {
    var w = buffWorld();
    killingBuffs(w);
    w.sent.pathLen = 0;
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt']);
    assert.ok(until(w, 1, 'Settle'), 'reached Settle of wave 2, at ' + stepName(w));
    W.ticksFor(w, quietMs(w) - 30000);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running, 'still waiting before the limit');
    W.ticksFor(w, 40000);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w.S.RunPause.Unreachable);
    assert.strictEqual(r.pause.target, 200);
    assert.ok(/no path/.test(r.pause.message), r.pause.message);
    assert.strictEqual(attacksOf(w).length, 0, 'no attack sent');
});

t.test('buff-only wave: a buff that leaves its camp standing still confirms, wave 2 attacks that camp', function () {
    var w = buffWorld();
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt']);
    var steps = trace(w);
    assertHandedOver(w);
    assert.strictEqual(w.buffs.length, 1);
    var a = attacksOf(w, '1.1');
    var b = attacksOf(w, '1.2');
    assert.strictEqual(a.length, 1, 'Anna attacked the standing camp');
    assert.strictEqual(a[0].grid, 100);
    assert.strictEqual(b.length, 1);
    assert.strictEqual(b[0].grid, 200);
    assert.ok(a[0].t < b[0].t, 'Anna before Bert');
    assert.ok(steps.indexOf('0:Confirm') >= 0, 'wave 1 confirmed on the buff alone: ' + steps.join(' '));
});

t.test('buff-only wave: a buff not seen is sent once, pauses NotObserved and sends nothing of wave 2', function () {
    var w = buffWorld();
    unseenBuffs(w);
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt']);
    trace(w, 80);
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused, 'status ' + r.status);
    assert.strictEqual(r.pause.reason, w.S.RunPause.NotObserved);
    assert.ok(/buff Fire on .*100.* sent but not seen/.test(r.pause.message), r.pause.message);
    assert.strictEqual(r.waveIndex, 0);
    assert.strictEqual(w.buffs.length, 1, 'the camp buff went out once, never twice (#63)');
    assert.strictEqual(attacksOf(w).length, 0, 'nothing of wave 2 sent');
    // The pause holds the line as sent: more passes send nothing.
    W.ticksFor(w, 120000);
    play(w);
    assert.strictEqual(w.buffs.length, 1, 'no send while paused');
});

t.test('buff-only wave: a buff not seen whose camp is gone counts as the kill, no pause, no resend', function () {
    var w = buffWorld();
    killingBuffs(w);
    unseenBuffs(w);
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt']);
    trace(w, 120);
    assertHandedOver(w);
    assert.strictEqual(w.buffs.length, 1, 'one buff send');
    assert.strictEqual(attacksOf(w, '1.1').length, 0, 'the beaten camp is not attacked');
    assert.strictEqual(attacksOf(w, '1.2').length, 1);
});

t.test('buff line: a def that allows a retry is still sent once (the executor forces retries 0)', function () {
    var w = buffWorld();
    var base = w.S.core.buffs.camp;
    w.S.core.buffs.camp = function (name, grid) {
        var def = base(name, grid);
        def.retries = 5;
        def.check = function () { return false; };
        return def;
    };
    startRun(w, ['C:/b/w1.txt', 'C:/b/w2.txt']);
    trace(w, 80);
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Paused);
    assert.strictEqual(w.buffs.length, 1);
});

// ---- one wave mixing Buff and Attack lines ------------------------------------

t.test('mixed wave from Gate: buff first, then attacks on other camps, order and gaps hold', function () {
    var w = buffWorld();
    killingBuffs(w);
    writeJson(w.fs, 'C:/b/m1.txt', {
        buff_fire: { type: 'buff', name: 'Fire', target: 300, order: 1 },
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 2, time: 3000, name: 'Anna' },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 3, time: 5000, name: 'Bert' }
    });
    startRun(w, ['C:/b/m1.txt']);
    var steps = trace(w);
    assertHandedOver(w);
    assert.strictEqual(w.buffs.length, 1);
    assert.strictEqual(w.buffs[0].grid, 300);
    var attacks = attacksOf(w);
    assert.deepStrictEqual(attacks.map(function (o) { return o.key; }), ['1.1', '1.2']);
    assert.deepStrictEqual(attacks.map(function (o) { return o.grid; }), [100, 200]);
    assert.ok(attacks[0].t >= w.buffs[0].t + 3000, 'Anna waits 3 s after the buff');
    assert.ok(attacks[1].t >= attacks[0].t + 5000, 'Bert waits 5 s after Anna');
    assert.ok(steps.indexOf('0:Confirm') >= 0, 'confirmed: ' + steps.join(' '));
    assert.ok(!hasStep(steps, 'Settle'), 'no Settle: ' + steps.join(' '));
});

t.test('mixed wave from Gate: buff between two attacks keeps its place and gap', function () {
    var w = buffWorld();
    writeJson(w.fs, 'C:/b/m1.txt', {
        '1.1': { grid: 10, target: 100, army: { Rifle: 5 }, order: 1, name: 'Anna' },
        buff_fire: { type: 'buff', name: 'Fire', target: 300, order: 2, time: 2000 },
        '1.2': { grid: 20, target: 200, army: { Rifle: 3 }, order: 3, time: 5000, name: 'Bert' }
    });
    startRun(w, ['C:/b/m1.txt']);
    trace(w);
    assertHandedOver(w);
    var a = attacksOf(w, '1.1');
    var b = attacksOf(w, '1.2');
    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 1);
    assert.strictEqual(w.buffs.length, 1);
    assert.strictEqual(w.buffs[0].grid, 300);
    assert.ok(a[0].t < w.buffs[0].t && w.buffs[0].t < b[0].t, 'send order Anna, buff, Bert');
    assert.ok(w.buffs[0].t >= a[0].t + 2000, 'buff waits 2 s after Anna');
    assert.ok(b[0].t >= w.buffs[0].t + 5000, 'Bert waits 5 s after the buff');
});
