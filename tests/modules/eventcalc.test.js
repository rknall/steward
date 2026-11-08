'use strict';

var t = require('../runner');
var harness = require('../harness');

var jq = require('../stubs/jq');

// The element-tree jQuery fake gives the helpers and the section's redraw
// a real tree to build and inspect.
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

t.test('renderSection without a live event shows the two empty states', function () {
    var H = withJq(harness.boot());
    var $p = H.$('<div>');
    H.Steward.modules.eventcalc.renderSection($p, H.Steward.kernel.ui.helpers);
    var titles = [];
    $p.find('.steward-empty-title').each(function () { titles.push(H.$(this).text()); });
    t.assert.deepStrictEqual(titles, [
        'No event with explorer items is live.',
        'No event with refillable fields is live.'
    ]);
});

t.test('renderSection draws the refill table while a deposit event is live', function () {
    var H = withJq(harness.boot());
    liveHalloween(H);
    var refill = H.Steward.core.events.refill;
    var calls = [];
    var orig = refill.compute;
    refill.compute = function (rows, T, route, upi) {
        calls.push({ rows: rows, T: T, route: route, upi: upi });
        return orig(rows, T, route, upi);
    };
    H.Steward.modules.eventcalc.resetSession();
    var $p = H.$('<div>');
    H.Steward.modules.eventcalc.renderSection($p, H.Steward.kernel.ui.helpers);
    t.assert.strictEqual(calls.length, 1);
    t.assert.strictEqual(calls[0].route, 6);
    t.assert.strictEqual(calls[0].upi, 1);
    t.assert.ok(calls[0].rows.length > 0, 'template or game rows present');
    t.assert.ok($p.find('tbody tr').length > 0, 'one table row per field');
});

t.test('refill compute receives the buffered route and units, not the saved ones', function () {
    var H = withJq(harness.boot());
    liveHalloween(H);
    var h = H.Steward.kernel.ui.helpers;
    var refill = H.Steward.core.events.refill;
    var calls = [];
    var orig = refill.compute;
    refill.compute = function (rows, T, route, upi) {
        calls.push({ route: route, upi: upi });
        return orig(rows, T, route, upi);
    };
    H.Steward.modules.eventcalc.resetSession();
    h.set('eventcalc', 'routeSeconds', 11);
    h.set('eventcalc', 'unitsPerItem', 4);
    H.Steward.modules.eventcalc.renderSection(H.$('<div>'), h);
    t.assert.strictEqual(calls[0].route, 11);
    t.assert.strictEqual(calls[0].upi, 4);
    t.assert.strictEqual(H.settings.read('eventcalc'), null, 'nothing saved by rendering');
});

t.test('eventPhase names the treasure and cooldown phases', function () {
    var H = harness.boot();
    var phase = H.Steward.modules.eventcalc.eventPhase;
    t.assert.strictEqual(phase({ categories: { treasure: true, shop: true } }).label, 'Treasure phase');
    t.assert.strictEqual(phase({ categories: { shop: true } }).label, 'Cooldown phase');
    t.assert.strictEqual(phase({ categories: { shop: true } }).kind, 'busy');
    t.assert.strictEqual(phase({ categoryList: ['a', 'b'] }).label, 'a, b');
    t.assert.strictEqual(phase({}).label, 'Live');
});

t.test('tiles gives nothing without an event and one tile per live event', function () {
    var H = withJq(harness.boot());
    var mod = H.Steward.modules.eventcalc;
    t.assert.strictEqual(mod.tiles(H.Steward.kernel.ui.helpers).length, 0);
    liveHalloween(H);
    var live = H.Steward.core.events.active();
    var tiles = mod.tiles(H.Steward.kernel.ui.helpers);
    t.assert.strictEqual(tiles.length, live.length);
    t.assert.ok(tiles.length > 0, 'a live event is reported');
    t.assert.strictEqual(tiles[0].title, live[0].name);
    t.assert.strictEqual(tiles[0].badge.text, 'Live');
    t.assert.strictEqual(tiles[0].links[0].tab, 'events');
});

t.test('the Events card uses the spacing classes and sets no inline spacing', function () {
    var H = withJq(harness.boot());
    liveHalloween(H);
    H.Steward.modules.eventcalc.resetSession();
    var $p = H.$('<div>');
    H.Steward.modules.eventcalc.renderSection($p, H.Steward.kernel.ui.helpers);
    t.assert.ok($p.find('.steward-inline').length > 0, 'inline row');
    t.assert.ok($p.find('.steward-inline-item').length > 0, 'inline items');
    t.assert.ok($p.find('.steward-card-foot').length > 0, 'bottom row');
    var spaced = ['.steward-inline', '.steward-inline-item', '.steward-card-foot', '.steward-card-badge', '.steward-note'];
    spaced.forEach(function (sel) {
        $p.find(sel).each(function () {
            var style = H.$(this)[0].style;
            t.assert.deepStrictEqual(Object.keys(style), [], sel + ' has no inline style');
        });
    });
});
