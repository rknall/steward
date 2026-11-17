'use strict';

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

function setup() {
    var H = harness.boot();
    return { H: H, S: H.Steward, game: H.host.game };
}

// A loaded, readable home zone: the stub starts with no player zone (loading).
function readable(s, zoneId) {
    s.game.gi.mCurrentPlayerZone = {};
    s.game.gi.mCurrentViewedZoneID = zoneId === undefined ? 5 : zoneId;
    s.game.gi.isOnHomzone = function () { return true; };
}

// ---- view -----------------------------------------------------------------------

t.test('view is ok on a readable home zone', function () {
    var s = setup();
    readable(s, 7);
    var r = s.S.core.zone.view();
    assert.strictEqual(r.state, 'ok');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.value)), { id: 7, home: true, adventure: false });
    assert.strictEqual(r.zoneId, 7);
});

t.test('view reports an adventure zone as not home', function () {
    var s = setup();
    readable(s, 9);
    s.game.gi.isOnHomzone = function () { return false; };
    s.game.gi.mCurrentPlayer = { mIsAdventureZone: true };
    var r = s.S.core.zone.view();
    assert.strictEqual(r.state, 'ok');
    assert.strictEqual(r.value.home, false);
    assert.strictEqual(r.value.adventure, true);
});

t.test('view is notReady while the player zone is null', function () {
    var s = setup();
    readable(s);
    s.game.gi.mCurrentPlayerZone = null;
    var r = s.S.core.zone.view();
    assert.strictEqual(r.state, 'notReady');
    assert.strictEqual(r.value, null);
});

t.test('view is unreadable when isOnHomzone throws or is missing', function () {
    var s = setup();
    readable(s);
    s.game.gi.isOnHomzone = function () { throw new Error('bridge'); };
    var r = s.S.core.zone.view();
    assert.strictEqual(r.state, 'unreadable');
    assert.ok(/bridge/.test(r.why));
    delete s.game.gi.isOnHomzone;
    assert.strictEqual(s.S.core.zone.view().state, 'unreadable');
});

t.test('view is unreadable when the viewed zone id is not a number', function () {
    var s = setup();
    readable(s);
    s.game.gi.mCurrentViewedZoneID = null;
    assert.strictEqual(s.S.core.zone.view().state, 'unreadable');
});

t.test('view is memoized inside a read pass and live with opts.live', function () {
    var s = setup();
    readable(s, 3);
    var calls = 0;
    s.game.gi.isOnHomzone = function () { calls++; return true; };
    s.S.kernel.hostRead.pass(function () {
        s.S.core.zone.view();
        s.S.core.zone.view();
        assert.strictEqual(calls, 1);
        s.S.core.zone.view({ live: true });
        assert.strictEqual(calls, 2);
    });
});

t.test('UNREADABLE is a read refusal', function () {
    var s = setup();
    assert.strictEqual(s.S.core.zone.UNREADABLE, 'zone unreadable');
    assert.strictEqual(s.S.kernel.read.isReadRefusal(s.S.core.zone.UNREADABLE), true);
});

t.test('homeId reads game.player first', function () {
    var s = setup();
    s.game.player = { GetHomeZoneId: function () { return 11; } };
    s.game.gi.mCurrentPlayer = { GetHomeZoneId: function () { return 22; } };
    assert.strictEqual(s.S.core.zone.homeId(), 11);
});

t.test('homeId falls back to mCurrentPlayer when game.player does not answer a number', function () {
    var s = setup();
    s.game.player = { GetHomeZoneId: function () { return null; } };
    s.game.gi.mCurrentPlayer = { GetHomeZoneId: function () { return 22; } };
    assert.strictEqual(s.S.core.zone.homeId(), 22);
    s.game.player = { GetHomeZoneId: function () { throw new Error('x'); } };
    assert.strictEqual(s.S.core.zone.homeId(), 22);
});

t.test('homeId is null when neither source is readable', function () {
    var s = setup();
    s.game.player = {};
    s.game.gi.mCurrentPlayer = { GetHomeZoneId: function () { return 'x'; } };
    assert.strictEqual(s.S.core.zone.homeId(), null);
    s.game.gi.mCurrentPlayer = null;
    assert.strictEqual(s.S.core.zone.homeId(), null);
});

// ---- landingGrids -------------------------------------------------------------

function field(grid) { return { GetGrid: function () { return grid; } }; }

t.test('landingGrids returns the positive grids of the landing fields, deduped, in vector order', function () {
    var s = setup();
    readable(s);
    s.game.zone.mStreetDataMap = { mLandingFields_vector: [field(12), field(34), field(12), field(0)] };
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.S.core.zone.landingGrids())), [12, 34]);
});

t.test('landingGrids is empty when the street data has no landing vector', function () {
    var s = setup();
    readable(s);
    s.game.zone.mStreetDataMap = {};
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.S.core.zone.landingGrids())), []);
    delete s.game.zone.mStreetDataMap;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.S.core.zone.landingGrids())), []);
});

t.test('landingGrids warns once in zone and returns [] when an entry throws', function () {
    var s = setup();
    readable(s);
    s.game.zone.mStreetDataMap = { mLandingFields_vector: [field(12),
        { GetGrid: function () { throw new Error('boom'); } }] };
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.S.core.zone.landingGrids())), []);
    var warns = s.H.logs().filter(function (l) { return l.category === 'zone' && l.level === 'warn'; });
    assert.strictEqual(warns.length, 1);
});

t.test('landingGrids is empty while view is not ok', function () {
    var s = setup();
    readable(s);
    s.game.zone.mStreetDataMap = { mLandingFields_vector: [field(12)] };
    s.game.gi.mCurrentPlayerZone = null;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.S.core.zone.landingGrids())), []);
    s.game.gi.mCurrentPlayerZone = {};
    s.game.gi.mCurrentViewedZoneID = undefined;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.S.core.zone.landingGrids())), []);
    s.game.gi.mCurrentViewedZoneID = 5;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.S.core.zone.landingGrids())), [12]);
});
