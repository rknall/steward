'use strict';

// The Geologists tab when a read is not settled: an unreadable list shows
// the muted "reading..." state instead of "none", a geologist whose status
// could not be read is counted as neither idle nor busy, and an unreadable
// deposit count never shows as a number.

var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');

function mount(H, list) {
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists(list)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
}

function unknownGeo(H, uid) {
    var g = H.specs.geologist({ name: 'unk', uid: uid });
    g.GetTask = function () { throw new Error('bridge'); };
    return g;
}

function draw(H, which) {
    jq.install(H);
    var $el = H.ctx.$('<div>');
    H.Steward.modules.geologists[which]($el, H.Steward.kernel.ui.helpers);
    return $el;
}

t.test('an unreadable list renders the unknown state', function () {
    var H = harness.boot();
    mount(H, []);
    H.Steward.core.specialists.byTypeRead = function () {
        return H.Steward.kernel.read.unreadable('bridge');
    };
    var $el = draw(H, 'render');
    t.assert.strictEqual($el.find('.steward-empty-title').text(), 'reading...');
    t.assert.ok($el.find('.steward-empty-title').hasClass('steward-muted'));
    t.assert.strictEqual($el.find('tbody tr').length, 0);
    t.assert.ok(H.Steward.modules.geologists.tiles(H.Steward.kernel.ui.helpers)[0].lines[0] === 'reading...');
});

t.test('an Unknown geologist renders as unknown and is counted in neither idle nor busy', function () {
    var H = harness.boot();
    mount(H, [H.specs.geologist({ name: 'irongut', uid: 'g1' }), unknownGeo(H, 'g2')]);
    var $el = draw(H, 'render');
    t.assert.strictEqual($el.find('tbody tr').length, 2);
    var $unk = $el.find('td .steward-muted');
    var found = false;
    for (var i = 0; i < $unk.length; i++) if ($unk.eq(i).text() === 'reading...') found = true;
    t.assert.ok(found, 'the status cell reads reading...');
    var line = H.Steward.modules.geologists.tiles(H.Steward.kernel.ui.helpers)[0].lines[0];
    t.assert.strictEqual(line, '2 geologists · 0 busy · 1 idle · 1 reading...');
});

t.test('an unreadable deposit count renders as unknown, not a number', function () {
    var H = harness.boot();
    mount(H, []);
    H.settings.write('geologists', { enabled: true, dispatchDelay: 0,
        deposits: { IronOre: { enabled: true, max: 2 } }, overrides: {} });
    H.Steward.core.deposits.byTypeRead = function () {
        return H.Steward.kernel.read.unreadable('bridge');
    };
    var $el = draw(H, 'side');
    var $rows = $el.find('tbody tr');
    var cell = null;
    for (var i = 0; i < $rows.length; i++) {
        if ($rows.eq(i).find('td').eq(0).attr('title') === 'IronOre') cell = $rows.eq(i).find('td').eq(2);
    }
    t.assert.ok(cell, 'the IronOre row exists');
    t.assert.strictEqual(cell.text(), 'reading...');
});

t.test('one list read feeds the whole draw', function () {
    var H = harness.boot();
    mount(H, [H.specs.geologist({ name: 'irongut', uid: 'g1' })]);
    var sp = H.Steward.core.specialists;
    var orig = sp.byTypeRead;
    var reads = 0;
    sp.byTypeRead = function () { reads++; return orig.apply(sp, arguments); };
    draw(H, 'render');
    t.assert.strictEqual(reads, 1);
});
