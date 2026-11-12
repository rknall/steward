'use strict';

// The updater's Settings group, its menu labels and its text table: every
// state renders, remote text stays text, a cancelled confirm installs
// nothing, and every enum value has a line in the wording table.

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var netStub = require('../stubs/net');
var jq = require('../stubs/jq');

var assert = t.assert;

var HEX = 'ef56ab12ef56ab12ef56ab12ef56ab12ef56ab12ef56ab12ef56ab12ef56ab12';
var PREFIX = 'https://github.com/rknall/steward/releases/download/';
var T0 = Date.UTC(2026, 5, 1, 10, 0, 0);

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup(running) {
    var fs = airfs.make();
    var net = netStub.make(fs);
    var H = harness.boot({ host: { air: fs.air } });
    jq.install(H).ajax = net.ajax;
    var S = H.Steward;
    var U = S.modules.updater;
    S.kernel.VERSION = running;
    H.ctx.settingsFile = 'settings.json';
    var clock = { ms: T0 };
    U.now = function () { return clock.ms; };
    var s = { H: H, S: S, U: U, fs: fs, net: net, clock: clock, notes: [], installs: [],
              confirms: [], answer: false, group: 'updater' };
    S.kernel.ui.notify = function (text) { s.notes.push(text); };
    S.kernel.ui.hasOpenEdits = function () { return false; };
    s.realRun = U.install.run;
    U.install.run = function (rel, o, done) { s.installs.push({ rel: rel, opts: plain(o), done: done }); };
    H.ctx.confirm = function (text) { s.confirms.push(text); return s.answer; };
    // The fake has no $.contains, and the settings screen is not open here.
    H.ctx.$.contains = function () { return true; };
    // The real install needs the bundle file to exist; it stops at the pending download.
    fs.dirs['C:/client/userscripts'] = true;
    fs.disk['C:/client/userscripts/user_steward.js'] = 'old();';
    fs.bytes['C:/client/userscripts/user_steward.js'] = Buffer.from('old();', 'utf8');
    S.kernel.ui.screen = { state: function () { return { group: s.group }; } };
    return s;
}

function gh(tag, over) {
    var r = {
        tag_name: tag, name: 'Steward ' + tag, draft: false, prerelease: false,
        published_at: '2026-05-01T00:00:00Z', body: 'Notes of ' + tag,
        assets: [{
            name: 'user_steward.js', size: 1000, digest: 'sha256:' + HEX,
            browser_download_url: PREFIX + tag + '/user_steward.js'
        }]
    };
    for (var k in over) if (over.hasOwnProperty(k)) r[k] = over[k];
    return r;
}

// A manual check answered with `list`.
function check(s, list) {
    s.U.check.run({ manual: true });
    s.net.respondJson(s.net.requests.length - 1, list);
}

function render(s) {
    var $m = s.H.ctx.$('<div>');
    s.U.renderSection($m, s.S.kernel.ui.helpers);
    return $m;
}

function buttons($m) {
    var $b = $m.find('button');
    var out = [];
    for (var i = 0; i < $b.length; i++) out.push({ text: $b.eq(i).text(), $b: $b.eq(i) });
    return out;
}

function button($m, text) {
    var all = buttons($m);
    for (var i = 0; i < all.length; i++) if (all[i].text === text) return all[i].$b;
    return null;
}

// Every element of a fake tree, depth first.
function walk(node, fn) {
    fn(node);
    for (var i = 0; i < node.children.length; i++) walk(node.children[i], fn);
}

function enumValues(obj) {
    var out = [];
    for (var k in obj) if (obj.hasOwnProperty(k)) out.push(obj[k]);
    return out;
}

function status(s, over) {
    var st = { state: s.S.UpdateState.Idle, failure: null, latest: null, list: [], checkedAt: null,
               running: s.S.kernel.semver.parse('0.11.0'), latestSeen: null, devBuild: false };
    for (var k in over) if (over.hasOwnProperty(k)) st[k] = over[k];
    return st;
}

// ---- the group in each state ------------------------------------------------

t.test('the group renders when nothing was checked yet', function () {
    var s = setup('0.11.0');
    var $m = render(s);
    assert.ok($m.text().indexOf('Running: Steward v0.11.0') >= 0);
    assert.ok($m.text().indexOf(s.U.text.state(s.U.check.status())) >= 0);
    assert.ok(button($m, 'Check now'));
    assert.strictEqual(button($m, 'Install v0.12.0'), null);
});

t.test('the group renders while checking and disables Check now', function () {
    var s = setup('0.11.0');
    s.U.check.run({ manual: true });
    var $m = render(s);
    assert.ok($m.text().indexOf('Checking') >= 0);
    var $b = button($m, 'Check now');
    assert.ok($b);
    assert.ok($b.prop('disabled') || $b.attr('disabled'), 'Check now disabled while checking');
});

t.test('the group renders as up to date', function () {
    var s = setup('0.11.0');
    check(s, [gh('v0.11.0'), gh('v0.10.0')]);
    var $m = render(s);
    assert.ok($m.text().indexOf('Up to date') >= 0);
    assert.ok($m.text().indexOf(s.U.text.state(s.U.check.status())) >= 0);
});

t.test('the group renders an available release with notes and an Install button', function () {
    var s = setup('0.11.0');
    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    var $m = render(s);
    assert.ok($m.text().indexOf('v0.12.0 (Release)') >= 0);
    assert.ok(button($m, 'Install v0.12.0'));
    assert.strictEqual($m.find('.steward-notes').text(), 'Notes of v0.12.0');
});

t.test('long release notes start collapsed and the link opens them', function () {
    var s = setup('0.11.0');
    var long = new Array(700).join('n');
    check(s, [gh('v0.12.0', { body: long }), gh('v0.11.0')]);
    var $m = s.H.ctx.$('<div>');
    s.U.renderSection($m, s.S.kernel.ui.helpers);
    assert.strictEqual($m.find('.steward-notes').length, 0);
    var $link = $m.find('a.steward-link');
    var opener = null;
    for (var i = 0; i < $link.length; i++) if ($link.eq(i).text() === 'Show release notes') opener = $link.eq(i);
    assert.ok(opener);
    opener.click();
    assert.strictEqual($m.find('.steward-notes').text(), long);
});

t.test('the group renders a failed check with its failure line', function () {
    var s = setup('0.11.0');
    s.U.check.run({ manual: true });
    s.net.failJson(0, 403, 'error');
    var $m = render(s);
    assert.ok($m.text().indexOf('Check failed') >= 0);
    assert.ok($m.text().indexOf(s.U.text.failure(s.S.UpdateFailure.RateLimited)) >= 0);
});

t.test('the group renders a development build', function () {
    var s = setup('0.11.0-3-gabc1234');
    check(s, [gh('v0.11.0')]);
    var $m = render(s);
    assert.ok($m.text().indexOf('Development build') >= 0);
});

t.test('the group renders an unknown running version without throwing', function () {
    var s = setup('@VERSION@');
    check(s, [gh('v0.11.0')]);
    var $m = render(s);
    assert.ok($m.text().indexOf('of unknown version') >= 0);
});

t.test('the group renders while installing, with the step line and no Install buttons', function () {
    var s = setup('0.11.0');
    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    s.U.install.busy = function () { return true; };
    s.U.install.step = function () { return s.S.InstallStep.Backup; };
    var $m = render(s);
    assert.ok($m.text().indexOf(s.U.text.step(s.S.InstallStep.Backup)) >= 0);
    assert.ok($m.text().indexOf('Installing') >= 0);
    var all = buttons($m);
    for (var i = 0; i < all.length; i++) {
        if (/^Install/.test(all[i].text)) {
            assert.ok(all[i].$b.prop('disabled') || all[i].$b.attr('disabled'), all[i].text + ' disabled');
        }
    }
});

t.test('the group renders with test releases and an empty backup folder', function () {
    var s = setup('0.11.0');
    s.S.kernel.settings.write('updater', { showPrereleases: true });
    check(s, [gh('v0.12.0-beta1'), gh('v0.11.0')]);
    var $m = render(s);
    assert.ok($m.text().indexOf('(Test release)') >= 0);
    assert.ok($m.text().indexOf('No settings backups yet') >= 0);
});

t.test('the versions list hides releases without an updater by default', function () {
    var s = setup('0.12.0');
    check(s, [gh('v0.13.0'), gh('v0.12.0'), gh('v0.11.0')]);
    var $m = render(s);
    var text = $m.text();
    assert.ok(text.indexOf('Running') >= 0);
    assert.ok(text.indexOf('No updater') < 0);
    assert.ok(text.indexOf('predate the updater') < 0);
    assert.ok(text.indexOf('v0.11.0') < 0);
    // The release card and the other listed row carry an Install button.
    var installs = buttons($m).filter(function (b) { return /^Install/.test(b.text); });
    assert.strictEqual(installs.length, 2);
});

t.test('with showOldReleases the versions list marks the ones without an updater', function () {
    var s = setup('0.12.0');
    s.S.kernel.settings.write('updater', { showOldReleases: true });
    check(s, [gh('v0.13.0'), gh('v0.12.0'), gh('v0.11.0')]);
    var $m = render(s);
    var text = $m.text();
    assert.ok(text.indexOf('Running') >= 0);
    assert.ok(text.indexOf('No updater') >= 0);
    assert.ok(text.indexOf('predate the updater') >= 0);
    assert.ok(text.indexOf('are hidden') < 0);
    // The release card and the two other rows carry an Install button.
    var installs = buttons($m).filter(function (b) { return /^Install/.test(b.text); });
    assert.strictEqual(installs.length, 3);
});

t.test('a list of only old releases shows the hidden empty state', function () {
    var s = setup('0.12.0');
    check(s, [gh('v0.11.0'), gh('v0.10.0')]);
    var text = render(s).text();
    assert.ok(text.indexOf('No versions listed') >= 0);
    assert.ok(text.indexOf('are hidden') >= 0);
    assert.ok(text.indexOf('Use Check now') < 0);
});

t.test('the running row stays listed when it predates the updater', function () {
    var s = setup('0.11.0');
    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    assert.ok(render(s).text().indexOf('Running') >= 0);
});

t.test('the options card has the old-releases toggle', function () {
    var s = setup('0.12.0');
    assert.ok(render(s).text().indexOf('Show versions before 0.12.0') >= 0);
});

t.test('the backup list shows this profile and mentions the other profiles', function () {
    var s = setup('0.11.0');
    s.H.host.settings.settings['steward.mining'] = { enabled: true };
    s.H.ctx.settingsFile = 'other.json';
    s.U.backups.create('0.10.0', '0.11.0');
    s.H.ctx.settingsFile = 'settings.json';
    var $m = render(s);
    assert.ok($m.text().indexOf('No settings backups for this profile') >= 0);
    assert.ok($m.text().indexOf('1 backups belong to other profiles') >= 0);
    s.clock.ms += 60000;
    var mine = s.U.backups.create('0.9.0', '0.10.0');
    var $m2 = render(s);
    assert.ok($m2.text().indexOf(mine.record.name) >= 0);
});

t.test('redraw repaints the shown group in place and ignores a hidden one', function () {
    var s = setup('0.11.0');
    var $m = render(s);
    assert.ok($m.text().indexOf('Up to date') < 0);
    check(s, [gh('v0.11.0')]);          // check.js redraws through U.redraw()
    assert.ok($m.text().indexOf('Up to date') >= 0);
    s.group = 'elsewhere';
    var before = $m.text();
    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    assert.strictEqual($m.text(), before);
});

t.test('the section summary comes from the text table', function () {
    var s = setup('0.11.0');
    assert.strictEqual(s.U.summary(), s.U.text.summary(s.U.check.status()));
    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    assert.strictEqual(s.U.summary(), 'v0.12.0 available');
});

// ---- remote text stays text -------------------------------------------------

t.test('release name and notes with markup are shown as text only', function () {
    var s = setup('0.11.0');
    var evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    check(s, [gh('v0.12.0', { body: evil, name: '<b onclick="x()">bold</b>' }), gh('v0.11.0')]);
    var $m = render(s);
    assert.strictEqual($m.find('.steward-notes').text(), evil);
    assert.ok($m.text().indexOf('<b onclick="x()">bold</b>') >= 0);
    var tags = {};
    var html = '';
    walk($m[0], function (n) {
        tags[n.tag] = true;
        if (n.htmlStr) html += n.htmlStr;
    });
    assert.strictEqual(tags.script, undefined);
    assert.strictEqual(tags.img, undefined);
    assert.strictEqual(html.indexOf('<script'), -1);
    assert.strictEqual(html.indexOf('onerror'), -1);
});

t.test('a backup file name with markup is shown as text only', function () {
    var s = setup('0.11.0');
    var made = s.U.backups.create('0.10.0', '0.11.0');
    var dir = made.path.slice(0, made.path.lastIndexOf('/'));
    var body = JSON.parse(s.fs.disk[made.path]);
    body.fromVersion = '<script>x</script>';
    s.fs.disk[dir + '/<img src=x>.json'] = JSON.stringify(body);
    var $m = render(s);
    var found = false;
    walk($m[0], function (n) {
        if (n.tag === 'script' || n.tag === 'img') found = true;
        if (n.htmlStr && n.htmlStr.indexOf('<') >= 0) found = true;
    });
    assert.strictEqual(found, false);
});

// ---- confirm and install -----------------------------------------------------

t.test('Install asks first and a cancel installs nothing', function () {
    var s = setup('0.11.0');
    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    var $m = render(s);
    s.answer = false;
    button($m, 'Install v0.12.0').click();
    assert.strictEqual(s.confirms.length, 1);
    assert.strictEqual(s.installs.length, 0);
});

t.test('a confirmed upgrade installs with no restore', function () {
    var s = setup('0.11.0');
    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    var $m = render(s);
    s.answer = true;
    button($m, 'Install v0.12.0').click();
    assert.strictEqual(s.installs.length, 1);
    assert.strictEqual(s.installs[0].rel.text, '0.12.0');
    assert.deepStrictEqual(s.installs[0].opts, { auto: false, restore: null });
    assert.ok(s.confirms[0].indexOf('Install Steward v0.12.0?') === 0);
});

t.test('a step-down from the versions list restores the backup written when leaving that version', function () {
    var s = setup('0.12.0');
    s.S.kernel.settings.write('updater', { showOldReleases: true });
    s.H.host.settings.settings['steward.mining'] = { enabled: true };
    var made = s.U.backups.create('0.11.0', '0.12.0');
    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    var $m = render(s);
    var rows = $m.find('tbody tr');
    var down = null;
    for (var i = 0; i < rows.length; i++) {
        if (rows.eq(i).text().indexOf('v0.11.0') >= 0 && rows.eq(i).find('button').length) down = rows.eq(i);
    }
    assert.ok(down, 'row of v0.11.0');
    s.answer = true;
    down.find('button').eq(0).click();
    assert.strictEqual(s.installs.length, 1);
    assert.strictEqual(s.installs[0].opts.auto, false);
    assert.strictEqual(s.installs[0].opts.restore.path, made.path);
    assert.ok(s.confirms[0].indexOf('Go back to Steward v0.11.0?') === 0);
    assert.ok(s.confirms[0].indexOf(made.record.name) >= 0);
});

t.test('a failed install is notified and shown in the group, then cleared by a new check', function () {
    var s = setup('0.11.0');
    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    var $m = render(s);
    s.answer = true;
    button($m, 'Install v0.12.0').click();
    s.installs[0].done({ ok: false, failure: s.S.UpdateFailure.SizeMismatch, version: '0.12.0' });
    assert.deepStrictEqual(s.notes, [s.U.text.failure(s.S.UpdateFailure.SizeMismatch)]);
    assert.ok($m.text().indexOf('Install of v0.12.0 failed') >= 0);
    assert.ok($m.text().indexOf(s.U.text.failure(s.S.UpdateFailure.SizeMismatch)) >= 0);
    button($m, 'Check now').click();
    s.net.respondJson(s.net.requests.length - 1, [gh('v0.12.0'), gh('v0.11.0')]);
    assert.ok($m.text().indexOf('Install of v0.12.0 failed') < 0);
});

t.test('Install does nothing while another install runs', function () {
    var s = setup('0.11.0');
    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    var $m = render(s);
    s.U.install.busy = function () { return true; };
    s.answer = true;
    button($m, 'Install v0.12.0').click();
    assert.strictEqual(s.confirms.length, 0);
    assert.strictEqual(s.installs.length, 0);
});

// ---- text.confirm variants ----------------------------------------------------

function ctxOf(over) {
    var c = { running: '0.11.0', profile: 'settings.json', beforeUpdater: false, noDigest: false };
    for (var k in over) if (over.hasOwnProperty(k)) c[k] = over[k];
    return c;
}

function relOf(s, version) {
    return { text: version, version: s.S.kernel.semver.parse(version), asset: { digest: HEX } };
}

function pickOf(name, from, exact) {
    return { exact: exact, record: { name: name, fromVersion: from, path: 'x/' + name } };
}

t.test('confirm: an upgrade keeps the settings and says so', function () {
    var s = setup('0.11.0');
    var text = s.U.text.confirm(relOf(s, '0.12.0'), null, ctxOf({}));
    assert.ok(text.indexOf('Install Steward v0.12.0?') === 0);
    assert.ok(text.indexOf('Nothing is restored') >= 0);
    assert.ok(text.indexOf('profile settings.json') >= 0);
    assert.strictEqual(text.indexOf('WARNING'), -1);
});

t.test('confirm: a step-down with an exact backup names it', function () {
    var s = setup('0.12.0');
    var text = s.U.text.confirm(relOf(s, '0.11.0'), pickOf('b-exact.json', '0.11.0', true), ctxOf({ running: '0.12.0' }));
    assert.ok(text.indexOf('Go back to Steward v0.11.0?') === 0);
    assert.ok(text.indexOf('b-exact.json') >= 0);
    assert.ok(text.indexOf('taken when you left v0.11.0') >= 0);
});

t.test('confirm: a step-down with an older backup names the version it comes from', function () {
    var s = setup('0.12.0');
    var text = s.U.text.confirm(relOf(s, '0.11.0'), pickOf('b-old.json', '0.10.0', false), ctxOf({ running: '0.12.0' }));
    assert.ok(text.indexOf('No backup exists for v0.11.0') >= 0);
    assert.ok(text.indexOf('v0.10.0') >= 0);
    assert.ok(text.indexOf('b-old.json') >= 0);
});

t.test('confirm: a step-down without any backup keeps the current settings', function () {
    var s = setup('0.12.0');
    var text = s.U.text.confirm(relOf(s, '0.11.0'), null, ctxOf({ running: '0.12.0' }));
    assert.ok(text.indexOf('Go back to') === 0);
    assert.ok(text.indexOf('the current settings are kept') >= 0);
});

t.test('confirm: a version before the updater warns, one without a digest says so', function () {
    var s = setup('0.12.0');
    var before = s.U.text.confirm(relOf(s, '0.11.0'), null, ctxOf({ running: '0.12.0', beforeUpdater: true }));
    assert.ok(before.indexOf('WARNING') >= 0);
    assert.ok(before.indexOf('predates the updater') >= 0);
    var none = s.U.text.confirm(relOf(s, '0.13.0'), null, ctxOf({ running: '0.12.0', noDigest: true }));
    assert.ok(none.indexOf('no SHA-256 checksum') >= 0);
    assert.strictEqual(none.indexOf('WARNING'), -1);
});

// ---- the text table ------------------------------------------------------------

t.test('every S.UpdateFailure value has its own non-empty line', function () {
    var s = setup('0.11.0');
    var values = enumValues(s.S.UpdateFailure);
    assert.ok(values.length > 10);
    var seen = {};
    for (var i = 0; i < values.length; i++) {
        var line = s.U.text.failure(values[i]);
        assert.strictEqual(typeof line, 'string');
        assert.ok(line.length > 0, values[i]);
        assert.strictEqual(line.indexOf('The update failed ('), -1, values[i] + ' falls back to the generic line');
        assert.strictEqual(seen[line], undefined, values[i] + ' repeats another line');
        seen[line] = true;
    }
    assert.ok(s.U.text.failure('SomethingNew').length > 0);
    assert.ok(s.U.text.failure(null).length > 0);
});

t.test('every S.InstallStep value has its own non-empty line', function () {
    var s = setup('0.11.0');
    var values = enumValues(s.S.InstallStep);
    var seen = {};
    for (var i = 0; i < values.length; i++) {
        var line = s.U.text.step(values[i], '0.12.0');
        assert.ok(line.length > 0, values[i]);
        assert.strictEqual(line.indexOf('Working on the update'), -1, values[i] + ' falls back');
        assert.strictEqual(seen[line], undefined, values[i] + ' repeats another line');
        seen[line] = true;
    }
    assert.ok(s.U.text.step(s.S.InstallStep.Download, '0.12.0').indexOf('v0.12.0') >= 0);
    assert.ok(s.U.text.step(s.S.InstallStep.Download).length > 0);
    assert.ok(s.U.text.step('Unknown').length > 0);
});

t.test('every S.UpdateState value gives a non-empty state, summary and menu status', function () {
    var s = setup('0.11.0');
    var values = enumValues(s.S.UpdateState);
    var latest = { text: '0.12.0', published: T0 };
    for (var i = 0; i < values.length; i++) {
        var variants = [
            status(s, { state: values[i] }),
            status(s, { state: values[i], latest: latest }),
            status(s, { state: values[i], latest: latest, devBuild: true, latestSeen: '0.12.0' }),
            status(s, { state: values[i], failure: s.S.UpdateFailure.Network, running: null, devBuild: true })
        ];
        for (var j = 0; j < variants.length; j++) {
            assert.ok(s.U.text.state(variants[j]).length > 0, values[i] + '/' + j + ' state');
            assert.ok(s.U.text.summary(variants[j]).length > 0, values[i] + '/' + j + ' summary');
            assert.ok(s.U.text.menuStatus(variants[j]).length > 0, values[i] + '/' + j + ' menu');
            assert.ok(s.U.text.checkResult(variants[j]).length > 0, values[i] + '/' + j + ' result');
            assert.ok(s.U.text.menuOpen(variants[j]).length > 0, values[i] + '/' + j + ' open');
        }
    }
});

t.test('the notices are plain text built from their data', function () {
    var s = setup('0.11.0');
    var T = s.U.text;
    var n = { from: '0.11.0', to: '0.12.0', auto: false, backup: 'b.json', restore: 'r.json', restored: false };
    assert.ok(T.available('0.12.0').indexOf('v0.12.0') >= 0);
    assert.ok(T.installing('0.12.0').indexOf('v0.12.0') >= 0);
    assert.ok(T.restartNeeded('0.12.0').indexOf('restart') >= 0);
    assert.ok(T.updated(n).indexOf('b.json') >= 0);
    assert.ok(T.notLoaded(n, '0.11.0').indexOf('v0.11.0') >= 0);
    assert.ok(T.notRestored(n).indexOf('r.json') >= 0);
    assert.strictEqual(T.updated({ from: '0.11.0', to: '0.12.0', auto: false, backup: null }).indexOf('saved first'), -1);
});

// ---- menu ----------------------------------------------------------------------

function menuLabels(s) {
    var items = s.S.kernel.registry.get('updater').menu.items;
    return items.map(function (it) { return typeof it.label === 'function' ? it.label() : it.label; });
}

t.test('the menu labels follow the state', function () {
    var s = setup('0.11.0');
    var F = s.S.UpdateFailure;
    assert.deepStrictEqual(plain(menuLabels(s)), ['Not checked for updates yet', 'Check for updates now', 'Updates…']);

    s.U.check.run({ manual: true });
    assert.strictEqual(menuLabels(s)[0], 'Checking for updates…');
    s.net.respondJson(0, [gh('v0.11.0')]);
    assert.strictEqual(menuLabels(s)[0], 'Steward v0.11.0 is up to date');
    assert.strictEqual(menuLabels(s)[2], 'Updates…');

    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    assert.strictEqual(menuLabels(s)[0], 'Update available: v0.12.0');
    assert.strictEqual(menuLabels(s)[2], 'Install v0.12.0…');

    s.U.check.run({ manual: true });
    s.net.failJson(s.net.requests.length - 1, 403, 'error');
    assert.ok(menuLabels(s)[0].indexOf('Last check failed: ') === 0);
    assert.ok(menuLabels(s)[0].indexOf(s.U.text.failure(F.RateLimited).split('. ')[0].replace(/\.$/, '')) > 0);

    s.U.install.busy = function () { return true; };
    assert.strictEqual(menuLabels(s)[0], 'Installing an update…');
});

t.test('the status item is disabled and the other two act', function () {
    var s = setup('0.11.0');
    var items = s.S.kernel.registry.get('updater').menu.items;
    assert.strictEqual(items[0].enabled, false);

    var opened = [];
    s.S.kernel.ui.openSettings = function (group) { opened.push(group); };
    items[2].onSelect();
    assert.deepStrictEqual(opened, ['updater']);

    items[1].onSelect();
    assert.strictEqual(s.net.requests.length, 1);
    s.net.respondJson(0, [gh('v0.12.0'), gh('v0.11.0')]);
    assert.deepStrictEqual(s.notes, [s.U.text.available('0.12.0')]);
});

// ---- wording follows REPO ---------------------------------------------------

t.test('text.state, failure, checkOnStartHelp and confirm follow REPO and say today\'s words by default', function () {
    var s = setup('0.11.0');
    var T = s.U.text;
    var F = s.S.UpdateFailure;
    var notChecked = T.state(s.U.check.status());
    assert.strictEqual(notChecked, 'Not checked yet. Steward checks GitHub (rknall/steward) when the client ' +
        'starts, at most once an hour.');
    assert.strictEqual(T.checkOnStartHelp(), 'At most one check an hour, whatever you set.');
    assert.strictEqual(T.failure(F.ForeignUrl), 'Refused a download address outside github.com/rknall/steward.');
    assert.ok(T.failure(F.RestoreFailed).indexOf('the backup file stays in steward/backups/.') > 0);
    var rel = relOf(s, '0.12.0');
    assert.ok(T.confirm(rel, null, ctxOf({})).indexOf(
        'saved to steward/backups/settings-<date and time>-v0.11.0.json.') > 0);

    s.U.REPO.slug = 'someone/else';
    s.U.REPO.checkMinIntervalMs = 7200000;
    s.U.REPO.backupSub = 'saved';
    assert.ok(T.state(s.U.check.status()).indexOf('(someone/else)') > 0);
    assert.ok(T.state(s.U.check.status()).indexOf('at most once every 2 hours.') > 0);
    assert.strictEqual(T.checkOnStartHelp(), 'At most one check every 2 hours, whatever you set.');
    assert.ok(T.failure(F.ForeignUrl).indexOf('github.com/someone/else.') > 0);
    assert.ok(T.failure(F.RestoreFailed).indexOf('stays in steward/saved/.') > 0);
    assert.ok(T.confirm(rel, null, ctxOf({})).indexOf('steward/saved/settings-<date and time>-v0.11.0.json') > 0);

    s.U.REPO.checkMinIntervalMs = 1800000;
    assert.strictEqual(T.checkOnStartHelp(), 'At most one check every 30 minutes, whatever you set.');
    s.U.check.run({ manual: true });
    assert.strictEqual(T.state(s.U.check.status()), 'Checking github.com/someone/else for releases…');
});

// ---- status labels ----------------------------------------------------------

t.test('text.badge has a label for every state and for a failed install', function () {
    var s = setup('0.11.0');
    var K = s.S.UpdateState;
    var T = s.U.text;
    assert.strictEqual(T.badge(status(s, { state: K.Idle }), false), 'Idle');
    assert.strictEqual(T.badge(status(s, { state: K.Idle, devBuild: true }), false), 'Development build');
    assert.strictEqual(T.badge(status(s, { state: K.Checking }), false), 'Checking');
    assert.strictEqual(T.badge(status(s, { state: K.Installing }), false), 'Installing');
    assert.strictEqual(T.badge(status(s, { state: K.Installing }), true), 'Installing');
    assert.strictEqual(T.badge(status(s, { state: K.Available }), false), 'Update available');
    assert.strictEqual(T.badge(status(s, { state: K.Failed }), false), 'Check failed');
    assert.strictEqual(T.badge(status(s, { state: K.Current }), false), 'Up to date');
    assert.strictEqual(T.badge(status(s, { state: K.Current, devBuild: true }), false), 'Development build');
    assert.strictEqual(T.badge(status(s, { state: K.Current }), true), 'Failed');
});

t.test('text.checkedMeta covers never, checking, checked and failed', function () {
    var s = setup('0.11.0');
    var K = s.S.UpdateState;
    var T = s.U.text;
    assert.strictEqual(T.checkedMeta(status(s, { state: K.Idle })), 'Never checked');
    assert.strictEqual(T.checkedMeta(status(s, { state: K.Checking, checkedAt: T0 })), 'Checking');
    assert.strictEqual(T.checkedMeta(status(s, { state: K.Current, checkedAt: T0 })),
        'Checked ' + T.dateTime(T0));
    assert.strictEqual(T.checkedMeta(status(s, { state: K.Failed, checkedAt: T0 })),
        'Last check ' + T.dateTime(T0));
    assert.ok(/^\d{4}-\d{2}-\d{2} \d/.test(T.dateTime(T0)), T.dateTime(T0));
    assert.strictEqual(T.dateTime(0), '');
    assert.strictEqual(T.date(0), '');
});

t.test('the rendered status card keeps its running, failed-install and automatic-install lines', function () {
    var s = setup('0.11.0');
    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    var $m = render(s);
    assert.ok($m.text().indexOf('Running: Steward v0.11.0') >= 0);
    assert.ok($m.text().indexOf('Automatic install is off') >= 0);
    s.answer = true;
    button($m, 'Install v0.12.0').click();
    s.installs[0].done({ ok: false, failure: s.S.UpdateFailure.SizeMismatch, version: '0.12.0' });
    assert.ok($m.text().indexOf('Install of v0.12.0 failed') >= 0);
});

// ---- the card names the version being installed -------------------------------

t.test('a manual install shows the download step and the target version', function () {
    var s = setup('0.11.0');
    check(s, [gh('v0.12.0'), gh('v0.11.0')]);
    s.U.install.run = s.realRun;
    var $m = render(s);
    s.answer = true;
    button($m, 'Install v0.12.0').click();
    var $c = render(s);
    assert.strictEqual(s.U.install.target(), '0.12.0');
    assert.ok($c.text().indexOf(s.U.text.step(s.S.InstallStep.Download, '0.12.0')) >= 0);
    assert.ok($c.text().indexOf('Downloading v0.12.0…') >= 0);
    assert.ok($c.text().indexOf('Installing v0.12.0') >= 0);
});

t.test('an automatic install started by the boot check shows the same lines', function () {
    var s = setup('0.11.0');
    s.S.kernel.settings.write('updater', { autoInstall: true });
    s.U.install.run = s.realRun;
    s.U.check.run({ manual: false });
    s.net.respondJson(s.net.requests.length - 1, [gh('v0.12.0'), gh('v0.11.0')]);
    assert.strictEqual(s.U.install.busy(), true);
    var $c = render(s);
    assert.ok($c.text().indexOf('Downloading v0.12.0…') >= 0);
    assert.ok($c.text().indexOf('Installing v0.12.0') >= 0);
    assert.ok($c.text().indexOf('Installing an update') < 0);
});

// ---- test releases follow the running build -------------------------------------

t.test('the versions list hides test releases for a release build and shows them for a test build', function () {
    var list = [gh('v0.12.0-beta1'), gh('v0.11.0-beta1'), gh('v0.10.0')];
    var a = setup('0.11.0');
    check(a, list);
    var textA = render(a).text();
    assert.strictEqual(textA.indexOf('v0.12.0-beta1'), -1);
    assert.strictEqual(textA.indexOf('(Test release)'), -1);

    var b = setup('0.11.0-beta1');
    check(b, list);
    var textB = render(b).text();
    assert.ok(textB.indexOf('v0.12.0-beta1') >= 0, textB);
    assert.ok(textB.indexOf('(Test release)') >= 0 || textB.indexOf('Test') >= 0);
});
