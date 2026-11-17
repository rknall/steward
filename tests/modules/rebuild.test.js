'use strict';

// Rebuild module: fail-closed plan reads, one rebuild per plan, the send
// through the construction rebuild def and its send-ledger entry, late
// settling of unseen rebuilds (src/modules/rebuild/module.js).

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var AC = require('../stubs/actions');
var Z = require('../stubs/zone');

var assert = t.assert;

var HOME = { zone: { isHome: true } };
var T0 = 1700000000000;
var WELL = 'MineDepletedDepositWater';
var FIELD = 'MineDepletedDepositCorn';
var KEY = 'rebuild|home|10';

// Values from the vm context have their own prototypes.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

// A booted harness on the given disk (none: no file API) with a packet
// recorder, a fake ledger clock, the home zone holding o.shells (default: a
// depleted well on grid 10) plus one unrelated building, a build queue of
// o.used of o.slots, a street map that calls every Depleted* name depleted
// (o.dep replaces it, null removes it) and the captured rebuild.place handler.
function setup(o) {
    o = o || {};
    var fs = o.noFs ? null : (o.fs || airfs.make());
    var H = fs ? harness.boot({ host: { air: fs.air } }) : harness.boot();
    var sent = AC.wire(H);
    var z = Z.zone();
    z.building(Z.building({ name: 'Woodcutter', grid: 99 }));
    var shells = o.shells || [{ name: WELL, grid: 10 }];
    var opts = [];
    for (var i = 0; i < shells.length; i++) {
        var so = { level: 1, constructing: false };
        for (var k in shells[i]) so[k] = shells[i][k];
        opts.push(so);
        z.building(Z.building(so));
    }
    z.buildQueue(typeof o.used === 'number' ? o.used : 0, typeof o.slots === 'number' ? o.slots : 4);
    H.installZone(z);
    var gi = H.host.game.gi;
    gi.mCurrentViewedZoneID = 1;
    var dep = o.dep === undefined
        ? function (b) { return b.GetBuildingName_string().indexOf('Depleted') > -1; }
        : o.dep;
    if (dep) z.zone.mStreetDataMap.IsADepletedDeposit = dep;
    H.settings.write('rebuild', { enabled: true, wellType: 'Well_03', fieldType: 'Farmfield' });

    var clock = { now: typeof o.now === 'number' ? o.now : T0 };
    var L = H.Steward.core.ledger;
    L.clock = function () { return clock.now; };

    var q = H.Steward.kernel.queue;
    var orig = q.action;
    var handlers = {};
    q.action = function (name, f) {
        handlers[name] = f;
        return orig.apply(q, arguments);
    };
    H.module('rebuild').boot();
    q.action = orig;
    H.clearQueued();
    H.clearLogs();

    return { H: H, S: H.Steward, L: L, fs: fs, z: z, gi: gi, sent: sent, clock: clock,
             shells: opts, place: handlers['rebuild.place'] };
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

// Runs one plan pass and returns the rebuild entries it queued.
function plan(s) {
    s.H.clearQueued();
    s.H.module('rebuild').plan(HOME);
    var out = s.H.queued().filter(function (e) { return /^rebuild\./.test(e.name); });
    s.H.clearQueued();
    return plain(out.map(function (e) { return e.params; }));
}

// Fires rebuild.place for the grid and plays the attempt to its end.
function fire(s, grid, name, driveOpts) {
    s.place([grid, name]);
    return AC.drive(s.H, driveOpts || { max: 300 });
}

function sends50(s) {
    return s.sent.actions.filter(function (a) { return a.id === 50; });
}

function logged(s, level, re) {
    return s.H.logs().filter(function (l) {
        return l.level === level && l.category === 'rebuild' && re.test(l.args.join(' '));
    });
}

// Fires the rebuild of grid 10 and leaves the shell in place: unseen.
function unseen(s) {
    fire(s, 10, 'Well_03');
    assert.strictEqual(fileEntries(s)[KEY].state, 'unseen');
}

t.test('plan queues exactly one rebuild, for the lowest-grid shell', function () {
    var s = setup({ shells: [{ name: FIELD, grid: 11 }, { name: WELL, grid: 10 }] });
    assert.deepStrictEqual(plan(s), [[10, 'Well_03']]);
    assert.strictEqual(logged(s, 'log', /^queued rebuild of Well_03 on grid 10$/).length, 1);
});

t.test('plan queues nothing on a full or unreadable build queue', function () {
    assert.deepStrictEqual(plan(setup({ used: 4, slots: 4 })), []);
    var s = setup();
    s.gi.mCurrentPlayer.mBuildQueue = null;
    assert.deepStrictEqual(plan(s), []);
});

t.test('plan queues nothing on an unreadable building list or without a player zone', function () {
    var s = setup();
    s.z.zone.mStreetDataMap.GetBuildings_vector = function () { throw new Error('list gone'); };
    assert.deepStrictEqual(plan(s), []);
    var s2 = setup();
    s2.gi.mCurrentPlayerZone = null;
    assert.deepStrictEqual(plan(s2), []);
});

t.test('plan queues nothing for a shell that reads not depleted or is under construction', function () {
    assert.deepStrictEqual(plan(setup({ dep: function () { return false; } })), []);
    assert.deepStrictEqual(plan(setup({ shells: [{ name: WELL, grid: 10, constructing: true }] })), []);
});

t.test('a shell whose depleted state throws is skipped with a debug line', function () {
    var s = setup({ dep: function () { throw new Error('x'); } });
    assert.deepStrictEqual(plan(s), []);
    assert.strictEqual(logged(s, 'debug', /^grid 10 skipped: depleted state unreadable$/).length, 1);
});

t.test('without IsADepletedDeposit the shell name decides', function () {
    assert.deepStrictEqual(plan(setup({ dep: null })), [[10, 'Well_03']]);
});

t.test('isReady needs the module enabled on the home zone', function () {
    var s = setup();
    var m = s.H.module('rebuild');
    assert.strictEqual(m.isReady(HOME), true);
    assert.strictEqual(m.isReady({ zone: { isHome: false } }), false);
    s.H.settings.write('rebuild', { enabled: false });
    assert.strictEqual(m.isReady(HOME), false);
});

t.test('place sends one action 50 whose ledger entry is on disk before the host call', function () {
    var s = setup();
    var base = s.gi.SendServerAction;
    var atSend = null;
    s.gi.SendServerAction = function (id) {
        if (id === 50) atSend = ledgerFile(s);
        return base.apply(this, arguments);
    };
    fire(s, 10, 'Well_03');
    assert.deepStrictEqual(plain(sends50(s)), [{ id: 50, p1: 176, p2: 10, p3: 0, data: null }]);
    assert.ok(atSend && atSend.entries[KEY], 'entry written before the send');
    assert.strictEqual(atSend.entries[KEY].state, 'sent');
    assert.strictEqual(atSend.entries[KEY].owner, 'rebuild');
    assert.strictEqual(atSend.entries[KEY].resolveAfterMs, 1800000);
});

t.test('a grid that shows another name verifies and clears the entry; the log has the diagnostic', function () {
    var s = setup();
    fire(s, 10, 'Well_03', {
        max: 300,
        onStep: function () { if (sends50(s).length === 1) s.shells[0].name = 'Well_03'; }
    });
    assert.strictEqual(sends50(s).length, 1);
    assert.ok(!fileEntries(s)[KEY], 'entry removed');
    assert.strictEqual(logged(s, 'log', /^rebuild Well_03 10: observed$/).length, 1);
    var line = logged(s, 'log', /^rebuild Well_03 10: ActionVerified/).pop();
    assert.ok(line, 'final line');
    var text = line.args.join(' ');
    assert.ok(text.indexOf('preplace ') >= 0, text);
    assert.ok(text.indexOf('queue ') >= 0, text);
    assert.ok(text.indexOf('lookup ') >= 0, text);
    assert.strictEqual(s.L.breaker('rebuild').snapshot().run, 0);
});

t.test('a grid that keeps the shell ends unseen and blocks the grid, also after a reboot', function () {
    var s = setup();
    unseen(s);
    assert.strictEqual(sends50(s).length, 1, 'retries 0: one send only');
    assert.strictEqual(s.L.breaker('rebuild').snapshot().run, 1);
    assert.strictEqual(s.L.blocked(KEY), 'unseen');
    s.clock.now += 10 * 60000;
    assert.deepStrictEqual(plan(s), []);

    var s2 = setup({ fs: s.fs, now: T0 + 20 * 60000 });
    assert.strictEqual(s2.L.blocked(KEY), 'unseen');
    assert.deepStrictEqual(plan(s2), []);
    assert.strictEqual(sends50(s2).length, 0);
});

t.test('an unseen grid that later shows the rebuild is cleared by plan', function () {
    var s = setup();
    unseen(s);
    s.clock.now += 5 * 60000;
    s.shells[0].constructing = true;
    assert.deepStrictEqual(plan(s), []);
    assert.ok(!fileEntries(s)[KEY], 'entry removed');
    assert.strictEqual(logged(s, 'log', /^rebuild Well_03 10: observed after 5 min$/).length, 1);
    assert.strictEqual(s.L.breaker('rebuild').snapshot().run, 0);
});

t.test('an unseen grid that still shows the idle shell after 30 min is freed and queued again', function () {
    var s = setup();
    unseen(s);
    s.clock.now += 29 * 60000;
    assert.deepStrictEqual(plan(s), [], 'not judged before 30 min');
    s.clock.now += 2 * 60000;
    assert.deepStrictEqual(plan(s), [[10, 'Well_03']]);
    assert.ok(!fileEntries(s)[KEY], 'entry removed');
    assert.strictEqual(logged(s, 'warn', /^rebuild Well_03 10: failed after 31 min: grid 10 still shows /).length, 1);
});

t.test('place sends nothing and writes no entry off home or on an unreadable viewed zone', function () {
    var s = setup();
    s.gi.isOnHomzone = function () { return false; };
    fire(s, 10, 'Well_03');
    assert.strictEqual(sends50(s).length, 0);
    assert.ok(!fileEntries(s)[KEY]);
    var s2 = setup();
    s2.gi.mCurrentViewedZoneID = 'x';
    fire(s2, 10, 'Well_03');
    assert.strictEqual(sends50(s2).length, 0);
    assert.ok(!fileEntries(s2)[KEY]);
});

t.test('place sends nothing when the grid no longer holds the shell', function () {
    var s = setup();
    s.shells[0].name = 'Well';
    fire(s, 10, 'Well_03');
    assert.strictEqual(sends50(s).length, 0);
    assert.ok(!fileEntries(s)[KEY]);
});

t.test('without a file API plan queues nothing and place sends nothing', function () {
    var s = setup({ noFs: true });
    assert.deepStrictEqual(plan(s), []);
    fire(s, 10, 'Well_03');
    assert.strictEqual(sends50(s).length, 0);
});

t.test('an attempt in flight keeps the module busy and its grid blocked', function () {
    var s = setup({ shells: [{ name: WELL, grid: 10 }, { name: FIELD, grid: 11 }] });
    var K = s.S.kernel;
    // The kernel queue tags entries added while a module's action runs with
    // that module, which is what keeps the scheduler from calling plan().
    K._currentModule = 'rebuild';
    var steps = 0;
    var checked = false;
    try {
        s.place([10, 'Well_03']);
        for (;;) {
            var entries = s.H.queued().filter(function (e) { return e.name === 'core.attempt'; });
            s.H.clearQueued();
            if (!entries.length || steps > 300) break;
            for (var i = 0; i < entries.length; i++) {
                assert.strictEqual(entries[i].moduleId, 'rebuild', 'step tagged with the module');
                s.S.core.actions.step(entries[i].params);
                steps++;
                if (sends50(s).length === 1 && steps === 1) {
                    K._currentModule = null;
                    assert.strictEqual(s.L.blocked(KEY), 'sent');
                    s.H.module('rebuild').plan(HOME);
                    var again = s.H.queued().filter(function (e) {
                        return e.name === 'rebuild.place' && e.params[0] === 10;
                    });
                    assert.strictEqual(again.length, 0, 'grid 10 not queued while in flight');
                    checked = true;
                    K._currentModule = 'rebuild';
                }
            }
        }
    } finally {
        K._currentModule = null;
    }
    assert.ok(checked, 'plan ran while the send was in flight');
    assert.ok(steps > 1, 'the attempt ran several steps');
    assert.strictEqual(sends50(s).length, 1);
});
