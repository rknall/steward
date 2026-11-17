'use strict';

// Mining build and upgrade sends: per-grid holds persisted before the send,
// verification on the grid, the build breaker and the queue actions that
// start them (src/modules/mining/builds.js, module.js).

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var AC = require('../stubs/actions');
var Z = require('../stubs/zone');

var assert = t.assert;

var NAMES = ['Stone', 'BronzeOre', 'Marble', 'IronOre', 'GoldOre',
             'Coal', 'Granite', 'TitaniumOre', 'Salpeter'];

var T0 = 1700000000000;

// Values from the vm context have their own prototypes.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function settings(opts) {
    opts = opts || {};
    var deposits = {};
    for (var i = 0; i < NAMES.length; i++) {
        var on = NAMES[i] === 'IronOre';
        deposits[NAMES[i]] = {
            enabled: on, build: on && !!opts.build, upgrade: on && !!opts.upgrade,
            targetLevel: typeof opts.target === 'number' ? opts.target : 2,
            pause: false, buff: '', refill: ''
        };
    }
    return { enabled: true, actionDelay: 0, deposits: deposits };
}

// A booted harness with the given disk (none: no file API), a packet
// recorder, a fake clock for the hold store, the IronOre deposits on the
// given grids, one unrelated building (so the building list reads) and the
// captured mining queue handlers.
function setup(opts) {
    opts = opts || {};
    var fs = opts.noFs ? null : (opts.fs || airfs.make());
    var H = fs ? harness.boot({ host: { air: fs.air } }) : harness.boot();
    var sent = AC.wire(H);
    var grids = opts.grids || [12];
    var depos = [];
    for (var i = 0; i < grids.length; i++) depos.push(Z.deposit({ name: 'IronOre', grid: grids[i] }));
    var z = H.zone.zone().deposits('IronOre', depos).buildQueue(0, 10);
    if (!opts.noOther) z.building(Z.building({ name: 'Woodcutter', grid: 99 }));
    var extra = opts.buildings || [];
    for (var j = 0; j < extra.length; j++) z.building(extra[j]);
    H.installZone(z);
    H.settings.write('mining', settings(opts));

    var clock = { now: typeof opts.now === 'number' ? opts.now : T0 };
    var builds = H.Steward.modules.mining.builds;
    builds.clock = function () { return clock.now; };

    var q = H.Steward.kernel.queue;
    var orig = q.action;
    var handlers = {};
    q.action = function (name, f) {
        handlers[name] = f;
        return orig.apply(q, arguments);
    };
    H.module('mining').boot();
    q.action = orig;
    H.clearQueued();

    var s = { H: H, fs: fs, z: z, sent: sent, clock: clock, builds: builds, handlers: handlers };
    s.path = fs ? holdPath(H) : null;
    return s;
}

function holdPath(H) {
    var d = H.Steward.kernel.files.stewardDir('mining');
    return d.dir.resolvePath('holds.json').nativePath;
}

// The hold file on disk, parsed, or null when there is none.
function holdFile(s) {
    var keys = Object.keys(s.fs.disk).filter(function (k) { return /\/mining\/holds\.json$/.test(k); });
    if (keys.length === 0) return null;
    return JSON.parse(s.fs.disk[keys[0]]);
}

function fileHolds(s) {
    var f = holdFile(s);
    return f ? f.holds : {};
}

// Runs one plan pass and returns the mining queue entries it added.
function plan(s) {
    s.H.clearQueued();
    s.H.module('mining').plan({ zone: { isHome: true } });
    var out = s.H.queued().filter(function (e) { return /^mining\./.test(e.name); });
    s.H.clearQueued();
    return out;
}

function named(entries, name) {
    return entries.filter(function (e) { return e.name === name; });
}

function logged(s, level, re) {
    return s.H.logs().filter(function (l) {
        return l.level === level && l.category === 'mining' && re.test(l.args.join(' '));
    });
}

function builds50(s) {
    return s.sent.actions.filter(function (a) { return a.id === 50; });
}

// Plans and runs the build of grid 12, then drives the attempt to its end.
function buildOnce(s, driveOpts) {
    var b = named(plan(s), 'mining.buildMine');
    assert.strictEqual(b.length, 1, 'one build queued');
    s.handlers['mining.buildMine'](b[0].params);
    return AC.drive(s.H, driveOpts);
}

function addMine(s, grid, extra) {
    var o = { name: 'IronMine', grid: grid };
    for (var k in extra) o[k] = extra[k];
    s.z.building(Z.building(o));
}

t.test('build: one action 50 whose hold is on disk before the host call', function () {
    var s = setup({ build: true });
    var gi = s.H.host.game.gi;
    var base = gi.SendServerAction;
    var atSend = null;
    gi.SendServerAction = function (id) {
        if (id === 50) atSend = holdFile(s);
        return base.apply(this, arguments);
    };
    buildOnce(s, { onStep: function (n) { if (n === 2) addMine(s, 12); } });
    assert.deepStrictEqual(plain(builds50(s)),
        [{ id: 50, p1: 50, p2: 12, p3: 0, data: null }]);
    assert.ok(atSend && atSend.holds['build|12'], 'hold written before the send');
    assert.strictEqual(atSend.holds['build|12'].until, T0 + s.builds.HOLD_MS);
    assert.strictEqual(atSend.holds['build|12'].name, 'IronMine');
    assert.strictEqual(logged(s, 'log', /^placed IronMine on grid 12 \(IronOre\)$/).length, 1);
});

t.test('build: a hold that cannot be written sends nothing and keeps no hold', function () {
    var s = setup({ build: true });
    s.fs.fail.move[s.path] = true;
    buildOnce(s);
    assert.strictEqual(builds50(s).length, 0);
    assert.deepStrictEqual(plain(s.builds.entries()), {});
    assert.strictEqual(holdFile(s), null);
    assert.strictEqual(logged(s, 'warn', /could not write the build hold for build\|12/).length, 1);
});

t.test('build: an unseen build keeps its hold, counts a miss and is not queued again', function () {
    var s = setup({ build: true });
    buildOnce(s);
    assert.strictEqual(builds50(s).length, 1, 'retries 0: one send only');
    assert.ok(fileHolds(s)['build|12'], 'hold stays on disk');
    assert.strictEqual(s.builds.breaker.snapshot().run, 1);
    assert.strictEqual(logged(s, 'warn', /IronMine on grid 12 was not seen after the build/).length, 1);
    s.clock.now += 29 * 60000;
    assert.strictEqual(named(plan(s), 'mining.buildMine').length, 0);
    assert.strictEqual(builds50(s).length, 1);
});

t.test('build: a reload reads the hold back and queues nothing for the grid', function () {
    var s = setup({ build: true });
    buildOnce(s);
    var s2 = setup({ build: true, fs: s.fs, now: T0 + 10 * 60000 });
    assert.ok(s2.builds.entries()['build|12'], 'hold read back');
    assert.strictEqual(logged(s2, 'log', /^read back 1 build\/upgrade hold\(s\) from .*mining\/holds\.json$/).length, 1);
    assert.strictEqual(named(plan(s2), 'mining.buildMine').length, 0);
    assert.strictEqual(builds50(s2).length, 0);
});

t.test('build: a far-future hold is capped and an expired one pruned on load', function () {
    var probe = setup({ build: true });
    var fs = probe.fs;
    var now = T0 + 3600000;
    fs.disk[probe.path] = JSON.stringify({
        version: 1,
        holds: {
            'build|12': { until: now + 10 * 3600000, sent: now - 1000, name: 'IronMine' },
            'build|13': { until: now - 1, sent: now - 1800001, name: 'IronMine' }
        }
    });
    var s = setup({ build: true, fs: fs, now: now });
    var e = s.builds.entries();
    assert.strictEqual(e['build|12'].until, now + s.builds.HOLD_MS, 'capped to one hold from now');
    assert.ok(!e['build|13'], 'expired entry not kept');
    var onDisk = fileHolds(s);
    assert.strictEqual(onDisk['build|12'].until, now + s.builds.HOLD_MS);
    assert.ok(!onDisk['build|13'], 'expired entry pruned from the file');
});

t.test('build: after 30 min an empty, readable grid gets exactly one new send and hold', function () {
    var s = setup({ build: true });
    buildOnce(s);
    s.clock.now += s.builds.HOLD_MS + 1000;
    buildOnce(s);
    assert.strictEqual(builds50(s).length, 2, 'one new send after expiry');
    assert.strictEqual(fileHolds(s)['build|12'].until, s.clock.now + s.builds.HOLD_MS);
    assert.strictEqual(logged(s, 'log', /build hold build\|12 \(IronMine\) expired after 30 min/).length, 1);
});

t.test('build: after 30 min an unreadable building list sends nothing', function () {
    var s = setup({ build: true });
    buildOnce(s);
    s.clock.now += s.builds.HOLD_MS + 1000;
    var list = s.z.zone.mStreetDataMap.mBuildingContainer;
    list.splice(0, list.length);
    buildOnce(s);
    assert.strictEqual(builds50(s).length, 1, 'no send while the list is unreadable');
    assert.ok(!s.builds.entries()['build|12'], 'no new hold');
});

t.test('build: after 30 min a mine on the grid drops the hold and queues nothing', function () {
    var s = setup({ build: true });
    buildOnce(s);
    s.clock.now += s.builds.HOLD_MS + 1000;
    addMine(s, 12);
    assert.strictEqual(plan(s).length, 0);
    assert.ok(!fileHolds(s)['build|12'], 'hold dropped from the file');
    assert.strictEqual(s.builds.breaker.snapshot().run, 0, 'the late sighting closes the run');
    assert.strictEqual(builds50(s).length, 1);
});

t.test('build: the mine seen within the window verifies and clears the hold', function () {
    var s = setup({ build: true });
    s.builds.breaker.miss();
    buildOnce(s, { onStep: function (n) { if (n === 3) addMine(s, 12); } });
    assert.ok(!fileHolds(s)['build|12'], 'hold removed from the file');
    assert.deepStrictEqual(plain(s.builds.entries()), {});
    var b = s.builds.breaker.snapshot();
    assert.strictEqual(b.open, false);
    assert.strictEqual(b.run, 0);
    assert.strictEqual(logged(s, 'log', /^IronMine on grid 12 seen, build hold cleared$/).length, 1);
});

// The upgrade fixture: IronMine level 1 on grid 12, target level 2, and a
// recording UpgradeBuildingOnGridPosition stub.
function upgradeSetup() {
    var mine = { name: 'IronMine', grid: 12, level: 1, upgradable: true, upgrading: false };
    var s = setup({ upgrade: true, buildings: [Z.building(mine)] });
    s.mine = mine;
    s.calls = [];
    s.H.host.game.zone.UpgradeBuildingOnGridPosition = function (g) {
        s.calls.push({ grid: g, file: holdFile(s) });
    };
    return s;
}

function upgradeOnce(s, driveOpts) {
    var u = named(plan(s), 'mining.upgradeMine');
    assert.strictEqual(u.length, 1, 'one upgrade queued');
    assert.deepStrictEqual(plain(u[0].params), [12, 'IronMine', 2]);
    s.handlers['mining.upgradeMine'](u[0].params);
    return AC.drive(s.H, driveOpts);
}

t.test('upgrade: one host call with the hold on disk first, verified on upgrading', function () {
    var s = upgradeSetup();
    upgradeOnce(s, { onStep: function (n) { if (n === 2) s.mine.upgrading = true; } });
    assert.strictEqual(s.calls.length, 1);
    assert.strictEqual(s.calls[0].grid, 12);
    assert.ok(s.calls[0].file && s.calls[0].file.holds['upgrade|12|2'], 'hold written before the call');
    assert.strictEqual(logged(s, 'log', /^upgrading IronMine on grid 12 to level 2$/).length, 1);
    assert.ok(!fileHolds(s)['upgrade|12|2'], 'verified: hold cleared');
    assert.strictEqual(logged(s, 'log', /upgrade to level 2 seen, hold cleared/).length, 1);
});

t.test('upgrade: a second handler call 2 s after the first sends nothing', function () {
    var s = upgradeSetup();
    var u = named(plan(s), 'mining.upgradeMine');
    s.handlers['mining.upgradeMine'](u[0].params);
    AC.drive(s.H, { max: 1 });
    s.clock.now += 2000;
    s.handlers['mining.upgradeMine'](u[0].params);
    AC.drive(s.H);
    assert.strictEqual(s.calls.length, 1, 'the observed double is gone');
    assert.strictEqual(logged(s, 'log', /^upgrade\|12\|2 is held, nothing sent$/).length, 1);
    assert.ok(fileHolds(s)['upgrade|12|2'], 'the refused second call keeps the hold');
});

t.test('upgrade: unseen keeps the hold; after 30 min one new call, or none when unreadable or reached', function () {
    var s = upgradeSetup();
    upgradeOnce(s);
    assert.strictEqual(s.calls.length, 1);
    assert.ok(fileHolds(s)['upgrade|12|2'], 'hold stays');
    assert.strictEqual(s.builds.breaker.snapshot().run, 1);
    assert.strictEqual(logged(s, 'warn', /upgrade to level 2 was not seen/).length, 1);
    s.clock.now += 10 * 60000;
    assert.strictEqual(named(plan(s), 'mining.upgradeMine').length, 0, 'held within 30 min');

    s.clock.now += s.builds.HOLD_MS;
    upgradeOnce(s);
    assert.strictEqual(s.calls.length, 2, 'one new call after expiry');
    assert.strictEqual(fileHolds(s)['upgrade|12|2'].until, s.clock.now + s.builds.HOLD_MS);

    // Expired again, but the upgrade state cannot be read: nothing goes out.
    s.clock.now += s.builds.HOLD_MS + 1000;
    var b = s.z.zone.GetBuildingFromGridPosition(12);
    delete b.IsUpgradeInProgress;
    upgradeOnce(s);
    assert.strictEqual(s.calls.length, 2, 'unreadable upgrade state sends nothing');

    // The level arrives: the plan drops any hold for it and queues nothing.
    s.mine.level = 2;
    assert.strictEqual(plan(s).length, 0);
    assert.ok(!fileHolds(s)['upgrade|12|2']);
});

t.test('upgrade: a held grid that reads upgrading drops its hold', function () {
    var s = upgradeSetup();
    upgradeOnce(s);
    assert.ok(fileHolds(s)['upgrade|12|2']);
    s.mine.upgrading = true;
    s.clock.now += 60000;
    assert.strictEqual(plan(s).length, 0);
    assert.ok(!fileHolds(s)['upgrade|12|2'], 'upgrade in progress is the effect');
    assert.strictEqual(s.builds.breaker.snapshot().run, 0);
});

t.test('build: a throwing send fails, keeps the hold, counts no miss and is not resent', function () {
    var s = setup({ build: true });
    var tries = 0;
    s.H.host.game.gi.SendServerAction = function () {
        tries++;
        throw new Error('host down');
    };
    buildOnce(s);
    assert.strictEqual(tries, 1);
    assert.ok(fileHolds(s)['build|12'], 'hold stays');
    assert.strictEqual(s.builds.breaker.snapshot().run, 0, 'no miss for a failed send');
    assert.strictEqual(logged(s, 'warn', /build IronMine 12 failed: send failed/).length, 1);
    s.clock.now += 60000;
    assert.strictEqual(named(plan(s), 'mining.buildMine').length, 0);
    assert.strictEqual(tries, 1);
});

t.test('breaker: 5 unseen builds open it; plan waits for the probe; buff breaker untouched', function () {
    var s = setup({ build: true, grids: [12, 13, 14, 15, 16] });
    var b = named(plan(s), 'mining.buildMine');
    assert.strictEqual(b.length, 5);
    for (var i = 0; i < b.length; i++) s.handlers['mining.buildMine'](b[i].params);
    AC.drive(s.H, { max: 200 });
    assert.strictEqual(builds50(s).length, 5);
    assert.strictEqual(s.builds.breaker.snapshot().open, true);
    assert.strictEqual(logged(s, 'warn', /^build breaker open: 5 /).length, 1);

    // Fresh work: two empty deposits and a mine to upgrade.
    var depos = [];
    var grids = [12, 13, 14, 15, 16, 17, 18, 20];
    for (var j = 0; j < grids.length; j++) depos.push(Z.deposit({ name: 'IronOre', grid: grids[j] }));
    s.z.deposits('IronOre', depos);
    addMine(s, 20, { level: 1, upgradable: true, upgrading: false });
    s.H.settings.write('mining', settings({ build: true, upgrade: true }));

    s.clock.now += 60000;
    assert.strictEqual(plan(s).length, 0, 'open breaker: no build or upgrade');

    s.clock.now += 5 * 60000;
    var probe = plan(s);
    assert.strictEqual(probe.length, 1, 'one probe after the cooldown');
    assert.strictEqual(probe[0].name, 'mining.buildMine');
    assert.strictEqual(plan(s).length, 0, 'the probe is spent');

    var buff = s.H.Steward.modules.mining.buffBreaker.snapshot();
    assert.strictEqual(buff.open, false);
    assert.strictEqual(buff.run, 0);
});

t.test('no file API: plan still queues, the handler sends nothing', function () {
    var s = setup({ build: true, noFs: true });
    var b = named(plan(s), 'mining.buildMine');
    assert.strictEqual(b.length, 1);
    s.handlers['mining.buildMine'](b[0].params);
    AC.drive(s.H);
    assert.strictEqual(builds50(s).length, 0);
    assert.deepStrictEqual(plain(s.builds.entries()), {});
});
