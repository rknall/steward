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
