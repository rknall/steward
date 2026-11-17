'use strict';

var vm = require('vm');

var t = require('../runner');
var harness = require('../harness');

function kernel() {
    return harness.boot({ sections: ['kernel'] }).Steward.kernel;
}

function throwsType(fn) {
    var err = null;
    try { fn(); } catch (e) { err = e; }
    t.assert.ok(err !== null, 'expected a throw');
    t.assert.ok(err instanceof TypeError, 'expected a TypeError');
}

t.test('is.has tells own keys from inherited ones', function () {
    var is = kernel().is;
    t.assert.strictEqual(is.has({ a: 1 }, 'a'), true);
    t.assert.strictEqual(is.has({}, 'toString'), false);
    t.assert.strictEqual(is.has({ a: undefined }, 'a'), true);
    t.assert.strictEqual(is.has({ a: 1 }, 'b'), false);
});

t.test('is.has throws on a null or undefined object', function () {
    var is = kernel().is;
    throwsType(function () { is.has(null, 'a'); });
    throwsType(function () { is.has(undefined, 'a'); });
});

t.test('is.array accepts arrays, including ones from another context', function () {
    var is = kernel().is;
    t.assert.strictEqual(is.array([]), true);
    t.assert.strictEqual(is.array(vm.runInNewContext('[]')), true);
    t.assert.strictEqual(is.array({ length: 0 }), false);
    t.assert.strictEqual(is.array('abc'), false);
    t.assert.strictEqual(is.array(null), false);
    (function () {
        t.assert.strictEqual(is.array(arguments), false);
    }(1, 2));
});

t.test('is.plainObject accepts only plain objects', function () {
    var is = kernel().is;
    t.assert.strictEqual(is.plainObject({}), true);
    t.assert.strictEqual(is.plainObject(null), false);
    t.assert.strictEqual(is.plainObject([]), false);
    t.assert.strictEqual(is.plainObject(new Date()), false);
    t.assert.strictEqual(is.plainObject(/x/), false);
    t.assert.strictEqual(is.plainObject('s'), false);
    t.assert.strictEqual(is.plainObject(5), false);
});

t.test('is.str gives the string or an empty string', function () {
    var is = kernel().is;
    t.assert.strictEqual(is.str('a'), 'a');
    t.assert.strictEqual(is.str(''), '');
    t.assert.strictEqual(is.str(null), '');
    t.assert.strictEqual(is.str(undefined), '');
    t.assert.strictEqual(is.str(5), '');
    t.assert.strictEqual(is.str({}), '');
});

t.test('is.trim coerces first and trims both ends', function () {
    var is = kernel().is;
    t.assert.strictEqual(is.trim('  a b  '), 'a b');
    t.assert.strictEqual(is.trim('\t\na\n'), 'a');
    t.assert.strictEqual(is.trim(null), 'null');
    t.assert.strictEqual(is.trim(5), '5');
    t.assert.strictEqual(is.trim(undefined), 'undefined');
});

t.test('is.num lets Infinity through and rejects NaN and non-numbers', function () {
    var is = kernel().is;
    t.assert.strictEqual(is.num(0), true);
    t.assert.strictEqual(is.num(-1.5), true);
    t.assert.strictEqual(is.num(Infinity), true);
    t.assert.strictEqual(is.num(-Infinity), true);
    t.assert.strictEqual(is.num(NaN), false);
    t.assert.strictEqual(is.num('5'), false);
    t.assert.strictEqual(is.num(null), false);
    t.assert.strictEqual(is.num(undefined), false);
});

t.test('is.finite rejects Infinity, NaN and non-numbers', function () {
    var is = kernel().is;
    t.assert.strictEqual(is.finite(0), true);
    t.assert.strictEqual(is.finite(-1.5), true);
    t.assert.strictEqual(is.finite(Infinity), false);
    t.assert.strictEqual(is.finite(-Infinity), false);
    t.assert.strictEqual(is.finite(NaN), false);
    t.assert.strictEqual(is.finite('5'), false);
    t.assert.strictEqual(is.finite(null), false);
});

t.test('enumKey finds the key of a value or gives null', function () {
    var K = kernel();
    var E = { A: 'a', B: 'b', N: 1 };
    t.assert.strictEqual(K.enumKey(E, 'b'), 'B');
    t.assert.strictEqual(K.enumKey(E, 'zzz'), null);
    t.assert.strictEqual(K.enumKey(null, 'a'), null);
    t.assert.strictEqual(K.enumKey(undefined, 'a'), null);
    t.assert.strictEqual(K.enumKey({}, 'a'), null);
    t.assert.strictEqual(K.enumKey(E, '1'), null);
    t.assert.strictEqual(K.enumKey(E, 1), 'N');
});

t.test('enumKey ignores inherited keys', function () {
    var K = kernel();
    var E = Object.create({ X: 'v' });
    t.assert.strictEqual(K.enumKey(E, 'v'), null);
    E.Y = 'v';
    t.assert.strictEqual(K.enumKey(E, 'v'), 'Y');
});

t.test('enumHas mirrors enumKey', function () {
    var K = kernel();
    var E = Object.create({ X: 'v' });
    E.A = 'a';
    E.N = 1;
    t.assert.strictEqual(K.enumHas(E, 'a'), true);
    t.assert.strictEqual(K.enumHas(E, 'v'), false);
    t.assert.strictEqual(K.enumHas(E, '1'), false);
    t.assert.strictEqual(K.enumHas(E, 1), true);
    t.assert.strictEqual(K.enumHas({}, 'a'), false);
    t.assert.strictEqual(K.enumHas(null, 'a'), false);
    t.assert.strictEqual(K.enumHas(undefined, 'a'), false);
});

t.test('PRIORITY_VALID still holds the three priority values', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var K = H.Steward.kernel;
    var keys = Object.keys(K.PRIORITY_VALID).sort();
    var want = [H.Steward.Priority.Critical, H.Steward.Priority.Normal, H.Steward.Priority.Idle].sort();
    t.assert.strictEqual(keys.length, 3);
    t.assert.strictEqual(keys.join(','), want.join(','));
});
