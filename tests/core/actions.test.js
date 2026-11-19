'use strict';

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

function boot() {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    return { H: H, S: H.Steward, A: H.Steward.core.actions };
}

// Runs the captured 'core.attempt' entries until none are queued. onStep(n)
// runs after the n-th round so a test can change state between polls.
function drive(b, onStep, maxRounds) {
    var rounds = 0;
    var delays = [];
    for (var n = 0; n < (maxRounds || 50); n++) {
        var entries = b.H.queued().filter(function (e) { return e.name === b.A.STEP; });
        if (entries.length === 0) break;
        b.H.clearQueued();
        for (var i = 0; i < entries.length; i++) {
            delays.push(entries[i].delay);
            b.A.step(entries[i].params);
        }
        rounds++;
        if (onStep) onStep(rounds);
    }
    return { rounds: rounds, delays: delays };
}

function gap(b) { return b.S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS; }

// A def whose effect appears when world.done is set; send counts calls.
function def(world, extra) {
    var d = {
        label:     'test action',
        category:  'testcat',
        send:      function () { world.sends++; return true; },
        check:     function () { return world.done === true; },
        timeoutMs: 1
    };
    var keys = Object.keys(extra || {});
    for (var i = 0; i < keys.length; i++) d[keys[i]] = extra[keys[i]];
    return d;
}

function run(b, d, onStep, maxRounds) {
    var results = [];
    var ok = b.A.attempt(d, function (r) { results.push(r); });
    var drove = drive(b, onStep, maxRounds);
    return { ok: ok, results: results, drove: drove };
}

function logsAt(b, level, category) {
    return b.H.logs().filter(function (l) { return l.level === level && l.category === category; });
}

t.test('verified on the first check after one send', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var d = def(world, { send: function () { world.sends++; world.done = true; return true; } });
    var r = run(b, d);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(r.results[0].reason, '');
    assert.strictEqual(r.results[0].label, 'test action');
    assert.strictEqual(world.sends, 1);
    assert.strictEqual(logsAt(b, 'log', 'testcat').length, 1);
});

t.test('satisfied before the first send verifies with zero sends', function () {
    var b = boot();
    var world = { sends: 0 };
    var r = run(b, def(world, { satisfied: function () { return true; } }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.results[0].sends, 0);
    assert.strictEqual(world.sends, 0);
});

t.test('precheck reason refuses without sending', function () {
    var b = boot();
    var world = { sends: 0 };
    var r = run(b, def(world, { precheck: function () { return 'general busy'; } }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Refused);
    assert.strictEqual(r.results[0].reason, 'general busy');
    assert.strictEqual(r.results[0].sends, 0);
    assert.strictEqual(world.sends, 0);
    assert.strictEqual(logsAt(b, 'warn', 'testcat').length, 1);
});

t.test('timeout then retry then verified', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    // Window of three polls; the effect appears only after the second send.
    var d = def(world, {
        timeoutMs: 3 * gap(b),
        send: function () { world.sends++; if (world.sends === 2) world.done = true; return true; }
    });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.results[0].sends, 2);
    assert.strictEqual(world.sends, 2);
    var retried = logsAt(b, 'warn', 'testcat').filter(function (l) {
        return String(l.args[0]).indexOf('not observed, retrying') !== -1;
    });
    assert.strictEqual(retried.length, 1);
});

t.test('two timeouts fail after exactly two sends', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var d = def(world, { timeoutMs: 2 * gap(b) });
    var r = run(b, d);
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].sends, 2);
    assert.strictEqual(r.results[0].reason, 'not observed within ' + (2 * gap(b)) + ' ms');
    assert.strictEqual(world.sends, 2);
    // send, 2 checks, send, 2 checks.
    assert.strictEqual(r.drove.rounds, 6);
});

t.test('retry checks the effect first and does not resend when it arrived late', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var d = def(world, { timeoutMs: gap(b) });
    // Round 1 sends, round 2 checks and times out; the effect lands before
    // the retry step runs.
    var r = run(b, d, function (n) { if (n === 2) world.done = true; });
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(world.sends, 1);
});

t.test('a precheck failing on retry fails with retry refused', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var d = def(world, {
        timeoutMs: gap(b),
        precheck:  function () { return world.sends > 0 ? 'target gone' : null; }
    });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].reason, 'retry refused: target gone');
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(world.sends, 1);
});

t.test('send returning false retries once then fails', function () {
    var b = boot();
    var world = { sends: 0, checks: 0 };
    var d = def(world, {
        send:  function () { world.sends++; return false; },
        check: function () { world.checks++; return false; }
    });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].reason, 'send failed');
    assert.strictEqual(r.results[0].sends, 2);
    assert.strictEqual(world.sends, 2);
    // Only the retry looks for a late effect; no check phase ran.
    assert.strictEqual(world.checks, 1);
});

t.test('a throwing send counts as not sent', function () {
    var b = boot();
    var world = { sends: 0 };
    var d = def(world, { send: function () { world.sends++; throw new Error('boom'); } });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].reason, 'send failed');
    assert.strictEqual(world.sends, 2);
});

t.test('baseline is read once and passed to send and check', function () {
    var b = boot();
    var world = { sends: 0, baselines: 0, seen: [] };
    var base = { stock: 5 };
    var d = def(world, {
        timeoutMs: gap(b),
        baseline:  function () { world.baselines++; return base; },
        send:      function (x) { world.sends++; world.seen.push(x); return true; },
        check:     function (x) { world.seen.push(x); return world.sends === 2; },
        describe:  function (x) { world.seen.push(x); return 'stock ' + x.stock; }
    });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(world.baselines, 1);
    assert.ok(world.seen.length >= 4);
    for (var i = 0; i < world.seen.length; i++) assert.strictEqual(world.seen[i], base);
    var line = logsAt(b, 'log', 'testcat')[0];
    assert.ok(String(line.args[0]).indexOf('stock 5') !== -1);
});

t.test('throwing check counts as not observed', function () {
    var b = boot();
    var world = { sends: 0 };
    var d = def(world, { check: function () { throw new Error('read failed'); } });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].sends, 2);
    assert.ok(logsAt(b, 'warn', 'testcat').some(function (l) {
        return String(l.args[0]).indexOf('check threw') !== -1;
    }));
});

t.test('throwing satisfied counts as not satisfied and sends', function () {
    var b = boot();
    var world = { sends: 0 };
    var d = def(world, {
        satisfied: function () { throw new Error('nope'); },
        send:      function () { world.sends++; world.done = true; return true; }
    });
    var r = run(b, d);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(world.sends, 1);
});

t.test('throwing precheck refuses with precheck threw', function () {
    var b = boot();
    var world = { sends: 0 };
    var r = run(b, def(world, { precheck: function () { throw new Error('x'); } }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Refused);
    assert.strictEqual(r.results[0].reason, 'precheck threw');
    assert.strictEqual(world.sends, 0);
});

t.test('throwing onDone is logged', function () {
    var b = boot();
    var world = { sends: 0, done: true };
    var ok = b.A.attempt(def(world, { satisfied: function () { return true; } }), function () {
        throw new Error('caller bug');
    });
    assert.strictEqual(ok, true);
    drive(b);
    var errors = logsAt(b, 'error', 'testcat');
    assert.strictEqual(errors.length, 1);
    assert.ok(String(errors[0].args[0]).indexOf('onDone threw') !== -1);
});

t.test('every step entry carries the poll gap', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var r = run(b, def(world, { timeoutMs: 2 * gap(b) }));
    assert.strictEqual(r.drove.delays.length, 6);
    for (var i = 0; i < r.drove.delays.length; i++) assert.strictEqual(r.drove.delays[i], gap(b));
});

t.test('invalid def is rejected and nothing is queued', function () {
    var b = boot();
    var world = { sends: 0 };
    var bad = [
        null,
        'move',
        def(world, { send: null }),
        def(world, { check: 'yes' }),
        def(world, { timeoutMs: 0 }),
        def(world, { timeoutMs: '1000' })
    ];
    for (var i = 0; i < bad.length; i++) {
        assert.strictEqual(b.A.attempt(bad[i], function () {}), false);
    }
    assert.strictEqual(b.H.queued().length, 0);
    assert.strictEqual(b.H.logs().filter(function (l) { return l.level === 'error'; }).length, bad.length);
});

t.test('result enum and exports are filled', function () {
    var b = boot();
    assert.strictEqual(b.S.ActionResult.Verified, 'ActionVerified');
    assert.strictEqual(b.S.ActionResult.Refused, 'ActionRefused');
    assert.strictEqual(b.S.ActionResult.Failed, 'ActionFailed');
    assert.strictEqual(b.A.RETRIES, 1);
    assert.strictEqual(b.A.STEP, 'core.attempt');
});

t.test('the step handler is registered with the kernel queue', function () {
    var b = boot();
    // Registering the name again warns only when a handler already exists.
    b.S.kernel.queue.action(b.A.STEP, function () {});
    var replaced = b.H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === 'queue' &&
            l.args.join(' ').indexOf('replacing previous handler') !== -1;
    });
    assert.strictEqual(replaced.length, 1);
});

// ---- retries: 0 (an order that must not go out twice) -----------------------

t.test('retries 0 sends once and ends not observed with unseen', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var r = run(b, def(world, { timeoutMs: 2 * gap(b), retries: 0 }));
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(r.results[0].unseen, true);
    assert.strictEqual(r.results[0].reason, 'not observed within ' + (2 * gap(b)) + ' ms');
    assert.strictEqual(world.sends, 1);
});

t.test('the default retry also ends unseen when never observed', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var r = run(b, def(world, { timeoutMs: gap(b) }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].unseen, true);
    assert.strictEqual(world.sends, 2);
});

t.test('a verified result carries no unseen', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var r = run(b, def(world, {
        retries: 0,
        send: function () { world.sends++; world.done = true; return true; }
    }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(r.results[0], 'unseen'), false);
});

t.test('a refused or send-failed result carries no unseen', function () {
    var b = boot();
    var world = { sends: 0 };
    var refused = run(b, def(world, { retries: 0, precheck: function () { return 'busy'; } }));
    assert.strictEqual(refused.results[0].status, b.S.ActionResult.Refused);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(refused.results[0], 'unseen'), false);
    var failed = run(b, def(world, { retries: 0, send: function () { world.sends++; return false; } }));
    assert.strictEqual(failed.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(failed.results[0], 'unseen'), false);
});

t.test('retries 0: a failed send ends Failed without a retry', function () {
    var b = boot();
    var world = { sends: 0 };
    var r = run(b, def(world, { retries: 0, send: function () { world.sends++; return false; } }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].reason, 'send failed');
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(world.sends, 1);
});

// ---- NOT_SENT: a send that made no host call --------------------------------

t.test('a first send returning NOT_SENT refuses without a retry or a check', function () {
    var b = boot();
    var world = { sends: 0, checks: 0 };
    var r = run(b, def(world, {
        retries: 1,
        send:  function () { world.sends++; return b.A.NOT_SENT; },
        check: function () { world.checks++; return false; }
    }));
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Refused);
    assert.strictEqual(r.results[0].reason, 'nothing sent');
    assert.strictEqual(r.results[0].sends, 0);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(r.results[0], 'unseen'), false);
    assert.strictEqual(world.sends, 1);
    assert.strictEqual(world.checks, 0);
    assert.strictEqual(r.drove.rounds, 1);
});

t.test('a retry send returning NOT_SENT fails with retry refused', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var r = run(b, def(world, {
        timeoutMs: gap(b),
        send: function () { world.sends++; return world.sends === 1 ? true : b.A.NOT_SENT; }
    }));
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].reason, 'retry refused: nothing sent');
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(world.sends, 2);
});

t.test('NOT_SENT is exported as the nothing-sent reason', function () {
    var b = boot();
    assert.strictEqual(b.A.NOT_SENT, 'nothing sent');
});

// ---- checkAfterMs: a quiet time before the first check ----------------------

t.test('checkAfterMs keeps check uncalled until the quiet time has passed, then verifies', function () {
    var b = boot();
    var world = { sends: 0, checks: 0 };
    var r = run(b, def(world, {
        retries: 0,
        timeoutMs: 6 * gap(b),
        checkAfterMs: 3 * gap(b),
        // The effect is there from the send on: only the quiet time holds the check back.
        send:  function () { world.sends++; return true; },
        check: function () { world.checks++; return true; }
    }));
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(world.checks, 1);
    // One send step and three check polls: two quiet ones and the one that reads.
    assert.strictEqual(r.drove.rounds, 4);
    assert.strictEqual(world.sends, 1);
});

t.test('without checkAfterMs the first poll already checks', function () {
    var b = boot();
    var world = { sends: 0, checks: 0 };
    var r = run(b, def(world, {
        retries: 0,
        timeoutMs: 6 * gap(b),
        send:  function () { world.sends++; return true; },
        check: function () { world.checks++; return true; }
    }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.drove.rounds, 2);
});

t.test('checkAfterMs does not stop the timeout: an unseen effect still fails at timeoutMs', function () {
    var b = boot();
    var world = { sends: 0, checks: 0 };
    var r = run(b, def(world, {
        retries: 0,
        timeoutMs: 5 * gap(b),
        checkAfterMs: 3 * gap(b),
        send:  function () { world.sends++; return true; },
        check: function () { world.checks++; return false; }
    }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].unseen, true);
    assert.strictEqual(r.results[0].reason, 'not observed within ' + (5 * gap(b)) + ' ms');
    // Polls 3 to 5 read; the two quiet ones do not.
    assert.strictEqual(world.checks, 3);
    assert.strictEqual(world.sends, 1);
});

t.test('an effect that appears during the quiet time is verified at its end', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var r = run(b, def(world, {
        retries: 0,
        timeoutMs: 6 * gap(b),
        checkAfterMs: 3 * gap(b)
    }), function (n) { if (n === 2) world.done = true; });
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.drove.rounds, 4);
});

t.test('attempt rejects a checkAfterMs that is negative, not below timeoutMs or not a number', function () {
    var b = boot();
    var world = { sends: 0 };
    var bad = [
        def(world, { timeoutMs: 5 * gap(b), checkAfterMs: -1 }),
        def(world, { timeoutMs: 5 * gap(b), checkAfterMs: 5 * gap(b) }),
        def(world, { timeoutMs: 5 * gap(b), checkAfterMs: 9 * gap(b) }),
        def(world, { timeoutMs: 5 * gap(b), checkAfterMs: '1000' }),
        def(world, { timeoutMs: 5 * gap(b), checkAfterMs: NaN })
    ];
    for (var i = 0; i < bad.length; i++) {
        assert.strictEqual(b.A.attempt(bad[i], function () {}), false);
    }
    assert.strictEqual(b.H.queued().length, 0);
    assert.strictEqual(world.sends, 0);
});

t.test('checkAfterMs 0 is accepted and behaves as no quiet time', function () {
    var b = boot();
    var world = { sends: 0, done: false };
    var r = run(b, def(world, {
        retries: 0,
        timeoutMs: 3 * gap(b),
        checkAfterMs: 0,
        send: function () { world.sends++; world.done = true; return true; }
    }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.drove.rounds, 2);
});

// ---- observable: a held check ----

// An observable() that returns false for its first n calls, then true.
function falseFor(n, world) {
    return function () {
        world.obsCalls = (world.obsCalls || 0) + 1;
        return world.obsCalls > n;
    };
}

t.test('observable false runs no check and does not use up the window', function () {
    var b = boot();
    var world = { sends: 0, checks: 0 };
    var obs = falseFor(5, world);
    var r = run(b, def(world, {
        retries: 0,
        timeoutMs: 3 * gap(b),
        observable: function () {
            var v = obs();
            if (!v) world.heldAt = world.checks;
            return v;
        },
        check: function () { world.checks++; return true; }
    }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(world.checks, 1);
    assert.strictEqual(world.heldAt, 0);
    assert.strictEqual(world.sends, 1);
    // The send step, five held polls and the poll that reads.
    assert.strictEqual(r.drove.rounds, 7);
});

t.test('an effect seen only once observable turns true is verified', function () {
    var b = boot();
    var world = { sends: 0 };
    var r = run(b, def(world, {
        retries: 0,
        timeoutMs: 2 * gap(b),
        observable: falseFor(4, world),
        send: function () { world.sends++; world.done = true; return true; }
    }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.results[0].sends, 1);
    assert.strictEqual(world.sends, 1);
    // More rounds than the two-poll window alone would allow.
    assert.strictEqual(r.drove.rounds, 6);
});

t.test('held polls do not count toward checkAfterMs', function () {
    var b = boot();
    var world = { sends: 0, checks: 0 };
    var r = run(b, def(world, {
        retries: 0,
        timeoutMs: 6 * gap(b),
        checkAfterMs: 3 * gap(b),
        observable: falseFor(3, world),
        check: function () { world.checks++; return true; }
    }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(world.checks, 1);
    // The send step, three held polls, then two quiet polls and the one that reads.
    assert.strictEqual(r.drove.rounds, 7);
});

t.test('the hold cap ends the hold and the attempt fails unseen at the timeout', function () {
    var b = boot();
    var world = { sends: 0, checks: 0, obsCalls: 0 };
    var cap = b.A.HOLD_MAX_MS / gap(b);
    var r = run(b, def(world, {
        retries: 0,
        timeoutMs: 3 * gap(b),
        observable: function () {
            world.obsCalls++;
            if (world.obsCalls <= cap) world.heldChecks = world.checks;
            return false;
        },
        check: function () { world.checks++; return false; }
    }), null, 200);
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].unseen, true);
    assert.strictEqual(r.results[0].reason, 'not observed within ' + (3 * gap(b)) + ' ms');
    assert.strictEqual(world.heldChecks || 0, 0);
    // The cap is used up once; after that the hook is no longer asked.
    assert.strictEqual(world.obsCalls, cap + 1);
    assert.strictEqual(world.sends, 1);
    var capped = logsAt(b, 'warn', 'testcat').filter(function (l) {
        return String(l.args[0]).indexOf('checking again') !== -1;
    });
    assert.strictEqual(capped.length, 1);
});

t.test('a throwing observable counts as observable', function () {
    var b = boot();
    var world = { sends: 0 };
    var r = run(b, def(world, {
        retries: 0,
        timeoutMs: 3 * gap(b),
        observable: function () { throw new Error('boom'); },
        send: function () { world.sends++; world.done = true; return true; }
    }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(r.drove.rounds, 2);
    var threw = logsAt(b, 'warn', 'testcat').filter(function (l) {
        return String(l.args[0]).indexOf('observable threw') !== -1;
    });
    assert.ok(threw.length >= 1);
});

t.test('the hold logs once per stretch', function () {
    var b = boot();
    var world = { sends: 0, checks: 0 };
    // Held, observable (check misses), held, observable (check reads).
    var seq = [false, false, true, false, true];
    var i = 0;
    var r = run(b, def(world, {
        retries: 0,
        timeoutMs: 6 * gap(b),
        observable: function () { return i < seq.length ? seq[i++] : true; },
        check: function () { world.checks++; return world.checks >= 2; }
    }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    var holds = logsAt(b, 'log', 'testcat').filter(function (l) {
        return String(l.args[0]).indexOf('holding the check') !== -1;
    });
    assert.strictEqual(holds.length, 2);
});

t.test('HOLD_MAX_MS is exported', function () {
    var b = boot();
    assert.strictEqual(b.A.HOLD_MAX_MS, 60000);
});

t.test('refuted ends the attempt Failed with refuted true and no retry', function () {
    var b = boot();
    var world = { sends: 0, done: false, bases: [] };
    var r = run(b, def(world, {
        timeoutMs: 5 * gap(b),
        baseline: function () { return { stock: 4 }; },
        refuted: function (base) { world.bases.push(base); return 'came back'; }
    }));
    assert.strictEqual(r.results.length, 1);
    var res = r.results[0];
    assert.strictEqual(res.status, b.S.ActionResult.Failed);
    assert.strictEqual(res.refuted, true);
    assert.strictEqual(res.reason, 'came back');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res, 'unseen'), false);
    assert.strictEqual(res.sends, 1, 'the default retry is not used');
    assert.strictEqual(world.sends, 1);
    assert.strictEqual(world.bases.length, 1);
    assert.strictEqual(world.bases[0].stock, 4, 'refuted gets the baseline');
    // The send step and the first poll, which ends the window early.
    assert.strictEqual(r.drove.rounds, 2);
});

t.test('refuted is not called while held or inside checkAfterMs', function () {
    var b = boot();
    var world = { sends: 0, checks: 0, order: [] };
    var r = run(b, def(world, {
        retries: 0,
        timeoutMs: 6 * gap(b),
        checkAfterMs: 3 * gap(b),
        observable: falseFor(3, world),
        check: function () { world.checks++; world.order.push('check'); return false; },
        refuted: function () { world.order.push('refuted@' + world.obsCalls); return 'came back'; }
    }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Failed);
    assert.strictEqual(r.results[0].refuted, true);
    // Three held polls, two quiet ones, then the poll that reads both.
    assert.deepStrictEqual(world.order, ['check', 'refuted@6']);
    assert.strictEqual(r.drove.rounds, 7);
});

t.test('check true wins over refuted on the same poll', function () {
    var b = boot();
    var world = { sends: 0, done: true, refutes: 0 };
    var r = run(b, def(world, {
        retries: 0,
        refuted: function () { world.refutes++; return 'came back'; }
    }));
    assert.strictEqual(r.results[0].status, b.S.ActionResult.Verified);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(r.results[0], 'refuted'), false);
    assert.strictEqual(world.refutes, 0);
});

t.test('a throwing refuted is no proof', function () {
    var b = boot();
    var world = { sends: 0, done: false, refutes: 0 };
    var r = run(b, def(world, {
        retries: 0,
        timeoutMs: 2 * gap(b),
        refuted: function () { world.refutes++; throw new Error('boom'); }
    }));
    var res = r.results[0];
    assert.strictEqual(res.status, b.S.ActionResult.Failed);
    assert.strictEqual(res.unseen, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res, 'refuted'), false);
    assert.strictEqual(world.refutes, 2, 'asked on every poll that checked');
    var threw = logsAt(b, 'warn', 'testcat').filter(function (l) {
        return String(l.args[0]).indexOf('refuted threw') !== -1;
    });
    assert.strictEqual(threw.length, 2);
});
