'use strict';

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

function setup(getText) {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    if (getText) H.host.loca.GetText = getText;
    return { H: H, locale: H.Steward.core.locale };
}

t.test('known: translated key returns the host text', function () {
    var s = setup(function (cat, key) { return 'Text of ' + key; });
    assert.strictEqual(s.locale.known('RES', 'Wood'), 'Text of Wood');
});

t.test('known: text equal to the key returns null', function () {
    var s = setup(function (cat, key) { return key; });
    assert.strictEqual(s.locale.known('RES', 'Wood'), null);
});

t.test('known: empty key returns null', function () {
    var s = setup(function () { return 'anything'; });
    assert.strictEqual(s.locale.known('RES', ''), null);
});

t.test('known: GetText returning empty or non-string returns null', function () {
    var s = setup(function () { return ''; });
    assert.strictEqual(s.locale.known('RES', 'Wood'), null);
    s.H.host.loca.GetText = function () { return 7; };
    assert.strictEqual(s.locale.known('RES', 'Wood'), null);
});

t.test('known: GetText throwing returns null', function () {
    var s = setup(function () { throw new Error('boom'); });
    assert.strictEqual(s.locale.known('RES', 'Wood'), null);
});

t.test('res: untranslated key returns the key', function () {
    var s = setup(function (cat, key) { return key; });
    assert.strictEqual(s.locale.res('Wood'), 'Wood');
});
