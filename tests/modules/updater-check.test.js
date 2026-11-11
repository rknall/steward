'use strict';

// The check state machine of the updater: the boot check and its rate limit,
// the state after a success or a failure, the once-per-version alert, the
// gates of the automatic install and the notice an install leaves for the
// next boot.

var t = require('../runner');
var harness = require('../harness');
var path = require('path');
var airfs = require('../stubs/airfs');
var netStub = require('../stubs/net');

var assert = t.assert;

var HEX = 'cd12ab34cd12ab34cd12ab34cd12ab34cd12ab34cd12ab34cd12ab34cd12ab34';
var PREFIX = 'https://github.com/rknall/steward/releases/download/';
var T0 = Date.UTC(2026, 5, 1, 10, 0, 0);
var HOUR = 3600000;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

// opts: { config: { ... } } is written into the updater settings.
function setup(running, opts) {
    opts = opts || {};
    var fs = airfs.make();
    var net = netStub.make(fs);
    var H = harness.boot({ host: { air: fs.air } });
    H.host.$.ajax = net.ajax;
    var S = H.Steward;
    var U = S.modules.updater;
    S.kernel.VERSION = running;
    var clock = { ms: T0 };
    U.now = function () { return clock.ms; };
    var ctl = { edits: false, depth: 0, runner: null };
    var notes = [];
    var installs = [];
    S.kernel.ui.hasOpenEdits = function () { return ctl.edits; };
    S.kernel.ui.notify = function (text) { notes.push(text); };
    S.kernel.queue.depth = function () { return ctl.depth; };
    S.kernel.queue.runningModule = function () { return ctl.runner; };
    U.install.run = function (rel, o, done) { installs.push({ rel: rel, opts: plain(o), done: done }); };
    if (opts.config) S.kernel.settings.write('updater', opts.config);
    return { H: H, S: S, U: U, net: net, clock: clock, ctl: ctl, notes: notes, installs: installs,
             state: function () { return U.state(); } };
}

function gh(tag, over) {
    var r = {
        tag_name: tag, name: 'Steward ' + tag, draft: false, prerelease: false,
        published_at: '2026-05-01T00:00:00Z', body: '',
        assets: [{
            name: 'user_steward.js', size: 1000, digest: 'sha256:' + HEX,
            browser_download_url: PREFIX + tag + '/user_steward.js'
        }]
    };
    for (var k in over) if (over.hasOwnProperty(k)) r[k] = over[k];
    return r;
}

function noDigest(tag) {
    var r = gh(tag);
    delete r.assets[0].digest;
    return r;
}

// Answers the newest pending API request.
function answer(s, list) {
    s.net.respondJson(s.net.requests.length - 1, list);
}

// A manual check, answered with `list`; returns the status it ended in.
function check(s, list, manual) {
    var got = null;
    s.U.check.run({ manual: manual === true }, function (st) { got = st; });
    answer(s, list);
    return got;
}

// ---- boot check and the failure path --------------------------------------

t.test('a failed check stores lastCheck and onBoot makes no second request within the interval', function () {
    var s = setup('0.11.0');
    var F = s.S.UpdateFailure;
    s.U.check.onBoot();
    assert.strictEqual(s.net.requests.length, 1);
    assert.strictEqual(s.state().lastCheck, T0);      // stored before the answer
    s.clock.ms = T0 + 5000;
    s.net.failJson(0, 0, 'timeout');
    assert.strictEqual(s.state().lastCheck, T0 + 5000);
    var st = s.U.check.status();
    assert.strictEqual(st.state, s.S.UpdateState.Failed);
    assert.strictEqual(st.failure, F.Network);
    assert.strictEqual(st.checkedAt, T0 + 5000);

    s.clock.ms = T0 + 10 * 60000;
    s.U.check.onBoot();
    assert.strictEqual(s.net.requests.length, 1);
    assert.strictEqual(s.U.check.status().state, s.S.UpdateState.Idle);

    s.clock.ms = T0 + 5000 + HOUR;
    s.U.check.onBoot();
    assert.strictEqual(s.net.requests.length, 2);
});

t.test('a rate limit failure is reported with its code and never retried by itself', function () {
    var s = setup('0.11.0');
    s.U.check.onBoot();
    s.net.failJson(0, 403, 'error');
    assert.strictEqual(s.U.check.status().failure, s.S.UpdateFailure.RateLimited);
    assert.strictEqual(s.net.requests.length, 1);
    assert.strictEqual(s.notes.length, 0);
});

t.test('onBoot does nothing when checkOnStart is off and shows the stored latest', function () {
    var s = setup('0.11.0', { config: { checkOnStart: false } });
    s.S.kernel.settings.write('updaterState', { latest: '0.12.0' });
    s.U.check.onBoot();
    assert.strictEqual(s.net.requests.length, 0);
    var st = s.U.check.status();
    assert.strictEqual(st.state, s.S.UpdateState.Idle);
    assert.strictEqual(st.latestSeen, '0.12.0');
});

t.test('a manual check works inside the interval and does not alert', function () {
    var s = setup('0.11.0');
    s.S.kernel.settings.write('updaterState', { lastCheck: T0 });
    var st = check(s, [gh('v0.12.0')], true);
    assert.strictEqual(st.state, s.S.UpdateState.Available);
    assert.strictEqual(st.latest.text, '0.12.0');
    assert.strictEqual(s.notes.length, 0);
    assert.strictEqual(s.state().latest, '0.12.0');
});

t.test('a second run while one is checking is ignored and still reports', function () {
    var s = setup('0.11.0');
    var seen = [];
    s.U.check.run({ manual: true }, function (st) { seen.push(st.state); });
    s.U.check.run({ manual: true }, function (st) { seen.push(st.state); });
    assert.strictEqual(s.net.requests.length, 1);
    assert.deepStrictEqual(seen, [s.S.UpdateState.Checking]);
    answer(s, [gh('v0.11.0')]);
    assert.deepStrictEqual(seen, [s.S.UpdateState.Checking, s.S.UpdateState.Current]);
});

// ---- states ----------------------------------------------------------------

t.test('the same version reads Current, an older list as well', function () {
    var s = setup('0.11.0');
    assert.strictEqual(check(s, [gh('v0.11.0'), gh('v0.10.0')]).state, s.S.UpdateState.Current);
    assert.strictEqual(check(s, [gh('v0.10.0')]).state, s.S.UpdateState.Current);
    assert.strictEqual(check(s, []).state, s.S.UpdateState.Current);
    assert.strictEqual(check(s, []).latest, null);
});

t.test('a prerelease is not offered unless test releases are on or one is running', function () {
    var s = setup('0.11.0');
    var list = [gh('v0.12.0-beta1'), gh('v0.11.0')];
    var st = check(s, list);
    assert.strictEqual(st.state, s.S.UpdateState.Current);
    assert.strictEqual(st.list.length, 2);

    var on = setup('0.11.0', { config: { showPrereleases: true } });
    var st2 = check(on, list);
    assert.strictEqual(st2.state, on.S.UpdateState.Available);
    assert.strictEqual(st2.latest.text, '0.12.0-beta1');

    var onPre = setup('0.12.0-beta1');
    assert.strictEqual(check(onPre, [gh('v0.12.0-beta2'), gh('v0.11.0')]).latest.text, '0.12.0-beta2');
});

t.test('status().list is the shared release cache; a failed check keeps the previous one', function () {
    var s = setup('0.11.0');
    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    assert.strictEqual(s.U.check.status().list, s.U.releases.cached().list);
    assert.strictEqual(s.U.check.status().list.length, 2);
    var kept = s.U.releases.cached().list;
    s.clock.ms = T0 + 2 * HOUR;
    s.U.check.run({ manual: true }, function () {});
    s.net.failJson(s.net.requests.length - 1, 0, 'timeout');
    assert.strictEqual(s.U.check.status().state, s.S.UpdateState.Failed);
    assert.strictEqual(s.U.check.status().list, kept);
    assert.strictEqual(s.U.check.status().list, s.U.releases.cached().list);
});

t.test('showPrereleases and runningText are the shared rules', function () {
    var s = setup('0.11.0');
    var U = s.U;
    var pre = s.S.kernel.semver.parse('0.12.0-beta1');
    var rel = s.S.kernel.semver.parse('0.11.0');
    assert.strictEqual(U.showPrereleases({ showPrereleases: false }, rel), false);
    assert.strictEqual(U.showPrereleases({ showPrereleases: true }, rel), true);
    assert.strictEqual(U.showPrereleases({ showPrereleases: false }, pre), true);
    assert.strictEqual(U.runningText(rel), '0.11.0');
    assert.strictEqual(U.runningText(), '0.11.0');
    assert.strictEqual(U.runningText(null), '0.11.0');
    s.S.kernel.VERSION = '@VERSION@';
    assert.strictEqual(U.runningText(), '@VERSION@');
    assert.strictEqual(U.runningText(null), '@VERSION@');
});

t.test('a 0.0.0 or unparseable running version reads Current and is marked as a dev build', function () {
    var zero = setup('0.0.0');
    var st = check(zero, [gh('v0.12.0')]);
    assert.strictEqual(st.state, zero.S.UpdateState.Current);
    assert.strictEqual(st.devBuild, true);
    assert.strictEqual(st.latest.text, '0.12.0');

    var junk = setup('@VERSION@');
    var st2 = check(junk, [gh('v0.12.0')]);
    assert.strictEqual(st2.state, junk.S.UpdateState.Current);
    assert.strictEqual(st2.devBuild, true);
    assert.strictEqual(st2.running, null);

    var dev = setup('0.11.0-3-gabc1234');
    assert.strictEqual(check(dev, [gh('v0.11.0')]).devBuild, true);
    assert.strictEqual(check(setup('0.11.0'), []).devBuild, false);
});

t.test('the package.json placeholder build reads Current, is a dev build and posts no notice', function () {
    var placeholder = require(path.join(__dirname, '..', '..', 'package.json')).version;
    var s = setup(placeholder);
    var st = check(s, [gh('v0.12.0')]);
    assert.strictEqual(st.state, s.S.UpdateState.Current);
    assert.strictEqual(st.devBuild, true);
    assert.strictEqual(st.latest.text, '0.12.0');
    assert.strictEqual(s.notes.length, 0);
    assert.strictEqual(s.U.showPrereleases({}, s.S.kernel.semver.running()), false);
});

t.test('status reports Installing while an install is busy', function () {
    var s = setup('0.11.0');
    s.U.install.busy = function () { return true; };
    assert.strictEqual(s.U.check.status().state, s.S.UpdateState.Installing);
    var done = null;
    s.U.check.run({ manual: true }, function (st) { done = st; });
    assert.strictEqual(s.net.requests.length, 0);
    assert.strictEqual(done.state, s.S.UpdateState.Installing);
});

t.test('a release list that makes the fetch throw ends in Failed, never stuck at Checking', function () {
    var s = setup('0.11.0');
    s.U.releases.fetch = function () { throw new Error('boom'); };
    var st = null;
    s.U.check.run({ manual: true }, function (x) { st = x; });
    assert.strictEqual(st.state, s.S.UpdateState.Failed);
    assert.strictEqual(st.failure, s.S.UpdateFailure.BadResponse);
});

// ---- alert once per version -------------------------------------------------

t.test('the boot check alerts once per version', function () {
    var s = setup('0.11.0');
    s.U.check.run({ manual: false });
    answer(s, [gh('v0.12.0'), gh('v0.11.0')]);
    assert.deepStrictEqual(s.notes, [s.U.text.available('0.12.0')]);
    assert.strictEqual(s.state().notifiedVersion, '0.12.0');

    s.U.check.run({ manual: false });
    answer(s, [gh('v0.12.0'), gh('v0.11.0')]);
    assert.strictEqual(s.notes.length, 1);

    s.U.check.run({ manual: false });
    answer(s, [gh('v0.13.0'), gh('v0.12.0')]);
    assert.strictEqual(s.notes.length, 2);
    assert.strictEqual(s.notes[1], s.U.text.available('0.13.0'));
});

t.test('a reload does not repeat the alert for a version already announced', function () {
    var s = setup('0.11.0');
    s.S.kernel.settings.write('updaterState', { notifiedVersion: '0.12.0' });
    s.U.check.run({ manual: false });
    answer(s, [gh('v0.12.0')]);
    assert.strictEqual(s.notes.length, 0);
});

t.test('no alert when nothing newer exists', function () {
    var s = setup('0.11.0');
    s.U.check.run({ manual: false });
    answer(s, [gh('v0.11.0')]);
    assert.strictEqual(s.notes.length, 0);
});

// ---- automatic install ------------------------------------------------------

var AUTO = { autoInstall: true };

t.test('a release running version with a digest installs automatically', function () {
    var s = setup('0.11.0', { config: AUTO });
    s.U.check.run({ manual: false });
    answer(s, [gh('v0.12.0')]);
    assert.strictEqual(s.installs.length, 1);
    assert.strictEqual(s.installs[0].rel.text, '0.12.0');
    assert.deepStrictEqual(s.installs[0].opts, { auto: true, restore: null });
});

t.test('a failed automatic install is notified through the failure text', function () {
    var s = setup('0.11.0', { config: AUTO });
    s.U.check.run({ manual: false });
    answer(s, [gh('v0.12.0')]);
    s.notes.length = 0;
    s.installs[0].done({ ok: false, failure: s.S.UpdateFailure.WriteFailed, version: '0.12.0' });
    assert.deepStrictEqual(s.notes, [s.U.text.failure(s.S.UpdateFailure.WriteFailed)]);
    s.notes.length = 0;
    s.installs[0].done({ ok: true, failure: null, version: '0.12.0' });
    assert.strictEqual(s.notes.length, 0);
});

t.test('the automatic install is off by default', function () {
    var s = setup('0.11.0');
    s.U.check.run({ manual: false });
    answer(s, [gh('v0.12.0')]);
    assert.strictEqual(s.installs.length, 0);
    assert.strictEqual(s.notes.length, 1);
});

t.test('a manual check never installs by itself', function () {
    var s = setup('0.11.0', { config: AUTO });
    check(s, [gh('v0.12.0')], true);
    assert.strictEqual(s.installs.length, 0);
});

t.test('a development running version blocks the automatic install but still alerts', function () {
    var s = setup('0.11.0-3-gabc1234', { config: AUTO });
    s.U.check.run({ manual: false });
    answer(s, [gh('v0.12.0')]);
    assert.strictEqual(s.installs.length, 0);
    assert.strictEqual(s.notes.length, 1);
});

t.test('a test release running version blocks the automatic install', function () {
    var s = setup('0.11.0-beta1', { config: AUTO });
    s.U.check.run({ manual: false });
    answer(s, [gh('v0.11.0')]);
    assert.strictEqual(s.installs.length, 0);
});

t.test('a prerelease target blocks the automatic install', function () {
    var s = setup('0.11.0', { config: { autoInstall: true, showPrereleases: true } });
    s.U.check.run({ manual: false });
    answer(s, [gh('v0.12.0-beta1')]);
    assert.strictEqual(s.installs.length, 0);
    assert.strictEqual(s.notes.length, 1);
});

t.test('a release without a digest blocks the automatic install', function () {
    var s = setup('0.11.0', { config: AUTO });
    s.U.check.run({ manual: false });
    answer(s, [noDigest('v0.12.0')]);
    assert.strictEqual(s.installs.length, 0);
});

t.test('queued work blocks the automatic install', function () {
    var s = setup('0.11.0', { config: AUTO });
    s.ctl.depth = 2;
    s.U.check.run({ manual: false });
    answer(s, [gh('v0.12.0')]);
    assert.strictEqual(s.installs.length, 0);
});

t.test('a running queue action blocks the automatic install', function () {
    var s = setup('0.11.0', { config: AUTO });
    s.ctl.runner = 'mining';
    s.U.check.run({ manual: false });
    answer(s, [gh('v0.12.0')]);
    assert.strictEqual(s.installs.length, 0);
});

t.test('open Settings edits block the automatic install', function () {
    var s = setup('0.11.0', { config: AUTO });
    s.ctl.edits = true;
    s.U.check.run({ manual: false });
    answer(s, [gh('v0.12.0')]);
    assert.strictEqual(s.installs.length, 0);
});

// ---- the notice an install left ---------------------------------------------

function notice(over) {
    var n = { from: '0.11.0', to: '0.12.0', time: T0 - 1000, auto: false,
              backup: 'settings-20260601-095900-v0.11.0.json', restore: null, restored: false };
    for (var k in over) if (over.hasOwnProperty(k)) n[k] = over[k];
    return n;
}

function bootWithNotice(running, n) {
    var s = setup(running);
    // A fresh check keeps onBoot from starting a request of its own.
    s.S.kernel.settings.write('updaterState', { lastCheck: T0, notice: n });
    s.U.check.onBoot();
    return s;
}

t.test('the new version loaded: the updated text, then the notice is cleared', function () {
    var n = notice({});
    var s = bootWithNotice('0.12.0', n);
    assert.deepStrictEqual(s.notes, [s.U.text.updated(n)]);
    assert.strictEqual(s.state().notice, null);
    assert.strictEqual(s.net.requests.length, 0);
});

t.test('an automatic install is told as such', function () {
    var n = notice({ auto: true });
    var s = bootWithNotice('0.12.0', n);
    assert.deepStrictEqual(s.notes, [s.U.text.updated(n)]);
    assert.notStrictEqual(s.U.text.updated(n), s.U.text.updated(notice({})));
});

t.test('the new version did not load: the not-loaded text names the running version', function () {
    var n = notice({});
    var s = bootWithNotice('0.11.0', n);
    assert.deepStrictEqual(s.notes, [s.U.text.notLoaded(n, '0.11.0')]);
    assert.strictEqual(s.state().notice, null);
});

t.test('a pending restore adds the not-restored line', function () {
    var n = notice({ to: '0.10.0', restore: 'settings-20260101-000000-v0.10.0.json', restored: false });
    var s = bootWithNotice('0.10.0', n);
    assert.strictEqual(s.notes.length, 1);
    assert.strictEqual(s.notes[0].indexOf(s.U.text.updated(n)), 0);
    assert.ok(s.notes[0].indexOf(s.U.text.notRestored(n)) > 0);
    assert.ok(s.notes[0].indexOf(n.restore) > 0);
});

t.test('a restore that ran adds nothing', function () {
    var n = notice({ to: '0.10.0', restore: 'settings-x.json', restored: true });
    var s = bootWithNotice('0.10.0', n);
    assert.deepStrictEqual(s.notes, [s.U.text.updated(n)]);
});

t.test('the notice is reported once, a second boot says nothing', function () {
    var s = bootWithNotice('0.12.0', notice({}));
    s.notes.length = 0;
    s.U.check.onBoot();
    assert.strictEqual(s.notes.length, 0);
});

t.test('a notice with an unparseable running version does not throw', function () {
    var n = notice({});
    var s = bootWithNotice('@VERSION@', n);
    assert.strictEqual(s.notes.length, 1);
    assert.ok(s.notes[0].indexOf('@VERSION@') > 0);
    assert.strictEqual(s.state().notice, null);
});

t.test('the boot check still runs after a notice when the last check is old', function () {
    var s = setup('0.12.0');
    s.S.kernel.settings.write('updaterState', { lastCheck: T0 - 2 * HOUR, notice: notice({}) });
    s.U.check.onBoot();
    assert.strictEqual(s.notes.length, 1);
    assert.strictEqual(s.net.requests.length, 1);
});
