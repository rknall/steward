'use strict';

var t = require('../runner');
var harness = require('../harness');

// The shared jQuery stub has no empty() and the vm context has no
// document; the helpers and the section's redraw need both.
function withEmpty(H) {
    H.host.$.fn.empty = function () { return H.host.$.fn; };
    H.ctx.document = { createTextNode: function (s) { return { nodeValue: s }; } };
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

t.test('eventcalc registers on the events tab with an Events submenu of 2 items', function () {
    var H = harness.boot();
    var mod = H.module('eventcalc');
    t.assert.ok(mod, 'eventcalc registered');
    t.assert.strictEqual(mod.ui.tab, 'events');

    var withMenu = H.Steward.kernel.registry.withMenu();
    var found = null;
    for (var i = 0; i < withMenu.length; i++) {
        if (withMenu[i].id === 'eventcalc') found = withMenu[i];
    }
    t.assert.ok(found, 'eventcalc in withMenu()');
    t.assert.strictEqual(found.menu.title, 'Events');
    t.assert.strictEqual(found.menu.items.length, 2);
});

t.test('boot seeds { routeSeconds: 6, unitsPerItem: 1 }', function () {
    var H = harness.boot();
    t.assert.strictEqual(H.settings.read('eventcalc'), null);
    H.module('eventcalc').boot();
    var s = H.settings.read('eventcalc');
    t.assert.strictEqual(s.routeSeconds, 6);
    t.assert.strictEqual(s.unitsPerItem, 1);
});

t.test('showEstimateAlert with no event shows the "no event" text', function () {
    var shown = [];
    var H = harness.boot({ host: { showGameAlert: function (msg) { shown.push(msg); } } });
    H.Steward.modules.eventcalc.showEstimateAlert();
    t.assert.strictEqual(shown.length, 1);
    t.assert.strictEqual(shown[0], 'Steward: no event with explorer items is live');
});

t.test('renderSection does not throw with the jQuery stub (no event)', function () {
    var H = withEmpty(harness.boot());
    H.Steward.modules.eventcalc.renderSection(H.host.$(), H.Steward.kernel.ui.helpers);
});

t.test('renderSection draws the refill table while a deposit event is live', function () {
    var H = withEmpty(harness.boot());
    liveHalloween(H);
    var refill = H.Steward.core.events.refill;
    var calls = [];
    var orig = refill.compute;
    refill.compute = function (rows, T, route, upi) {
        calls.push({ rows: rows, T: T, route: route, upi: upi });
        return orig(rows, T, route, upi);
    };
    H.Steward.modules.eventcalc.resetSession();
    H.Steward.modules.eventcalc.renderSection(H.host.$(), H.Steward.kernel.ui.helpers);
    t.assert.strictEqual(calls.length, 1);
    t.assert.strictEqual(calls[0].route, 6);
    t.assert.strictEqual(calls[0].upi, 1);
    t.assert.ok(calls[0].rows.length > 0, 'template or game rows present');
});
