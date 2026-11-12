'use strict';

var t = require('../runner');
var harness = require('../harness');

// A booted harness with the engine's call-time cores replaced: buildings are
// plain objects { grid, block }, buffs.building returns a marker def and
// actions.attempt records the call so the test finishes it by hand.
function setup() {
    var H = harness.boot();
    var S = H.Steward;
    var env = { H: H, S: S, T: 1000000, attempts: [], startOk: true };
    S.core.buildings.grid = function (b) { return b.grid; };
    S.core.buildings.buffBlock = function (b) { return b.block || null; };
    S.core.buffs.building = function (name, grid, bName, workyard) {
        return { buff: name, grid: grid, bName: bName, workyard: workyard };
    };
    S.core.actions.attempt = function (def, onDone) {
        if (!env.startOk) return false;
        env.attempts.push({ def: def, onDone: onDone });
        return true;
    };
    env.e = S.core.buffing.create({
        category:   'testcat',
        label:      'test buff breaker',
        missText:   'applies were not seen',
        pausedText: 'test buffing is paused',
        resumeText: 'test buffing resumes'
    });
    env.e.breaker.clock = function () { return env.T; };
    H.clearLogs();
    return env;
}

function R(env) { return env.S.ActionResult; }

function lines(env, level) {
    return env.H.logs().filter(function (l) {
        return l.level === level && l.category === 'testcat';
    });
}

// Applies on grid and finishes the attempt with result r.
function applyAndFinish(env, grid, r, onResult) {
    t.assert.strictEqual(env.e.apply(grid, 'Bakery', 'Fish', false, onResult), true);
    env.attempts[env.attempts.length - 1].onDone(r);
}

function unseen(env) {
    return { status: R(env).Failed, unseen: true, sends: 1, reason: 'not seen' };
}

t.test('defaults: hold 30 min, live holds map, breaker instance', function () {
    var env = setup();
    t.assert.strictEqual(env.S.core.buffing.HOLD_MS, 1800000);
    t.assert.strictEqual(env.e.HOLD_MS, 1800000);
    t.assert.strictEqual(env.e.holds(), env.e.holds());
    t.assert.strictEqual(typeof env.e.breaker.admit, 'function');
    var custom = env.S.core.buffing.create({ category: 'c', holdMs: 60000 });
    t.assert.strictEqual(custom.HOLD_MS, 60000);
});

t.test('eligible checks grid, assigned, hold and block before the breaker', function () {
    var env = setup();
    var e = env.e;
    var admits = 0;
    var realAdmit = e.breaker.admit;
    e.breaker.admit = function (n) { admits++; return realAdmit(n); };
    t.assert.strictEqual(e.eligible({ grid: null }, {}), env.S.BuffVerdict.Skip);
    t.assert.strictEqual(e.eligible({}, {}), env.S.BuffVerdict.Skip);
    t.assert.strictEqual(e.eligible({ grid: 5 }, { 5: true }), env.S.BuffVerdict.Skip);
    e.holds()[6] = env.T + 1;
    t.assert.strictEqual(e.eligible({ grid: 6 }, {}), env.S.BuffVerdict.Skip);
    t.assert.strictEqual(e.eligible({ grid: 7, block: 'buffed' }, {}), env.S.BuffVerdict.Skip);
    t.assert.strictEqual(admits, 0, 'no skip spends the breaker');
    e.holds()[8] = env.T;                                   // expired hold
    t.assert.strictEqual(e.eligible({ grid: 8 }, {}), env.S.BuffVerdict.Ok);
    t.assert.strictEqual(e.eligible({ grid: 9 }), env.S.BuffVerdict.Ok);
    t.assert.strictEqual(admits, 2);
});

t.test('verified apply clears the hold, closes the breaker and logs buffed', function () {
    var env = setup();
    env.e.holds()[4] = env.T - 1;
    applyAndFinish(env, 4, { status: R(env).Verified, sends: 1 });
    var a = env.attempts[0].def;
    t.assert.deepStrictEqual(JSON.parse(JSON.stringify(a)),
        { buff: 'Fish', grid: 4, bName: 'Bakery', workyard: false });
    t.assert.strictEqual(Object.prototype.hasOwnProperty.call(env.e.holds(), 4), false);
    var l = lines(env, 'log');
    t.assert.strictEqual(l.length, 1);
    t.assert.deepStrictEqual(l[0].args.slice(0, 6),
        ['buffed', 'Bakery', 'on grid', 4, 'with', 'Fish']);
});

t.test('an unseen apply holds the grid, counts a miss and warns', function () {
    var env = setup();
    applyAndFinish(env, 3, unseen(env));
    t.assert.strictEqual(env.e.holds()[3], env.T + 1800000);
    t.assert.strictEqual(env.e.breaker.snapshot().run, 1);
    var w = lines(env, 'warn');
    t.assert.strictEqual(w.length, 1);
    t.assert.ok(w[0].args.join(' ').indexOf('was not seen to apply') >= 0);
    t.assert.strictEqual(env.e.eligible({ grid: 3 }, {}), env.S.BuffVerdict.Skip);
    env.T += 1800000;
    t.assert.strictEqual(env.e.eligible({ grid: 3 }, {}), env.S.BuffVerdict.Ok);
});

t.test('a failed send holds without a miss; refused only logs debug', function () {
    var env = setup();
    applyAndFinish(env, 2, { status: R(env).Failed, sends: 0, reason: 'threw' });
    t.assert.strictEqual(env.e.holds()[2], env.T + 1800000);
    t.assert.strictEqual(env.e.breaker.snapshot().run, 0);
    t.assert.strictEqual(lines(env, 'warn').length, 1);
    applyAndFinish(env, 1, { status: R(env).Refused, sends: 0, reason: 'blocked' });
    t.assert.strictEqual(Object.prototype.hasOwnProperty.call(env.e.holds(), 1), false);
    t.assert.strictEqual(lines(env, 'debug').length, 1);
});

t.test('5 unseen applies open the breaker, stop while open, one probe after cooldown', function () {
    var env = setup();
    for (var g = 10; g < 15; g++) applyAndFinish(env, g, unseen(env));
    t.assert.strictEqual(env.e.breaker.isOpen(), true);
    t.assert.strictEqual(env.e.eligible({ grid: 20 }, {}), env.S.BuffVerdict.Stop);
    t.assert.strictEqual(env.e.eligible({ grid: 10 }, {}), env.S.BuffVerdict.Skip, 'held grid still skips');
    env.T += env.e.breaker.COOLDOWN_MS;
    t.assert.strictEqual(env.e.eligible({ grid: 20 }, {}), env.S.BuffVerdict.Ok, 'probe');
    t.assert.strictEqual(env.e.eligible({ grid: 21 }, {}), env.S.BuffVerdict.Stop);
    applyAndFinish(env, 20, { status: R(env).Verified, sends: 1 });
    t.assert.strictEqual(env.e.breaker.isOpen(), false);
    t.assert.strictEqual(env.e.eligible({ grid: 21 }, {}), env.S.BuffVerdict.Ok);
});

t.test('onResult is called with the result after the engine judged it', function () {
    var env = setup();
    var seen = [];
    applyAndFinish(env, 3, unseen(env), function (r) {
        seen.push({ status: r.status, held: env.e.holds()[3] > 0 });
    });
    t.assert.deepStrictEqual(seen, [{ status: R(env).Failed, held: true }]);
    applyAndFinish(env, 4, { status: R(env).Verified, sends: 1 });  // without onResult
});

t.test('apply returns false and logs an error when attempt does not start', function () {
    var env = setup();
    env.startOk = false;
    t.assert.strictEqual(env.e.apply(3, 'Bakery', 'Fish', false), false);
    t.assert.strictEqual(lines(env, 'error').length, 1);
});
