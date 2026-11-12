'use strict';

var fs   = require('fs');
var path = require('path');
var vm   = require('vm');

var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');

var QUEUE_FILE = 'src/kernel/60_queue.js';
var QUEUE_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', '..', QUEUE_FILE), 'utf8');

// The harness replaces queue.add with a capture, so each test boots its own
// harness and re-runs the queue source into that context to get the real
// queue. A fresh boot per test keeps the re-run queue from leaking.
function realQueue() {
    var H = harness.boot({ sections: ['kernel'] });
    var timers = [];
    H.ctx.setTimeout = function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; };
    // No visible host modal: the queue must never defer in these tests.
    var $ = function () { return { length: 0 }; };
    $.fn = { length: 0 };
    H.ctx.$ = $;
    vm.runInContext(QUEUE_SOURCE, H.ctx, { filename: QUEUE_FILE });
    var S = H.Steward;
    return {
        S: S,
        Q: S.kernel.queue,
        timers: timers,
        // Runs the next pending timer (the queue's paced runOne).
        step: function () {
            var next = timers.shift();
            if (next) next.fn();
            return !!next;
        }
    };
}

function noopAction() {}

t.test('add tags with the current module', function () {
    var R = realQueue();
    R.Q.action('noop', noopAction);
    R.S.kernel._currentModule = 'mining';
    R.Q.add('noop', [], 10);
    R.S.kernel._currentModule = null;
    t.assert.strictEqual(R.Q.depthByModule('mining'), 1);
    t.assert.strictEqual(R.Q.isModuleBusy('mining'), true);
});

t.test('add from inside a running tagged action inherits its tag', function () {
    var R = realQueue();
    var seenRunning = null;
    R.Q.action('child', noopAction);
    R.Q.action('parent', function () {
        seenRunning = R.Q.runningModule();
        R.Q.add('child', [], 10);
    });
    R.S.kernel._currentModule = 'adventures';
    R.Q.add('parent', [], 10);
    R.S.kernel._currentModule = null;
    R.Q.drain();
    t.assert.strictEqual(seenRunning, 'adventures');
    t.assert.strictEqual(R.Q.depth(), 1);
    t.assert.strictEqual(R.Q.depthByModule('adventures'), 1);
});

t.test('add outside any module is untagged', function () {
    var R = realQueue();
    R.Q.action('noop', noopAction);
    R.S.kernel._currentModule = null;
    R.Q.add('noop', [], 10);
    t.assert.strictEqual(R.Q.depth(), 1);
    t.assert.strictEqual(R.Q.isModuleBusy('mining'), false);
    t.assert.strictEqual(R.Q.cancelByModule('mining'), 0);
    t.assert.strictEqual(R.Q.depth(), 1);
});

t.test('isModuleBusy stays true while a running action re-enqueues itself', function () {
    var R = realQueue();
    var runs = 0;
    var busyDuringRun = [];
    R.Q.action('loop', function () {
        runs++;
        busyDuringRun.push(R.Q.isModuleBusy('adventures'));
        if (runs < 3) R.Q.add('loop', [], 50);
    });
    R.S.kernel._currentModule = 'adventures';
    R.Q.add('loop', [], 50);
    R.S.kernel._currentModule = null;

    R.Q.drain();
    t.assert.strictEqual(R.Q.isModuleBusy('adventures'), true);
    R.step();
    t.assert.strictEqual(R.Q.isModuleBusy('adventures'), true);
    R.step();
    t.assert.strictEqual(runs, 3);
    t.assert.deepStrictEqual(busyDuringRun, [true, true, true]);
    t.assert.strictEqual(R.Q.isModuleBusy('adventures'), false);
    t.assert.strictEqual(R.Q.depth(), 0);
});

t.test('cancelByModule drops inherited entries', function () {
    var R = realQueue();
    R.Q.action('other', noopAction);
    R.Q.action('loop', function () { R.Q.add('loop', [], 50); });
    R.S.kernel._currentModule = 'adventures';
    R.Q.add('loop', [], 50);
    R.S.kernel._currentModule = 'mining';
    R.Q.add('other', [], 50);
    R.S.kernel._currentModule = null;

    R.Q.drain();   // runs 'loop', which re-enqueues itself behind 'other'
    t.assert.strictEqual(R.Q.depthByModule('adventures'), 1);
    t.assert.strictEqual(R.Q.cancelByModule('adventures'), 1);
    t.assert.strictEqual(R.Q.depthByModule('adventures'), 0);
    t.assert.strictEqual(R.Q.depthByModule('mining'), 1);
    t.assert.strictEqual(R.Q.isModuleBusy('adventures'), false);
});

t.test('an entry added during a pending delay waits for that delay timer', function () {
    var R = realQueue();
    R.Q.action('first', noopAction);
    var ran = 0;
    R.Q.action('late', function () { ran++; });
    R.Q.add('first', [], 400);
    R.Q.drain();                       // runs 'first', arms its 400 ms delay
    t.assert.strictEqual(R.timers.length, 1);
    t.assert.strictEqual(R.timers[0].ms, 400);

    R.Q.add('late', [], 10);
    R.Q.drain();                       // the previous drain is still pacing
    t.assert.strictEqual(ran, 0);
    t.assert.strictEqual(R.Q.depth(), 1);

    R.step();                          // the delay timer fires
    t.assert.strictEqual(ran, 1);
    t.assert.strictEqual(R.Q.depth(), 0);
});

// ---------------------------------------------------------------------------
// Dialog guard: a real element tree (jq fake), recording timers and a fake
// clock, so a test can hold the queue behind a visible dialog and step time.
// ---------------------------------------------------------------------------

function dialogQueue() {
    var H = harness.boot({ sections: ['kernel'] });
    var timers = [];
    H.ctx.setTimeout = function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; };
    var $ = jq.install(H);
    var clock = { T: 0 };
    function D(v) { return arguments.length ? new Date(v) : new Date(clock.T); }
    D.now = function () { return clock.T; };
    H.ctx.Date = D;
    vm.runInContext(QUEUE_SOURCE, H.ctx, { filename: QUEUE_FILE });
    var S = H.Steward;
    H.clearLogs();
    return {
        H: H,
        S: S,
        Q: S.kernel.queue,
        timers: timers,
        clock: clock,
        // Appends a role="dialog" div to the body; null id leaves it without one.
        dialog: function (id) {
            var attrs = { role: 'dialog' };
            if (id !== null) attrs.id = id;
            var $d = $('<div>', attrs);
            $('body').append($d);
            return $d[0];
        },
        // Runs the oldest pending timer.
        fire: function () {
            var next = timers.shift();
            if (next) next.fn();
            return !!next;
        },
        lines: function (level) {
            return H.logs().filter(function (l) {
                return l.category === 'queue' && l.level === level;
            }).map(function (l) { return l.args.join(' '); });
        }
    };
}

// Values built inside the vm context carry its prototypes; compare plain copies.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function startsWith(prefix) {
    return function (s) { return s.indexOf(prefix) === 0; };
}

var STALE_TEXT = '; if no steward window is on screen the game may be covering it: restart the client';

t.test('visibleDialogs lists visible ids in order and dialogList formats them', function () {
    var R = dialogQueue();
    t.assert.deepStrictEqual(plain(R.Q.visibleDialogs()), []);
    R.dialog('X');
    var hidden = R.dialog('H');
    hidden.visible = false;
    R.dialog(null);
    R.dialog('Y');
    t.assert.deepStrictEqual(plain(R.Q.visibleDialogs()), ['X', '', 'Y']);
    t.assert.strictEqual(R.Q.dialogList([]), 'none');
    t.assert.strictEqual(R.Q.dialogList(['X', 'Y']), '#X, #Y');
    t.assert.strictEqual(R.Q.dialogList(['']), '(no id)');
});

t.test('a deferral logs one start line and nothing per poll', function () {
    var R = dialogQueue();
    var ran = 0;
    R.Q.action('a', function () { ran++; });
    R.dialog('X');
    R.Q.add('a', [], 10);
    R.Q.drain();
    t.assert.deepStrictEqual(R.lines('log'), ['deferring 1 action(s): dialog visible: #X']);
    t.assert.strictEqual(R.timers.length, 1);
    t.assert.strictEqual(R.timers[0].ms, R.S.kernel.TIMEOUTS.QUEUE_MODAL_RECHECK_MS);
    for (var i = 0; i < 10; i++) {
        R.clock.T += 2000;
        R.fire();
    }
    t.assert.strictEqual(R.lines('log').length, 1);
    t.assert.strictEqual(ran, 0);
    t.assert.strictEqual(R.Q.depth(), 1);
    t.assert.strictEqual(R.Q.isDraining(), true);
});

t.test('a long deferral repeats at most once per LOG_REPEAT_MS', function () {
    var R = dialogQueue();
    var REPEAT = R.S.kernel.TIMEOUTS.LOG_REPEAT_MS;
    R.Q.action('a', noopAction);
    R.dialog('X');
    R.Q.add('a', [], 10);
    R.Q.drain();
    R.clock.T = REPEAT - 1;
    R.fire();
    t.assert.strictEqual(R.lines('log').filter(startsWith('still')).length, 0);
    R.clock.T = REPEAT;
    R.fire();
    R.clock.T = REPEAT + 2000;
    R.fire();
    R.clock.T = 2 * REPEAT - 1;
    R.fire();
    t.assert.deepStrictEqual(R.lines('log').filter(startsWith('still')),
        ['still deferring 1 action(s) after 300 s: dialog visible: #X']);
});

t.test('a stale deferral warns once with the dialog ids', function () {
    var R = dialogQueue();
    var STALE = R.S.kernel.TIMEOUTS.QUEUE_MODAL_STALE_MS;
    R.Q.action('a', noopAction);
    R.dialog('X');
    R.Q.add('a', [], 10);
    R.Q.drain();
    R.clock.T = STALE - 1;
    R.fire();
    t.assert.strictEqual(R.lines('warn').length, 0);
    R.clock.T = STALE;
    R.fire();
    R.clock.T = 2 * STALE;
    R.fire();
    t.assert.deepStrictEqual(R.lines('warn'), ['held 10 min by dialog #X' + STALE_TEXT]);
});

t.test('closing the dialog logs resumed and runs the action', function () {
    var R = dialogQueue();
    var logsAtRun = null;
    R.Q.action('a', function () { logsAtRun = R.lines('log'); });
    var x = R.dialog('X');
    R.Q.add('a', [], 10);
    R.Q.drain();
    R.clock.T = 7400;
    x.visible = false;
    R.fire();
    t.assert.deepStrictEqual(logsAtRun,
        ['deferring 1 action(s): dialog visible: #X', 'resumed after 7 s']);
    t.assert.strictEqual(R.Q.deferral(), null);
    t.assert.strictEqual(R.Q.depth(), 0);
});

t.test('deferral() reports the hold as a fresh copy', function () {
    var R = dialogQueue();
    R.Q.action('a', noopAction);
    t.assert.strictEqual(R.Q.deferral(), null);
    R.dialog('X');
    R.Q.add('a', [], 10);
    R.Q.drain();
    R.clock.T = 5000;
    R.fire();
    var d = R.Q.deferral();
    t.assert.deepStrictEqual(plain(d), { since: 0, ms: 5000, ids: ['X'], depth: 1 });
    d.ids.push('Z');
    t.assert.deepStrictEqual(plain(R.Q.deferral().ids), ['X']);
});

t.test('a queue emptied while deferred ends the deferral and stops draining', function () {
    var R = dialogQueue();
    R.Q.action('a', noopAction);
    R.dialog('X');
    R.S.kernel._currentModule = 'mining';
    R.Q.add('a', [], 10);
    R.S.kernel._currentModule = null;
    R.Q.drain();
    R.clock.T = 4000;
    R.Q.cancelByModule('mining');
    R.fire();
    t.assert.strictEqual(R.lines('log').filter(startsWith('deferral ended'))[0],
        'deferral ended after 4 s: queue empty');
    t.assert.strictEqual(R.Q.isDraining(), false);
    t.assert.strictEqual(R.timers.length, 0);
    t.assert.strictEqual(R.Q.deferral(), null);
});

t.test('reset while deferred logs the drop and retires the old poll timer', function () {
    var R = dialogQueue();
    var ran = 0;
    R.Q.action('a', function () { ran++; });
    var x = R.dialog('X');
    R.Q.add('a', [], 10);
    R.Q.add('a', [], 10);
    R.Q.drain();
    R.clock.T = 3000;
    R.Q.reset();
    t.assert.strictEqual(R.lines('log').filter(startsWith('reset'))[0],
        'reset while deferring after 3 s, 2 action(s) dropped');
    t.assert.strictEqual(R.Q.deferral(), null);

    x.visible = false;
    R.Q.add('a', [], 10);
    R.Q.add('a', [], 10);
    R.Q.drain();                       // runs one, arms the next poll
    t.assert.strictEqual(ran, 1);
    t.assert.strictEqual(R.timers.length, 2);
    R.timers[0].fn();                  // the poll armed before reset()
    t.assert.strictEqual(ran, 1);
    t.assert.strictEqual(R.Q.depth(), 1);
    R.timers[1].fn();                  // the current chain still runs
    t.assert.strictEqual(ran, 2);
});

t.test('an action that throws still schedules the next poll', function () {
    var R = dialogQueue();
    var ran = 0;
    R.Q.action('boom', function () { throw new Error('boom'); });
    R.Q.action('a', function () { ran++; });
    R.Q.add('boom', [], 10);
    R.Q.add('a', [], 10);
    R.Q.drain();
    t.assert.strictEqual(R.lines('error').length, 1);
    t.assert.strictEqual(R.timers.length, 1);
    R.fire();
    t.assert.strictEqual(ran, 1);
});

t.test('a throwing dialog probe counts as no dialog', function () {
    var R = dialogQueue();
    var ran = 0;
    R.Q.action('a', function () { ran++; });
    R.H.ctx.$ = function () { throw new Error('no jquery'); };
    R.Q.add('a', [], 10);
    R.Q.drain();
    t.assert.strictEqual(ran, 1);
    t.assert.strictEqual(R.lines('log').length, 0);
});

t.test('a throw inside the step is logged rate-limited and the queue keeps polling', function () {
    var R = dialogQueue();
    var GAP = R.S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS;
    R.Q.action('a', noopAction);
    R.dialog('X');
    Object.defineProperty(R.S.kernel.TIMEOUTS, 'QUEUE_MODAL_RECHECK_MS', {
        get: function () { throw new Error('bad timeout'); },
        configurable: true
    });
    R.Q.add('a', [], 10);
    R.Q.drain();
    t.assert.deepStrictEqual(R.lines('error'), ['runOne threw: Error: bad timeout']);
    t.assert.strictEqual(R.timers.length, 1);
    t.assert.strictEqual(R.timers[0].ms, GAP);
    t.assert.strictEqual(R.Q.isDraining(), true);

    R.clock.T = 1000;
    R.fire();                          // a second throw inside LOG_REPEAT_MS
    t.assert.strictEqual(R.lines('error').length, 1);
    t.assert.strictEqual(R.timers.length, 1);
    t.assert.strictEqual(R.Q.isDraining(), true);

    R.clock.T = R.S.kernel.TIMEOUTS.LOG_REPEAT_MS;
    R.fire();
    t.assert.strictEqual(R.lines('error')[1],
        'runOne threw (1 more since the last line): Error: bad timeout');
});
