'use strict';

var t = require('../runner');
var harness = require('../harness');
var AC = require('../stubs/actions');

var assert = t.assert;

// A building on grid 42 whose production state is state.on.
function setup(o) {
    o = o || {};
    var H = harness.boot();
    var sent = AC.wire(H);
    var state = { on: o.on !== false };
    var bld = {
        GetBuildingName_string: function () { return o.name || 'IronMine'; },
        GetGrid: function () { return 42; },
        IsProductionActive: function () { return state.on; }
    };
    if (o.noState) delete bld.IsProductionActive;
    var gi = H.host.game.gi;
    gi.mCurrentPlayerZone = {
        GetBuildingFromGridPosition: function (grid) { return grid === 42 ? bld : null; }
    };
    gi.isOnHomzone = function () { return o.home !== false; };
    gi.mCurrentViewedZoneID = 1;
    // The host applies the state a send asks for unless the test says it never does.
    if (!o.ignore) {
        var base = gi.SendServerAction;
        gi.SendServerAction = function (id, p1, p2, p3, data) {
            base.apply(this, arguments);
            if (id === 107) state.on = p1 === 1;
        };
    }
    return { H: H, S: H.Steward, sent: sent, state: state };
}

function run(s, def) {
    var result = null;
    assert.strictEqual(s.S.core.actions.attempt(def, function (r) { result = r; }), true);
    AC.drive(s.H);
    return result;
}

t.test('setActive: label, category and timeout name the building and grid', function () {
    var s = setup();
    var def = s.S.core.production.setActive(42, 'IronMine', false);
    assert.strictEqual(def.label, 'pause IronMine 42');
    assert.strictEqual(def.category, 'production');
    assert.strictEqual(def.timeoutMs, 15000);
    assert.strictEqual(s.S.core.production.setActive(42, 'IronMine', true).label, 'resume IronMine 42');
});

t.test('setActive: a building already in the state is satisfied with zero sends', function () {
    var s = setup({ on: true });
    var r = run(s, s.S.core.production.setActive(42, 'IronMine', true));
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('setActive: a pause is sent as (107, 0, grid, 0, null) and verified after the flip', function () {
    var s = setup({ on: true });
    var r = run(s, s.S.core.production.setActive(42, 'IronMine', false));
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.sent.actions)),
        [{ id: 107, p1: 0, p2: 42, p3: 0, data: null }]);
});

t.test('setActive: a resume sends 1', function () {
    var s = setup({ on: false });
    var r = run(s, s.S.core.production.setActive(42, 'IronMine', true));
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(s.sent.actions[0].p1, 1);
});

t.test('setActive: a state the host never applies ends unseen', function () {
    var s = setup({ on: true, ignore: true });
    var r = run(s, s.S.core.production.setActive(42, 'IronMine', false));
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.unseen, true);
});

t.test('setActive: a different building on the grid is refused without a send', function () {
    var s = setup({ name: 'Quarry' });
    var r = run(s, s.S.core.production.setActive(42, 'IronMine', false));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(r.reason, 'building changed');
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('setActive: a building that cannot report its state is refused', function () {
    var s = setup({ noState: true });
    var r = run(s, s.S.core.production.setActive(42, 'IronMine', false));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(r.reason, 'production state unreadable');
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('isActive: true and false for boolean stubs', function () {
    var s = setup();
    var isActive = s.S.core.production.isActive;
    assert.strictEqual(isActive({ IsProductionActive: function () { return true; } }), true);
    assert.strictEqual(isActive({ IsProductionActive: function () { return false; } }), false);
});

t.test('isActive: a non-boolean return is null, not a truthy or falsy guess', function () {
    var s = setup();
    var isActive = s.S.core.production.isActive;
    assert.strictEqual(isActive({ IsProductionActive: function () { return 1; } }), null);
    assert.strictEqual(isActive({ IsProductionActive: function () { return 0; } }), null);
});

t.test('isActive: a throwing method, a missing method and a null building are null', function () {
    var s = setup();
    var isActive = s.S.core.production.isActive;
    assert.strictEqual(isActive({ IsProductionActive: function () { throw new Error('host'); } }), null);
    assert.strictEqual(isActive({}), null);
    assert.strictEqual(isActive(null), null);
});

t.test('setActive: away from home is refused', function () {
    var s = setup({ home: false });
    var r = run(s, s.S.core.production.setActive(42, 'IronMine', false));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(s.sent.actions.length, 0);
});
