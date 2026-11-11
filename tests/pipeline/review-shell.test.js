'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var t = require('../runner');

var SHELL = path.join(__dirname, '..', '..', '.claude', 'skills', 'so-pipeline',
    'review-shell', 'shell.html');

// The shell's pure logic runs in an empty realm: if it reached for a page or
// browser global, loading it here would throw.
function logicText() {
    var html = fs.readFileSync(SHELL, 'utf8');
    var m = /<script id="rv-logic">([\s\S]*?)<\/script>/.exec(html);
    if (!m) { throw new Error('rv-logic script not found in shell.html'); }
    return m[1];
}

function load() {
    return vm.runInNewContext(logicText() + '\n;RV;', {});
}

// Results come from the vm realm; copy them so deepStrictEqual compares values.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

var SET = {
    set: 'demo', task: 'x', kind: 'mockup', rev: 2,
    pages: [
        { id: 'a', title: 'A', summary: 's', options: [
            { id: 'state', label: 'State', values: [{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }] },
            { id: 'size', label: 'Size', values: [{ id: 'big', label: 'Big' }] }
        ] },
        { id: 'b', title: 'B', summary: 's' },
        { id: 'c', title: 'C', summary: 's' }
    ]
};

function doc(page, verdict, rev, set) {
    return { set: set || 'demo', page: page, verdict: verdict, comment: '', rev: rev,
        options: {}, by: null, at: 't' };
}

t.test('logic exposes the nine functions', function () {
    t.assert.deepStrictEqual(Object.keys(load()).sort(), ['defaultState', 'feedback', 'makeVerdict',
        'matches', 'pageIndex', 'parseSet', 'parseWhen', 'progress', 'status']);
});

t.test('logic text uses no page or browser global', function () {
    var text = logicText();
    ['document', 'window', 'localStorage', 'navigator', 'claude'].forEach(function (word) {
        t.assert.ok(text.indexOf(word) < 0, 'rv-logic mentions ' + word);
    });
});

t.test('parseSet parses and throws on bad JSON', function () {
    var RV = load();
    t.assert.strictEqual(RV.parseSet(JSON.stringify(SET)).set, 'demo');
    t.assert.throws(function () { RV.parseSet('{nope'); });
});

t.test('pageIndex maps hashes to indexes, unknown to 0', function () {
    var RV = load();
    t.assert.strictEqual(RV.pageIndex(SET, ''), 0);
    t.assert.strictEqual(RV.pageIndex(SET, '#unknown'), 0);
    t.assert.strictEqual(RV.pageIndex(SET, '#c'), 2);
    t.assert.strictEqual(RV.pageIndex(SET, 'b'), 1);
});

t.test('defaultState picks first values and is empty without options', function () {
    var RV = load();
    t.assert.deepStrictEqual(plain(RV.defaultState(SET.pages[0])), { state: 'on', size: 'big' });
    t.assert.deepStrictEqual(plain(RV.defaultState(SET.pages[1])), {});
});

t.test('parseWhen splits on & and the first =', function () {
    var RV = load();
    t.assert.deepStrictEqual(plain(RV.parseWhen('a=b&c=d')),
        [{ opt: 'a', val: 'b' }, { opt: 'c', val: 'd' }]);
    t.assert.deepStrictEqual(plain(RV.parseWhen(' a = b & c=d=e ')),
        [{ opt: 'a', val: 'b' }, { opt: 'c', val: 'd=e' }]);
});

t.test('matches needs every condition and a present option', function () {
    var RV = load();
    t.assert.strictEqual(RV.matches('state=on', { state: 'on' }), true);
    t.assert.strictEqual(RV.matches('state=on&size=big', { state: 'on', size: 'big' }), true);
    t.assert.strictEqual(RV.matches('state=off', { state: 'on' }), false);
    t.assert.strictEqual(RV.matches('state=on&size=big', { state: 'on' }), false);
    t.assert.strictEqual(RV.matches('missing=x', {}), false);
});

t.test('makeVerdict approves with an empty comment', function () {
    var RV = load();
    var r = RV.makeVerdict(SET, SET.pages[0], 'approve', '', { state: 'on' }, null, 'T');
    t.assert.ok(r.doc && !r.error);
    t.assert.strictEqual(r.doc.verdict, 'approve');
    t.assert.strictEqual(r.doc.comment, '');
});

t.test('makeVerdict rejects a blank disapprove and a bad verdict', function () {
    var RV = load();
    t.assert.ok(RV.makeVerdict(SET, SET.pages[0], 'disapprove', '   ', {}, null, 'T').error);
    t.assert.ok(RV.makeVerdict(SET, SET.pages[0], 'maybe', 'x', {}, null, 'T').error);
});

t.test('makeVerdict doc has the contract fields and a copied options object', function () {
    var RV = load();
    var state = { state: 'off' };
    var r = RV.makeVerdict(SET, SET.pages[0], 'disapprove', '  fix it  ', state, 'u1', '2026-01-01T00:00:00Z');
    t.assert.deepStrictEqual(plain(r.doc), {
        set: 'demo', page: 'a', verdict: 'disapprove', comment: 'fix it', rev: 2,
        options: { state: 'off' }, by: 'u1', at: '2026-01-01T00:00:00Z'
    });
    state.state = 'on';
    t.assert.strictEqual(r.doc.options.state, 'off');
});

t.test('status is none, stale by rev, stale by set, or the verdict', function () {
    var RV = load();
    t.assert.strictEqual(RV.status(SET, null), 'none');
    t.assert.strictEqual(RV.status(SET, doc('a', 'approve', 1)), 'stale');
    t.assert.strictEqual(RV.status(SET, doc('a', 'approve', 2, 'other')), 'stale');
    t.assert.strictEqual(RV.status(SET, doc('a', 'approve', 2)), 'approve');
    t.assert.strictEqual(RV.status(SET, doc('a', 'disapprove', 2)), 'disapprove');
});

t.test('progress counts stale and missing as pending', function () {
    var RV = load();
    var docs = { a: doc('a', 'approve', 2), b: doc('b', 'disapprove', 1) };
    t.assert.deepStrictEqual(plain(RV.progress(SET, docs)),
        { approved: 1, disapproved: 0, pending: 2, total: 3 });
    docs.b = doc('b', 'disapprove', 2);
    t.assert.deepStrictEqual(plain(RV.progress(SET, docs)),
        { approved: 1, disapproved: 1, pending: 1, total: 3 });
});

t.test('feedback lists only current docs in page order', function () {
    var RV = load();
    var docs = { c: doc('c', 'approve', 2), a: doc('a', 'disapprove', 2), b: doc('b', 'approve', 1) };
    var list = JSON.parse(RV.feedback(SET, docs));
    t.assert.ok(Array.isArray(list));
    t.assert.deepStrictEqual(list.map(function (d) { return d.page; }), ['a', 'c']);
});
