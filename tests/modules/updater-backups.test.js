'use strict';

// Settings backups of the updater: what create() writes, which records
// list() and pick() see for the running profile, how prune() trims, and what
// restore() replaces in the host settings.

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');

var assert = t.assert;

var BASE = Date.UTC(2026, 4, 10, 12, 0, 0);

function setup(profile) {
    var fs = airfs.make();
    var H = harness.boot({ host: { air: fs.air } });
    H.ctx.settingsFile = profile || 'settings.json';
    var U = H.Steward.modules.updater;
    var clock = { ms: BASE };
    U.now = function () { return clock.ms; };
    return { H: H, S: H.Steward, U: U, fs: fs, B: U.backups, clock: clock,
             host: H.host.settings };
}

function seedSettings(s) {
    s.host.settings['steward.kernel'] = { paused: false, logLevel: 'LOG' };
    s.host.settings['steward.mining'] = { enabled: true, zones: { a: 1 } };
    s.host.settings['steward.updaterState'] = { lastCheck: 5, notice: { to: '9.9.9' } };
    s.host.settings['someoneelse'] = { keep: 'me' };
}

// Writes a backup `minutes` after BASE, left from version `from`.
function makeAt(s, from, to, minutes) {
    s.clock.ms = BASE + minutes * 60000;
    var res = s.B.create(from, to);
    assert.strictEqual(res.ok, true, 'create ' + from + ': ' + res.message);
    return res;
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function fileBody(s, path) { return JSON.parse(s.fs.disk[path]); }

t.test('create writes the namespaces of all() and never updaterState', function () {
    var s = setup();
    seedSettings(s);
    var res = s.B.create('0.11.0', '0.12.0');
    assert.strictEqual(res.ok, true);
    var body = fileBody(s, res.path);
    var expected = plain(s.S.kernel.settings.all());
    delete expected.updaterState;
    assert.deepStrictEqual(body.namespaces, expected);
    assert.strictEqual('updaterState' in body.namespaces, false);
    assert.strictEqual('someoneelse' in body.namespaces, false);
    assert.strictEqual(body.format, 1);
    assert.strictEqual(body.kind, 'steward-settings-backup');
    assert.strictEqual(body.fromVersion, '0.11.0');
    assert.strictEqual(body.toVersion, '0.12.0');
    assert.strictEqual(body.profile, 'settings.json');
    assert.strictEqual(body.time, BASE);
    assert.strictEqual(res.record.name, res.path.slice(res.path.lastIndexOf('/') + 1));
    assert.ok(/^settings-\d{8}-\d{6}-v0\.11\.0\.json$/.test(res.record.name), res.record.name);
    assert.ok(res.path.indexOf('/steward/backups/') > 0, res.path);
});

t.test('a backup never contains updaterState even when the state is large', function () {
    var s = setup();
    seedSettings(s);
    s.host.settings['steward.updaterState'].extra = new Array(50).join('x');
    var res = s.B.create('0.11.0', '0.12.0');
    assert.strictEqual(s.fs.disk[res.path].indexOf('updaterState'), -1);
    assert.strictEqual(s.fs.disk[res.path].indexOf('9.9.9'), -1);
});

t.test('create does not touch the live settings', function () {
    var s = setup();
    seedSettings(s);
    var before = plain(s.host.settings);
    s.B.create('0.11.0', '0.12.0');
    assert.deepStrictEqual(plain(s.host.settings), before);
});

t.test('two backups in the same second get distinct names', function () {
    var s = setup();
    seedSettings(s);
    var a = s.B.create('0.11.0', '0.12.0');
    var b = s.B.create('0.11.0', '0.12.0');
    var c = s.B.create('0.11.0', '0.12.0');
    assert.notStrictEqual(a.path, b.path);
    assert.ok(/-v0\.11\.0-2\.json$/.test(b.path), b.path);
    assert.ok(/-v0\.11\.0-3\.json$/.test(c.path), c.path);
    assert.strictEqual(s.B.list().length, 3);
});

t.test('create names its file with fileName and the folder shows the display path', function () {
    var s = setup();
    seedSettings(s);
    var a = s.B.create('0.11.0', '0.12.0');
    // The stamp is local time, so read it back from the name.
    var stamp = /^settings-(\d{8}-\d{6})-v/.exec(a.record.name)[1];
    assert.strictEqual(a.record.name, s.B.fileName(stamp, '0.11.0'));
    var b = s.B.create('0.11.0', '0.12.0');
    assert.strictEqual(b.record.name, s.B.fileName(stamp, '0.11.0', 2));
    assert.strictEqual(s.B.fileName(stamp, '0.11.0', 1), s.B.fileName(stamp, '0.11.0'));
    assert.strictEqual(s.B.folder(), 'steward/backups/');
});

t.test('the version in the file name never adds a path or illegal character', function () {
    var s = setup();
    seedSettings(s);
    var res = s.B.create('0.11.0-3-gabc/..\\x:y', '0.12.0');
    assert.strictEqual(res.ok, true);
    assert.ok(/-v0\.11\.0-3-gabc_.._x_y\.json$/.test(res.record.name), res.record.name);
    assert.strictEqual(res.record.name.indexOf('/'), -1);
    assert.strictEqual(res.record.name.indexOf('\\'), -1);
});

t.test('create reports a failed write and leaves no file', function () {
    var s = setup();
    seedSettings(s);
    var probe = s.B.create('0.11.0', '0.12.0');
    s.S.kernel.files.remove(probe.path);
    // The same clock second picks the same name again, and the move onto it fails.
    s.fs.fail.move[probe.path] = true;
    var res = s.B.create('0.11.0', '0.12.0');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(typeof res.message, 'string');
    assert.strictEqual(s.B.list().length, 0);
});

t.test('list is newest first, per profile, and counts the other profiles', function () {
    var s = setup('main.json');
    seedSettings(s);
    makeAt(s, '0.9.0', '0.10.0', 1);
    makeAt(s, '0.10.0', '0.11.0', 2);
    s.H.ctx.settingsFile = 'alt.json';
    makeAt(s, '0.11.0', '0.12.0', 3);
    s.H.ctx.settingsFile = 'main.json';
    var list = s.B.list();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list.others, 1);
    assert.strictEqual(list[0].fromVersion, '0.10.0');
    assert.strictEqual(list[1].fromVersion, '0.9.0');
    assert.strictEqual(list[0].profile, 'main.json');
    assert.strictEqual(list[0].toVersion, '0.11.0');
    assert.strictEqual(list[0].time, BASE + 2 * 60000);
    s.H.ctx.settingsFile = 'alt.json';
    var alt = s.B.list();
    assert.strictEqual(alt.length, 1);
    assert.strictEqual(alt.others, 2);
});

t.test('profile falls back to settings.json when the host has no settingsFile', function () {
    var s = setup();
    delete s.H.ctx.settingsFile;
    assert.strictEqual(s.B.profile(), 'settings.json');
    s.H.ctx.settingsFile = '';
    assert.strictEqual(s.B.profile(), 'settings.json');
    s.H.ctx.settingsFile = 'second.json';
    assert.strictEqual(s.B.profile(), 'second.json');
});

t.test('list skips unreadable and foreign files and warns about them', function () {
    var s = setup();
    seedSettings(s);
    var good = makeAt(s, '0.10.0', '0.11.0', 1);
    var dir = good.path.slice(0, good.path.lastIndexOf('/'));
    s.fs.disk[dir + '/broken.json'] = '{ not json';
    s.fs.disk[dir + '/other.json'] = JSON.stringify({ format: 1, kind: 'something-else', namespaces: {} });
    s.fs.disk[dir + '/oldformat.json'] = JSON.stringify({ format: 2, kind: 'steward-settings-backup', namespaces: {} });
    s.fs.disk[dir + '/notes.txt'] = 'ignored';
    s.H.clearLogs();
    var list = s.B.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, good.record.name);
    var warns = s.H.logs().filter(function (l) { return l.level === 'warn' && l.category === 'updater'; });
    assert.strictEqual(warns.length, 3);
});

t.test('pick: an exact match wins, newest on ties', function () {
    var s = setup();
    seedSettings(s);
    makeAt(s, '0.9.0', '0.10.0', 1);
    makeAt(s, '0.10.0', '0.11.0', 2);
    var newer = makeAt(s, '0.10.0', '0.11.0', 3);
    makeAt(s, '0.11.0', '0.12.0', 4);
    var p = s.B.pick('0.10.0');
    assert.strictEqual(p.exact, true);
    assert.strictEqual(p.record.path, newer.path);
});

t.test('pick: without an exact match the closest older version is used', function () {
    var s = setup();
    seedSettings(s);
    makeAt(s, '0.9.0', '0.10.0', 1);
    makeAt(s, '0.10.0', '0.11.0', 2);
    makeAt(s, '0.12.0', '0.13.0', 3);
    var p = s.B.pick('0.11.5');
    assert.strictEqual(p.exact, false);
    assert.strictEqual(p.record.fromVersion, '0.10.0');
    var q = s.B.pick('0.12.0-alpha1');
    assert.strictEqual(q.exact, false);
    assert.strictEqual(q.record.fromVersion, '0.10.0');
});

t.test('pick: nothing older, an unparseable target, or no backups gives null', function () {
    var s = setup();
    assert.strictEqual(s.B.pick('0.5.0'), null);
    seedSettings(s);
    makeAt(s, '0.10.0', '0.11.0', 1);
    assert.strictEqual(s.B.pick('0.9.0'), null);
    assert.strictEqual(s.B.pick('not a version'), null);
});

t.test('pick ignores the backups of other profiles', function () {
    var s = setup('main.json');
    seedSettings(s);
    s.H.ctx.settingsFile = 'alt.json';
    makeAt(s, '0.10.0', '0.11.0', 1);
    s.H.ctx.settingsFile = 'main.json';
    assert.strictEqual(s.B.pick('0.10.0'), null);
});

t.test('prune keeps the newest N and never the protected path', function () {
    var s = setup();
    seedSettings(s);
    var oldest = makeAt(s, '0.7.0', '0.8.0', 1);
    makeAt(s, '0.8.0', '0.9.0', 2);
    makeAt(s, '0.9.0', '0.10.0', 3);
    makeAt(s, '0.10.0', '0.11.0', 4);
    // Beyond the newest two are two files; the protected one stays.
    var removed = s.B.prune(2, oldest.path);
    assert.strictEqual(removed, 1);
    var left = s.B.list();
    assert.strictEqual(left.length, 3);
    var froms = plain(left.map(function (r) { return r.fromVersion; }));
    assert.deepStrictEqual(froms, ['0.10.0', '0.9.0', '0.7.0']);
});

t.test('prune keeps every path in a keep list', function () {
    var s = setup();
    seedSettings(s);
    var a = makeAt(s, '0.7.0', '0.8.0', 1);
    var b = makeAt(s, '0.8.0', '0.9.0', 2);
    makeAt(s, '0.9.0', '0.10.0', 3);
    makeAt(s, '0.10.0', '0.11.0', 4);
    var removed = s.B.prune(1, [a.path, b.path]);
    assert.strictEqual(removed, 1);
    var froms = plain(s.B.list().map(function (r) { return r.fromVersion; }));
    assert.deepStrictEqual(froms, ['0.10.0', '0.8.0', '0.7.0']);
});

t.test('prune keeps at least one backup and spares other profiles', function () {
    var s = setup('main.json');
    seedSettings(s);
    s.H.ctx.settingsFile = 'alt.json';
    makeAt(s, '0.5.0', '0.6.0', 1);
    s.H.ctx.settingsFile = 'main.json';
    makeAt(s, '0.9.0', '0.10.0', 2);
    makeAt(s, '0.10.0', '0.11.0', 3);
    assert.strictEqual(s.B.prune(0, null), 1);
    assert.strictEqual(s.B.list().length, 1);
    assert.strictEqual(s.B.list()[0].fromVersion, '0.10.0');
    assert.strictEqual(s.B.list().others, 1);
});

t.test('restore replaces the namespaces, drops those the backup lacks and saves once', function () {
    var s = setup();
    seedSettings(s);
    var res = s.B.create('0.11.0', '0.12.0');
    // The newer build changed things and added a module namespace.
    s.host.settings['steward.kernel'] = { paused: true, logLevel: 'DEBUG', newKey: 1 };
    s.host.settings['steward.mining'] = { enabled: false, extra: true };
    s.host.settings['steward.brandnew'] = { a: 1 };
    s.host.settings['steward.updaterState'] = { lastCheck: 99, notice: { to: '0.12.0', restored: false } };
    var saves = s.host.saves;
    var carryState = { lastCheck: 99, notice: { to: '0.12.0', restored: true } };

    var ok = s.B.restore(res.record, { paused: true, state: carryState });

    assert.strictEqual(ok, true);
    assert.strictEqual(s.host.saves, saves + 1);
    assert.deepStrictEqual(plain(s.host.settings['steward.mining']), { enabled: true, zones: { a: 1 } });
    assert.strictEqual('steward.brandnew' in s.host.settings, false);
    assert.deepStrictEqual(plain(s.host.settings['steward.kernel']), { paused: true, logLevel: 'LOG' });
    assert.deepStrictEqual(plain(s.host.settings['steward.updaterState']), carryState);
    assert.deepStrictEqual(plain(s.host.settings.someoneelse), { keep: 'me' });
});

t.test('restore keeps the carried kernel.paused and updaterState', function () {
    var s = setup();
    seedSettings(s);
    s.host.settings['steward.kernel'] = { paused: false };
    var res = s.B.create('0.11.0', '0.12.0');
    var state = { notice: { restored: true } };
    assert.strictEqual(s.B.restore(res.record, { paused: true, state: state }), true);
    assert.strictEqual(s.host.settings['steward.kernel'].paused, true);
    assert.deepStrictEqual(plain(s.host.settings['steward.updaterState']), state);
});

t.test('restore without carry values leaves the backup kernel and no state', function () {
    var s = setup();
    seedSettings(s);
    var res = s.B.create('0.11.0', '0.12.0');
    assert.strictEqual(s.B.restore(res.record, {}), true);
    assert.strictEqual(s.host.settings['steward.kernel'].paused, false);
    assert.strictEqual('steward.updaterState' in s.host.settings, false);
});

t.test('restore builds a kernel namespace when the backup has none', function () {
    var s = setup();
    s.host.settings['steward.mining'] = { enabled: true };
    var res = s.B.create('0.11.0', '0.12.0');
    assert.strictEqual(s.B.restore(res.record, { paused: true }), true);
    assert.deepStrictEqual(plain(s.host.settings['steward.kernel']), { paused: true });
});

t.test('restore of a missing or invalid file changes nothing and does not save', function () {
    var s = setup();
    seedSettings(s);
    var res = s.B.create('0.11.0', '0.12.0');
    var before = plain(s.host.settings);
    var saves = s.host.saves;

    assert.strictEqual(s.B.restore({ path: res.path + '.gone' }, {}), false);
    s.fs.disk[res.path] = JSON.stringify({ format: 1, kind: 'steward-settings-backup' });
    assert.strictEqual(s.B.restore(res.record, {}), false);
    s.fs.disk[res.path] = '{ nope';
    assert.strictEqual(s.B.restore(res.record, {}), false);
    assert.strictEqual(s.B.restore(null, {}), false);

    assert.deepStrictEqual(plain(s.host.settings), before);
    assert.strictEqual(s.host.saves, saves);
});

t.test('read returns the namespaces or the reason', function () {
    var s = setup();
    seedSettings(s);
    var res = s.B.create('0.11.0', '0.12.0');
    var r = s.B.read(res.path);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(plain(r.namespaces.mining), { enabled: true, zones: { a: 1 } });
    var bad = s.B.read(res.path + '.gone');
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(typeof bad.message, 'string');
});
