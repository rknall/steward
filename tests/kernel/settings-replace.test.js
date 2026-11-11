'use strict';

var t = require('../runner');
var harness = require('../harness');
var hostStubs = require('../stubs/host');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup(hs) {
    hs = hs || hostStubs.makeSettingsHost();
    var H = harness.boot({ sections: ['kernel'], host: { settings: hs } });
    return { hs: hs, S: H.Steward, H: H, st: H.Steward.kernel.settings };
}

function seed(hs) {
    hs.settings['steward.collect'] = { a: 1, b: 2 };
    hs.settings['steward.mining'] = { x: true };
    hs.settings['steward.kernel'] = { debug: true };
    hs.settings.global = { keep: 'me' };
    hs.settings.autoTSO = { other: 1 };
}

t.test('replaceAll removes namespaces and keys absent from the map', function () {
    var s = setup();
    seed(s.hs);
    var ok = s.st.replaceAll({ collect: { a: 9 }, fresh: { n: 1 } });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(plain(s.hs.settings['steward.collect']), { a: 9 });
    assert.deepStrictEqual(plain(s.hs.settings['steward.fresh']), { n: 1 });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s.hs.settings, 'steward.mining'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s.hs.settings, 'steward.kernel'), false);
});

t.test('replaceAll leaves non-steward host keys alone', function () {
    var s = setup();
    seed(s.hs);
    s.st.replaceAll({});
    assert.deepStrictEqual(plain(s.hs.settings.global), { keep: 'me' });
    assert.deepStrictEqual(plain(s.hs.settings.autoTSO), { other: 1 });
    assert.deepStrictEqual(Object.keys(s.hs.settings).sort(), ['autoTSO', 'global']);
});

t.test('replaceAll calls save once and all() reflects the result', function () {
    var s = setup();
    seed(s.hs);
    s.st.replaceAll({ collect: { a: 9 } });
    assert.strictEqual(s.hs.saves, 1);
    assert.deepStrictEqual(plain(s.st.all()), { collect: { a: 9 } });
});

t.test('replaceAll deep-copies the map', function () {
    var s = setup();
    var map = { collect: { list: [1, 2] } };
    s.st.replaceAll(map);
    map.collect.list.push(3);
    assert.deepStrictEqual(plain(s.hs.settings['steward.collect']), { list: [1, 2] });
});

t.test('replaceAll without host save is false and mutates nothing', function () {
    var hs = hostStubs.makeSettingsHost();
    delete hs.save;
    var s = setup(hs);
    seed(hs);
    var before = JSON.stringify(hs.settings);
    assert.strictEqual(s.st.replaceAll({ collect: { a: 9 } }), false);
    assert.strictEqual(JSON.stringify(hs.settings), before);
});

t.test('replaceAll with an unserialisable map is false and mutates nothing', function () {
    var s = setup();
    seed(s.hs);
    var before = JSON.stringify(s.hs.settings);
    var cyc = {};
    cyc.self = cyc;
    assert.strictEqual(s.st.replaceAll({ collect: cyc }), false);
    assert.strictEqual(JSON.stringify(s.hs.settings), before);
    assert.strictEqual(s.hs.saves, 0);
});

t.test('replaceAll returns false when save throws', function () {
    var s = setup();
    s.hs.save = function () { throw new Error('disk full'); };
    assert.strictEqual(s.st.replaceAll({ collect: { a: 1 } }), false);
});
