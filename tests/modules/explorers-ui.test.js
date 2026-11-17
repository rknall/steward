'use strict';

// The Explorers tab: the live table and the overview tile over one list read,
// and what they show while that read is not settled.

var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');

function boot() {
    var H = harness.boot();
    jq.install(H);
    // The core classifies entries through the specialist class; without it
    // every entry is unclassified and the list is only partial.
    var cls = H.specs.kindClass({});
    H.host.game.def = function (n) { return n === 'Specialists::cSpecialist' ? cls : null; };
    return H;
}

function mount(H, list) {
    var z = H.zone.zone()
        .specialists(list)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
}

function explorer(H, name, uid) {
    // Game type 1 is the explorer base type, as in explorers.test.js.
    return H.specs.spec({ type: 1, name: name, uid: uid });
}

// An explorer whose status read throws, so its status is Unknown.
function unknownExplorer(H, name, uid) {
    var e = explorer(H, name, uid);
    e.GetTask = function () { throw new Error('bridge'); };
    return e;
}

function render(H) {
    var $el = H.ctx.$('<div>');
    H.Steward.modules.explorers.render($el, H.Steward.kernel.ui.helpers);
    return $el;
}

function tile(H) {
    var tiles = H.Steward.modules.explorers.tiles(H.Steward.kernel.ui.helpers);
    return tiles[0].lines[0];
}

function rowTexts($el) {
    var $rows = $el.find('tbody tr');
    var out = [];
    for (var i = 0; i < $rows.length; i++) out.push($rows.eq(i).find('td').eq(1).text());
    return out;
}

function unreadable(H) {
    var S = H.Steward;
    S.core.specialists.byTypeRead = function () { return S.kernel.read.unreadable('list unreadable'); };
}

t.test('an unreadable list renders the unknown state', function () {
    var H = boot();
    mount(H, [explorer(H, 'Alma', 'e1')]);
    unreadable(H);
    var $el = render(H);
    t.assert.strictEqual($el.find('.steward-empty-title').text(), 'reading...');
    t.assert.ok($el.find('.steward-empty-title').hasClass('steward-muted'));
    t.assert.strictEqual($el.find('tbody tr').length, 0);
    t.assert.ok($el.text().indexOf('No explorers found') < 0, 'not shown as none');
    t.assert.strictEqual(tile(H).text(), 'reading...');
});

t.test('an Unknown explorer renders as approved and is counted in neither idle nor busy', function () {
    var H = boot();
    mount(H, [explorer(H, 'Alma', 'e1'), unknownExplorer(H, 'Bruno', 'e2')]);
    var $el = render(H);
    var texts = rowTexts($el);
    t.assert.strictEqual(texts.length, 2);
    t.assert.strictEqual(texts[1], 'reading...');
    var chips = $el.find('.steward-chip');
    var labels = [];
    for (var i = 0; i < chips.length; i++) labels.push(chips.eq(i).text());
    t.assert.deepStrictEqual(labels, ['All 2', 'Busy 0', 'Idle 1', 'Overrides 0']);
    t.assert.strictEqual(tile(H).text(), '2 explorers \u00b7 0 busy \u00b7 1 idle \u00b7 1 reading...');
});

t.test('one list read per draw', function () {
    var H = boot();
    mount(H, [explorer(H, 'Alma', 'e1'), explorer(H, 'Bruno', 'e2')]);
    var c = H.Steward.core.specialists;
    var real = c.byTypeRead;
    var calls = 0;
    c.byTypeRead = function () { calls++; return real.apply(c, arguments); };
    render(H);
    t.assert.strictEqual(calls, 1);
    calls = 0;
    tile(H);
    t.assert.strictEqual(calls, 1);
});
