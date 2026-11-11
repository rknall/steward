'use strict';

var t = require('../runner');
var harness = require('../harness');
var path = require('path');
var versionScript = require('../../scripts/version');
var repoRoot = path.join(__dirname, '..', '..');

var assert = t.assert;

function boot(version) {
    var H = harness.boot({ sections: ['kernel'] });
    if (version !== undefined) H.Steward.kernel.VERSION = version;
    return H.Steward;
}

t.test('semver order table', function () {
    var S = boot();
    var sv = S.kernel.semver;
    var order = ['0.5.0-alpha', '0.5.0-alpha2', '0.5.0-alpha10', '0.5.0', '0.5.0-dirty',
        '0.5.0-1-gabc', '0.5.0-3-gabc', '0.5.0-3-gabc-dirty', '0.5.1'];
    for (var i = 0; i < order.length; i++) {
        for (var j = 0; j < order.length; j++) {
            var want = i < j ? -1 : (i > j ? 1 : 0);
            assert.strictEqual(sv.compare(order[i], order[j]), want, order[i] + ' vs ' + order[j]);
        }
    }
});

t.test('semver compares numerically, not as strings', function () {
    var sv = boot().kernel.semver;
    assert.strictEqual(sv.compare('0.10.0', '0.9.0'), 1);
    assert.strictEqual(sv.compare('1.0.0', '0.99.99'), 1);
    assert.strictEqual(sv.compare('0.0.10', '0.0.9'), 1);
});

t.test('semver parse kinds and fields', function () {
    var S = boot();
    var sv = S.kernel.semver;
    var K = S.VersionKind;
    var r = sv.parse('1.2.3');
    assert.strictEqual(r.kind, K.Release);
    assert.strictEqual(r.major, 1);
    assert.strictEqual(r.minor, 2);
    assert.strictEqual(r.patch, 3);
    assert.strictEqual(sv.parse('1.2.3-alpha2').kind, K.Prerelease);
    assert.strictEqual(sv.parse('1.2.3-alpha2').pre, 'alpha2');
    var d = sv.parse('1.2.3-4-gabc1234-dirty');
    assert.strictEqual(d.kind, K.Dev);
    assert.strictEqual(d.ahead, 4);
    assert.strictEqual(d.dirty, true);
    var d2 = sv.parse('1.2.3-dirty');
    assert.strictEqual(d2.kind, K.Dev);
    assert.strictEqual(d2.ahead, 0);
    assert.strictEqual(d2.dirty, true);
});

t.test('semver: a dev build on a prerelease base is a Prerelease', function () {
    var S = boot();
    var sv = S.kernel.semver;
    var p = sv.parse('0.5.0-alpha2-3-gabc');
    assert.strictEqual(p.kind, S.VersionKind.Prerelease);
    assert.strictEqual(p.pre, 'alpha2-3-gabc');
    assert.strictEqual(sv.compare('0.5.0-alpha2', '0.5.0-alpha2-3-gabc'), -1);
    assert.strictEqual(sv.compare('0.5.0-alpha2-3-gabc', '0.5.0-alpha10'), -1);
    assert.strictEqual(sv.autoInstallable('0.5.0-alpha2-3-gabc', '0.6.0'), false);
    assert.strictEqual(sv.autoInstallable('0.4.0', '0.5.0-alpha2-3-gabc'), false);
});

t.test('semver: 0.0.0 is Unknown, garbage is null, a v prefix is dropped', function () {
    var S = boot();
    var sv = S.kernel.semver;
    assert.strictEqual(sv.parse('0.0.0').kind, S.VersionKind.Unknown);
    ['', 'abc', '1.2', '1.2.3.4', null, undefined, 5, {}].forEach(function (g) {
        assert.strictEqual(sv.parse(g), null, String(g));
    });
    var v = sv.parse('v1.2.3');
    assert.strictEqual(v.text, '1.2.3');
    assert.strictEqual(v.kind, S.VersionKind.Release);
    assert.strictEqual(sv.compare('v1.2.3', '1.2.3'), 0);
});

t.test('semver compare puts unparseable input below a valid version', function () {
    var sv = boot().kernel.semver;
    assert.strictEqual(sv.compare('garbage', '1.0.0'), -1);
    assert.strictEqual(sv.compare('1.0.0', 'garbage'), 1);
    assert.strictEqual(sv.compare('garbage', 'junk'), 0);
});

t.test('semver isNewer never offers an update to an Unknown or unparseable base', function () {
    var sv = boot().kernel.semver;
    assert.strictEqual(sv.isNewer('1.0.0', '0.0.0'), false);
    assert.strictEqual(sv.isNewer('1.0.0', 'garbage'), false);
    assert.strictEqual(sv.isNewer('1.0.1', '1.0.0'), true);
    assert.strictEqual(sv.isNewer('1.0.0', '1.0.0'), false);
    assert.strictEqual(sv.isNewer('1.0.0', '1.0.1'), false);
});

t.test('semver autoInstallable: only release over an older release', function () {
    var sv = boot().kernel.semver;
    assert.strictEqual(sv.autoInstallable('0.5.0', '0.5.1'), true);
    assert.strictEqual(sv.autoInstallable('0.5.0', '0.5.0'), false);
    assert.strictEqual(sv.autoInstallable('0.5.1', '0.5.0'), false);
    assert.strictEqual(sv.autoInstallable('0.5.0-alpha', '0.5.0'), false);
    assert.strictEqual(sv.autoInstallable('0.5.0', '0.6.0-alpha'), false);
    assert.strictEqual(sv.autoInstallable('0.5.0-3-gabc', '0.6.0'), false);
    assert.strictEqual(sv.autoInstallable('0.5.0-dirty', '0.6.0'), false);
    assert.strictEqual(sv.autoInstallable('0.0.0', '0.6.0'), false);
    assert.strictEqual(sv.autoInstallable('garbage', '0.6.0'), false);
    assert.strictEqual(sv.autoInstallable('0.5.0', 'garbage'), false);
});

t.test('semver running parses Steward.kernel.VERSION', function () {
    var S = boot('1.4.2-3-gabc1234');
    var r = S.kernel.semver.running();
    assert.strictEqual(r.kind, S.VersionKind.Dev);
    assert.strictEqual(r.ahead, 3);
    assert.strictEqual(boot('nonsense').kernel.semver.running(), null);
});

t.test('semver parses what scripts/version.js produces from git describe', function () {
    var S = boot();
    var K = S.VersionKind;
    var cases = [
        ['v0.10.14', K.Release],
        ['v0.10.14-3-gabc1234', K.Dev],
        ['v0.10.14-3-gabc1234-dirty', K.Dev],
        ['v0.10.14-dirty', K.Dev],
        ['v0.10.14-alpha2', K.Prerelease],
        ['v0.10.14-alpha2-3-gabc1234', K.Prerelease],
        ['v0.0.0', K.Unknown]
    ];
    cases.forEach(function (c) {
        var text = versionScript.fromDescribe(c[0]);
        var p = S.kernel.semver.parse(text);
        assert.ok(p, c[0] + ' parses');
        assert.strictEqual(p.kind, c[1], c[0]);
    });
});

t.test('semver: the package.json placeholder version is Unknown', function () {
    var S = boot();
    var sv = S.kernel.semver;
    var K = S.VersionKind;
    var placeholder = require(path.join(repoRoot, 'package.json')).version;
    var p = sv.parse(placeholder);
    assert.ok(p, 'the placeholder parses');
    assert.strictEqual(p.kind, K.Unknown);
    assert.strictEqual(sv.isNewer('0.11.0', placeholder), false);
    assert.strictEqual(sv.autoInstallable(placeholder, '0.11.0'), false);
    assert.strictEqual(versionScript.resolve(undefined, null, placeholder), placeholder);
    assert.strictEqual(sv.parse('0.0.0-dirty').kind, K.Unknown);
    assert.strictEqual(sv.parse('0.0.0-1-gabc1234').kind, K.Unknown);
    assert.strictEqual(sv.parse('0.0.1-git').kind, K.Prerelease);
});
