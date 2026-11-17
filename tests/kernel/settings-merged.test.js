'use strict';

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

// Values built in the vm realm have other prototypes than the test's own.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

// The harness swaps kernel.settings.read/write for its own store, and merged
// reads through that public read, so stored values are seeded with write.
function setup(stored) {
    var H = harness.boot({ sections: ['kernel'] });
    var st = H.Steward.kernel.settings;
    if (stored) st.write('m', stored);
    return { H: H, st: st };
}

t.test('merged: defaults then stored, extra stored keys kept, stored wins whatever its type', function () {
    var s = setup({ a: 'text', b: null, extra: 7 });
    var out = s.st.merged('m', { a: 1, b: 2, c: 3 });
    assert.deepStrictEqual(plain(out), { a: 'text', b: null, c: 3, extra: 7 });
});

t.test('merged: no stored namespace and no host give the defaults', function () {
    var s = setup();
    assert.deepStrictEqual(plain(s.st.merged('m', { a: 1, b: { n: 2 } })), { a: 1, b: { n: 2 } });
    assert.deepStrictEqual(plain(s.st.merged('m', { a: 1 })), { a: 1 });
    assert.deepStrictEqual(plain(s.st.merged('m', null)), {});
});

t.test('merged only: extra stored keys dropped, a stored null still wins', function () {
    var s = setup({ a: 5, b: null, extra: 7 });
    var out = s.st.merged('m', { a: 1, b: 2, c: 3 }, { only: true });
    assert.deepStrictEqual(plain(out), { a: 5, b: null, c: 3 });
});

t.test('merged only+typed: a stored value of another type reads as the default', function () {
    var s = setup({ a: 'x', b: 9, c: null, d: true, extra: 1 });
    var out = s.st.merged('m', { a: 1, b: 2, c: 'def', d: false, e: 'z' }, { only: true, typed: true });
    assert.deepStrictEqual(plain(out), { a: 1, b: 9, c: 'def', d: true, e: 'z' });
});

t.test('merged rows replace: a stored row replaces its default row whole', function () {
    var s = setup({ rows: { A: { enabled: false }, S: { x: 1 }, N: 'abc' } });
    var out = s.st.merged('m', { rows: { A: { enabled: true, max: 8 }, B: { enabled: true, max: 6 } } },
        { rows: { rows: 'replace' } });
    assert.deepStrictEqual(plain(out.rows), {
        A: { enabled: false },
        B: { enabled: true, max: 6 },
        S: { x: 1 },
        N: 'abc'
    });
    assert.deepStrictEqual(Object.keys(out.rows), ['A', 'B', 'S', 'N']);
});

t.test('merged rows fields: stored object rows fill in field by field', function () {
    var s = setup({ rows: { A: { max: 3 }, B: 'abc', C: null, D: { x: 1 }, E: 'abc' } });
    var out = s.st.merged('m', {
        rows: { A: { enabled: true, max: 8 }, B: { enabled: true, max: 6 }, C: { enabled: false, max: 1 } }
    }, { rows: { rows: 'fields' } });
    assert.deepStrictEqual(plain(out.rows), {
        A: { enabled: true, max: 3 },
        B: { enabled: true, max: 6 },
        C: { enabled: false, max: 1 },
        D: { x: 1 },
        E: 'abc'
    });
});

t.test('merged rows template: every row starts from the template', function () {
    var s = setup({ rows: { A: { mine: 1 }, X: { only: 2 }, N: null } });
    var out = s.st.merged('m', {
        rows: { A: { enabled: false, tag: 'd' }, N: { tag: 'dn' }, B: { tag: 'b' } }
    }, { rows: { rows: { template: { enabled: true, cap: 10 } } } });
    assert.deepStrictEqual(plain(out.rows), {
        A: { enabled: false, cap: 10, tag: 'd', mine: 1 },
        N: { enabled: true, cap: 10, tag: 'dn' },
        B: { enabled: true, cap: 10, tag: 'b' },
        X: { enabled: true, cap: 10, only: 2 }
    });
});

t.test('merged returns a fresh copy: changing it leaves the defaults and the store alone', function () {
    var s = setup({ a: { list: [1, 2] }, rows: { A: { n: 1 } } });
    var defaults = { a: { list: [0] }, rows: { A: { n: 0 } }, top: 1 };
    var defBefore = JSON.stringify(defaults);
    var storeBefore = JSON.stringify(s.st.read('m'));
    var opts = { rows: { rows: 'fields' } };
    var one = s.st.merged('m', defaults, opts);
    var two = s.st.merged('m', defaults, opts);
    assert.notStrictEqual(one, two);
    assert.notStrictEqual(one.rows, two.rows);
    one.rows.A.n = 99;
    one.a.list.push(3);
    one.top = 'changed';
    assert.strictEqual(JSON.stringify(defaults), defBefore);
    assert.strictEqual(JSON.stringify(s.st.read('m')), storeBefore);
    assert.strictEqual(two.rows.A.n, 1);
    assert.deepStrictEqual(plain(two.a.list), [1, 2]);
    assert.strictEqual(two.top, 1);
});

t.test('merged keeps the defaults order, then the stored-only keys', function () {
    var s = setup({ z: 1, a: 2, q: 3 });
    var out = s.st.merged('m', { c: 0, a: 0, b: 0 });
    assert.deepStrictEqual(Object.keys(out), ['c', 'a', 'b', 'z', 'q']);
});

t.test('copy passes primitives and null through and deep-copies objects', function () {
    var st = setup().st;
    assert.strictEqual(st.copy(null), null);
    assert.strictEqual(st.copy(3), 3);
    assert.strictEqual(st.copy('s'), 's');
    assert.strictEqual(st.copy(true), true);
    assert.strictEqual(st.copy(undefined), undefined);
    var src = { a: { b: [1, { c: 2 }] } };
    var dup = st.copy(src);
    assert.deepStrictEqual(plain(dup), plain(src));
    assert.notStrictEqual(dup, src);
    assert.notStrictEqual(dup.a, src.a);
    assert.notStrictEqual(dup.a.b, src.a.b);
    dup.a.b[1].c = 9;
    assert.strictEqual(src.a.b[1].c, 2);
});

t.test('merged: reads the store at call time, so a later write is seen', function () {
    var s = setup();
    assert.deepStrictEqual(plain(s.st.merged('m', { a: 1 })), { a: 1 });
    s.H.settings.write('m', { a: 3 });
    assert.deepStrictEqual(plain(s.st.merged('m', { a: 1 })), { a: 3 });
});
