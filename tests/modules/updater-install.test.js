'use strict';

// The install flow of the updater: guards, verification of the download,
// quiescing, the backup and the atomic write, the post-install notice, and the
// reload timer that also carries a step-down's settings restore.

var crypto = require('crypto');
var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var netStub = require('../stubs/net');
var build = require('../../scripts/build');

var assert = t.assert;

var APP = 'C:/client';
var BUNDLE = APP + '/userscripts/user_steward.js';
var BUNDLE_BACKUP = APP + '/userscripts/user_steward.js.backup';
var PREFIX = 'https://github.com/rknall/steward/releases/download/';

// The fixtures carry the banner the build script writes, so a change to its
// first line breaks these tests instead of the real install.
function bundleText(version) {
    return build.banner(version, 'abc1234', '2026-11-11', 1, 100) + '\n(function () { /* ' + version + ' */ }());\n';
}

var OLD_TEXT = bundleText('0.11.0');

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// A boot with the file system, the network and the recording timers wired in.
// running is the version the instance claims to be; with a null bundle the
// userscripts file does not exist.
function setup(running, opts) {
    opts = opts || {};
    var fs = airfs.make();
    var net = netStub.make(fs);
    var timers = [];
    var H = harness.boot({
        host: { air: fs.air },
        timers: {
            setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms, fired: false }); return timers.length; },
            clearTimeout: function () {}
        }
    });
    var S = H.Steward;
    var U = S.modules.updater;
    S.kernel.VERSION = running;
    H.ctx.settingsFile = 'settings.json';
    var ctl = { edits: false, paused: false };
    var calls = { notify: [], close: [], start: 0, stop: 0, reset: 0, reloads: [] };
    S.kernel.ui.hasOpenEdits = function () { return ctl.edits; };
    S.kernel.ui.isPaused = function () { return ctl.paused; };
    S.kernel.ui.notify = function (text) { calls.notify.push(text); };
    S.kernel.ui.closeDashboard = function (commit) { calls.close.push(commit); };
    S.kernel.scheduler.start = function () { calls.start++; };
    S.kernel.scheduler.stop = function () { calls.stop++; };
    S.kernel.queue.reset = function () { calls.reset++; };
    if (opts.reload !== false) {
        H.ctx.reloadScripts = function () {
            calls.reloads.push({ mining: plain(H.host.settings.settings['steward.mining'] || null) });
        };
    }
    if (opts.bundle !== false) {
        fs.dirs[APP + '/userscripts'] = true;
        fs.disk[BUNDLE] = OLD_TEXT;
        fs.bytes[BUNDLE] = Buffer.from(OLD_TEXT, 'utf8');
    }
    return { H: H, S: S, U: U, fs: fs, net: net, timers: timers, ctl: ctl, calls: calls,
             host: H.host.settings };
}

// A release record for `version` whose asset is `buf`; over replaces fields of
// the asset (size, digest).
function release(s, version, buf, over) {
    var rel = {
        tag: 'v' + version,
        text: version,
        version: s.S.kernel.semver.parse(version),
        name: 'Steward v' + version,
        body: '',
        published: 0,
        prerelease: false,
        asset: { url: PREFIX + 'v' + version + '/user_steward.js', size: buf.length, digest: sha(buf) }
    };
    for (var k in over) if (over.hasOwnProperty(k)) rel.asset[k] = over[k];
    return rel;
}

// Runs an install and answers the download with `buf` at once.
function install(s, rel, buf, opts) {
    var results = [];
    s.U.install.run(rel, opts || { auto: false, restore: null }, function (r) { results.push(plain(r)); });
    if (buf) s.net.respondBytes(s.net.requests.length - 1, buf);
    return results;
}

function reloadTimers(s) {
    var delay = s.U.REPO.reloadDelayMs;
    return s.timers.filter(function (x) { return x.ms === delay; });
}

function fire(s) {
    var list = reloadTimers(s);
    assert.strictEqual(list.length, 1, 'one reload timer');
    list[0].fired = true;
    list[0].fn();
}

function untouched(s) {
    assert.strictEqual(s.fs.bytes[BUNDLE].toString('utf8'), OLD_TEXT);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s.fs.disk, BUNDLE_BACKUP), false);
    assert.strictEqual(reloadTimers(s).length, 0);
    assert.strictEqual(s.calls.reloads.length, 0);
    assert.strictEqual(s.U.backups.list().length, 0);
}

function seedSettings(s) {
    s.host.settings['steward.kernel'] = { paused: false, logLevel: 'LOG' };
    s.host.settings['steward.mining'] = { enabled: true, gen: 'seed' };
}

t.test('happy path: new bytes in the bundle, old bytes kept, backup and notice written', function () {
    var s = setup('0.11.0');
    seedSettings(s);
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var rel = release(s, '0.12.0', buf);

    var results = install(s, rel, buf);

    assert.strictEqual(s.net.requests[0].url, rel.asset.url);
    assert.strictEqual(s.fs.bytes[BUNDLE].toString('utf8'), buf.toString('utf8'));
    assert.strictEqual(s.fs.bytes[BUNDLE_BACKUP].toString('utf8'), OLD_TEXT);
    assert.strictEqual(results.length, 1);
    assert.deepStrictEqual(results[0], { ok: true, failure: null, version: '0.12.0' });

    var list = s.U.backups.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].fromVersion, '0.11.0');
    assert.strictEqual(list[0].toVersion, '0.12.0');

    var notice = plain(s.H.settings.store.updaterState.notice);
    assert.strictEqual(notice.from, '0.11.0');
    assert.strictEqual(notice.to, '0.12.0');
    assert.strictEqual(notice.auto, false);
    assert.strictEqual(notice.backup, list[0].name);
    assert.strictEqual(notice.restore, null);
    assert.strictEqual(notice.restored, false);

    // The backup was written from the settings as they were before the install.
    var body = JSON.parse(s.fs.disk[list[0].path]);
    assert.strictEqual(body.namespaces.mining.gen, 'seed');

    assert.deepStrictEqual(s.calls.close, [false]);
    assert.deepStrictEqual(s.calls.notify, [s.U.text.installing('0.12.0')]);
    assert.strictEqual(s.calls.stop, 1);
    assert.strictEqual(s.calls.reset, 1);
    assert.strictEqual(s.calls.start, 0);
});

t.test('the reload happens once, only after the timer fires', function () {
    var s = setup('0.11.0');
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    install(s, release(s, '0.12.0', buf), buf);

    assert.strictEqual(s.calls.reloads.length, 0);
    assert.strictEqual(reloadTimers(s).length, 1);
    assert.strictEqual(reloadTimers(s)[0].ms, s.U.REPO.reloadDelayMs);
    fire(s);
    assert.strictEqual(s.calls.reloads.length, 1);
});

t.test('the install steps are reported in order through the redraw hook', function () {
    var s = setup('0.11.0');
    var steps = [];
    s.U.redraw = function () { steps.push(s.U.install.step()); };
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var I = s.S.InstallStep;
    install(s, release(s, '0.12.0', buf), buf);
    var seen = [];
    for (var i = 0; i < steps.length; i++) if (seen[seen.length - 1] !== steps[i]) seen.push(steps[i]);
    assert.deepStrictEqual(seen, [I.Download, I.Verify, I.Backup, I.Write, I.Reload]);
});

t.test('a size mismatch aborts before anything is written', function () {
    var s = setup('0.11.0');
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var rel = release(s, '0.12.0', buf, { size: buf.length + 1 });
    var results = install(s, rel, buf);
    assert.strictEqual(results[0].ok, false);
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.SizeMismatch);
    untouched(s);
    assert.strictEqual(s.calls.stop, 0);
    assert.strictEqual(s.U.install.busy(), false);
});

t.test('a digest mismatch aborts before anything is written', function () {
    var s = setup('0.11.0');
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var rel = release(s, '0.12.0', buf, { digest: sha(Buffer.from('something else')) });
    var results = install(s, rel, buf);
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.DigestMismatch);
    untouched(s);
    assert.strictEqual(s.U.install.busy(), false);
});

t.test('a banner naming another version aborts before anything is written', function () {
    var s = setup('0.11.0');
    // Right size and checksum for the bytes, but the file is v0.13.0.
    var buf = Buffer.from(bundleText('0.13.0'), 'utf8');
    var rel = release(s, '0.12.0', buf);
    var results = install(s, rel, buf);
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.VersionMismatch);
    untouched(s);
});

t.test('a file without a banner aborts, also without a digest', function () {
    var s = setup('0.11.0');
    var buf = Buffer.from('console.log("no banner");\n', 'utf8');
    var rel = release(s, '0.12.0', buf, { digest: null });
    var results = install(s, rel, buf);
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.VersionMismatch);
    untouched(s);
});

t.test('a release without a digest installs by size and banner', function () {
    var s = setup('0.11.0');
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var results = install(s, release(s, '0.12.0', buf, { digest: null }), buf);
    assert.strictEqual(results[0].ok, true);
    assert.strictEqual(s.fs.bytes[BUNDLE].toString('utf8'), buf.toString('utf8'));
});

t.test('a failed download ends the run and frees the guard', function () {
    var s = setup('0.11.0');
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var results = [];
    s.U.install.run(release(s, '0.12.0', buf), { auto: false, restore: null },
        function (r) { results.push(plain(r)); });
    assert.strictEqual(s.U.install.busy(), true);
    s.net.failBytes(0);
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.Network);
    assert.strictEqual(s.U.install.busy(), false);
    untouched(s);
});

t.test('a failed write restarts a running scheduler', function () {
    var s = setup('0.11.0');
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    s.fs.fail.move[BUNDLE] = true;
    var results = install(s, release(s, '0.12.0', buf), buf);
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.WriteFailed);
    assert.strictEqual(s.calls.stop, 1);
    assert.strictEqual(s.calls.start, 1);
    assert.strictEqual(s.fs.bytes[BUNDLE].toString('utf8'), OLD_TEXT);
    assert.strictEqual(reloadTimers(s).length, 0);
    assert.strictEqual(s.U.install.busy(), false);
});

t.test('a failed write leaves a paused scheduler stopped', function () {
    var s = setup('0.11.0');
    s.ctl.paused = true;
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    s.fs.fail.move[BUNDLE] = true;
    var results = install(s, release(s, '0.12.0', buf), buf);
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.WriteFailed);
    assert.strictEqual(s.calls.stop, 1);
    assert.strictEqual(s.calls.start, 0);
});

t.test('a failed settings backup aborts before the bundle is touched', function () {
    var s = setup('0.11.0');
    s.U.backups.create = function () { return { ok: false, message: 'disk full' }; };
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var results = install(s, release(s, '0.12.0', buf), buf);
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.BackupFailed);
    assert.strictEqual(s.fs.bytes[BUNDLE].toString('utf8'), OLD_TEXT);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s.fs.disk, BUNDLE_BACKUP), false);
    assert.strictEqual(s.calls.start, 1);
});

t.test('an old backup is pruned after an install, the new one stays', function () {
    var s = setup('0.11.0');
    seedSettings(s);
    s.H.Steward.modules.updater.now = (function () { var n = Date.UTC(2026, 1, 1); return function () { return n += 60000; }; }());
    s.host.settings['steward.updater'] = { keepBackups: 1 };
    s.S.kernel.settings.write('updater', { keepBackups: 1 });
    s.U.backups.create('0.9.0', '0.10.0');
    s.U.backups.create('0.10.0', '0.11.0');
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    install(s, release(s, '0.12.0', buf), buf);
    var list = s.U.backups.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].toVersion, '0.12.0');
});

t.test('a missing bundle gives BundleMissing without a request', function () {
    var s = setup('0.11.0', { bundle: false });
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var results = install(s, release(s, '0.12.0', buf), null);
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.BundleMissing);
    assert.strictEqual(s.net.requests.length, 0);
    assert.strictEqual(s.U.install.busy(), false);
});

t.test('open Settings edits give OpenEdits without a request', function () {
    var s = setup('0.11.0');
    s.ctl.edits = true;
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var results = install(s, release(s, '0.12.0', buf), null);
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.OpenEdits);
    assert.strictEqual(s.net.requests.length, 0);
    assert.strictEqual(s.calls.stop, 0);
});

t.test('a second run while one is in flight gives Busy and leaves the first alone', function () {
    var s = setup('0.11.0');
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var rel = release(s, '0.12.0', buf);
    var first = [];
    s.U.install.run(rel, { auto: false, restore: null }, function (r) { first.push(plain(r)); });
    var second = [];
    s.U.install.run(rel, { auto: false, restore: null }, function (r) { second.push(plain(r)); });
    assert.strictEqual(second[0].failure, s.S.UpdateFailure.Busy);
    assert.strictEqual(s.net.requests.length, 1);
    assert.strictEqual(s.U.install.busy(), true);
    s.net.respondBytes(0, buf);
    assert.strictEqual(first[0].ok, true);
});

t.test('after a successful install the instance stays busy until the reload', function () {
    var s = setup('0.11.0');
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var rel = release(s, '0.12.0', buf);
    install(s, rel, buf);
    assert.strictEqual(s.U.install.busy(), true);
    var again = [];
    s.U.install.run(rel, { auto: false, restore: null }, function (r) { again.push(plain(r)); });
    assert.strictEqual(again[0].failure, s.S.UpdateFailure.Busy);
    assert.strictEqual(s.net.requests.length, 1);
    assert.deepStrictEqual(plain(s.U.install.last()), { ok: true, failure: null, version: '0.12.0' });
});

t.test('automatic install of a development running version gives AutoBlocked', function () {
    var s = setup('0.11.0-3-gabc1234');
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var results = install(s, release(s, '0.12.0', buf), null, { auto: true, restore: null });
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.AutoBlocked);
    assert.strictEqual(s.net.requests.length, 0);
});

t.test('automatic install of a prerelease target gives AutoBlocked', function () {
    var s = setup('0.11.0');
    var buf = Buffer.from(bundleText('0.12.0-beta1'), 'utf8');
    var results = install(s, release(s, '0.12.0-beta1', buf), null, { auto: true, restore: null });
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.AutoBlocked);
});

t.test('automatic install without a digest gives NoDigest', function () {
    var s = setup('0.11.0');
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var results = install(s, release(s, '0.12.0', buf, { digest: null }), null, { auto: true, restore: null });
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.NoDigest);
    assert.strictEqual(s.net.requests.length, 0);
});

t.test('an automatic install of a newer plain release goes through and is marked auto', function () {
    var s = setup('0.11.0');
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var results = install(s, release(s, '0.12.0', buf), buf, { auto: true, restore: null });
    assert.strictEqual(results[0].ok, true);
    assert.strictEqual(s.H.settings.store.updaterState.notice.auto, true);
});

// A step-down from 0.12.0 to 0.11.0 with a backup that 0.11.0 wrote when it
// was left. The settings at the time of the step-down differ from it.
function stepDown(s) {
    seedSettings(s);
    s.host.settings['steward.kernel'].paused = false;
    s.ctl.paused = true;
    var older = s.U.backups.create('0.11.0', '0.12.0');
    assert.strictEqual(older.ok, true);
    s.host.settings['steward.kernel'] = { paused: true, logLevel: 'DEBUG', fresh: 1 };
    s.host.settings['steward.mining'] = { enabled: false, gen: 'current' };
    s.host.settings['steward.newmodule'] = { x: 1 };
    var buf = Buffer.from(bundleText('0.11.0'), 'utf8');
    var results = install(s, release(s, '0.11.0', buf), buf, { auto: false, restore: older.record });
    return { results: results, record: older.record };
}

t.test('a step-down keeps the current settings until the timer fires', function () {
    var s = setup('0.12.0');
    var saves0;
    seedSettings(s);
    saves0 = s.host.saves;
    var r = stepDown(s);
    assert.strictEqual(r.results[0].ok, true);
    assert.strictEqual(s.host.settings['steward.mining'].gen, 'current');
    assert.strictEqual('steward.newmodule' in s.host.settings, true);
    assert.strictEqual(s.host.saves, saves0);
    assert.strictEqual(s.calls.reloads.length, 0);
    assert.strictEqual(s.H.settings.store.updaterState.notice.restore, r.record.name);
    assert.strictEqual(s.H.settings.store.updaterState.notice.restored, false);
});

t.test('the step-down restore runs inside the timer, right before reloadScripts', function () {
    var s = setup('0.12.0');
    var r = stepDown(s);
    var saves = s.host.saves;
    fire(s);
    assert.strictEqual(s.host.saves, saves + 1);
    assert.strictEqual(s.calls.reloads.length, 1);
    // The reload already saw the restored settings.
    assert.strictEqual(s.calls.reloads[0].mining.gen, 'seed');
    assert.strictEqual('steward.newmodule' in s.host.settings, false);
    assert.strictEqual(s.host.settings['steward.kernel'].logLevel, 'LOG');
    assert.strictEqual(s.host.settings['steward.kernel'].fresh, undefined);
    assert.ok(r.record.name);
});

t.test('a step-down with keepBackups 1 keeps the picked record until the timer fires', function () {
    var s = setup('0.12.0');
    var clock = Date.UTC(2026, 1, 1);
    s.U.now = function () { clock += 60000; return clock; };
    s.S.kernel.settings.write('updater', { keepBackups: 1 });
    seedSettings(s);
    var older = s.U.backups.create('0.11.0', '0.12.0');
    s.host.settings['steward.mining'] = { enabled: false, gen: 'current' };
    var pick = s.U.backups.pick('0.11.0');
    assert.strictEqual(pick.exact, true);
    var buf = Buffer.from(bundleText('0.11.0'), 'utf8');
    var results = install(s, release(s, '0.11.0', buf), buf, { auto: false, restore: pick.record });
    assert.strictEqual(results[0].ok, true);
    // The new backup and the picked one both survive the prune.
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s.fs.disk, older.path), true);
    assert.strictEqual(s.U.backups.list().length, 2);
    fire(s);
    assert.strictEqual(s.host.settings['steward.mining'].gen, 'seed');
    assert.strictEqual(plain(s.host.settings['steward.updaterState']).notice.restored, true);
});

t.test('the step-down restore keeps the current pause and the updater state', function () {
    var s = setup('0.12.0');
    stepDown(s);
    fire(s);
    assert.strictEqual(s.host.settings['steward.kernel'].paused, true);
    var state = plain(s.host.settings['steward.updaterState']);
    assert.strictEqual(state.notice.to, '0.11.0');
    assert.strictEqual(state.notice.restored, true);
});

t.test('the step-down restore takes the runtime pause, not the persisted copy', function () {
    var s = setup('0.12.0');
    stepDown(s);
    s.ctl.paused = false;
    s.host.settings['steward.kernel'].paused = true;
    fire(s);
    assert.strictEqual(s.host.settings['steward.kernel'].paused, false);
});

t.test('install.target is the release text from the start, stays after success, null after a failure', function () {
    var s = setup('0.11.0');
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    assert.strictEqual(s.U.install.target(), null);
    var results = install(s, release(s, '0.12.0', buf), null);
    assert.strictEqual(s.U.install.target(), '0.12.0');
    s.net.respondBytes(s.net.requests.length - 1, buf);
    assert.strictEqual(results[0].ok, true);
    assert.strictEqual(s.U.install.target(), '0.12.0');

    var f = setup('0.11.0');
    f.fs.fail.move[BUNDLE] = true;
    install(f, release(f, '0.12.0', buf), buf);
    assert.strictEqual(f.U.install.target(), null);
});

t.test('a stale lifecycle skips the reload and the restore and leaves restored false', function () {
    var s = setup('0.12.0');
    stepDown(s);
    var store = s.H.settings.store;
    harness.reload(s.H);
    var saves = s.host.saves;
    fire(s);
    assert.strictEqual(s.calls.reloads.length, 0);
    assert.strictEqual(s.host.saves, saves);
    assert.strictEqual(s.host.settings['steward.mining'].gen, 'current');
    assert.strictEqual(store.updaterState.notice.restored, false);
});

t.test('a failing restore still reloads and keeps restored false in the stored notice', function () {
    var s = setup('0.12.0');
    var r = stepDown(s);
    s.fs.disk[r.record.path] = '{ broken';
    var saves = s.host.saves;
    fire(s);
    assert.strictEqual(s.host.saves, saves);
    assert.strictEqual(s.host.settings['steward.mining'].gen, 'current');
    assert.strictEqual(s.calls.reloads.length, 1);
    assert.strictEqual(s.H.settings.store.updaterState.notice.restored, false);
});

t.test('without a reloadScripts global the restart notice is shown and the scheduler stays stopped', function () {
    var s = setup('0.11.0', { reload: false });
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    install(s, release(s, '0.12.0', buf), buf);
    s.calls.notify.length = 0;
    fire(s);
    assert.deepStrictEqual(s.calls.notify, [s.U.text.restartNeeded('0.12.0')]);
    assert.strictEqual(s.calls.start, 0);
    assert.strictEqual(s.calls.stop, 1);
    assert.strictEqual(s.U.install.busy(), true);
});

t.test('a throwing reloadScripts gives the same restart notice', function () {
    var s = setup('0.11.0');
    s.H.ctx.reloadScripts = function () { throw new Error('host refused'); };
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    install(s, release(s, '0.12.0', buf), buf);
    s.calls.notify.length = 0;
    fire(s);
    assert.deepStrictEqual(s.calls.notify, [s.U.text.restartNeeded('0.12.0')]);
});

t.test('a throw inside the install does not leave the instance busy', function () {
    var s = setup('0.11.0');
    s.U.backups.create = function () { throw new Error('boom'); };
    var buf = Buffer.from(bundleText('0.12.0'), 'utf8');
    var results = install(s, release(s, '0.12.0', buf), buf);
    assert.strictEqual(results[0].failure, s.S.UpdateFailure.BackupFailed);
    assert.strictEqual(s.U.install.busy(), false);
    assert.strictEqual(s.calls.start, 1);
});
