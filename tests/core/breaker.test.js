'use strict';

var t = require('../runner');
var harness = require('../harness');

var TEXTS = {
    category:   'testcat',
    label:      'test breaker',
    missText:   'actions in a row were not seen',
    pausedText: 'testing is paused',
    resumeText: 'testing resumes'
};

// A booted harness plus a breaker on a test clock. T is read at call time, so
// a test moves time by assigning env.T.
function setup(extra) {
    var H = harness.boot();
    var env = { H: H, T: 1000000 };
    var opts = {};
    var k;
    for (k in TEXTS) opts[k] = TEXTS[k];
    for (k in (extra || {})) opts[k] = extra[k];
    if (!opts.clock) opts.clock = function () { return env.T; };
    env.b = H.Steward.core.breaker.create(opts);
    H.clearLogs();
    return env;
}

function lines(env, level, category) {
    return env.H.logs().filter(function (l) {
        return l.level === level && l.category === category;
    });
}

function missN(b, n) {
    for (var i = 0; i < n; i++) b.miss();
}

t.test('defaults are exported and copied on the instance', function () {
    var env = setup();
    var B = env.H.Steward.core.breaker;
    t.assert.strictEqual(B.MISSES, 5);
    t.assert.strictEqual(B.COOLDOWN_MS, 300000);
    t.assert.strictEqual(env.b.MISSES, 5);
    t.assert.strictEqual(env.b.COOLDOWN_MS, 300000);
    var custom = setup({ misses: 3, cooldownMs: 120000 }).b;
    t.assert.strictEqual(custom.MISSES, 3);
    t.assert.strictEqual(custom.COOLDOWN_MS, 120000);
});

t.test('opens at misses with exactly one warn naming label, missText and pausedText', function () {
    var env = setup({ misses: 3, cooldownMs: 120000 });
    var b = env.b;
    t.assert.strictEqual(b.miss(), false);
    t.assert.strictEqual(b.miss(), false);
    t.assert.strictEqual(lines(env, 'warn', 'testcat').length, 0);
    t.assert.strictEqual(b.miss(), true);
    t.assert.strictEqual(b.isOpen(), true);
    var w = lines(env, 'warn', 'testcat');
    t.assert.strictEqual(w.length, 1);
    var text = String(w[0].args[0]);
    t.assert.ok(text.indexOf('test breaker open: 3 ') === 0, text);
    t.assert.ok(text.indexOf(TEXTS.missText) >= 0, text);
    t.assert.ok(text.indexOf(TEXTS.pausedText) >= 0, text);
    t.assert.ok(/one probe every 2 min/.test(text), text);
    t.assert.deepStrictEqual(JSON.parse(JSON.stringify(b.snapshot())),
        { open: true, run: 3, nextProbeAt: env.T + 120000 });
});

t.test('further misses while open add no second warn', function () {
    var env = setup();
    missN(env.b, 5);
    missN(env.b, 4);
    t.assert.strictEqual(lines(env, 'warn', 'testcat').length, 1);
    t.assert.strictEqual(env.b.snapshot().run, 9);
});

t.test('admit gives n when closed and one probe per cooldown when open', function () {
    var env = setup();
    var b = env.b;
    t.assert.strictEqual(b.admit(3), 3);
    t.assert.strictEqual(b.admit(0), 0);
    missN(b, 5);
    t.assert.strictEqual(b.admit(2), 0, 'no probe before the cooldown');
    env.T += b.COOLDOWN_MS;
    t.assert.strictEqual(b.admit(2), 1, 'one probe once the cooldown passed');
    t.assert.strictEqual(b.admit(2), 0, 'second caller gets nothing');
    t.assert.strictEqual(lines(env, 'debug', 'testcat').length, 1);
    env.T += b.COOLDOWN_MS - 1;
    t.assert.strictEqual(b.admit(1), 0);
    env.T += 1;
    t.assert.strictEqual(b.admit(1), 1);
});

t.test('verify closes with one log and resets run', function () {
    var env = setup();
    var b = env.b;
    missN(b, 2);
    b.verify('thing A');
    t.assert.strictEqual(b.snapshot().run, 0);
    t.assert.strictEqual(lines(env, 'log', 'testcat').length, 0, 'closed breaker logs nothing');
    missN(b, 5);
    b.verify('thing B');
    b.verify('thing C');
    t.assert.strictEqual(b.isOpen(), false);
    t.assert.strictEqual(b.snapshot().run, 0);
    var l = lines(env, 'log', 'testcat');
    t.assert.strictEqual(l.length, 1);
    t.assert.strictEqual(String(l[0].args[0]),
        'test breaker closed: thing B verified, testing resumes');
    t.assert.strictEqual(b.admit(4), 4);
});

t.test('two instances are independent', function () {
    var env = setup();
    var other = env.H.Steward.core.breaker.create({
        category: 'othercat', label: 'other', missText: 'm', pausedText: 'p', resumeText: 'r',
        clock: function () { return env.T; }
    });
    missN(env.b, 5);
    t.assert.strictEqual(env.b.isOpen(), true);
    t.assert.strictEqual(other.isOpen(), false);
    t.assert.strictEqual(other.snapshot().run, 0);
    t.assert.strictEqual(other.admit(2), 2);
    t.assert.strictEqual(lines(env, 'warn', 'othercat').length, 0);
    missN(other, 5);
    env.b.verify('x');
    t.assert.strictEqual(env.b.isOpen(), false);
    t.assert.strictEqual(other.isOpen(), true);
});

t.test('a custom clock is honoured, also when replaced after create', function () {
    var env = setup();
    var b = env.b;
    missN(b, 5);
    t.assert.strictEqual(b.snapshot().nextProbeAt, 1000000 + b.COOLDOWN_MS);
    var late = 5000000;
    b.clock = function () { return late; };
    t.assert.strictEqual(b.admit(1), 1);
    t.assert.strictEqual(b.snapshot().nextProbeAt, late + b.COOLDOWN_MS);
});

t.test('without a clock option the instance reads Date.now', function () {
    var env = setup();
    var b = env.H.Steward.core.breaker.create(TEXTS);
    var before = Date.now();
    missN(b, 5);
    var at = b.snapshot().nextProbeAt - b.COOLDOWN_MS;
    t.assert.ok(at >= before && at <= Date.now(), String(at));
});
