'use strict';

var t = require('../runner');
var harness = require('../harness');

var jq = require('../stubs/jq');

function withJq(H) {
    H.$ = jq.install(H);
    return H;
}

// Stubs heldResources with fixed rows and draws the card into a fresh div.
// The filter is off unless activeOnly is given, so every event's rows show.
function draw(rows, boot, activeOnly) {
    var H = withJq(boot || harness.boot());
    if (activeOnly !== undefined) {
        if (activeOnly !== null) H.settings.write('eventcalc', { heldActiveOnly: activeOnly });
    } else {
        H.settings.write('eventcalc', { heldActiveOnly: false });
    }
    H.Steward.core.events.heldResources = function () {
        return { source: 'host', rows: rows };
    };
    var $p = H.$('<div>');
    $p.append(H.Steward.modules.eventcalc.heldCard(H.Steward.kernel.ui.helpers));
    return { H: H, $p: $p };
}


function row(resource, code, amount, live) {
    return { resource: resource, amount: amount, eventName: code + '_Shop', code: code, live: !!live };
}

t.test('heldCard lists a known event resource with its amount, no event live', function () {
    var d = draw([row('HalloweenResource', 'HW', 35)]);
    t.assert.strictEqual(d.$p.find('tbody tr').length, 1);
    t.assert.ok(d.$p.text().indexOf('35') >= 0, 'amount shown');
    t.assert.strictEqual(d.$p.find('.steward-b-ok').length, 0, 'no Live badge');
});

t.test('heldCard greys a zero amount and shows an unreadable one as a muted dash', function () {
    var d = draw([row('HalloweenResource', 'HW', 0), row('WMShoulderPad', 'WM', null)]);
    var $muted = d.$p.find('.steward-muted');
    var texts = [];
    $muted.each(function () { texts.push(d.H.$(this).text()); });
    t.assert.ok(texts.indexOf('0') >= 0, 'zero is muted');
    t.assert.ok(texts.indexOf('—') >= 0, 'null is a muted dash');
    t.assert.strictEqual(d.$p.text().indexOf('null'), -1);
});

t.test('heldCard marks the live event row with a Live badge', function () {
    var d = draw([row('HalloweenResource', 'HW', 12, true), row('WMShoulderPad', 'WM', 5, false)]);
    t.assert.strictEqual(d.$p.find('.steward-b-ok').length, 1);
    t.assert.strictEqual(d.$p.find('.steward-b-ok').text(), 'Live');
});

t.test('heldCard is one flat list in the returned order and drops rows with no known event', function () {
    var d = draw([
        row('HalloweenResource', 'HW', 1),
        { resource: 'AdventureRelics', amount: 9, eventName: 'Relic', code: null, live: false },
        row('WMShoulderPad', 'WM', 2)
    ]);
    t.assert.strictEqual(d.$p.find('.steward-subhead').length, 0, 'no per-event groups');
    t.assert.strictEqual(d.$p.find('tbody tr').length, 2);
    t.assert.strictEqual(d.$p.text().indexOf('Relic'), -1);
});

t.test('heldCard shows the empty state with no rows or when heldResources throws', function () {
    var d = draw([]);
    t.assert.strictEqual(d.$p.find('.steward-empty-title').text(), 'No event resources held.');
    var H = withJq(harness.boot());
    H.settings.write('eventcalc', { heldActiveOnly: false });
    H.Steward.core.events.heldResources = function () { throw new Error('boom'); };
    var $p = H.$('<div>');
    $p.append(H.Steward.modules.eventcalc.heldCard(H.Steward.kernel.ui.helpers));
    t.assert.strictEqual($p.find('.steward-empty-title').text(), 'No event resources held.');
});

t.test('heldCard renders a host name containing markup as text', function () {
    var d = draw([row('<b>x</b>', 'HW', 3)]);
    t.assert.strictEqual(d.$p.find('tbody b').length, 0);
    t.assert.ok(d.$p.text().indexOf('<b>x</b>') >= 0);
});

t.test('heldTile is null with and without a live event', function () {
    var H = harness.boot();
    var tile = H.Steward.modules.eventcalc.heldTile;
    t.assert.strictEqual(tile(), null);
    H.host.game.gi.mEventManager.GetActiveEventNames = function () { return ['HW2017plus_Content']; };
    t.assert.strictEqual(tile(), null);
});

// ---- active event filter ------------------------------------------------------

t.test('by default heldCard lists only the live event resources', function () {
    var d = draw([row('HalloweenResource', 'HW', 12, true), row('WMShoulderPad', 'WM', 5, false)], null, null);
    t.assert.strictEqual(d.H.Steward.modules.eventcalc.defaultSettings.heldActiveOnly, true);
    t.assert.strictEqual(d.$p.find('tbody tr').length, 1);
    t.assert.strictEqual(d.$p.text().indexOf('5'), -1);
    t.assert.strictEqual(d.$p.find('input[type=checkbox]').length, 1, 'toggle under the table');
    t.assert.strictEqual(d.$p.find('input[type=checkbox]').attr('checked'), 'checked');
});

t.test('with the filter off heldCard lists every event resource', function () {
    var d = draw([row('HalloweenResource', 'HW', 12, true), row('WMShoulderPad', 'WM', 5, false)], null, false);
    t.assert.strictEqual(d.$p.find('tbody tr').length, 2);
    t.assert.strictEqual(d.$p.find('input[type=checkbox]').attr('checked'), undefined);
});

t.test('without a live event the default shows its own empty state and the toggle', function () {
    var d = draw([row('WMShoulderPad', 'WM', 5, false)], null, null);
    t.assert.strictEqual(d.$p.find('tbody tr').length, 0);
    t.assert.strictEqual(d.$p.find('.steward-empty-title').text(), 'No resources of an active event held.');
    t.assert.strictEqual(d.$p.find('input[type=checkbox]').length, 1);
});

t.test('switching the toggle writes the buffer and redraws', function () {
    var H = withJq(harness.boot());
    H.Steward.core.events.heldResources = function () {
        return { source: 'host', rows: [row('HalloweenResource', 'HW', 12, true), row('WMShoulderPad', 'WM', 5, false)] };
    };
    var h = H.Steward.kernel.ui.helpers;
    var redraws = 0;
    var $p = H.$('<div>');
    $p.append(H.Steward.modules.eventcalc.heldCard(h, function () { redraws++; }));
    $p.find('input[type=checkbox]').prop('checked', false).trigger('change');
    t.assert.strictEqual(redraws, 1);
    t.assert.strictEqual(h.settings('eventcalc').heldActiveOnly, false);
    var $q = H.$('<div>');
    $q.append(H.Steward.modules.eventcalc.heldCard(h));
    t.assert.strictEqual($q.find('tbody tr').length, 2);
});
