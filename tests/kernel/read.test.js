'use strict';

var t = require('../runner');
var harness = require('../harness');

// Kernel-only boot with a controllable zone id. zone.id() is counted so a test
// can tell whether a get read it.
function boot() {
    var H = harness.boot({ sections: ['kernel'] });
    var S = H.Steward;
    var z = { id: 1, reads: 0 };
    S.core.zone = { id: function () { z.reads++; return z.id; } };
    return { S: S, R: S.kernel.read, HR: S.kernel.hostRead, zone: z };
}

// A source whose read counts its calls and answers from fn (default ok).
function counting(R, name, scope, fn) {
    var c = { n: 0, ctx: null };
    R.source(name, {
        scope: scope,
        read: function (arg, ctx) {
            c.n++;
            c.ctx = ctx;
            return fn ? fn(arg, ctx, c.n) : R.ok('v' + (arg === undefined ? '' : arg), ctx.zoneId);
        }
    });
    return c;
}

function withNow(times, fn) {
    var real = Date.now;
    var i = 0;
    Date.now = function () { return times[Math.min(i++, times.length - 1)]; };
    try { return fn(); } finally { Date.now = real; }
}

t.test('get memoizes per zone inside a pass', function () {
    var b = boot();
    var c = counting(b.R, 'a.list', 'zone');
    b.HR.pass(function () {
        var r1 = b.R.get('a.list');
        var r2 = b.R.get('a.list');
        t.assert.strictEqual(r1, r2);
        t.assert.strictEqual(r1.state, 'ok');
        t.assert.strictEqual(r1.zoneId, 1);
        b.R.get('a.list', 'x');
        b.R.get('a.list', 'x');
    });
    t.assert.strictEqual(c.n, 2);
});

t.test('get reads live outside a pass and with opts.live', function () {
    var b = boot();
    var c = counting(b.R, 'a.list', 'zone');
    b.R.get('a.list');
    b.R.get('a.list');
    t.assert.strictEqual(c.n, 2);
    b.HR.pass(function () {
        b.R.get('a.list', undefined, { live: true });
        b.R.get('a.list', undefined, { live: true });
        t.assert.strictEqual(c.ctx.live, true);
    });
    t.assert.strictEqual(c.n, 4);
});

t.test('a live source is never memoized', function () {
    var b = boot();
    var c = counting(b.R, 'a.live', 'live');
    b.HR.pass(function () { b.R.get('a.live'); b.R.get('a.live'); });
    t.assert.strictEqual(c.n, 2);
});

t.test('opts.zone bypasses the memo', function () {
    var b = boot();
    var c = counting(b.R, 'a.list', 'zone');
    var zoneObj = { name: 'other' };
    b.HR.pass(function () {
        b.R.get('a.list');
        b.R.get('a.list', undefined, { zone: zoneObj });
        t.assert.strictEqual(c.ctx.zone, zoneObj);
        b.R.get('a.list', undefined, { zone: zoneObj });
    });
    t.assert.strictEqual(c.n, 3);
});

t.test('a non-key argument bypasses the memo', function () {
    var b = boot();
    var c = counting(b.R, 'a.list', 'pass', function (arg, ctx) { return b.R.ok(1); });
    b.HR.pass(function () { b.R.get('a.list', { k: 1 }); b.R.get('a.list', { k: 1 }); });
    t.assert.strictEqual(c.n, 2);
});

t.test('a zone id change inside a pass misses the memo', function () {
    var b = boot();
    var c = counting(b.R, 'a.list', 'zone');
    b.HR.pass(function () {
        t.assert.strictEqual(b.R.get('a.list').zoneId, 1);
        b.zone.id = 2;
        t.assert.strictEqual(b.R.get('a.list').zoneId, 2);
        b.R.get('a.list');
    });
    t.assert.strictEqual(c.n, 2);
});

t.test('a pass source does not read the zone id', function () {
    var b = boot();
    var c = counting(b.R, 'a.pass', 'pass');
    b.HR.pass(function () {
        b.R.get('a.pass');
        b.zone.id = 2;
        b.R.get('a.pass');
    });
    t.assert.strictEqual(c.n, 1);
    t.assert.strictEqual(c.ctx.zoneId, null);
    t.assert.strictEqual(b.zone.reads, 0);
});

t.test('a missing or throwing zone reader leaves zoneId null', function () {
    var b = boot();
    var c = counting(b.R, 'a.list', 'zone');
    b.S.core.zone = { id: function () { throw new Error('gone'); } };
    t.assert.strictEqual(b.R.get('a.list').zoneId, null);
    b.S.core.zone = undefined;
    t.assert.strictEqual(b.R.get('a.list').state, 'ok');
    t.assert.strictEqual(c.ctx.zoneId, null);
});

t.test('a throwing source is unreadable and not memoized', function () {
    var b = boot();
    var c = counting(b.R, 'a.flaky', 'zone', function (arg, ctx, n) {
        if (n === 1) throw new Error('bridge');
        return b.R.ok('fine', ctx.zoneId);
    });
    b.HR.pass(function () {
        var r = b.R.get('a.flaky');
        t.assert.strictEqual(r.state, 'unreadable');
        t.assert.strictEqual(r.value, null);
        t.assert.strictEqual(r.why, 'threw: bridge');
        t.assert.strictEqual(r.zoneId, 1);
        t.assert.strictEqual(b.R.get('a.flaky').state, 'ok');
        t.assert.strictEqual(b.R.get('a.flaky').state, 'ok');
    });
    t.assert.strictEqual(c.n, 2);
});

t.test('a bad source result is unreadable', function () {
    var b = boot();
    var answers = [null, undefined, 5, {}, { state: 'maybe' }];
    var i = 0;
    b.R.source('a.bad', { scope: 'live', read: function () { return answers[i++]; } });
    for (var k = 0; k < answers.length; k++) {
        var r = b.R.get('a.bad');
        t.assert.strictEqual(r.state, 'unreadable');
        t.assert.strictEqual(r.why, 'bad result');
    }
});

t.test('an unknown source throws', function () {
    var b = boot();
    t.assert.throws(function () { b.R.get('no.such'); }, /unknown source/);
});

t.test('a second registration replaces the first', function () {
    var b = boot();
    b.R.source('a.def', { scope: 'static', read: function () { return b.R.ok('old'); } });
    t.assert.strictEqual(b.R.get('a.def').value, 'old');
    b.R.source('a.def', { scope: 'static', read: function () { return b.R.ok('new'); } });
    t.assert.strictEqual(b.R.get('a.def').value, 'new');
});

t.test('static caches ok only', function () {
    var b = boot();
    var c = counting(b.R, 'a.def', 'static', function (arg, ctx, n) {
        return n === 1 ? b.R.unreadable('def missing') : b.R.ok('class');
    });
    t.assert.strictEqual(b.R.get('a.def').state, 'unreadable');
    t.assert.strictEqual(b.R.get('a.def').state, 'ok');
    t.assert.strictEqual(b.R.get('a.def').value, 'class');
    b.HR.pass(function () { b.R.get('a.def'); });
    t.assert.strictEqual(c.n, 2);
    // opts.live reads again even after an ok answer.
    b.R.get('a.def', undefined, { live: true });
    t.assert.strictEqual(c.n, 3);
});

t.test('static non-ok is kept only for the pass', function () {
    var b = boot();
    var c = counting(b.R, 'a.def', 'static', function () { return b.R.unreadable('def missing'); });
    b.HR.pass(function () { b.R.get('a.def'); b.R.get('a.def'); });
    t.assert.strictEqual(c.n, 1);
    b.HR.pass(function () { b.R.get('a.def'); });
    t.assert.strictEqual(c.n, 2);
});

t.test('a static ok hit does not read the zone id', function () {
    var b = boot();
    counting(b.R, 'a.def', 'static');
    b.R.get('a.def', 51);
    b.R.get('a.def', 51);
    b.HR.pass(function () { b.R.get('a.def', 51); });
    t.assert.strictEqual(b.zone.reads, 0);
});

t.test('non-ok inside a pass marks the pass unsettled', function () {
    var b = boot();
    counting(b.R, 'a.ok', 'zone');
    b.R.source('a.part', { scope: 'zone', read: function () { return b.R.partial([1], 2, 'dropped'); } });
    b.HR.pass(function () {
        b.R.get('a.ok');
        t.assert.strictEqual(b.HR.unsettled(), false);
        var r = b.R.get('a.part');
        t.assert.strictEqual(r.lost, 2);
        t.assert.strictEqual(b.HR.unsettled(), true);
    });
    t.assert.strictEqual(b.HR.unsettled(), false);
});

t.test('a memoized non-ok answer still marks the pass unsettled', function () {
    var b = boot();
    b.R.source('a.nr', { scope: 'pass', read: function () { return b.R.notReady('loading'); } });
    b.HR.pass(function () { b.R.get('a.nr'); });
    b.HR.pass(function () {
        b.R.get('a.nr');
        t.assert.strictEqual(b.HR.unsettled(), true);
    });
});

t.test('helpers: isOk, has, num', function () {
    var R = boot().R;
    t.assert.strictEqual(R.isOk(R.ok(1)), true);
    t.assert.strictEqual(R.isOk(R.partial([], 1)), false);
    t.assert.strictEqual(R.has(R.partial([], 1)), true);
    t.assert.strictEqual(R.has(R.unreadable('x')), false);
    t.assert.strictEqual(R.has(R.notReady('x')), false);
    t.assert.strictEqual(R.num(R.ok(4)), 4);
    t.assert.strictEqual(R.num(R.ok(NaN)), null);
    t.assert.strictEqual(R.num(R.ok('4')), null);
    t.assert.strictEqual(R.num(R.partial(4, 1)), null);
    t.assert.strictEqual(R.unreadable('x').value, null);
    t.assert.strictEqual(R.ok(1).lost, 0);
});

t.test('absent is false on partial', function () {
    var R = boot().R;
    function isB(x) { return x === 'b'; }
    t.assert.strictEqual(R.absent(R.ok(['a']), isB), true);
    t.assert.strictEqual(R.absent(R.ok(['a', 'b']), isB), false);
    t.assert.strictEqual(R.absent(R.partial(['a'], 1), isB), false);
    t.assert.strictEqual(R.absent(R.unreadable('x'), isB), false);
});

t.test('show is ? unless ok', function () {
    var R = boot().R;
    t.assert.strictEqual(R.show(R.ok(3)), '3');
    t.assert.strictEqual(R.show(R.ok(3), function (v) { return v + ' pcs'; }), '3 pcs');
    t.assert.strictEqual(R.show(R.partial(3, 1)), '?');
    t.assert.strictEqual(R.show(R.unreadable('x')), '?');
    t.assert.strictEqual(R.show(R.notReady('x')), '?');
});

t.test('wait go clears the record', function () {
    var R = boot().R;
    var rec = {};
    t.assert.strictEqual(R.wait('m', 'list', R.unreadable('x'), { record: rec, wake: false }), 'wait');
    t.assert.strictEqual(rec.tries, 1);
    t.assert.strictEqual(R.wait('m', 'list', R.ok([]), { record: rec }), 'go');
    t.assert.strictEqual(rec.since, null);
    t.assert.strictEqual(rec.tries, 0);
    // accept 'partial' lets present facts go.
    t.assert.strictEqual(R.wait('m', 'list', R.partial([], 1), { record: rec, wake: false }), 'wait');
    t.assert.strictEqual(R.wait('m', 'list', R.partial([], 1), { accept: 'partial' }), 'go');
});

t.test('wait expires after tries and ms', function () {
    var R = boot().R;
    var bad = R.unreadable('x');
    var out = withNow([1000, 2000, 3000, 70000], function () {
        return [
            R.wait('m', 'k', bad, { wake: false }),   // try 1 at 1000
            R.wait('m', 'k', bad, { wake: false }),   // try 2
            R.wait('m', 'k', bad, { wake: false }),   // try 3, but only 2 s
            R.wait('m', 'k', bad, { wake: false })    // try 4, 69 s
        ];
    });
    t.assert.deepStrictEqual(out, ['wait', 'wait', 'wait', 'expired']);
    // Many tries within the time limit never expire.
    var quick = withNow([0], function () {
        var last;
        for (var i = 0; i < 10; i++) last = R.wait('m', 'q', bad, { wake: false });
        return last;
    });
    t.assert.strictEqual(quick, 'wait');
    // A long time with too few tries does not expire either.
    var slow = withNow([0, 100000], function () {
        return [R.wait('m', 's', bad, { wake: false, tries: 5 }), R.wait('m', 's', bad, { wake: false, tries: 5 })];
    });
    t.assert.deepStrictEqual(slow, ['wait', 'wait']);
});

t.test('wait returns expired once and then starts a new window', function () {
    var R = boot().R;
    var bad = R.notReady('loading');
    var opts = { wake: false, tries: 2, ms: 10 };
    var out = withNow([0, 20, 30, 40, 60], function () {
        return [R.wait('m', 'k', bad, opts), R.wait('m', 'k', bad, opts),
            R.wait('m', 'k', bad, opts), R.wait('m', 'k', bad, opts), R.wait('m', 'k', bad, opts)];
    });
    t.assert.deepStrictEqual(out, ['wait', 'expired', 'wait', 'expired', 'wait']);
});

t.test('clearWait drops a memory record', function () {
    var R = boot().R;
    var bad = R.unreadable('x');
    var opts = { wake: false, tries: 2, ms: 10 };
    var out = withNow([0, 20, 30], function () {
        var a = R.wait('m', 'k', bad, opts);
        R.clearWait('m', 'k');
        return [a, R.wait('m', 'k', bad, opts), R.wait('m', 'k', bad, opts)];
    });
    t.assert.deepStrictEqual(out, ['wait', 'wait', 'expired']);
});

t.test('wait wakes a registered owner with READ_RETRY_MS', function () {
    var b = boot();
    var wakes = [];
    b.S.kernel.scheduler.wake = function (id, ms) { wakes.push([id, ms]); return true; };
    b.S.kernel.registry.get = function (id) { return id === 'explorers' ? { id: id } : null; };
    var bad = b.R.unreadable('x');
    b.R.wait('explorers', 'list', bad);
    b.R.wait('nobody', 'list', bad);
    b.R.wait('explorers', 'list', bad, { wake: false });
    b.R.wait('explorers', 'list', b.R.ok([]));
    t.assert.deepStrictEqual(wakes, [['explorers', b.S.kernel.TIMEOUTS.READ_RETRY_MS]]);
    t.assert.strictEqual(b.S.kernel.TIMEOUTS.READ_RETRY_MS, 2000);
});

t.test('wait uses a caller-owned record', function () {
    var R = boot().R;
    var bad = R.unreadable('x');
    var rec = { other: 'kept' };
    var opts = { record: rec, wake: false, tries: 2, ms: 10 };
    withNow([5, 30], function () {
        t.assert.strictEqual(R.wait('m', 'k', bad, opts), 'wait');
        t.assert.strictEqual(rec.since, 5);
        t.assert.strictEqual(rec.tries, 1);
        // The same key without the record keeps its own memory record.
        t.assert.strictEqual(R.wait('m', 'k', bad, { wake: false, tries: 2, ms: 10 }), 'wait');
    });
    t.assert.strictEqual(rec.tries, 1);
    t.assert.strictEqual(withNow([40], function () { return R.wait('m', 'k', bad, opts); }), 'expired');
    t.assert.strictEqual(rec.since, null);
    t.assert.strictEqual(rec.tries, 0);
    t.assert.strictEqual(rec.other, 'kept');
});

t.test('isReadRefusal knows registered reasons only', function () {
    var R = boot().R;
    t.assert.strictEqual(R.readRefusal('thing unreadable'), 'thing unreadable');
    t.assert.strictEqual(R.isReadRefusal('thing unreadable'), true);
    t.assert.strictEqual(R.isReadRefusal('not on the home island'), false);
    t.assert.strictEqual(R.isReadRefusal(null), false);
    t.assert.strictEqual(R.isReadRefusal('toString'), false);
});

t.test('read constants sit in TIMEOUTS and LIMITS', function () {
    var S = boot().S;
    t.assert.strictEqual(S.kernel.TIMEOUTS.READ_MAX_MS, 60000);
    t.assert.strictEqual(S.kernel.LIMITS.READ_WAIT_TRIES, 3);
    t.assert.strictEqual(S.kernel.LIMITS.READ_REDRAWS, 3);
});

t.test('message is exported and formats an error or a value', function () {
    var R = boot().R;
    t.assert.strictEqual(R.message(new Error('x')), 'x');
    t.assert.strictEqual(R.message('y'), 'y');
});
