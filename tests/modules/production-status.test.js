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

    // The listing reads each queue once for all surfaces, never once per surface.
    Object.keys(b.w.counts.queue).forEach(function (k) {
        assert.strictEqual(b.w.counts.queue[k], 1, 'queue ' + k + ' was read ' + b.w.counts.queue[k] + ' times');
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
                    main: $main.text(),
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

t.test('a dashboard draw on the real model never calls queues() or buildings()', function () {
    var b = world();
    var n = { queues: 0, buildings: 0 };
    var q = b.P.model.queues, bl = b.P.model.buildings;
    b.P.model.queues = function () { n.queues++; return q.apply(this, arguments); };
    b.P.model.buildings = function () { n.buildings++; return bl.apply(this, arguments); };
    b.S.kernel.hostRead.pass(function () {
        b.P.summary(b.h);
        build(b, 'side');
        build(b, 'render');
        b.P.tiles(b.h);
    });
    assert.strictEqual(n.queues, 0);
    assert.strictEqual(n.buildings, 0);
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


t.test('views never read the last pass or onOffCounts themselves', function () {
    var dir = path.join(__dirname, '..', '..', 'src', 'modules', 'production');
    ['ui.js', 'window.js', 'views.js'].forEach(function (f) {
        var src = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.ok(!/onOffCounts/.test(src), f + ' calls onOffCounts');
        var calls = src.match(/lastPass\(/g) || [];
        assert.strictEqual(calls.length, 0, f + ' has ' + calls.length + ' lastPass( calls');
    });
});

// ---- one listing rule on the manager table and the Queues tab ----

// A Bakery (timed type 3) whose one item needs an event that has not started,
// so it is unproducible; Culture (type 20) is the cooldown Concert Hall.
function listWorld(opts) {
    opts = opts || {};
    var w = PS.world({
        enumNames: { 1: 'provisionhouse', 20: 'culturebuilding' },
        queues: { 3: opts.bakery || [], 20: opts.culture || [] },
        timed: { 3: [{ name: 'Cake', yield: 1, costs: [{ name_string: 'Wheat', amount: 3 }],
            requiresEvent: 'Halloween' }] },
        buildings: [{ name: 'Bakery', type: 3 }, { name: 'Culture', type: 20 }]
    });
    var H = harness.boot({ host: { swmmo: w.swmmo } });
    PS.install(H, w);
    jq.install(H);
    H.settings.write('production', { enabled: true });
    var S = H.Steward;
    S.core.deposits.types = function () { return []; };
    S.core.buildings.invalidate();
    if (opts.saved) {
        S.modules.production.readSettings = function () {
            return { enabled: true, buildings: { Bakery: { item: 'Cake', items: 1, buff: '', enabled: true } } };
        };
    }
    w.reset();
    var b = { H: H, S: S, w: w, P: S.modules.production, h: S.kernel.ui.helpers };
    b.rig = hostStubs.installModal(H);
    S.kernel.ui.ensureStyle = function () {};
    S.kernel.ui.releaseDashboard = function () {};
    H.ctx.Modal.prototype.show = function () {};
    return b;
}

function windowBody(b) {
    b.P.window.open();
    return b.rig.made[b.rig.made.length - 1].modal.Body();
}

function buttonText(b, $root, prefix) {
    var $ = b.H.ctx.$;
    var hit = null;
    $root.find('button').each(function () {
        if (hit === null && $(this).text().indexOf(prefix) === 0) hit = $(this);
    });
    return hit;
}

function clickButton(b, $root, prefix) {
    var hit = buttonText(b, $root, prefix);
    assert.ok(hit, 'button "' + prefix + '" exists');
    hit.trigger('click');
}

// Both surfaces of one window: the manager table's building labels, then the
// Queues tab text and its chip.
function surfaces(b) {
    var $ = b.H.ctx.$;
    var $body = windowBody(b);
    var labels = [];
    $body.find('tr').each(function () {
        var $td = $(this).find('td').eq(0);
        if ($td.length && $td.find('b').length) labels.push($td.find('b').eq(0).text());
    });
    var chip = buttonText(b, $body, 'Queues ').text();
    clickButton(b, $body, 'Queues ');
    return { manager: labels, queuesText: $body.text(), chip: chip };
}

function listed(list, label) { return list.indexOf(label) !== -1; }

t.test('a Concert Hall with entries is on neither the manager table nor the Queues tab', function () {
    var b = listWorld({ culture: [qe('Show')] });
    var bui = b.S.core.locale.bui;
    var s = surfaces(b);
    assert.ok(!listed(s.manager, bui('Culture')), s.manager.join(','));
    assert.ok(s.queuesText.indexOf(bui('Culture')) < 0, s.queuesText);
});

t.test('an all-unproducible building with an empty queue is on neither surface', function () {
    var b = listWorld();
    var bui = b.S.core.locale.bui;
    var s = surfaces(b);
    assert.ok(!listed(s.manager, bui('Bakery')), s.manager.join(','));
    assert.ok(s.queuesText.indexOf(bui('Bakery')) < 0, s.queuesText);
});

t.test('a busy all-unproducible building is on the Queues tab and its chip, not the manager table', function () {
    var b = listWorld({ bakery: [qe('Cake')] });
    var bui = b.S.core.locale.bui;
    var s = surfaces(b);
    assert.ok(!listed(s.manager, bui('Bakery')), s.manager.join(','));
    assert.ok(s.queuesText.indexOf(bui('Bakery')) >= 0, s.queuesText);
    assert.strictEqual(s.chip, 'Queues 1');
});

t.test('a saved row keeps its building on both surfaces', function () {
    var b = listWorld({ saved: true });
    var bui = b.S.core.locale.bui;
    var s = surfaces(b);
    assert.ok(listed(s.manager, bui('Bakery')), s.manager.join(','));
    assert.ok(s.queuesText.indexOf(bui('Bakery')) >= 0, s.queuesText);
});

t.test('the window, dashboard tab, tile and submenu texts have no Standing and no Demand', function () {
    var b = world();
    var rig = hostStubs.installModal(b.H);
    b.S.kernel.ui.ensureStyle = function () {};
    b.S.kernel.ui.releaseDashboard = function () {};
    b.H.ctx.Modal.prototype.show = function () {};
    b.P.window.open();
    var $body = rig.made[rig.made.length - 1].modal.Body();
    var texts = [$body.text()];
    ['Queues ', 'Settings'].forEach(function (p) {
        clickButton(b, $body, p);
        texts.push($body.text());
    });
    texts.push(build(b, 'side').text(), build(b, 'render').text(), b.P.summary(b.h));
    b.P.tiles(b.h).forEach(function (tile) {
        texts.push(tile.title || '', tile.lines.join('|'), tile.badge ? tile.badge.text : '');
    });
    b.P.menu.items().forEach(function (it) {
        texts.push(typeof it.label === 'function' ? it.label({}) : String(it.label || ''));
    });
    texts.forEach(function (x) {
        assert.ok(!/Standing|Demand/.test(x), x);
    });
});
