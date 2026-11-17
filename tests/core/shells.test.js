'use strict';

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;
var SHELL = 'Shell_Well';

// A home zone holding the given buildings; dep is the street map's
// IsADepletedDeposit (omitted when null, as a host without the method).
function setup(buildings, dep) {
    var H = harness.boot();
    var z = H.zone.zone();
    for (var i = 0; i < buildings.length; i++) z.building(H.zone.building(buildings[i]));
    H.installZone(z);
    if (dep) z.zone.mStreetDataMap.IsADepletedDeposit = dep;
    return { H: H, z: z, SH: H.Steward.core.shells };
}

function shell(extra) {
    var o = { name: SHELL, grid: 10, level: 1 };
    for (var k in (extra || {})) o[k] = extra[k];
    return o;
}

function yes() { return true; }

t.test('constructing: true, false, absent method and throwing method', function () {
    var s = setup([], null);
    var mk = s.H.zone.building;
    assert.strictEqual(s.SH.constructing(null), null);
    assert.strictEqual(s.SH.constructing(mk({ constructing: true })), true);
    assert.strictEqual(s.SH.constructing(mk({ constructing: false })), false);
    assert.strictEqual(s.SH.constructing(mk({})), false);
    var b = mk({ constructing: false });
    b.IsInConstructionMode = function () { throw new Error('bridge'); };
    assert.strictEqual(s.SH.constructing(b), null);
});

t.test('ready: null on an idle depleted shell', function () {
    var s = setup([], yes);
    var b = s.H.zone.building(shell({ constructing: false }));
    assert.strictEqual(s.SH.ready(b, SHELL), null);
});

t.test('ready: shell gone for another name and for no building', function () {
    var s = setup([], yes);
    var b = s.H.zone.building(shell({ name: 'Well_03', constructing: false }));
    assert.strictEqual(s.SH.ready(b, SHELL), 'shell gone');
    assert.strictEqual(s.SH.ready(null, SHELL), 'shell gone');
});

t.test('ready: unreadable construction is a read refusal', function () {
    var s = setup([], yes);
    var b = s.H.zone.building(shell({ constructing: false }));
    b.IsInConstructionMode = function () { throw new Error('x'); };
    var r = s.SH.ready(b, SHELL);
    assert.strictEqual(r, s.SH.CONSTRUCTION_UNREADABLE);
    assert.ok(s.H.Steward.kernel.read.isReadRefusal(r));
});

t.test('ready: under construction', function () {
    var s = setup([], yes);
    var b = s.H.zone.building(shell({ constructing: true }));
    assert.strictEqual(s.SH.ready(b, SHELL), 'under construction');
});

t.test('ready: depleted false, throwing and a missing method', function () {
    var s = setup([], function () { return false; });
    var b = s.H.zone.building(shell({ constructing: false }));
    assert.strictEqual(s.SH.ready(b, SHELL), 'not depleted');
    s.z.zone.mStreetDataMap.IsADepletedDeposit = function () { throw new Error('x'); };
    var r = s.SH.ready(b, SHELL);
    assert.strictEqual(r, s.SH.DEPLETED_UNREADABLE);
    assert.ok(s.H.Steward.kernel.read.isReadRefusal(r));
    delete s.z.zone.mStreetDataMap.IsADepletedDeposit;
    assert.strictEqual(s.SH.ready(b, SHELL), null);
});

t.test('changed: another name, constructing, depleted false', function () {
    var s = setup([], yes);
    var mk = s.H.zone.building;
    assert.strictEqual(s.SH.changed(mk(shell({ name: 'Well_03' })), SHELL), true);
    assert.strictEqual(s.SH.changed(mk(shell({ constructing: true })), SHELL), true);
    assert.strictEqual(s.SH.changed(mk(shell({ constructing: false })), SHELL), false);
    s.z.zone.mStreetDataMap.IsADepletedDeposit = function () { return false; };
    assert.strictEqual(s.SH.changed(mk(shell({ constructing: false })), SHELL), true);
});

t.test('changed: null, empty name and throwing reads are false', function () {
    var s = setup([], yes);
    var mk = s.H.zone.building;
    assert.strictEqual(s.SH.changed(null, SHELL), false);
    var empty = mk(shell({ constructing: false }));
    empty.GetBuildingName_string = function () { return ''; };
    assert.strictEqual(s.SH.changed(empty, SHELL), false);
    var thrower = mk(shell());
    thrower.GetBuildingName_string = function () { throw new Error('x'); };
    thrower.IsInConstructionMode = function () { throw new Error('x'); };
    s.z.zone.mStreetDataMap.IsADepletedDeposit = function () { throw new Error('x'); };
    assert.strictEqual(s.SH.changed(thrower, SHELL), false);
});

t.test('unchanged: true only on the idle shell', function () {
    var s = setup([], yes);
    var mk = s.H.zone.building;
    assert.strictEqual(s.SH.unchanged(mk(shell({ constructing: false })), SHELL), true);
    assert.strictEqual(s.SH.unchanged(mk(shell({ constructing: true })), SHELL), false);
    assert.strictEqual(s.SH.unchanged(mk(shell({ name: 'Well_03', constructing: false })), SHELL), false);
    assert.strictEqual(s.SH.unchanged(null, SHELL), false);
    // An absent construction method reads false, so the idle shell still counts.
    assert.strictEqual(s.SH.unchanged(mk(shell()), SHELL), true);
    var b = mk(shell());
    b.IsInConstructionMode = function () { throw new Error('x'); };
    assert.strictEqual(s.SH.unchanged(b, SHELL), false);
});

t.test('snapshot: facts with and without pre-place and the id lookup', function () {
    var s = setup([shell({ constructing: false })], yes);
    var sdm = s.z.zone.mStreetDataMap;
    var a = s.SH.snapshot(10, 'Well_03');
    assert.strictEqual(a.name, SHELL);
    assert.strictEqual(a.c, false);
    assert.strictEqual(a.d, true);
    assert.strictEqual(a.level, 1);
    assert.strictEqual(a.preplace, 'no');
    assert.strictEqual(a.nr, '?');
    sdm.SetPrePlaceBuildingGridPos = function () {};
    s.H.ctx.global = { buildingGroup: { GetNrFromName: function (n) { return n === 'Well_03' ? 176 : 0; } } };
    var b = s.SH.snapshot(10, 'Well_03');
    assert.strictEqual(b.preplace, 'yes');
    assert.strictEqual(b.nr, 176);
    s.H.ctx.global = { buildingGroup: { GetNrFromName: function () { throw new Error('x'); } } };
    assert.strictEqual(s.SH.snapshot(10, 'Well_03').nr, '?');
});

t.test('snapshot: an empty grid and an unreadable depleted read', function () {
    var s = setup([shell({ constructing: false })], function () { throw new Error('x'); });
    assert.strictEqual(s.SH.snapshot(99, 'Well_03').name, 'none');
    assert.strictEqual(s.SH.snapshot(10, 'Well_03').d, null);
    assert.strictEqual(JSON.stringify(s.SH.snapshot(10, 'Well_03')).indexOf('undefined'), -1);
});

t.test('describe: both snapshots and an undefined base', function () {
    var s = setup([], yes);
    var a = { name: SHELL, c: false, d: true, level: 1 };
    var b = { name: 'Well_03', c: true, d: false, level: 0, preplace: 'no', nr: 176 };
    assert.strictEqual(s.SH.describe(a, b),
        'grid Shell_Well -> Well_03, constructing false -> true, depleted true -> false, ' +
        'level 1 -> 0, preplace no, lookup 176');
    var d = s.SH.describe(undefined, b);
    assert.ok(d.indexOf('grid ? -> Well_03') === 0);
    assert.ok(/preplace no, lookup 176$/.test(d));
    assert.ok(/preplace \?, lookup \?$/.test(s.SH.describe(a, undefined)));
});
