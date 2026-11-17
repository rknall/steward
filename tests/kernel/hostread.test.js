'use strict';

var t = require('../runner');
var harness = require('../harness');

function hostRead() {
    var H = harness.boot({ sections: ['kernel'] });
    return H.Steward.kernel.hostRead;
}

function counter(value) {
    var c = { n: 0 };
    c.fn = function () { c.n++; return value; };
    return c;
}

t.test('hostRead.call reads a getter member once and invokes it on its owner', function () {
    var R = hostRead();
    var reads = 0;
    var self = null;
    var o = {};
    Object.defineProperty(o, 'GetX', {
        get: function () {
            reads++;
            return function () { self = this; return 42; };
        }
    });
    t.assert.strictEqual(R.call(o, 'GetX'), 42);
    t.assert.strictEqual(reads, 1);
    t.assert.strictEqual(self, o);
});

t.test('hostRead.call returns undefined for a non-function member or a missing owner', function () {
    var R = hostRead();
    t.assert.strictEqual(R.call({ GetX: 5 }, 'GetX'), undefined);
    t.assert.strictEqual(R.call({}, 'GetX'), undefined);
    t.assert.strictEqual(R.call(null, 'GetX'), undefined);
    t.assert.strictEqual(R.call(undefined, 'GetX'), undefined);
});

t.test('hostRead.call does not catch a throwing member', function () {
    var R = hostRead();
    t.assert.throws(function () {
        R.call({ GetX: function () { throw new Error('bridge'); } }, 'GetX');
    }, /bridge/);
});

t.test('hostRead.cached computes every time outside a pass', function () {
    var R = hostRead();
    var c = counter('v');
    t.assert.strictEqual(R.inPass(), false);
    t.assert.strictEqual(R.cached('a.b', c.fn), 'v');
    t.assert.strictEqual(R.cached('a.b', c.fn), 'v');
    t.assert.strictEqual(c.n, 2);
});

t.test('hostRead.cached computes once per key inside a pass', function () {
    var R = hostRead();
    var a = counter('A');
    var b = counter('B');
    var out = R.pass(function () {
        t.assert.strictEqual(R.inPass(), true);
        return [R.cached('x.a', a.fn), R.cached('x.a', a.fn),
            R.cached('x.b|1', b.fn), R.cached('x.b|1', b.fn)];
    });
    t.assert.deepStrictEqual(out, ['A', 'A', 'B', 'B']);
    t.assert.strictEqual(a.n, 1);
    t.assert.strictEqual(b.n, 1);
});

t.test('hostRead.pass returns the value of fn', function () {
    var R = hostRead();
    t.assert.strictEqual(R.pass(function () { return 7; }), 7);
});

t.test('a nested pass joins the open one and shares its memo', function () {
    var R = hostRead();
    var c = counter('v');
    R.pass(function () {
        R.cached('n.k', c.fn);
        R.pass(function () {
            t.assert.strictEqual(R.inPass(), true);
            R.cached('n.k', c.fn);
        });
        t.assert.strictEqual(R.inPass(), true);
        R.cached('n.k', c.fn);
    });
    t.assert.strictEqual(c.n, 1);
    t.assert.strictEqual(R.inPass(), false);
});

t.test('a compute that opens a pass joins the outer one', function () {
    var R = hostRead();
    var inner = counter('i');
    var v = R.pass(function () {
        return R.cached('o.k', function () {
            return R.pass(function () { return R.cached('o.i', inner.fn); });
        });
    });
    t.assert.strictEqual(v, 'i');
    t.assert.strictEqual(R.inPass(), false);
});

t.test('after a pass closes a new pass recomputes', function () {
    var R = hostRead();
    var c = counter('v');
    R.pass(function () { R.cached('p.k', c.fn); });
    t.assert.strictEqual(R.inPass(), false);
    R.pass(function () { R.cached('p.k', c.fn); });
    t.assert.strictEqual(c.n, 2);
});

t.test('a throwing pass rethrows, closes and leaves no memo behind', function () {
    var R = hostRead();
    var c = counter('v');
    t.assert.throws(function () {
        R.pass(function () {
            R.cached('t.k', c.fn);
            throw new Error('boom');
        });
    }, /boom/);
    t.assert.strictEqual(R.inPass(), false);
    R.pass(function () { R.cached('t.k', c.fn); });
    t.assert.strictEqual(c.n, 2);
});

t.test('a throwing compute is not memoized', function () {
    var R = hostRead();
    var n = 0;
    function flaky() {
        n++;
        if (n === 1) throw new Error('transient');
        return 'ok';
    }
    var v = R.pass(function () {
        t.assert.throws(function () { R.cached('f.k', flaky); }, /transient/);
        t.assert.strictEqual(R.inPass(), true);
        return [R.cached('f.k', flaky), R.cached('f.k', flaky)];
    });
    t.assert.deepStrictEqual(v, ['ok', 'ok']);
    t.assert.strictEqual(n, 2);
});

t.test('null and undefined results are memoized', function () {
    var R = hostRead();
    var nul = counter(null);
    var und = counter(undefined);
    R.pass(function () {
        t.assert.strictEqual(R.cached('z.null', nul.fn), null);
        t.assert.strictEqual(R.cached('z.null', nul.fn), null);
        t.assert.strictEqual(R.cached('z.undef', und.fn), undefined);
        t.assert.strictEqual(R.cached('z.undef', und.fn), undefined);
    });
    t.assert.strictEqual(nul.n, 1);
    t.assert.strictEqual(und.n, 1);
});

t.test('keys that shadow Object.prototype members are plain keys', function () {
    var R = hostRead();
    var c = counter('v');
    R.pass(function () {
        t.assert.strictEqual(R.cached('toString', c.fn), 'v');
        t.assert.strictEqual(R.cached('hasOwnProperty', c.fn), 'v');
    });
    t.assert.strictEqual(c.n, 2);
});

t.test('forget drops keys by prefix', function () {
    var R = hostRead();
    var a = counter('A');
    var b = counter('B');
    var c = counter('C');
    R.pass(function () {
        R.cached('buildings.list|1', a.fn);
        R.cached('buildings.nameIndex|1', b.fn);
        R.cached('quests.pool|1', c.fn);
        R.forget('buildings.');
        R.cached('buildings.list|1', a.fn);
        R.cached('buildings.nameIndex|1', b.fn);
        R.cached('quests.pool|1', c.fn);
    });
    t.assert.strictEqual(a.n, 2);
    t.assert.strictEqual(b.n, 2);
    t.assert.strictEqual(c.n, 1);
});

t.test('forget outside a pass is a no-op', function () {
    var R = hostRead();
    R.forget('x.');
    t.assert.strictEqual(R.inPass(), false);
});

t.test('markUnsettled sets the flag of the open pass only', function () {
    var R = hostRead();
    R.markUnsettled();
    t.assert.strictEqual(R.unsettled(), false);
    R.pass(function () {
        t.assert.strictEqual(R.unsettled(), false);
        R.pass(function () { R.markUnsettled(); });
        t.assert.strictEqual(R.unsettled(), true);
    });
    t.assert.strictEqual(R.unsettled(), false);
});

t.test('unsettled resets on a new outer pass', function () {
    var R = hostRead();
    R.pass(function () { R.markUnsettled(); });
    R.pass(function () { t.assert.strictEqual(R.unsettled(), false); });
    t.assert.throws(function () {
        R.pass(function () { R.markUnsettled(); throw new Error('boom'); });
    }, /boom/);
    R.pass(function () { t.assert.strictEqual(R.unsettled(), false); });
});

// The kernel runs in its own realm: copy into a local array to compare.
function plain(a) { return Array.prototype.slice.call(a); }

t.test('hostRead.list copies the result of toArray when there is one', function () {
    var R = hostRead();
    var vec = { length: 1, 0: 'index', toArray: function () { return ['via', 'toArray']; } };
    t.assert.deepStrictEqual(plain(R.list(vec)), ['via', 'toArray']);
});

t.test('hostRead.list walks the indexes of a vector without toArray', function () {
    var R = hostRead();
    var out = R.list({ length: 3, 0: 'a', 1: 'b', 2: 'c' });
    t.assert.ok(Array.isArray(out));
    t.assert.deepStrictEqual(plain(out), ['a', 'b', 'c']);
});

t.test('hostRead.list falls back to the index walk when toArray throws', function () {
    var R = hostRead();
    var vec = { length: 2, 0: 'a', 1: 'b', toArray: function () { throw new Error('bridge'); } };
    t.assert.deepStrictEqual(plain(R.list(vec)), ['a', 'b']);
});

t.test('hostRead.list falls back to the index walk when toArray returns a non-array', function () {
    var R = hostRead();
    var vec = { length: 2, 0: 'a', 1: 'b', toArray: function () { return null; } };
    t.assert.deepStrictEqual(plain(R.list(vec)), ['a', 'b']);
    vec.toArray = function () { return {}; };
    t.assert.deepStrictEqual(plain(R.list(vec)), ['a', 'b']);
});

t.test('hostRead.list is null for a missing vector or one without a length', function () {
    var R = hostRead();
    t.assert.strictEqual(R.list(null), null);
    t.assert.strictEqual(R.list(undefined), null);
    t.assert.strictEqual(R.list({}), null);
});

t.test('hostRead.list does not catch a throwing index read', function () {
    var R = hostRead();
    var vec = { length: 1 };
    Object.defineProperty(vec, '0', { get: function () { throw new Error('index'); } });
    t.assert.throws(function () { R.list(vec); }, /index/);
});
