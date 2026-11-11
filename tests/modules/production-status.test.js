'use strict';

// One status value on every surface. The real model runs on the counting host
// stub; after the first status read the world changes, and every passive
// surface (dashboard strip and card, summary, tile, submenu label) must still
// show the first read, so two surfaces can never disagree about a count.

var fs = require('fs');
var path = require('path');
var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');
var hostStubs = require('../stubs/host');
var PS = require('../stubs/production');

var assert = t.assert;

var ENUMS = { 1: 'provisionhouse', 2: 'bookbinder', 6: 'fishhouse', 20: 'culturebuilding' };

function qe(item) {
    return { type: item, amount: 1, produced: 0, timeMs: 5000, collectedMs: 0, bonus: 1, producedItems: 0 };
}

// Counted queues: 1, 6 and 2 (cooldown 20 is left out); entries in 1 and 2.
// Production buildings: the four queue buildings, a buffed mine and a buffed
// sawmill (2 of 6 buffed); the fishhouse has no production settings.
function world() {
    var w = PS.world({
        enumNames: ENUMS,
        queues: { 1: [qe('Bread')], 6: [], 2: [qe('Tome')], 20: [] },
        buildings: [
            { name: 'ProvisionHouse', type: 1 },
            { name: 'Fishhouse', type: 6 },
            { name: 'Bookbinder', type: 2 },
            { name: 'Culture', type: 20 },
            { name: 'CopperMine', state: 0, buff: 'Mine_Buff' },
            { name: 'Sawmill', state: 0, buff: 'Saw_Buff' }
        ]
    });
    var H = harness.boot({ host: { swmmo: w.swmmo } });
    PS.install(H, w);
    jq.install(H);
    H.settings.write('production', { enabled: true });
    var S = H.Steward;
    S.core.deposits.types = function () { return []; };
    S.core.buildings.invalidate();
    return { H: H, S: S, w: w, P: S.modules.production, h: S.kernel.ui.helpers };
}

function build(b, part) {
    var $el = b.H.ctx.$('<div>');
    b.P[part]($el, b.h);
    return $el;
}

t.test('every passive surface shows the first status after the world changes', function () {
    var b = world();
    var first = b.P.model.status();
    assert.strictEqual(first.queues, 2);
    assert.strictEqual(first.types, 3);
    assert.strictEqual(first.buffed, 2);
    assert.strictEqual(first.buffable, 6);

    // The type-6 queue gains an entry, type 1 stops reading, a buff is removed.
    b.w.queues[6] = [qe('Fish')];
    var zone = b.H.host.game.gi.mCurrentPlayerZone;
    var base = zone.GetProductionQueue;
    zone.GetProductionQueue = function (type) {
        if (type !== 1) return base(type);
        return { mProductionType: 1, productionBuilding: {},
            get mTimedProductions_vector() { throw new Error('bridge'); } };
    };
    b.w.buildings[4].buff = null;
    b.w.reset();

    var $side = build(b, 'side');
    var $main = build(b, 'render');
    var stats = $main.find('.steward-stat');
    assert.strictEqual(stats.eq(0).find('.steward-stat-k').text(), 'Queues');
    assert.strictEqual(stats.eq(0).find('.steward-stat-v').text(), '2 of 3');
    assert.ok($side.text().indexOf('Queues running') < 0, 'the strip has no queue stat');
    assert.strictEqual($side.find('.steward-stat').eq(1).find('.steward-stat-v').text(), '2 of 6');
    assert.ok($main.text().indexOf('2 buildings buffed') >= 0, $main.text());

    var tiles = b.P.tiles(b.h);
    assert.strictEqual(tiles[0].lines[1].indexOf('2 queues'), 0, tiles[0].lines[1]);
    assert.strictEqual(typeof b.P.summary(b.h), 'string');

    var label = b.P.menu.items()[1].label({});
    assert.ok(label.indexOf('2 queues') === 0, label);

    // Only the card's Bookbinder line reads a queue (type 2), never the counted ones.
    Object.keys(b.w.counts.queue).forEach(function (k) {
        assert.strictEqual(k, '2', 'queue ' + k + ' was read by a surface');
    });
});

t.test('the window header and its Queues chip come from one fresh status', function () {
    var b = world();
    var rig = hostStubs.installModal(b.H);
    b.S.kernel.ui.ensureStyle = function () {};
    b.S.kernel.ui.releaseDashboard = function () {};
    b.H.ctx.Modal.prototype.show = function () {};
    b.P.window.open();
    var body = rig.made[rig.made.length - 1].modal.Body();
    var text = body.text();
    var m = /· (\d+) queues ·/.exec(text);
    assert.ok(m, text);
    assert.strictEqual(m[1], '2');
    var chip = null;
    var $ = b.H.ctx.$;
    body.find('button').each(function () {
        var s = $(this).text();
        if (s.indexOf('Queues ') === 0) chip = s;
    });
    assert.strictEqual(chip, 'Queues 2');
});

// Runs fn with Date.now answering from clock.at, restored after.
function atClock(clock, fn) {
    var real = Date.now;
    Date.now = function () { return clock.at; };
    try { return fn(); } finally { Date.now = real; }
}

t.test('one pass: summary, side, render and tiles share the first read', function () {
    var b = world();
    var clock = { at: new Date(2026, 0, 1, 12, 0, 0).getTime() };
    var seen = {};
    atClock(clock, function () {
        b.S.kernel.hostRead.pass(function () {
            var take = function (name) {
                var $side = build(b, 'side');
                var $main = build(b, 'render');
                seen[name] = {
                    side: $side.text(),
                    // The Bookbinder line is a countdown from the draw time.
                    main: $main.text().replace(/ · Bookbinder:.*?(Open production)/, '$1'),
                    tile: b.P.tiles(b.h)[0].lines.join('|'),
                    sum: b.P.summary(b.h)
                };
            };
            take('first');
            var queuesAfterFirst = JSON.stringify(b.w.counts.queue);
            // Past the 30 s max age, and the type-6 queue gains an entry.
            clock.at += 60000;
            b.w.queues[6] = [qe('Fish')];
            take('second');
            assert.strictEqual(JSON.stringify(b.w.counts.queue), queuesAfterFirst,
                'later parts of the pass read no queue again');
        });
    });
    assert.deepStrictEqual(seen.second, seen.first);
    assert.ok(seen.first.main.indexOf('2 of 3') >= 0, seen.first.main);
    assert.ok(seen.first.tile.indexOf('2 queues') >= 0, seen.first.tile);
});

t.test('Idle counts only standing rows: an adventure hold does not idle the tile', function () {
    var b = world();
    var D = b.S.DemandStatus;
    var rows = [
        { owner: 'production', status: D.Waiting },
        { owner: 'adventures', status: D.Held },
        { owner: 'production', status: D.Covered }
    ];
    b.P.lastPass = function () { return { at: 0, rows: rows }; };
    var tile = b.P.tiles(b.h)[0];
    assert.strictEqual(tile.badge.text, 'Running');
    rows[0] = { owner: 'production', status: D.Covered };
    tile = b.P.tiles(b.h)[0];
    assert.strictEqual(tile.badge.text, 'Idle');
});

t.test('Production now shows the read time of the host part, not the draw time', function () {
    var b = world();
    var clock = { at: new Date(2026, 0, 1, 12, 0, 50).getTime() };
    var $main;
    atClock(clock, function () {
        b.P.model.snapshot();
        clock.at = new Date(2026, 0, 1, 12, 1, 10).getTime();
        $main = build(b, 'render');
    });
    var read = 'read ' + b.h.clock(new Date(new Date(2026, 0, 1, 12, 0, 50).getTime()));
    var draw = 'read ' + b.h.clock(new Date(clock.at));
    assert.notStrictEqual(read, draw);
    assert.ok($main.text().indexOf(read) >= 0, $main.text());
    assert.ok($main.text().indexOf(draw) < 0, $main.text());
});

t.test('no view counts queues or entries itself', function () {
    var dir = path.join(__dirname, '..', '..', 'src', 'modules', 'production');
    ['ui.js', 'menu.js', 'window.js', 'views.js'].forEach(function (f) {
        var src = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.ok(!/P\(\)\.entries\(/.test(src), f + ' calls entries(');
        assert.ok(!/queueTypes\(/.test(src), f + ' calls queueTypes(');
    });
});

t.test('views read last-pass rows only through ui.js lastRows, and never onOffCounts', function () {
    var dir = path.join(__dirname, '..', '..', 'src', 'modules', 'production');
    ['ui.js', 'window.js', 'views.js'].forEach(function (f) {
        var src = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.ok(!/onOffCounts/.test(src), f + ' calls onOffCounts');
        var calls = src.match(/lastPass\(/g) || [];
        assert.strictEqual(calls.length, f === 'ui.js' ? 1 : 0, f + ' has ' + calls.length + ' lastPass( calls');
    });
    var ui = fs.readFileSync(path.join(dir, 'ui.js'), 'utf8');
    var fn = /function lastRows\(\) \{[\s\S]*?\n    \}/.exec(ui);
    assert.ok(fn && /lastPass\(/.test(fn[0]), 'the one lastPass( call is in lastRows');
});
