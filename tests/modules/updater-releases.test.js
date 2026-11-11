'use strict';

// The release list of the updater: what parse() keeps, how it orders and
// labels it, which release latest() picks, and how fetch() maps a failed or
// odd answer to an S.UpdateFailure.

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var netStub = require('../stubs/net');

var assert = t.assert;

var HEX = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
var PREFIX = 'https://github.com/rknall/steward/releases/download/';

function setup() {
    var fs = airfs.make();
    var net = netStub.make(fs);
    var H = harness.boot({ host: { air: fs.air } });
    H.host.$.ajax = net.ajax;
    return { H: H, S: H.Steward, net: net, rel: H.Steward.modules.updater.releases };
}

// One GitHub release object as the API sends it; `over` replaces fields.
function gh(tag, over) {
    var r = {
        tag_name: tag,
        name: 'Steward ' + tag,
        draft: false,
        prerelease: false,
        published_at: '2026-03-04T05:06:07Z',
        body: 'Notes for ' + tag,
        assets: [{
            name: 'user_steward.js',
            size: 4096,
            digest: 'sha256:' + HEX,
            browser_download_url: PREFIX + tag + '/user_steward.js'
        }]
    };
    for (var k in over) if (over.hasOwnProperty(k)) r[k] = over[k];
    return r;
}

function texts(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i].text);
    return out;
}

t.test('a valid release parses into a full record', function () {
    var s = setup();
    var res = s.rel.parse([gh('v0.11.0')]);
    assert.strictEqual(res.list.length, 1);
    assert.strictEqual(res.skipped, 0);
    var r = res.list[0];
    assert.strictEqual(r.tag, 'v0.11.0');
    assert.strictEqual(r.text, '0.11.0');
    assert.strictEqual(r.name, 'Steward v0.11.0');
    assert.strictEqual(r.body, 'Notes for v0.11.0');
    assert.strictEqual(r.published, Date.parse('2026-03-04T05:06:07Z'));
    assert.strictEqual(r.prerelease, false);
    assert.strictEqual(r.version.major, 0);
    assert.strictEqual(r.version.minor, 11);
    assert.strictEqual(r.asset.url, PREFIX + 'v0.11.0/user_steward.js');
    assert.strictEqual(r.asset.size, 4096);
    assert.strictEqual(r.asset.digest, HEX);
});

t.test('tags: v0.11.0 is kept, vv0.11.0, 0.11.0, v0.0.0 and v1.2 are skipped', function () {
    var s = setup();
    var res = s.rel.parse([gh('v0.11.0'), gh('vv0.11.0'), gh('0.11.0'), gh('v0.0.0'), gh('v1.2')]);
    assert.deepStrictEqual(texts(res.list), ['0.11.0']);
    assert.strictEqual(res.skipped, 4);
});

t.test('a draft is skipped', function () {
    var s = setup();
    var res = s.rel.parse([gh('v0.11.0', { draft: true }), gh('v0.10.0')]);
    assert.deepStrictEqual(texts(res.list), ['0.10.0']);
    assert.strictEqual(res.skipped, 1);
});

t.test('an asset URL outside the tag download path is skipped', function () {
    var s = setup();
    var foreign = gh('v0.11.0');
    foreign.assets[0].browser_download_url = 'https://evil.example.com/user_steward.js';
    var otherTag = gh('v0.10.0');
    otherTag.assets[0].browser_download_url = PREFIX + 'v0.9.0/user_steward.js';
    var otherRepo = gh('v0.9.0');
    otherRepo.assets[0].browser_download_url =
        'https://github.com/someone/steward/releases/download/v0.9.0/user_steward.js';
    var res = s.rel.parse([foreign, otherTag, otherRepo]);
    assert.strictEqual(res.list.length, 0);
    assert.strictEqual(res.skipped, 3);
});

t.test('a release without exactly one user_steward.js asset is skipped', function () {
    var s = setup();
    var none = gh('v0.11.0', { assets: [] });
    var wrong = gh('v0.10.0');
    wrong.assets[0].name = 'steward.zip';
    var twice = gh('v0.9.0');
    twice.assets.push(JSON.parse(JSON.stringify(twice.assets[0])));
    var bad = gh('v0.8.0', { assets: 'nope' });
    var res = s.rel.parse([none, wrong, twice, bad]);
    assert.strictEqual(res.list.length, 0);
    assert.strictEqual(res.skipped, 4);
});

t.test('a bad asset size is skipped', function () {
    var s = setup();
    var list = [];
    var sizes = [0, -5, 1.5, '4096', null];
    for (var i = 0; i < sizes.length; i++) {
        var r = gh('v0.' + (20 + i) + '.0');
        r.assets[0].size = sizes[i];
        list.push(r);
    }
    assert.strictEqual(s.rel.parse(list).list.length, 0);
});

t.test('a missing or malformed digest gives null, a valid one is lowercased', function () {
    var s = setup();
    var upper = gh('v0.15.0');
    upper.assets[0].digest = 'sha256:' + HEX.toUpperCase();
    var missing = gh('v0.14.0');
    delete missing.assets[0].digest;
    var nul = gh('v0.13.0');
    nul.assets[0].digest = null;
    var shortHex = gh('v0.12.0');
    shortHex.assets[0].digest = 'sha256:abcd';
    var wrongAlgo = gh('v0.11.0');
    wrongAlgo.assets[0].digest = 'sha1:' + HEX;
    var res = s.rel.parse([upper, missing, nul, shortHex, wrongAlgo]);
    assert.strictEqual(res.list.length, 5);
    assert.strictEqual(res.list[0].asset.digest, HEX);
    for (var i = 1; i < 5; i++) assert.strictEqual(res.list[i].asset.digest, null);
});

t.test('the prerelease flag follows GitHub and the version suffix', function () {
    var s = setup();
    var res = s.rel.parse([
        gh('v0.12.0-beta1'),
        gh('v0.11.0', { prerelease: true }),
        gh('v0.10.0')
    ]);
    var by = {};
    for (var i = 0; i < res.list.length; i++) by[res.list[i].text] = res.list[i].prerelease;
    assert.strictEqual(by['0.12.0-beta1'], true);
    assert.strictEqual(by['0.11.0'], true);
    assert.strictEqual(by['0.10.0'], false);
});

t.test('the list is sorted newest first, a prerelease below its release', function () {
    var s = setup();
    var res = s.rel.parse([gh('v0.10.0'), gh('v0.12.0-alpha2'), gh('v0.12.0'), gh('v0.11.0'),
                           gh('v0.12.0-alpha10')]);
    assert.deepStrictEqual(texts(res.list),
        ['0.12.0', '0.12.0-alpha10', '0.12.0-alpha2', '0.11.0', '0.10.0']);
});

t.test('non-objects and non-arrays are counted or ignored', function () {
    var s = setup();
    var res = s.rel.parse([null, 'x', 5, [], gh('v0.11.0')]);
    assert.strictEqual(res.list.length, 1);
    assert.strictEqual(res.skipped, 4);
    var none = s.rel.parse({ not: 'array' });
    assert.strictEqual(none.list.length, 0);
});

t.test('the body is cut at REPO.bodyMaxChars', function () {
    var s = setup();
    var max = s.S.modules.updater.REPO.bodyMaxChars;
    var res = s.rel.parse([gh('v0.11.0', { body: new Array(max + 500).join('x') })]);
    assert.strictEqual(res.list[0].body.length, max);
});

t.test('latest skips prereleases unless asked for them', function () {
    var s = setup();
    var list = s.rel.parse([gh('v0.12.0-beta1'), gh('v0.11.0'), gh('v0.10.0')]).list;
    assert.strictEqual(s.rel.latest(list, false).text, '0.11.0');
    assert.strictEqual(s.rel.latest(list, true).text, '0.12.0-beta1');
    assert.strictEqual(s.rel.latest([], true), null);
    var onlyPre = s.rel.parse([gh('v0.12.0-beta1')]).list;
    assert.strictEqual(s.rel.latest(onlyPre, false), null);
    assert.strictEqual(s.rel.latest(null, false), null);
});

t.test('fetch reads the API once and hands back the parsed list', function () {
    var s = setup();
    var got = null;
    s.rel.fetch(function (failure, list, skipped) { got = { failure: failure, list: list, skipped: skipped }; });
    assert.strictEqual(s.net.requests.length, 1);
    assert.strictEqual(s.net.requests[0].url, s.S.modules.updater.REPO.api);
    s.net.respondJson(0, [gh('v0.11.0'), gh('v0.0.0')]);
    assert.strictEqual(got.failure, null);
    assert.strictEqual(got.list.length, 1);
    assert.strictEqual(got.skipped, 1);
    assert.strictEqual(s.rel.cached().list.length, 1);
});

t.test('fetch: 403 gives RateLimited, a timeout gives Network, a 500 gives BadResponse', function () {
    var s = setup();
    var F = s.S.UpdateFailure;
    var seen = [];
    function ask() { s.rel.fetch(function (failure) { seen.push(failure); }); }
    ask(); s.net.failJson(0, 403, 'error');
    ask(); s.net.failJson(1, 0, 'timeout');
    ask(); s.net.failJson(2, 500, 'error');
    assert.deepStrictEqual(seen, [F.RateLimited, F.Network, F.BadResponse]);
});

t.test('fetch: an answer that is not an array gives BadResponse and caches nothing', function () {
    var s = setup();
    var got = 'unset';
    s.rel.fetch(function (failure) { got = failure; });
    s.net.respondJson(0, { message: 'Not Found' });
    assert.strictEqual(got, s.S.UpdateFailure.BadResponse);
    assert.strictEqual(s.rel.cached(), null);
});
