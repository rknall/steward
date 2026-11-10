'use strict';

var t = require('../runner');
var harness = require('../harness');
var specStubs = require('../stubs/specialists');

function boot() {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    return { H: H, c: H.Steward.core.specialists };
}

// getImageTag is a host global; the harness host object is where it lives.
function withImageTag(b) {
    b.H.ctx.getImageTag = function (icon, size) { return '<img ' + icon + ' ' + size + '>'; };
}

t.test('portraitTag returns the host tag for the icon id', function () {
    var b = boot();
    withImageTag(b);
    var spec = specStubs.spec({ iconID: 'icon_x' });
    t.assert.strictEqual(b.c.portraitTag(spec), '<img icon_x 20px>');
    t.assert.strictEqual(b.c.portraitTag(spec, '32px'), '<img icon_x 32px>');
});

t.test('portraitTag is empty without the global, the icon id or a readable getter', function () {
    var b = boot();
    var spec = specStubs.spec({ iconID: 'icon_x' });
    b.H.ctx.getImageTag = undefined;
    t.assert.strictEqual(b.c.portraitTag(spec), '', 'no getImageTag global');
    withImageTag(b);
    t.assert.strictEqual(b.c.portraitTag(specStubs.spec({})), '', 'no icon id');
    t.assert.strictEqual(b.c.portraitTag(null), '', 'no spec');
    var thrower = specStubs.spec({ iconID: 'icon_x' });
    thrower.getIconID = function () { throw new Error('half-initialised'); };
    t.assert.strictEqual(b.c.portraitTag(thrower), '', 'getIconID throws');
});

t.test('portraitTag caches a real image per icon and size', function () {
    var b = boot();
    var calls = 0;
    b.H.ctx.getImageTag = function (icon, size) { calls++; return '<img ' + icon + ' ' + size + '>'; };
    var spec = specStubs.spec({ iconID: 'icon_cache' });
    b.c.portraitTag(spec, '20px');
    b.c.portraitTag(spec, '20px');
    t.assert.strictEqual(calls, 1, 'same icon and size is one host call');
    b.c.portraitTag(spec, '32px');
    t.assert.strictEqual(calls, 2, 'other size is a second host call');
});

t.test('portraitTag does not cache the placeholder and marks the pass', function () {
    var b = boot();
    var calls = 0;
    b.H.ctx.getImageTag = function (icon, size) {
        calls++;
        return calls === 1 ? '<span ph></span>' : '<img ' + icon + ' ' + size + '>';
    };
    var spec = specStubs.spec({ iconID: 'icon_ph' });
    var pass = {};
    t.assert.strictEqual(b.c.portraitTag(spec, '20px', pass), '<span ph></span>');
    t.assert.strictEqual(pass.portraitMissed, true, 'placeholder marks the pass');
    t.assert.strictEqual(b.c.portraitTag(spec, '20px', pass), '<img icon_ph 20px>');
    t.assert.strictEqual(b.c.portraitTag(spec, '20px', pass), '<img icon_ph 20px>');
    t.assert.strictEqual(calls, 2, 'third call is a cache hit');
});

t.test('portraitTag without a pass argument still works', function () {
    var b = boot();
    b.H.ctx.getImageTag = function () { return '<span ph></span>'; };
    var spec = specStubs.spec({ iconID: 'icon_np' });
    t.assert.strictEqual(b.c.portraitTag(spec), '<span ph></span>');
});

t.test('compareByName orders mixed-case names and treats a nameless spec as empty', function () {
    var b = boot();
    var names = ['bravo', 'Alpha', 'charlie', 'Bravo2'];
    var list = names.map(function (n) { return specStubs.spec({ name: n }); });
    var nameless = specStubs.spec({});
    nameless.GetName_string = nameless.GetName = nameless.getName = function () { return ''; };
    nameless.GetSpecialistDescription = function () { return null; };
    list.push(nameless);
    list.sort(b.c.compareByName);
    var sorted = list.map(function (s) { return b.c.name(s) || ''; });
    t.assert.deepStrictEqual(sorted, ['', 'Alpha', 'bravo', 'Bravo2', 'charlie']);
    t.assert.strictEqual(b.c.compareByName(list[1], list[1]), 0);
});

t.test('searchingIndex returns the task sub type and null when unreadable', function () {
    var b = boot();
    var busy = specStubs.spec({ task: { GetType: function () { return 1; }, GetSubType: function () { return 4; } } });
    t.assert.strictEqual(b.c.searchingIndex(busy), 4);
    t.assert.strictEqual(b.c.searchingIndex(specStubs.spec({})), null, 'idle');
    var odd = specStubs.spec({ task: { GetSubType: function () { return '4'; } } });
    t.assert.strictEqual(b.c.searchingIndex(odd), null, 'non-number sub type');
    var thrower = specStubs.spec({});
    thrower.GetTask = function () { throw new Error('gone'); };
    t.assert.strictEqual(b.c.searchingIndex(thrower), null, 'GetTask throws');
});
