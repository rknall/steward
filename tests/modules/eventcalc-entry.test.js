'use strict';

var t = require('../runner');
var harness = require('../harness');

var jq = require('../stubs/jq');

function withJq(H) {
    H.$ = jq.install(H);
    return H;
}

function liveHalloween(H) {
    H.host.game.gi.mEventManager.GetActiveEventNames = function () {
        return ['HW2017plus_Content', 'HW2017plus_Shop'];
    };
    H.host.game.gi.mEventManager.GetEventStopDate = function (name) {
        return name === 'HW2017plus_Shop' ? 1795381200000 : 1794819600000;
    };
}

// Wraps refill.rows (one row whose deposit is read from state.deposit) and
// spies on refill.compute so a test sees what each draw read.
function spyRefill(H, state) {
    var refill = H.Steward.core.events.refill;
    var origCompute = refill.compute;
    state.rowsCalls = 0;
    state.seen = [];
    refill.rows = function () {
        state.rowsCalls++;
        return {
            source: 'game',
            rows: [{ key: 'f1', name: 'Field', deposit: state.deposit,
                     rate12h: 10, source: 'game' }]
        };
    };
    refill.compute = function (rows, T, route, upi) {
        state.seen.push(rows[0].deposit);
        return origCompute(rows, T, route, upi);
    };
}

t.test('the Events tab stays registered with no live event', function () {
    var H = harness.boot();
    var list = H.Steward.kernel.registry.byTab('events');
    var found = false;
    for (var i = 0; i < list.length; i++) {
        if (list[i].id === 'eventcalc') found = true;
    }
    t.assert.ok(found, 'eventcalc on the events tab');
});

t.test('every section render re-reads the fields', function () {
    var H = withJq(harness.boot());
    liveHalloween(H);
    var state = { deposit: 100 };
    spyRefill(H, state);
    var section = H.module('eventcalc').ui.section;
    var h = H.Steward.kernel.ui.helpers;

    section.render(H.$('<div>'), h);
    state.deposit = 250;
    section.render(H.$('<div>'), h);

    t.assert.strictEqual(state.rowsCalls, 2);
    t.assert.deepStrictEqual(state.seen, [100, 250]);
});

t.test('the menu entry opens the same fresh view', function () {
    var H = withJq(harness.boot());
    liveHalloween(H);
    var state = { deposit: 100 };
    spyRefill(H, state);
    var section = H.module('eventcalc').ui.section;
    var h = H.Steward.kernel.ui.helpers;

    // Dashboard stand-in: opening a tab runs the section render.
    H.Steward.kernel.ui.openDashboard = function () {
        section.render(H.$('<div>'), h);
    };
    section.render(H.$('<div>'), h);
    state.deposit = 300;

    var items = H.module('eventcalc').menu.items;
    items[0].onSelect();

    t.assert.strictEqual(state.rowsCalls, 2);
    t.assert.strictEqual(state.seen[state.seen.length - 1], 300);
});
