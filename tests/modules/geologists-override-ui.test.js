'use strict';

// The kind override editor of the Geologists tab: the default/override word
// in the Search cell, the editor row under a deposit, the chip picks and
// what they leave in the settings buffer, and the ranking log that filters
// the way the dispatcher does.

var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');

var NAMES = ['Stone', 'BronzeOre', 'Marble', 'IronOre', 'GoldOre',
             'Coal', 'Granite', 'TitaniumOre', 'Salpeter'];

// The core caches the static specialist class per context, so it is
// installed right after boot, before the first specialist read. Kind 76 is
// a geologist kind of its own (base type 2); 80 is a kind nobody owns.
function boot() {
    var H = harness.boot();
    var cls = H.specs.kindClass({ 76: 'Gingerbread Geologist', 80: 'Bewitching Geologist' });
    H.host.game.def = function (n) { return n === 'Specialists::cSpecialist' ? cls : null; };
    return H;
}

// Every deposit row is written, so the defaults do not leak in through the
// settings merge. rows: { Name: { enabled, max, kinds } }.
function settingsWith(rows) {
    var deposits = {};
    for (var i = 0; i < NAMES.length; i++) {
        deposits[NAMES[i]] = rows[NAMES[i]] || { enabled: false, max: 0 };
    }
    return { enabled: true, dispatchDelay: 0, deposits: deposits, overrides: {} };
}

function mountList(H, list) {
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists(list)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
}

// Two Gingerbread geologists and one vanilla one.
function mountMixed(H) {
    mountList(H, [
        H.specs.geologist({ name: 'Gingerbread Geologist', uid: 'g1', kind: 76 }),
        H.specs.geologist({ name: 'Gingerbread Geologist', uid: 'g2', kind: 76 }),
        H.specs.geologist({ name: 'Geologist', uid: 'g3' })
    ]);
}

// The settings column of the module, built with the real helpers over the
// element-tree jq fake.
function build(H) {
    jq.install(H);
    var $el = H.ctx.$('<div>');
    H.Steward.modules.geologists.side($el, H.Steward.kernel.ui.helpers);
    return $el;
}

function rowsOf($el) { return $el.find('tbody tr'); }

// The table row whose first cell carries the raw `name` as its tooltip.
function rowFor($el, name) {
    var $rows = rowsOf($el);
    for (var i = 0; i < $rows.length; i++) {
        if ($rows.eq(i).find('td').eq(0).attr('title') === name) return $rows.eq(i);
    }
    return null;
}

function wordOf($el, name) { return rowFor($el, name).find('td').eq(1).find('a.steward-link'); }

function editors($el) { return $el.find('td.steward-span'); }

// The index of a deposit's row and of the editor row in the table body.
function rowIndex($el, name) {
    var $rows = rowsOf($el);
    for (var i = 0; i < $rows.length; i++) {
        if ($rows.eq(i).find('td').eq(0).attr('title') === name) return i;
    }
    return -1;
}

function editorIndex($el) {
    var $rows = rowsOf($el);
    for (var i = 0; i < $rows.length; i++) {
        if ($rows.eq(i).find('td.steward-span').length) return i;
    }
    return -1;
}

function chipTexts($el) {
    var $c = $el.find('td.steward-span .steward-chip');
    var out = [];
    for (var i = 0; i < $c.length; i++) out.push($c.eq(i).text() + ($c.eq(i).hasClass('active') ? '*' : ''));
    return out;
}

// The chip shown as `text`, with a trailing * when it is active.
function chip($el, text) {
    var $c = $el.find('td.steward-span .steward-chip');
    for (var i = 0; i < $c.length; i++) {
        if ($c.eq(i).text() + ($c.eq(i).hasClass('active') ? '*' : '') === text) return $c.eq(i);
    }
    return null;
}

function countsLine($el) { return $el.find('td.steward-span .steward-note span.steward-muted').text(); }

function buffered(H, name) { return H.Steward.kernel.ui.helpers.get('geologists', 'deposits.' + name); }

function changeCount(H) { return H.Steward.kernel.ui.screen.changes().count; }

function hasKey(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

t.test('the Search cell shows the toggle and a muted default word', function () {
    var H = boot();
    mountMixed(H);
    H.settings.write('geologists', settingsWith({}));
    var $cell = rowFor(build(H), 'IronOre').find('td').eq(1);
    t.assert.strictEqual($cell.find('input').length, 1);
    var $w = $cell.find('a.steward-link');
    t.assert.strictEqual($w.text(), 'default');
    t.assert.ok($w.hasClass('steward-muted'));
    t.assert.ok(!$w.hasClass('steward-dirty'));
    t.assert.ok(!$cell.hasClass('steward-c'), 'the Search column is left aligned');
});

t.test('a listed type shows override with the kind labels in the tooltip', function () {
    var H = boot();
    mountMixed(H);
    H.Steward.core.locale.res = function (name) { return 'Res ' + name; };
    H.settings.write('geologists', settingsWith({ BronzeOre: { enabled: true, max: 2, kinds: [80, 76] } }));
    var $w = wordOf(build(H), 'BronzeOre');
    t.assert.strictEqual($w.text(), 'override');
    t.assert.ok(!$w.hasClass('steward-muted'));
    t.assert.strictEqual($w.attr('title'),
        'override: only Gingerbread Geologist, Bewitching Geologist may search Res BronzeOre');
});

t.test('clicking the word opens one editor row under that deposit, a second click closes it', function () {
    var H = boot();
    mountMixed(H);
    H.settings.write('geologists', settingsWith({}));
    var $el = build(H);
    t.assert.strictEqual(editors($el).length, 0);

    wordOf($el, 'BronzeOre').trigger('click');
    t.assert.strictEqual(editors($el).length, 1);
    t.assert.strictEqual(editorIndex($el), rowIndex($el, 'BronzeOre') + 1);
    t.assert.strictEqual(editors($el).eq(0).attr('colspan'), '4');
    t.assert.strictEqual($el.find('td.steward-span .steward-subhead span').eq(0).text(),
        'OVERRIDE: ONLY THESE SEARCH BRONZEORE');

    wordOf($el, 'Coal').trigger('click');
    t.assert.strictEqual(editors($el).length, 1, 'clicking another word moves the editor');
    t.assert.strictEqual(editorIndex($el), rowIndex($el, 'Coal') + 1);

    wordOf($el, 'Coal').trigger('click');
    t.assert.strictEqual(editors($el).length, 0);

    // A fresh draw of the tab starts closed.
    wordOf($el, 'Coal').trigger('click');
    t.assert.strictEqual(editors(build(H)).length, 0);
});

t.test('chips list owned kinds with counts and a listed unowned kind with ×0', function () {
    var H = boot();
    mountMixed(H);
    H.settings.write('geologists', settingsWith({ BronzeOre: { enabled: true, max: 2, kinds: [76, 80] } }));
    var $el = build(H);
    wordOf($el, 'BronzeOre').trigger('click');
    t.assert.deepStrictEqual(chipTexts($el),
        ['Geologist ×1', 'Gingerbread Geologist ×2*', 'Bewitching Geologist ×0*']);
    t.assert.strictEqual(countsLine($el),
        '2 kinds ticked · 2 geologists. A kind covers every geologist of that kind, now and later.');
});

t.test('a chip click adds and removes the kind in the buffered row and updates the counts line', function () {
    var H = boot();
    mountMixed(H);
    H.settings.write('geologists', settingsWith({ BronzeOre: { enabled: true, max: 2 } }));
    var $el = build(H);
    wordOf($el, 'BronzeOre').trigger('click');
    t.assert.strictEqual(countsLine($el), 'No kind ticked: BronzeOre searches as default.');

    chip($el, 'Gingerbread Geologist ×2').trigger('click');
    t.assert.strictEqual(JSON.stringify(buffered(H, 'BronzeOre').kinds), '[76]');
    t.assert.strictEqual(editors($el).length, 1, 'the editor stays open');
    t.assert.strictEqual(countsLine($el),
        '1 kind ticked · 2 geologists. A kind covers every geologist of that kind, now and later.');
    t.assert.strictEqual(wordOf($el, 'BronzeOre').text(), 'override');
    t.assert.ok(wordOf($el, 'BronzeOre').hasClass('steward-dirty'));

    chip($el, 'Geologist ×1').trigger('click');
    t.assert.strictEqual(JSON.stringify(buffered(H, 'BronzeOre').kinds), '[2,76]');
    t.assert.strictEqual(countsLine($el),
        '2 kinds ticked · 3 geologists. A kind covers every geologist of that kind, now and later.');

    chip($el, 'Gingerbread Geologist ×2*').trigger('click');
    t.assert.strictEqual(JSON.stringify(buffered(H, 'BronzeOre').kinds), '[2]');
    t.assert.strictEqual(buffered(H, 'BronzeOre').max, 2);
});

t.test('tick then untick on a default type leaves no unsaved change', function () {
    var H = boot();
    mountMixed(H);
    H.settings.write('geologists', settingsWith({ BronzeOre: { enabled: true, max: 2 } }));
    var $el = build(H);
    wordOf($el, 'BronzeOre').trigger('click');
    chip($el, 'Gingerbread Geologist ×2').trigger('click');
    t.assert.ok(changeCount(H) > 0);
    chip($el, 'Gingerbread Geologist ×2*').trigger('click');

    t.assert.ok(!hasKey(buffered(H, 'BronzeOre'), 'kinds'));
    t.assert.strictEqual(changeCount(H), 0);
    t.assert.strictEqual(wordOf($el, 'BronzeOre').text(), 'default');
    t.assert.ok(!wordOf($el, 'BronzeOre').hasClass('steward-dirty'));
});

t.test('tick then untick on a type missing from the stored settings leaves no unsaved change', function () {
    var H = boot();
    mountMixed(H);
    H.settings.write('geologists', { enabled: true, deposits: {} });
    var $el = build(H);
    wordOf($el, 'Granite').trigger('click');
    chip($el, 'Geologist ×1').trigger('click');
    chip($el, 'Geologist ×1*').trigger('click');
    t.assert.strictEqual(changeCount(H), 0);
});

t.test('unticking the last kind of a saved override buffers kinds: [] and counts a change', function () {
    var H = boot();
    mountMixed(H);
    H.settings.write('geologists', settingsWith({ BronzeOre: { enabled: true, max: 2, kinds: [76] } }));
    var $el = build(H);
    t.assert.ok(!wordOf($el, 'BronzeOre').hasClass('steward-dirty'));
    wordOf($el, 'BronzeOre').trigger('click');
    chip($el, 'Gingerbread Geologist ×2*').trigger('click');

    t.assert.strictEqual(JSON.stringify(buffered(H, 'BronzeOre').kinds), '[]');
    t.assert.ok(changeCount(H) > 0);
    t.assert.strictEqual(wordOf($el, 'BronzeOre').text(), 'default');
    t.assert.ok(wordOf($el, 'BronzeOre').hasClass('steward-dirty'));
    t.assert.strictEqual(countsLine($el), 'No kind ticked: BronzeOre searches as default.');
});

t.test('Back to default on a saved override enables Save, writes the default state and a redraw shows default', function () {
    var H = boot();
    mountMixed(H);
    H.settings.write('geologists', settingsWith({ BronzeOre: { enabled: true, max: 2, kinds: [76] } }));
    var $el = build(H);
    wordOf($el, 'BronzeOre').trigger('click');
    var $back = $el.find('td.steward-span .steward-subhead-meta a.steward-link');
    t.assert.strictEqual($back.text(), 'Back to default');
    $back.trigger('click');

    t.assert.strictEqual(editors($el).length, 0, 'the editor closes');
    t.assert.ok(changeCount(H) > 0);
    t.assert.ok(H.Steward.kernel.ui.canSave());

    // The footer's Save button runs closeDashboard(true).
    H.Steward.kernel.ui.closeDashboard(true);
    var stored = H.settings.read('geologists').deposits.BronzeOre;
    t.assert.strictEqual(JSON.stringify(stored.kinds), '[]');
    t.assert.strictEqual(stored.enabled, true);
    t.assert.strictEqual(stored.max, 2);
    t.assert.strictEqual(H.Steward.modules.geologists.rowKinds(stored).length, 0);

    var $w = wordOf(build(H), 'BronzeOre');
    t.assert.strictEqual($w.text(), 'default');
    t.assert.ok($w.hasClass('steward-muted'));
    t.assert.ok(!$w.hasClass('steward-dirty'));
});

t.test('switching Search keeps the stored kinds', function () {
    var H = boot();
    mountMixed(H);
    H.settings.write('geologists', settingsWith({ BronzeOre: { enabled: false, max: 3, kinds: [76] } }));
    var $el = build(H);
    rowFor($el, 'BronzeOre').find('input').eq(0).prop('checked', true).trigger('change');
    var row = buffered(H, 'BronzeOre');
    t.assert.strictEqual(row.enabled, true);
    t.assert.strictEqual(JSON.stringify(row.kinds), '[76]');
    t.assert.ok(!H.Steward.kernel.ui.helpers.isChanged('geologists', 'deposits.BronzeOre.kinds'));
});

t.test('the editor shows a note instead of chips when the geologists cannot be read', function () {
    var H = boot();
    mountMixed(H);
    H.settings.write('geologists', settingsWith({ BronzeOre: { enabled: true, max: 2, kinds: [76] } }));
    H.Steward.core.specialists.geologists = function () { throw new Error('bridge'); };
    var $el = build(H);
    t.assert.strictEqual(wordOf($el, 'BronzeOre').attr('title'),
        'override: only Gingerbread Geologist may search BronzeOre');
    wordOf($el, 'BronzeOre').trigger('click');
    t.assert.strictEqual($el.find('td.steward-span .steward-chip').length, 0);
    t.assert.strictEqual($el.find('td.steward-span .steward-note').text(), 'Geologists could not be read.');
    $el.find('td.steward-span .steward-subhead-meta a.steward-link').trigger('click');
    t.assert.strictEqual(JSON.stringify(buffered(H, 'BronzeOre').kinds), '[]');
});

t.test('the ranking log uses the same eligibility', function () {
    var H = boot();
    mountMixed(H);
    H.settings.write('geologists', settingsWith({
        BronzeOre: { enabled: true, max: 2, kinds: [76] },
        Stone:     { enabled: true, max: 2 }
    }));
    var c = H.Steward.core.specialists;
    var seen = {};
    // Every candidate gets a trait, so each one handed to the ranker is logged.
    c.rankGeologistsForDeposit = function (name, opts) {
        seen[name] = opts.from.map(function (g) { return c.name(g) + '#' + c.kind(g); }).sort();
        return opts.from.map(function (g) { return { geo: g, capacityFactor: 2, timeFactor: 1 }; });
    };
    H.Steward.modules.geologists.showRanking();

    t.assert.strictEqual(JSON.stringify(seen.BronzeOre), JSON.stringify(['Gingerbread Geologist#76', 'Gingerbread Geologist#76']));
    t.assert.strictEqual(JSON.stringify(seen.Stone), JSON.stringify(['Geologist#2']));
    var lines = H.logs().filter(function (l) { return l.category === 'geologists'; })
        .map(function (l) { return l.args ? l.args.join(' ') : String(l.message); });
    var text = lines.join('\n');
    t.assert.ok(text.indexOf('  kinds: only Gingerbread Geologist') >= 0, text);
    t.assert.ok(text.indexOf('  kinds: default') >= 0, text);
});
