'use strict';

// Send ledger: entries persisted before the host call, verified, unseen,
// late settling by reread, stale and resolve, the unread and no-folder fail
// closed paths, owners and their breakers (src/core/ledger.js).

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var AC = require('../stubs/actions');

var assert = t.assert;

var T0 = 1700000000000;
var KEY = 'test|home|10';

// Values from the vm context have their own prototypes.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

// A booted harness on the given disk (none: no file API) with a packet
// recorder, a fake ledger clock and the owner 'tester' registered.
function setup(opts) {
    opts = opts || {};
    var fs = opts.noFs ? null : (opts.fs || airfs.make());
    var H = fs ? harness.boot({ host: { air: fs.air } }) : harness.boot();
    var sent = AC.wire(H);
    var L = H.Steward.core.ledger;
    var clock = { now: typeof opts.now === 'number' ? opts.now : T0 };
    L.clock = function () { return clock.now; };
    if (opts.register !== false) {
        L.register('tester', {
            category: 'testcat',
            breaker: {
                label: 'test breaker', missText: 'test sends in a row were not seen',
                pausedText: 'testing is paused', resumeText: 'testing resumes'
            }
        });
    }
    H.clearLogs();
    H.clearQueued();
    var s = { H: H, S: H.Steward, L: L, fs: fs, sent: sent, clock: clock, flag: { done: false } };
    s.path = fs ? ledgerPath(H) : null;
    return s;
}

function ledgerPath(H) {
    var d = H.Steward.kernel.files.stewardDir('state');
    return d.dir.resolvePath('ledger.json').nativePath;
}

// The ledger file on disk, parsed, or null when there is none.
function ledgerFile(s) {
    var keys = Object.keys(s.fs.disk).filter(function (k) { return /\/state\/ledger\.json$/.test(k); });
    if (keys.length === 0) return null;
    return JSON.parse(s.fs.disk[keys[0]]);
}

function fileEntries(s) {
    var f = ledgerFile(s);
    return f ? f.entries : {};
}

// A def whose check reads s.flag.done and whose send is server action 77.
function def(s, extra) {
    var d = {
        label:     'test send',
        timeoutMs: 3000,
        baseline:  function () { return { at: 'grid 10' }; },
        check:     function () { return s.flag.done === true; },
        send:      function () { return s.S.core.packets.sendAction(77, 10, 0, 0); }
    };
    var k;
    for (k in (extra || {})) d[k] = extra[k];
    return d;
}

function run(s, d, intent, driveOpts) {
    var result = { r: null };
    var it = { key: KEY, owner: 'tester', name: 'test thing' };
    var k;
    for (k in (intent || {})) it[k] = intent[k];
    var ok = s.L.attempt(d, it, function (r) { result.r = r; });
    result.ok = ok;
    AC.drive(s.H, driveOpts);
    return result;
}

function sends77(s) {
    return s.sent.actions.filter(function (a) { return a.id === 77; });
}

function logged(s, level, category, re) {
    return s.H.logs().filter(function (l) {
        return l.level === level && l.category === category && re.test(l.args.join(' '));
    });
}

t.test('key: joins three parts and refuses empty parts or a bar', function () {
    var s = setup();
    assert.strictEqual(s.L.key('rebuild', 'home', 10), 'rebuild|home|10');
    assert.strictEqual(s.L.key('a', '', 1), null);
    assert.strictEqual(s.L.key('a', 'b', null), null);
    assert.strictEqual(s.L.key('a|x', 'b', 1), null);
});

t.test('attempt: the entry is on disk as sent before the host call', function () {
    var s = setup();
    var gi = s.H.host.game.gi;
    var base = gi.SendServerAction;
    var atSend = null;
    gi.SendServerAction = function (id) {
        if (id === 77) atSend = ledgerFile(s);
        return base.apply(this, arguments);
    };
    run(s, def(s), null, { onStep: function (n) { if (n === 2) s.flag.done = true; } });
    assert.ok(atSend && atSend.entries[KEY], 'entry written before the send');
    var e = atSend.entries[KEY];
    assert.strictEqual(e.state, 'sent');
    assert.strictEqual(e.owner, 'tester');
    assert.strictEqual(e.name, 'test thing');
    assert.strictEqual(e.sentAt, T0);
    assert.deepStrictEqual(e.base, { at: 'grid 10' });
    assert.strictEqual(e.resolveAfterMs, 60000, 'max(3 * timeout, 60 s)');
    assert.strictEqual(e.expireMs, 21600000);
    assert.strictEqual(logged(s, 'log', 'testcat', /^test send: sent$/).length, 1);
});

t.test('attempt: verified removes the entry, closes the breaker and logs observed', function () {
    var s = setup();
    s.L.breaker('tester').miss();
    var res = run(s, def(s), null, { onStep: function (n) { if (n === 1) s.flag.done = true; } });
    assert.strictEqual(res.r.status, s.S.ActionResult.Verified);
    assert.strictEqual(sends77(s).length, 1);
    assert.deepStrictEqual(plain(fileEntries(s)), {});
    assert.strictEqual(s.L.blocked(KEY), null);
    assert.strictEqual(s.L.breaker('tester').snapshot().run, 0);
    assert.strictEqual(logged(s, 'log', 'testcat', /^test send: observed$/).length, 1);
});

t.test('attempt: NOT_SENT from the def removes the entry', function () {
    var s = setup();
    var res = run(s, def(s, { send: function () { return s.S.core.actions.NOT_SENT; } }));
    assert.strictEqual(res.r.status, s.S.ActionResult.Refused);
    assert.deepStrictEqual(plain(fileEntries(s)), {});
    assert.strictEqual(s.L.blocked(KEY), null);
});

t.test('attempt: an unseen send stays blocked, counts one miss and refuses a second attempt', function () {
    var s = setup();
    var res = run(s, def(s));
    assert.strictEqual(res.r.status, s.S.ActionResult.Failed);
    assert.strictEqual(res.r.unseen, true);
    assert.strictEqual(sends77(s).length, 1, 'retries 0: one send only');
    assert.strictEqual(fileEntries(s)[KEY].state, 'unseen');
    assert.strictEqual(s.L.blocked(KEY), 'unseen');
    assert.strictEqual(s.L.breaker('tester').snapshot().run, 1);
    assert.strictEqual(logged(s, 'warn', 'testcat', /^test send: unseen, test\|home\|10 stays blocked$/).length, 1);

    var again = run(s, def(s));
    assert.strictEqual(again.r.status, s.S.ActionResult.Refused);
    assert.strictEqual(again.r.reason, 'pending: unseen');
    assert.strictEqual(sends77(s).length, 1, 'no second send');
});

t.test('attempt: a send returning false leaves the key unseen with no miss', function () {
    var s = setup();
    var res = run(s, def(s, { send: function () { return false; } }));
    assert.strictEqual(res.r.status, s.S.ActionResult.Failed);
    assert.strictEqual(s.L.blocked(KEY), 'unseen');
    assert.strictEqual(s.L.breaker('tester').snapshot().run, 0);
    assert.strictEqual(logged(s, 'warn', 'testcat', /test send failed: send failed; test\|home\|10 stays blocked/).length, 1);
});

t.test('reboot: the entry is read back and a read-back sent entry rereads as unseen', function () {
    var s = setup();
    // The file as a reload right after the send leaves it.
    var gi = s.H.host.game.gi;
    var snap = null;
    gi.SendServerAction = function () { snap = s.fs.disk[s.path]; };
    run(s, def(s));
    s.fs.disk[s.path] = snap;
    var s2 = setup({ fs: s.fs, now: T0 + 1000 });
    assert.strictEqual(s2.L.blocked(KEY), 'sent');
    assert.strictEqual(logged(s2, 'log', 'ledger', /^read back 1 send ledger entry from .*state\/ledger\.json$/).length, 1);
    assert.strictEqual(s2.L.reread(KEY, def(s2)), 'unseen');
    assert.strictEqual(fileEntries(s2)[KEY].state, 'unseen');
});

t.test('reread: check true removes the entry as observed and closes the breaker', function () {
    var s = setup();
    run(s, def(s));
    s.clock.now += 120000;
    s.flag.done = true;
    assert.strictEqual(s.L.reread(KEY, def(s)), null);
    assert.strictEqual(s.L.blocked(KEY), null);
    assert.strictEqual(s.L.breaker('tester').snapshot().run, 0);
    assert.strictEqual(logged(s, 'log', 'testcat', /^test send: observed after 2 min$/).length, 1);
});

t.test('reread: a proof counts only after resolveAfterMs and then frees the key', function () {
    var s = setup();
    run(s, def(s));
    var proofs = 0;
    var d = def(s, { failedProof: function (base) { proofs++; return base.at + ' is still empty'; } });
    s.clock.now = T0 + 30000;
    assert.strictEqual(s.L.reread(KEY, d), 'unseen', 'too early for a proof');
    assert.strictEqual(proofs, 0);
    s.clock.now = T0 + 60000;
    assert.strictEqual(s.L.reread(KEY, d), null);
    assert.strictEqual(s.L.blocked(KEY), null);
    assert.ok(!fileEntries(s)[KEY]);
    assert.strictEqual(logged(s, 'warn', 'testcat',
        /^test send: failed after 1 min: grid 10 is still empty; test\|home\|10 is free$/).length, 1);
    assert.strictEqual(s.L.breaker('tester').snapshot().run, 1, 'failed does not count again');
});

t.test('reread: an empty proof never frees the key; expiry makes it stale until resolved', function () {
    var s = setup();
    run(s, def(s));
    var d = def(s, { failedProof: function () { return ''; } });
    s.clock.now = T0 + 3600000;
    assert.strictEqual(s.L.reread(KEY, d), 'unseen');
    s.clock.now = T0 + 21600000;
    assert.strictEqual(s.L.reread(KEY, d), 'stale');
    assert.strictEqual(s.L.reread(KEY, d), 'stale');
    assert.strictEqual(logged(s, 'warn', 'testcat', /stale after 360 min, blocking test\|home\|10 until resolved/).length, 1);
    assert.strictEqual(fileEntries(s)[KEY].state, 'stale');

    var s2 = setup({ fs: s.fs, now: T0 + 22000000 });
    assert.strictEqual(s2.L.blocked(KEY), 'stale', 'stale survives a reboot');
    s2.flag.done = true;
    assert.strictEqual(s2.L.reread(KEY, def(s2)), 'stale', 'only resolve clears stale');
    assert.strictEqual(s2.L.resolve(KEY, 'the user'), true);
    assert.strictEqual(s2.L.blocked(KEY), null);
    assert.ok(!fileEntries(s2)[KEY]);
    assert.strictEqual(logged(s2, 'log', 'ledger', /^test\|home\|10 resolved by the user$/).length, 1);
});

t.test('reread: nothing changes while observable() is false or the key is in flight', function () {
    var s = setup();
    run(s, def(s));
    s.flag.done = true;
    s.clock.now += 600000;
    assert.strictEqual(s.L.reread(KEY, def(s, { observable: function () { return false; } })), 'unseen');
    assert.strictEqual(s.L.blocked(KEY), 'unseen');

    var s2 = setup();
    s2.L.attempt(def(s2), { key: KEY, owner: 'tester', name: 'x' });
    var q = s2.H.queued();
    s2.H.clearQueued();
    s2.S.core.actions.step(q[0].params);     // the send
    assert.strictEqual(s2.L.blocked(KEY), 'sent');
    s2.flag.done = true;
    assert.strictEqual(s2.L.reread(KEY, def(s2)), 'sent', 'its attempt settles it');
    assert.strictEqual(s2.L.resolve(KEY, 'x'), false, 'resolve leaves a key in flight');
    assert.strictEqual(s2.L.blocked(KEY), 'sent');
});

t.test('release: a cancelled attempt\'s key settles by reread; other owners keep theirs', function () {
    var s = setup();
    s.L.register('other', { category: 'othercat' });
    var OTHER = 'test|home|11';
    s.L.attempt(def(s), { key: KEY, owner: 'tester', name: 'x' });
    s.L.attempt(def(s), { key: OTHER, owner: 'other', name: 'y' });
    var q = s.H.queued();
    s.H.clearQueued();
    s.S.core.actions.step(q[0].params);     // tester's send
    s.S.core.actions.step(q[1].params);     // other's send
    assert.strictEqual(s.L.blocked(KEY), 'sent');
    assert.strictEqual(s.L.blocked(OTHER), 'sent');
    // The queued follow-up steps are dropped, as cancelByModule does.
    s.H.clearQueued();

    assert.strictEqual(s.L.release('nobody'), 0);
    assert.strictEqual(s.L.release('tester'), 1);
    assert.strictEqual(s.L.release('tester'), 0, 'a second release finds nothing');
    assert.strictEqual(s.L.blocked(KEY), 'sent', 'the entry stays until reread');

    s.flag.done = true;
    s.clock.now += 5000;
    assert.strictEqual(s.L.reread(KEY, def(s)), null, 'observed once the mark is gone');
    assert.ok(!fileEntries(s)[KEY]);
    assert.strictEqual(s.L.reread(OTHER, def(s)), 'sent', 'still left to its own attempt');
    assert.strictEqual(s.L.resolve(OTHER, 'x'), false);
});

t.test('no file API: refused as unavailable and nothing sent', function () {
    var s = setup({ noFs: true });
    var res = run(s, def(s));
    assert.strictEqual(res.r.status, s.S.ActionResult.Refused);
    assert.strictEqual(res.r.reason, 'send ledger unavailable');
    assert.strictEqual(sends77(s).length, 0);
    assert.strictEqual(logged(s, 'warn', 'ledger', /no writable steward\/state folder/).length, 1);
});

t.test('unreadable file: every key reads unread, nothing is sent, a later read works', function () {
    var probe = setup();
    var fs = probe.fs;
    fs.disk[probe.path] = JSON.stringify({ version: 1, entries: {} });
    fs.fail.read[probe.path] = true;
    var s = setup({ fs: fs });
    assert.strictEqual(s.L.blocked(KEY), 'unread');
    assert.strictEqual(s.L.blocked('other|home|1'), 'unread');
    var res = run(s, def(s));
    assert.strictEqual(res.r.status, s.S.ActionResult.Refused);
    assert.strictEqual(sends77(s).length, 0);
    assert.strictEqual(logged(s, 'warn', 'ledger', /^send ledger not read: .*; guarded sends wait$/).length, 1);

    delete fs.fail.read[probe.path];
    s.clock.now += 5000;
    assert.strictEqual(s.L.blocked(KEY), 'unread', 'retried only after 10 s');
    s.clock.now += 6000;
    assert.strictEqual(s.L.blocked(KEY), null);
});

t.test('invalid file content starts empty with a warning', function () {
    var probe = setup();
    probe.fs.disk[probe.path] = '{ not json';
    var s = setup({ fs: probe.fs });
    assert.strictEqual(s.L.blocked(KEY), null);
    assert.strictEqual(logged(s, 'warn', 'ledger', /^send ledger is invalid, starting empty$/).length, 1);
});

t.test('load: bad entries are dropped and a future sentAt is clamped', function () {
    var probe = setup();
    probe.fs.disk[probe.path] = JSON.stringify({ version: 1, entries: {
        'a|home|1': { owner: 'tester', state: 'unseen', sentAt: T0 + 9999999 },
        'a|home|2': { owner: 'tester', state: 'weird', sentAt: T0 },
        'a|home|3': { owner: 'tester', state: 'unseen' }
    } });
    var s = setup({ fs: probe.fs });
    var snap = s.L.snapshot();
    assert.strictEqual(snap.length, 1);
    assert.strictEqual(snap[0].key, 'a|home|1');
    assert.strictEqual(snap[0].sentAt, T0);
    assert.deepStrictEqual(Object.keys(fileEntries(s)), ['a|home|1']);
});

t.test('owners: separate breakers, snapshot filters, register is idempotent', function () {
    var s = setup();
    s.L.register('other', { category: 'othercat' });
    s.L.register('tester', { category: 'ignored' });
    run(s, def(s));
    run(s, def(s, { label: 'other send' }), { key: 'other|home|5', owner: 'other' });
    assert.strictEqual(s.L.breaker('tester').snapshot().run, 1);
    assert.strictEqual(s.L.breaker('other').snapshot().run, 1);
    assert.ok(s.L.breaker('tester') !== s.L.breaker('other'));
    assert.strictEqual(logged(s, 'warn', 'testcat', /^test send: unseen/).length, 1, 'first category kept');
    assert.strictEqual(logged(s, 'warn', 'othercat', /^other send: unseen/).length, 1);
    assert.deepStrictEqual(plain(s.L.snapshot('other').map(function (e) { return e.key; })), ['other|home|5']);
    assert.deepStrictEqual(plain(s.L.snapshot().map(function (e) { return e.key; })), ['other|home|5', KEY]);
    assert.strictEqual(s.L.snapshot('tester')[0].base, undefined, 'base left out');
    assert.strictEqual(s.L.admit('nobody'), false);
    assert.strictEqual(s.L.admit('tester'), true);
});

t.test('attempt: an unregistered owner or a null key is refused without an attempt', function () {
    var s = setup();
    assert.strictEqual(s.L.attempt(def(s), { key: KEY, owner: 'nobody' }), false);
    assert.strictEqual(s.L.attempt(def(s), { key: null, owner: 'tester' }), false);
    assert.strictEqual(s.H.queued().length, 0);
    assert.strictEqual(logged(s, 'error', 'ledger', /send ledger owner nobody not registered/).length, 1);
});

t.test('idempotent: the def keeps its retries and a retry sends a second time', function () {
    var s = setup();
    var d = def(s, { idempotent: true, retries: 1 });
    var res = run(s, d);
    assert.strictEqual(d.retries, 1);
    assert.strictEqual(sends77(s).length, 2, 'the retry is not refused as pending');
    assert.strictEqual(res.r.status, s.S.ActionResult.Failed);
    assert.strictEqual(s.L.blocked(KEY), 'unseen');

    var s2 = setup();
    var d2 = def(s2);
    d2.retries = 3;
    run(s2, d2);
    assert.strictEqual(d2.retries, 0, 'a non-idempotent def never retries');
    assert.strictEqual(sends77(s2).length, 1);
});

t.test('attempt: a refuted attempt frees its key with no breaker miss', function () {
    var s = setup();
    var res = run(s, def(s, { refuted: function () { return 'stack came back'; } }));
    assert.strictEqual(res.r.status, s.S.ActionResult.Failed);
    assert.strictEqual(res.r.refuted, true);
    assert.strictEqual(sends77(s).length, 1);
    assert.deepStrictEqual(plain(fileEntries(s)), {});
    assert.strictEqual(s.L.blocked(KEY), null);
    assert.strictEqual(s.L.breaker('tester').snapshot().run, 0);
    assert.strictEqual(logged(s, 'log', 'testcat', /^test send: stack came back; test\|home\|10 is free$/).length, 1);
    assert.strictEqual(logged(s, 'warn', 'testcat', /stays blocked/).length, 0);

    // The key is free: a new send goes out.
    var again = run(s, def(s, { refuted: function () { return 'stack came back'; } }));
    assert.strictEqual(again.r.refuted, true);
    assert.strictEqual(sends77(s).length, 2);
});

t.test('attempt: an unseen attempt still counts a miss', function () {
    var s = setup();
    var res = run(s, def(s, { refuted: function () { return ''; } }));
    assert.strictEqual(res.r.status, s.S.ActionResult.Failed);
    assert.strictEqual(res.r.unseen, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res.r, 'refuted'), false);
    assert.strictEqual(s.L.blocked(KEY), 'unseen');
    assert.strictEqual(s.L.breaker('tester').snapshot().run, 1);
});
