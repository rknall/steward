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

// A field row as refill.rows returns it. workTime 3600 with the default
// 6 s route gives a fixed rate; the time left comes from fixedEvent.
function field(key, deposit, source, buffed) {
    return {
        key:            key,
        building:       'PumpkinField',
        grid:           null,
        deposit:        deposit,
        workTime:       3600,
        perCycle:       1,
        source:         source || 'game',
        buffedPerCycle: buffed ? 2 : null,
        buffEndMs:      buffed ? new Date().getTime() + 10 * 86400000 : null
    };
}

// Live Halloween with fixed refill rows and three days left, and a spy that
// keeps every compute input and result.
function liveWithRows(rows, source) {
    var H = withJq(harness.boot());
    liveHalloween(H);
    var refill = H.Steward.core.events.refill;
    var spy = { calls: [] };
    var orig = refill.compute;
    refill.depositEvent = function () {
        return { code: 'HW', name: 'Halloween', resource: 'HalloweenResource',
                 endTime: new Date().getTime() + 3 * 86400000, remainingSec: 3 * 86400 };
    };
    refill.rows = function () { return { source: source || 'game', rows: rows }; };
    refill.compute = function (r, T, route, upi) {
        var res = orig(r, T, route, upi);
        spy.calls.push({ rows: r, T: T, route: route, upi: upi, result: res });
        return res;
    };
    H.Steward.modules.eventcalc.resetSession();
    var $p = H.$('<div>');
    H.Steward.modules.eventcalc.renderSection($p, H.Steward.kernel.ui.helpers);
    spy.H = H;
    spy.$p = $p;
    return spy;
}

function cardTitles(H, $p) {
    var out = [];
    $p.find('.steward-card-h').each(function () { out.push(H.$(this).text()); });
    return out;
}

function refillCardOf(H, $p) {
    var found = null;
    $p.find('.steward-card').each(function () {
        if (H.$(this).find('.steward-card-h').text() === 'Refill calculator') found = H.$(this);
    });
    return found;
}

function headLabels(H, $card) {
    var out = [];
    $card.find('th').each(function () { out.push(H.$(this).text()); });
    return out;
}

// Text of column `col` in every body row of the refill table.
function columnTexts(H, $card, col) {
    var out = [];
    $card.find('tbody tr').each(function () {
        out.push(H.$(this).find('td').eq(col).text());
    });
    return out;
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

t.test('renderSection without a live event shows the refill empty state, then the held card', function () {
    var H = withJq(harness.boot());
    var $p = H.$('<div>');
    H.Steward.modules.eventcalc.renderSection($p, H.Steward.kernel.ui.helpers);
    t.assert.deepStrictEqual(cardTitles(H, $p), ['Refill calculator', 'Event resources']);
    var $refill = refillCardOf(H, $p);
    t.assert.strictEqual($refill.find('.steward-empty-title').text(),
        'No event with refillable fields is live.');
});

t.test('renderSection while live draws estimate, refill and held cards in that order', function () {
    var spy = liveWithRows([field('f1', 5)]);
    var titles = cardTitles(spy.H, spy.$p);
    t.assert.strictEqual(titles.length, 3);
    t.assert.strictEqual(titles[1], 'Refill calculator');
    t.assert.strictEqual(titles[2], 'Event resources');
});

t.test('the refill table has Field, Amount, Per 12 h and Refills needed without a buff', function () {
    var spy = liveWithRows([field('f1', 5), field('f2', 0)]);
    var $card = refillCardOf(spy.H, spy.$p);
    t.assert.deepStrictEqual(headLabels(spy.H, $card),
        ['Field', 'Amount', 'Per 12 h', 'Refills needed']);
    t.assert.strictEqual($card.find('tbody tr').length, 2, 'one body row per field');
    t.assert.strictEqual($card.find('tfoot tr').length, 1, 'total row');
    t.assert.strictEqual($card.find('button').length, 0, 'no buttons');
    t.assert.strictEqual($card.find('input').length, 0, 'no inputs on game rows');
});

t.test('the Amount header is aligned like its figures', function () {
    var spy = liveWithRows([field('f1', 5)]);
    var $card = refillCardOf(spy.H, spy.$p);
    t.assert.ok($card.find('th').eq(1).hasClass('steward-num'), 'Amount header right-aligned');
    t.assert.ok($card.find('tbody td').eq(1).hasClass('steward-num'), 'Amount cell right-aligned');
});

t.test('a buffed field adds the Buffed 12 h column, filled only on that row', function () {
    var spy = liveWithRows([field('f1', 5), field('f2', 3, 'game', true)]);
    var $card = refillCardOf(spy.H, spy.$p);
    t.assert.deepStrictEqual(headLabels(spy.H, $card),
        ['Field', 'Amount', 'Per 12 h', 'Buffed 12 h', 'Refills needed']);
    var result = spy.calls[0].result;
    t.assert.strictEqual(result.rows[0].rate12hBuffed, null);
    t.assert.deepStrictEqual(columnTexts(spy.H, $card, 3),
        ['—', String(result.rows[1].rate12hBuffed)]);
    t.assert.strictEqual($card.find('tfoot td').eq(3).text(), String(result.totalRate12hBuffed));
});

t.test('Refills needed and the totals come from compute', function () {
    var spy = liveWithRows([field('f1', 5), field('f2', 40)]);
    var $card = refillCardOf(spy.H, spy.$p);
    var result = spy.calls[0].result;
    t.assert.strictEqual(spy.calls[0].T, 3 * 86400, 'time left from the event');
    t.assert.deepStrictEqual(columnTexts(spy.H, $card, 3),
        [String(result.rows[0].units), String(result.rows[1].units)]);
    t.assert.deepStrictEqual(columnTexts(spy.H, $card, 1), ['5', '40']);
    var foot = [];
    $card.find('tfoot td').each(function () { foot.push(spy.H.$(this).text()); });
    t.assert.deepStrictEqual(foot, ['Total', String(result.totalDeposit),
        String(result.totalRate12h), String(result.totalUnits)]);
});

t.test('template rows take the amount as an input and a change recomputes', function () {
    var spy = liveWithRows([field('f1', 0, 'manual'), field('f2', 0, 'manual')], 'manual');
    var $card = refillCardOf(spy.H, spy.$p);
    t.assert.strictEqual($card.find('input').length, 2, 'one input per template row');
    t.assert.ok(spy.$p.find('.steward-note').length > 0, 'not-readable note');
    $card.find('input').eq(0).val('7').trigger('change');
    var last = spy.calls[spy.calls.length - 1];
    t.assert.ok(spy.calls.length > 1, 'redrawn');
    t.assert.strictEqual(last.rows[0].deposit, 7);
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

t.test('tiles appends the held-resources tile when the hook returns one', function () {
    var H = withJq(harness.boot());
    var mod = H.Steward.modules.eventcalc;
    var tile = { title: 'Event resources', lines: [], links: [{ label: 'Events', tab: 'events' }] };
    mod.heldTile = function () { return tile; };
    var out = mod.tiles(H.Steward.kernel.ui.helpers);
    t.assert.strictEqual(out.length, 1);
    t.assert.strictEqual(out[0], tile);
    mod.heldTile = function () { throw new Error('boom'); };
    t.assert.strictEqual(mod.tiles(H.Steward.kernel.ui.helpers).length, 0, 'a throw adds nothing');
});

t.test('the Events cards use the spacing classes and set no inline spacing', function () {
    var spy = liveWithRows([field('f1', 0, 'manual')], 'manual');
    var $p = spy.$p;
    t.assert.ok($p.find('.steward-stack').length > 0, 'card stack');
    t.assert.ok($p.find('.steward-note').length > 0, 'note');
    var spaced = ['.steward-stack', '.steward-card', '.steward-card-badge', '.steward-note'];
    spaced.forEach(function (sel) {
        $p.find(sel).each(function () {
            var style = spy.H.$(this)[0].style;
            t.assert.deepStrictEqual(Object.keys(style), [], sel + ' has no inline style');
        });
    });
});
