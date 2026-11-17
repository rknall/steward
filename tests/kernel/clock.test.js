'use strict';

var t = require('../runner');
var harness = require('../harness');

var TEXTS = {
    category: 'test', label: 'test', missText: 'miss',
    pausedText: 'paused', resumeText: 'resumed'
};

function clocked() {
    var env = { T: 1000 };
    env.H = harness.boot({ now: function () { return env.T; } });
    env.S = env.H.Steward;
    return env;
}

t.test('kernel.now returns the wall clock on a plain boot', function () {
    var S = harness.boot().Steward;
    var before = Date.now();
    var v = S.kernel.now();
    var after = Date.now();
    t.assert.strictEqual(typeof v, 'number');
    t.assert.ok(v >= before && v <= after, 'now within the Date.now window');
});

t.test('opts.now moves every default clock, read at call time', function () {
    var e = clocked();
    var S = e.S;
    function all() {
        return [
            S.core.breaker.create(TEXTS).clock(),
            S.core.production.demand.clock(),
            S.core.specialists.sendGuard.clock(),
            S.modules.adventures.state.now(),
            S.modules.collect.now(),
            S.modules.updater.now(),
            S.modules.mining.builds.clock()
        ];
    }
    var i, v = all();
    for (i = 0; i < v.length; i++) t.assert.strictEqual(v[i], 1000, 'default ' + i);
    e.T = 5555;
    v = all();
    for (i = 0; i < v.length; i++) t.assert.strictEqual(v[i], 5555, 'moved ' + i);
});

t.test('a seam override wins over the kernel clock', function () {
    var e = clocked();
    var S = e.S;
    S.modules.collect.now = function () { return 7; };
    var opts = {};
    for (var k in TEXTS) opts[k] = TEXTS[k];
    opts.clock = function () { return 9; };
    t.assert.strictEqual(S.modules.collect.now(), 7);
    t.assert.strictEqual(S.core.breaker.create(opts).clock(), 9);
    t.assert.strictEqual(S.kernel.now(), 1000);
});

t.test('patching Date.now follows through on a plain boot', function () {
    var S = harness.boot().Steward;
    var b = S.core.breaker.create(TEXTS);
    var orig = Date.now;
    try {
        Date.now = function () { return 424242; };
        t.assert.strictEqual(S.kernel.now(), 424242);
        t.assert.strictEqual(b.clock(), 424242);
    } finally {
        Date.now = orig;
    }
});

t.test('reload reapplies the opt-in clock and live breakers follow it', function () {
    var e = clocked();
    var b = e.S.core.breaker.create(TEXTS);
    var H2 = harness.reload(e.H);
    t.assert.strictEqual(H2.Steward.kernel.now(), 1000);
    e.T = 2000;
    t.assert.strictEqual(b.clock(), 2000);
    H2.Steward.kernel.now = function () { return 3000; };
    t.assert.strictEqual(b.clock(), 3000);
});
