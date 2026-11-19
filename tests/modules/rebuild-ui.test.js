'use strict';

// Rebuild view: the Rebuild tab's settings column, the wells and fields
// table with its states, the summary and the tile
// (src/modules/rebuild/ui.js). The view only reads.

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var jq = require('../stubs/jq');
var Z = require('../stubs/zone');

var assert = t.assert;

var WELL = 'MineDepletedDepositWater';
var FIELD = 'MineDepletedDepositCorn';
var KEY = 'rebuild|home|10';
var T0 = 1700000000000;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

// A booted steward on the home island holding o.buildings, with the Water and
// Corn deposits o.water / o.corn, a build queue of o.used of o.slots and the
// rebuild settings o.settings. o.fs reuses a disk (a reboot).
function setup(o) {
    o = o || {};
    var fs = o.fs || airfs.make();
    var H = harness.boot({ host: { air: fs.air } });
    jq.install(H);
    var z = Z.zone();
    var list = o.buildings || [];
    for (var i = 0; i < list.length; i++) {
        var bo = { level: 1, constructing: false };
        for (var k in list[i]) bo[k] = list[i][k];
        z.building(Z.building(bo));
    }
    z.buildQueue(typeof o.used === 'number' ? o.used : 0, typeof o.slots === 'number' ? o.slots : 4);
    if (o.water) z.deposits('Water', o.water);
    if (o.corn) z.deposits('Corn', o.corn);
    H.installZone(z);
    var gi = H.host.game.gi;
    gi.mCurrentViewedZoneID = 1;
    z.zone.mStreetDataMap.IsADepletedDeposit = function (b) {
        return b.GetBuildingName_string().indexOf('Depleted') > -1;
    };
    H.settings.write('rebuild', o.settings || { enabled: true, wellType: 'Well_03', fieldType: 'Farmfield' });
    var clock = { now: T0 };
    H.Steward.core.ledger.clock = function () { return clock.now; };
    H.module('rebuild').boot();
    return { H: H, S: H.Steward, h: H.Steward.kernel.ui.helpers, fs: fs, gi: gi, clock: clock };
}

function build(s, part) {
    var $el = s.H.ctx.$('<div>');
    s.S.modules.rebuild[part]($el, s.h);
    return $el;
}

function text(s, part) { return build(s, part).text(); }

var BUILDINGS = [
    { name: WELL, grid: 10 },
    { name: 'Well_03', grid: 12 },
    { name: FIELD, grid: 14 },
    { name: 'Farmfield', grid: 11 },
    { name: 'Woodcutter', grid: 99 }
];
var WATER = [
    Z.deposit({ name: 'Water', grid: 12, amount: 500, maxAmount: 850 }),
    Z.deposit({ name: 'Water', grid: 20, amount: 120 })
];
var CORN = [Z.deposit({ name: 'Corn', grid: 11, amount: 920, maxAmount: 800 })];

t.test('the side has the switch and the two type dropdowns with the module names as values', function () {
    var s = setup();
    var $side = build(s, 'side');
    assert.ok(/Rebuild on the home island/.test($side.text()));
    assert.ok(/Spends resources and a build slot per rebuild; off by default/.test($side.text()));
    var sel = $side.find('select');
    assert.strictEqual(sel.length, 2);
    var m = s.S.modules.rebuild;
    function values($sel) {
        var out = [];
        $sel.find('option').each(function () { out.push(s.H.ctx.$(this).attr('value')); });
        return out;
    }
    assert.deepStrictEqual(plain(values(sel.eq(0))), plain(m.wells.map(function (w) { return w.name; })));
    assert.deepStrictEqual(plain(values(sel.eq(1))), plain(m.fields.map(function (f) { return f.name; })));
    assert.ok(!/Build queue|Last|State|Clear/.test($side.text()));
});

t.test('changing a dropdown and saving writes steward.rebuild.wellType', function () {
    var s = setup();
    var $side = build(s, 'side');
    $side.find('select').eq(0).val('Well_04').trigger('change');
    s.S.kernel.ui.closeDashboard(true);
    assert.strictEqual(s.H.settings.read('rebuild').wellType, 'Well_04');
});

t.test('running: rows by grid with amounts, no status text', function () {
    var s = setup({ buildings: BUILDINGS, water: WATER, corn: CORN });
    var $main = build(s, 'render');
    var rows = [];
    $main.find('tbody tr').each(function () {
        var cells = [];
        s.H.ctx.$(this).find('td').each(function () { cells.push(s.H.ctx.$(this).text()); });
        rows.push(cells);
    });
    assert.deepStrictEqual(plain(rows), [
        ['10', 'Exhausted well', 'Deep Well', '0'],
        ['11', 'Wheatfield', 'Wheatfield', '920 / 800'],
        ['12', 'Deep Well', 'Deep Well', '500 / 850'],
        ['14', 'Exhausted field', 'Wheatfield', '0']
    ]);
    var txt = $main.text();
    assert.ok(/4 on the home island/.test(txt));
    assert.ok(/Amount is what is left in the shell\./.test(txt));
    assert.ok(!/Build queue|Last|State|Clear|\?/.test(txt));
    assert.ok(!/Waiting for rebuild/.test(txt));
});

t.test('a plain amount without a maximum, and reading for a live building without a deposit', function () {
    var s = setup({
        buildings: [{ name: 'Well_03', grid: 20 }, { name: 'Well', grid: 21 }],
        water: WATER
    });
    var txt = text(s, 'render');
    assert.ok(/120/.test(txt));
    assert.ok(!/120 \//.test(txt));
    assert.ok(/reading\.\.\./.test(txt));
});

t.test('a full build queue shows only the waiting line', function () {
    var s = setup({ buildings: BUILDINGS, water: WATER, corn: CORN, used: 4, slots: 4 });
    var txt = text(s, 'render');
    assert.ok(/\(Waiting for rebuild\.\.\.\)/.test(txt));
    assert.ok(!/Build queue/.test(txt));
});

t.test('off', function () {
    var s = setup({ settings: { enabled: false } });
    var txt = text(s, 'render');
    assert.ok(/Rebuilding is off/.test(txt));
    assert.ok(/Switch it on to list the wells and fields of the home island\./.test(txt));
});

t.test('away from the home island lists no table', function () {
    var s = setup({ buildings: BUILDINGS, water: WATER, corn: CORN });
    s.gi.isOnHomzone = function () { return false; };
    var $main = build(s, 'render');
    assert.ok(/Rebuilds run on the home island only/.test($main.text()));
    assert.ok(/Away from the home island/.test($main.text()));
    assert.strictEqual($main.find('table').length, 0);
});

t.test('an unread building list is reading', function () {
    var s = setup({ buildings: BUILDINGS });
    s.S.core.buildings.listRead = function () { return s.S.kernel.read.unreadable('no list'); };
    var $main = build(s, 'render');
    assert.ok(/reading\.\.\./.test($main.text()));
    assert.ok(/Waiting for the building list and the build queue to read\./.test($main.text()));
    assert.strictEqual($main.find('table').length, 0);
});

t.test('an unusable ledger shows the banner and no table', function () {
    var s = setup({ buildings: BUILDINGS });
    s.S.core.ledger.usable = function () { return false; };
    var $main = build(s, 'render');
    assert.ok(/Nothing is sent: there is no writable steward folder, or the send ledger could not be read\./.test($main.text()));
    assert.ok(/No rebuilds while the ledger is unusable/.test($main.text()));
    assert.strictEqual($main.find('table').length, 0);
});

t.test('an open breaker shows its banner with the run and the cooldown', function () {
    var s = setup({ buildings: BUILDINGS, water: WATER, corn: CORN });
    var brk = s.S.core.ledger.breaker('rebuild');
    for (var i = 0; i < brk.MISSES; i++) brk.miss();
    var txt = text(s, 'render');
    assert.ok(/Rebuilding paused: 5 rebuilds in a row were not seen on their grid\. One probe every 5 min; reloading scripts resets it\./.test(txt));
    assert.ok(/Wells and fields/.test(txt));
});

t.test('a stale entry shows a banner naming its grid', function () {
    var s = setup({ buildings: BUILDINGS, water: WATER, corn: CORN });
    // The ledger reads its file once; reboot on a disk that holds the entry.
    var path = 'C:/client/steward/state/' + s.S.core.ledger.FILE_NAME;
    var entries = {};
    entries[KEY] = { owner: 'rebuild', label: 'rebuild Well_03 10', name: 'Well_03', state: 'stale',
                     sentAt: T0 - 7 * 3600000, base: null };
    s.fs.disk[path] = JSON.stringify({ version: s.S.core.ledger.FILE_VERSION, entries: entries });
    var s2 = setup({ fs: s.fs, buildings: BUILDINGS, water: WATER, corn: CORN });
    s2.clock.now = T0;
    var txt = text(s2, 'render');
    assert.ok(/Grid 10: the rebuild was sent 420 min ago and the shell was never seen on its grid\. Check it in the game; Steward does not clear this for you\./.test(txt), txt);
});

t.test('summary text', function () {
    var s = setup();
    assert.strictEqual(s.S.modules.rebuild.summary(s.h), 'Deep Well · Wheatfield');
});

t.test('tile lines per state', function () {
    var s = setup({ buildings: BUILDINGS, water: WATER, corn: CORN });
    var tl = s.S.modules.rebuild.tiles(s.h);
    assert.strictEqual(tl.length, 1);
    assert.strictEqual(tl[0].title, 'Rebuild wells and fields');
    assert.deepStrictEqual(plain(tl[0].lines), ['2 exhausted', 'Deep Well · Wheatfield']);

    var none = setup({ buildings: [{ name: 'Well_03', grid: 12 }], water: WATER });
    assert.deepStrictEqual(plain(none.S.modules.rebuild.tiles(none.h)[0].lines),
        ['No exhausted wells or fields', 'Deep Well · Wheatfield']);

    var off = setup({ settings: { enabled: false } });
    assert.deepStrictEqual(plain(off.S.modules.rebuild.tiles(off.h)[0].lines),
        ['Off', 'Well · Wheatfield']);

    var away = setup({ buildings: BUILDINGS });
    away.gi.isOnHomzone = function () { return false; };
    assert.deepStrictEqual(plain(away.S.modules.rebuild.tiles(away.h)[0].lines),
        ['reading...', 'Deep Well · Wheatfield']);

    var brkS = setup({ buildings: BUILDINGS });
    var brk = brkS.S.core.ledger.breaker('rebuild');
    for (var i = 0; i < brk.MISSES; i++) brk.miss();
    assert.deepStrictEqual(plain(brkS.S.modules.rebuild.tiles(brkS.h)[0].lines),
        ['Paused by the breaker', 'Deep Well · Wheatfield']);
});

t.test('the surfaces queue nothing and write no ledger entry', function () {
    var s = setup({ buildings: BUILDINGS, water: WATER, corn: CORN });
    var queued = 0;
    var attempts = 0;
    s.S.kernel.queue.add = function () { queued++; };
    s.S.core.ledger.attempt = function () { attempts++; };
    build(s, 'side');
    build(s, 'render');
    s.S.modules.rebuild.tiles(s.h);
    assert.strictEqual(queued, 0);
    assert.strictEqual(attempts, 0);
});
