'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var AC = require('../stubs/actions');
var MS = require('../stubs/mail');

var assert = t.assert;

// A booted setup with an in-memory disk, the mail host fakes on the home
// island and a controllable clock (the dump file name carries the epoch ms).
// The caller restores the clock.
function setup(list) {
    var RealDate = Date;
    var clock = { now: 2000000 };
    function FakeDate(a) {
        if (arguments.length) return new RealDate(a);
        return new RealDate(clock.now);
    }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = function () { return clock.now; };
    global.Date = FakeDate;

    var fs = airfs.make();
    var H = harness.boot({ host: { air: fs.air } });
    var sent = AC.wire(H);
    var M = MS.install(H);
    H.host.game.gi.channels = { MailChannel: {}, ChatChannel: {} };
    if (list) M.prime(list);
    return {
        H: H, M: M, fs: fs, clock: clock, sent: sent,
        mail: H.Steward.modules.diagnostics.mail,
        restore: function () { global.Date = RealDate; }
    };
}

function withSetup(list, fn) {
    var s = setup(list);
    try { fn(s); } finally { s.restore(); }
}

function files(s) {
    return Object.keys(s.fs.disk).filter(function (k) {
        return /\/steward\/dumps\/mail-[A-Za-z0-9_-]+-\d+\.json$/.test(k);
    });
}

function headerCount(s) {
    return s.M.sentOf(MS.MSG_HEADERS).length;
}

t.test('dump writes mail-<zone>-<ms>.json with every part', function () {
    withSetup([MS.mail(1, 6), MS.mail(2, 6), MS.mail(3, 7)], function (s) {
        s.mail.dump();
        var found = files(s);
        assert.strictEqual(found.length, 1);
        assert.ok(/mail-77-2000000\.json$/.test(found[0]));
        var doc = JSON.parse(s.fs.disk[found[0]]);
        ['window', 'service', 'channels', 'snapshot', 'types'].forEach(function (k) {
            assert.ok(doc[k] !== undefined, k + ' is in the document');
        });
        assert.strictEqual(doc.window.open.state, 'ok');
        assert.strictEqual(doc.window.open.value, false);
        assert.strictEqual(doc.window.present, true);
        assert.deepStrictEqual(doc.channels, ['ChatChannel', 'MailChannel']);
        assert.strictEqual(doc.snapshot.state, 'ok');
        assert.strictEqual(doc.snapshot.count, 3);
        assert.strictEqual(doc.types['6'].count, 2);
        assert.strictEqual(doc.types['7'].count, 1);
        assert.strictEqual(doc.types['6'].type, 6);
    });
});

t.test('two dumps do not overwrite each other', function () {
    withSetup([MS.mail(1, 6)], function (s) {
        s.mail.dump();
        s.clock.now += 5;
        s.mail.dump();
        assert.strictEqual(files(s).length, 2);
    });
});

t.test('dump asks for the headers exactly once and sends nothing else', function () {
    withSetup(null, function (s) {
        var before = headerCount(s);
        s.mail.dump();
        s.M.drive();
        assert.strictEqual(headerCount(s) - before, 1);
        assert.strictEqual(s.sent.actions.length, 0);
        assert.strictEqual(s.M.messages.length, before + 1);
        var doc = JSON.parse(s.fs.disk[files(s)[0]]);
        assert.ok(doc.refresh !== undefined);
    });
});

t.test('dump logs the document in chunks when no folder is writable', function () {
    withSetup([MS.mail(1, 6)], function (s) {
        s.H.Steward.kernel.files.stewardDir = function () { return null; };
        s.H.clearLogs();
        s.mail.dump();
        assert.strictEqual(files(s).length, 0);
        var logs = s.H.logs().filter(function (l) { return l.category === 'diag:mail'; });
        assert.ok(logs.some(function (l) { return /^window 1\/\d+: /.test(String(l.args[0])); }));
        assert.ok(logs.some(function (l) { return /^types 1\/\d+: /.test(String(l.args[0])); }));
    });
});

t.test('a throwing host part becomes an error value, not an abort', function () {
    withSetup([MS.mail(1, 6)], function (s) {
        Object.defineProperty(s.H.host.game.gi, 'channels', {
            get: function () { throw new Error('no channels'); },
            configurable: true
        });
        s.mail.dump();
        var found = files(s);
        assert.strictEqual(found.length, 1);
        var doc = JSON.parse(s.fs.disk[found[0]]);
        assert.ok(/no channels/.test(doc.channels.error));
        assert.strictEqual(doc.snapshot.state, 'ok');
        assert.strictEqual(doc.types['6'].count, 1);
    });
});

t.test('a missing mail window is recorded, not fatal', function () {
    withSetup([MS.mail(1, 6)], function (s) {
        s.M.setWindow(null);
        s.mail.dump();
        var doc = JSON.parse(s.fs.disk[files(s)[0]]);
        assert.strictEqual(doc.window.present, false);
        assert.strictEqual(doc.window.types, null);
        assert.strictEqual(doc.types['6'].count, 1);
    });
});

t.test('no body text, subject or sender name appears in the document', function () {
    withSetup([MS.mail(1, 6, { body_string: 'SECRETBODY' }), MS.mail(2, 7)], function (s) {
        s.M.setPassive([MS.mail(1, 6, { body_string: 'SECRETBODY' })]);
        s.mail.dump();
        var text = s.fs.disk[files(s)[0]];
        assert.ok(text.indexOf('SECRETBODY') < 0);
        assert.ok(text.indexOf('Subject 1') < 0);
        assert.ok(text.indexOf('Sender 1') < 0);
        var doc = JSON.parse(text);
        assert.ok(doc.firstRaw.indexOf('body_string') >= 0, 'member names only');
    });
});
