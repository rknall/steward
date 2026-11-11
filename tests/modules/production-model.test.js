'use strict';

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

// A booted steward whose building list is a small world of stub buildings.
function setup(list, home) {
    var H = harness.boot();
    var S = H.Steward;
    S.core.zone.isHome = function () { return home !== false; };
    S.core.buildings.list = function () { return list; };
    S.core.buildings.name = function (b) { return b.name; };
    S.core.buildings.grid = function (b) { return b.grid; };
    S.core.deposits.types = function () {
        return [{ mineName: 'CopperMine', masonName: 'CopperMason' }];
    };
    return S;
}

function bld(name, grid, active, state) {
    return {
        name: name,
        grid: grid,
        IsProductionActive: function () { return active; },
        GetResourceCreation: function () {
            return { GetProductionState: function () { return state; } };
        }
    };
}

function names(rows) {
    return rows.map(function (r) { return r.name; });
}

t.test('onOff lists a switched-off building with active false', function () {
    var S = setup([bld('Bakery', 1, false, 0)]);
    var rows = S.modules.production.model.onOff().rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].active, false);
});

t.test('onOff lists an active building whose input is missing', function () {
    var S = setup([bld('Bakery', 1, true, 1)]);
    assert.equal(names(S.modules.production.model.onOff().rows).join(','), 'Bakery');
});

t.test('onOff skips an active building that is producing', function () {
    var S = setup([bld('Bakery', 1, true, 0)]);
    assert.equal(S.modules.production.model.onOff().rows.length, 0);
});

t.test('onOff skips a non-boolean active read in state 0', function () {
    var S = setup([bld('Bakery', 1, 0, 0)]);
    assert.equal(S.modules.production.model.onOff().rows.length, 0);
});

t.test('a mine is flagged mining and counted as miningOwned', function () {
    var S = setup([bld('CopperMine', 2, false, 0), bld('Bakery', 1, false, 0)]);
    var m = S.modules.production.model;
    var scan = m.onOff();
    assert.equal(scan.rows[0].mining, true);
    assert.equal(scan.rows[1].mining, false);
    assert.equal(scan.counts.stopped, 2);
    assert.equal(scan.counts.miningOwned, 1);
    assert.equal(m.onOffCounts, undefined);
});

t.test('onOff caps the rows, counts every stopped building and scans once', function () {
    var list = [];
    for (var i = 0; i < 205; i++) list.push(bld('Bakery', i, false, 0));
    var S = setup(list);
    var reads = 0;
    S.core.buildings.list = function () { reads++; return list; };
    var scan = S.modules.production.model.onOff();
    assert.equal(scan.rows.length, 200);
    assert.equal(scan.counts.stopped, 205);
    assert.equal(scan.counts.miningOwned, 0);
    assert.equal(reads, 1);
});

t.test('off the home zone the rows are empty', function () {
    var S = setup([bld('Bakery', 1, false, 0)], false);
    assert.equal(S.modules.production.model.onOff().rows.length, 0);
});

// ---- status, snapshot, counted queues and grouping on the counting stub ----

var PS = require('../stubs/production');

var ENUMS = { 1: 'provisionhouse', 2: 'bookbinder', 6: 'fishhouse', 11: 'winery', 20: 'culturebuilding' };

function qe(item, amount, timeMs) {
    return { type: item, amount: amount, produced: 0, timeMs: timeMs, collectedMs: 0, bonus: 1, producedItems: 0 };
}

function logLines(b, text) {
    return b.H.logs().filter(function (l) {
        return l.category === 'production' && String(l.args[0]).indexOf(text) !== -1;
    });
}

// A booted steward (all sections) on the shared production stub. Each
// building fake's productionBuff is a getter that counts its reads in
// buffReads[name] and follows the spec's buff live, so a test can change a
// running buff without a new building list.
function world(opts) {
    opts = opts || {};
    if (!opts.enumNames) opts.enumNames = ENUMS;
    var w = PS.world(opts);
    var H = harness.boot({ host: { swmmo: w.swmmo } });
    PS.install(H, w);
    var S = H.Steward;
    S.core.deposits.types = function () {
        return [{ mineName: 'CopperMine', masonName: 'CopperMason' }];
    };
    var reads = {};
    var sdm = H.host.game.gi.mCurrentPlayerZone.mStreetDataMap;
    var base = sdm.GetBuildings_vector;
    sdm.GetBuildings_vector = function () {
        var vec = base();
        vec.forEach(function (fake, i) {
            var spec = w.buildings[i];
            reads[spec.name] = reads[spec.name] || 0;
            Object.defineProperty(fake, 'productionBuff', {
                configurable: true,
                enumerable: true,
                get: function () {
                    reads[spec.name]++;
                    if (!spec.buff) return null;
                    return { GetBuffDefinition: function () {
                        return { GetName_string: function () { return spec.buff; } };
                    } };
                }
            });
        });
        return vec;
    };
    S.core.buildings.invalidate();
    w.reset();
    return { H: H, S: S, m: S.modules.production.model, w: w, buffReads: reads };
}

function countedWorld() {
    return world({
        queues: { 1: [qe('Bread', 1, 5000)], 6: [], 20: [], 40: [] },
        buildings: [
            { name: 'ProvisionHouse', type: 1 },
            { name: 'Fishhouse', type: 6 },
            { name: 'Culture', type: 20 },
            { name: 'CopperMine', type: 40 },
            { name: 'Winery', type: 11 }
        ]
    });
}

t.test('status reads the building vector at most twice and each queue at most once', function () {
    var b = countedWorld();
    b.m.status();
    assert.ok(b.w.counts.zoneBuildings <= 2, 'zoneBuildings ' + b.w.counts.zoneBuildings);
    Object.keys(b.w.counts.queue).forEach(function (type) {
        assert.ok(b.w.counts.queue[type] <= 1, 'queue[' + type + '] ' + b.w.counts.queue[type]);
    });
});

t.test('status(30000) right after status() reads nothing; status() reads fresh', function () {
    var b = countedWorld();
    b.m.status();
    b.S.core.buildings.invalidate();
    b.w.reset();
    b.m.status(30000);
    var snap = b.m.snapshot();
    assert.equal(Object.keys(b.w.counts.queue).length, 0);
    assert.equal(b.w.counts.zoneBuildings, 0);
    assert.equal(snap.types, 2);
    assert.equal(b.m.SNAPSHOT_MAX_AGE_MS, 30000);
    b.m.status();
    assert.ok(b.w.counts.queue[1] >= 1);
});

t.test('counted queues leave out cooldown, mining and no-queue types', function () {
    var b = countedWorld();
    var s = b.m.status();
    assert.equal(s.types, 2);
    assert.equal(s.queues, 1);
    assert.equal(s.unreadable, 0);
    assert.equal(s.entries, 1);
    var lines = logLines(b, 'queue count leaves out');
    assert.equal(lines.length, 1);
    var text = String(lines[0].args[0]);
    assert.ok(text.indexOf('40 (mining)') !== -1, text);
    assert.ok(text.indexOf('20 (cooldown)') !== -1, text);
    assert.ok(text.indexOf('11 (no queue)') !== -1, text);
    b.m.status();
    assert.equal(logLines(b, 'queue count leaves out').length, 1, 'an unchanged set logs once');
});

t.test('an unreadable entries vector counts as unreadable, not running', function () {
    var b = countedWorld();
    var zone = b.H.host.game.gi.mCurrentPlayerZone;
    var base = zone.GetProductionQueue;
    zone.GetProductionQueue = function (type) {
        if (type !== 6) return base(type);
        return { mProductionType: 6, productionBuilding: {},
            get mTimedProductions_vector() { throw new Error('bridge'); } };
    };
    var s = b.m.status();
    assert.equal(s.types, 2);
    assert.equal(s.queues, 1);
    assert.equal(s.unreadable, 1);
});

t.test('nextDoneAt and nextItem come from the earliest head', function () {
    var b = world({
        queues: { 1: [qe('Bread', 1, 5000), qe('Bread', 1, 100)], 6: [qe('Fish', 1, 2000)] },
        buildings: [{ name: 'ProvisionHouse', type: 1 }, { name: 'Fishhouse', type: 6 }]
    });
    var before = Date.now();
    var s = b.m.status();
    assert.equal(s.nextItem, 'Fish');
    assert.ok(s.nextDoneAt >= before + 2000 && s.nextDoneAt <= Date.now() + 2000, String(s.nextDoneAt));
    assert.equal(s.entries, 3);
    assert.equal(s.queues, 2);
});

function buffWorld() {
    return world({
        queues: { 1: [], 3: [] },
        buildings: [
            { name: 'ProvisionHouse', type: 1, buff: 'Fish_Buff' },
            { name: 'Bakery', type: 3 },
            { name: 'CopperMine', state: 0, buff: 'Mine_Buff' },
            { name: 'Sawmill', state: 0, buff: 'Saw_Buff' },
            { name: 'Decoration' }
        ]
    });
}

t.test('buildings buffed counts every production building island-wide', function () {
    var b = buffWorld();
    var s = b.m.status();
    assert.equal(s.buffed, 3);
    assert.equal(s.buffable, 4);
    assert.ok(b.w.counts.zoneBuildings <= 2, 'zoneBuildings ' + b.w.counts.zoneBuildings);
    ['ProvisionHouse', 'Bakery', 'CopperMine', 'Sawmill'].forEach(function (n) {
        assert.equal(b.buffReads[n], 1, n + ' productionBuff reads');
    });
});

t.test('the buffed figure comes from the cached host part', function () {
    var b = buffWorld();
    b.m.status();
    b.w.buildings[2].buff = null;
    assert.equal(b.m.status(30000).buffed, 3);
    assert.equal(b.m.status().buffed, 2);
});

t.test('buildings buffed is 0 of 0 off the home zone', function () {
    var b = buffWorld();
    b.w.home = false;
    var s = b.m.status();
    assert.equal(s.buffed, 0);
    assert.equal(s.buffable, 0);
});

function rowCounts(fishNames) {
    var bs = [{ name: 'ProvisionHouse', type: 1 }, { name: 'ProvisionHouse2', type: 1 }];
    for (var i = 0; i < fishNames; i++) bs.push({ name: 'Fish' + i, type: 6 });
    var map = {};
    for (var d = 0; d < 10; d++) map['BB_' + d] = { target: 'Fish0', group: '', type: 0 };
    var b = world({
        buffs: PS.buffDefs(200, ['3', '5', '11']),
        buffMap: map,
        star: [{ type: 'BB_1', amount: 2 }],
        queues: { 1: [], 6: [] },
        buildings: bs
    });
    var rows = b.m.buildings();
    assert.equal(rows.length, 2 + fishNames);
    return b.w.counts;
}

t.test('buildings() host reads do not grow with the rows', function () {
    var a = rowCounts(6);
    var c = rowCounts(12);
    [a, c].forEach(function (k) {
        assert.ok(k.buffVector <= 1, 'buffVector ' + k.buffVector);
        assert.ok(k.buffName <= 200, 'buffName ' + k.buffName);
        assert.ok(k.targetDesc <= 10, 'targetDesc ' + k.targetDesc);
        assert.ok(k.starMenu <= 1, 'starMenu ' + k.starMenu);
        assert.ok(k.zoneBuildings <= 2, 'zoneBuildings ' + k.zoneBuildings);
    });
    ['buffVector', 'buffName', 'targetDesc', 'starMenu', 'zoneBuildings'].forEach(function (f) {
        assert.equal(c[f], a[f], f + ' differs between 8 and 14 rows');
    });
});

t.test('queue rows carry lines beside entries', function () {
    var b = world({
        queues: { 1: [qe('Bread', 5, 100), qe('Bread', 3, 100), qe('Bread', 3, 100)] },
        buildings: [{ name: 'ProvisionHouse', type: 1 }]
    });
    var q = b.m.queues()[0];
    assert.equal(q.entries.length, 3);
    assert.equal(q.lines.length, 2);
    assert.equal(q.lines[1].repeat, 2);
});

// ---- groupEntries (pure) ----

function ge(item, amount, rem, finished) {
    return { item: item, amount: amount, produced: 1, remainingMs: rem, finished: !!finished,
             timeMs: 10, bonus: 1, producedItems: 7 };
}

function shape(lines) {
    return lines.map(function (l) {
        return l.repeat > 1 ? l.repeat + 'x' + l.amount : String(l.amount);
    }).join(',');
}

function grouper() {
    return harness.boot().Steward.modules.production.model.groupEntries;
}

t.test('groupEntries merges neighbours after the head only', function () {
    var g = grouper();
    assert.equal(shape(g([ge('A', 5, 1), ge('A', 3, 1), ge('A', 3, 1)])), '5,2x3');
    assert.equal(shape(g([ge('A', 3, 1), ge('A', 5, 1), ge('A', 3, 1)])), '3,5,3');
    assert.equal(shape(g([ge('A', 3, 1), ge('A', 3, 1)])), '3,3');
    assert.equal(shape(g([ge('A', 4, 1), ge('A', 3, 1), ge('A', 3, 1), ge('A', 3, 1)])), '4,3x3');
    assert.equal(shape(g([ge('A', 4, 1), ge('A', 3, 1), ge('B', 3, 1), ge('A', 3, 1)])), '4,3,3,3');
    assert.equal(g(null), null);
});

t.test('groupEntries sums a group and nulls a partial time', function () {
    var g = grouper();
    var l = g([ge('A', 4, 1), ge('A', 3, 100), ge('A', 3, 250, true)])[1];
    assert.equal(l.repeat, 2);
    assert.equal(l.total, 6);
    assert.equal(l.remainingMs, 350);
    assert.equal(l.produced, 2);
    assert.equal(l.finished, false);
    assert.equal(l.timeMs, 10);
    assert.equal(l.producedItems, null);
    assert.equal(l.entries.length, 2);
    var n = g([ge('A', 4, 1), ge('A', 3, 100), ge('A', 3, null)])[1];
    assert.equal(n.remainingMs, null);
    var single = g([ge('A', 4, 9)])[0];
    assert.equal(single.repeat, 1);
    assert.equal(single.total, 4);
    assert.equal(single.remainingMs, 9);
    assert.equal(single.producedItems, 7);
});

// ---- round 6: status shape, snapshot memo, scope from queueNames ----

// Runs fn with Date.now fixed to the value clock.at holds, restored after.
function atClock(clock, fn) {
    var real = Date.now;
    Date.now = function () { return clock.at; };
    try { return fn(); } finally { Date.now = real; }
}

t.test('standingCovered and standingHeld count only own rows', function () {
    var b = countedWorld();
    var D = b.S.DemandStatus;
    b.S.modules.production.lastPass = function () {
        return { at: 1, rows: [
            { owner: 'production', status: D.Waiting },
            { owner: 'adventures', status: D.Held },
            { owner: 'other', status: D.Covered }
        ] };
    };
    var s = b.m.status();
    assert.equal(s.standing, 1);
    assert.equal(s.standingCovered, 0);
    assert.equal(s.standingHeld, 0);
    assert.equal(s.covered, 1);
    assert.equal(s.held, 1);
    assert.equal(s.waiting, 1);
});

t.test('readAt is when the host part was read', function () {
    var b = countedWorld();
    var clock = { at: 1000000 };
    atClock(clock, function () {
        assert.equal(b.m.status().readAt, 1000000);
        clock.at += 10000;
        assert.equal(b.m.status(30000).readAt, 1000000);
        assert.equal(b.m.status().readAt, 1010000);
    });
    assert.equal(b.m.emptyStatus().readAt, null);
});

t.test('readAt is null before any host part was read', function () {
    var b = countedWorld();
    b.S.core.production.queueTypes = function () { throw new Error('bridge'); };
    b.S.modules.production.queueNames = function () { throw new Error('bridge'); };
    var real = b.S.kernel.hostRead.pass;
    b.S.kernel.hostRead.pass = function () { throw new Error('bridge'); };
    var s;
    try { s = b.m.status(); } finally { b.S.kernel.hostRead.pass = real; }
    assert.equal(s.readAt, null);
    assert.equal(s.types, 0);
});

t.test('emptyStatus has the same fields as status', function () {
    var b = countedWorld();
    var e = b.m.emptyStatus();
    assert.deepEqual(Object.keys(e).sort(), Object.keys(b.m.status()).sort());
    assert.equal(e.enabled, false);
    assert.equal(e.types, 0);
    assert.equal(e.standingCovered, 0);
    assert.equal(e.orderBreaker, null);
    assert.equal(e.buffBreaker, null);
});

t.test('snapshot is one object per read pass, fresh outside one', function () {
    var b = countedWorld();
    var clock = { at: 2000000 };
    atClock(clock, function () {
        var pair = b.S.kernel.hostRead.pass(function () {
            var first = b.m.snapshot();
            clock.at += 40000;
            return [first, b.m.snapshot()];
        });
        assert.ok(pair[0] === pair[1], 'same object inside one pass');
        assert.equal(pair[0].readAt, 2000000);
        var a = b.m.snapshot();
        clock.at += 40000;
        var c = b.m.snapshot();
        assert.ok(a !== c, 'a new object outside a pass');
        assert.equal(c.readAt, 2080000, 'the part is read fresh past the max age');
    });
});

t.test('scope and building rows follow queueNames', function () {
    var b = countedWorld();
    var P = b.S.modules.production;
    var real = P.queueNames;
    var full = b.m.status();
    assert.equal(full.types, 2);
    P.queueNames = function () { return { ProvisionHouse: 1 }; };
    var s = b.m.status();
    assert.equal(s.types, 1);
    assert.equal(names(b.m.buildings()).join(','), 'ProvisionHouse');
    var qs = b.m.queues();
    assert.equal(qs.length, 1);
    assert.equal(qs[0].type, 1);
    P.queueNames = real;
    assert.equal(b.m.status().types, 2);
});

t.test('scope and building rows never call ownedByMining; onOff does', function () {
    var b = world({
        enumNames: ENUMS,
        queues: { 1: [qe('Bread', 1, 5000)], 6: [], 40: [] },
        buildings: [
            { name: 'ProvisionHouse', type: 1 },
            { name: 'Fishhouse', type: 6, active: false },
            { name: 'CopperMine', type: 40 }
        ]
    });
    var P = b.S.modules.production;
    var real = P.ownedByMining;
    var calls = 0;
    P.ownedByMining = function (n) { calls++; return real(n); };
    b.m.status();
    b.m.queues();
    var rows = b.m.buildings();
    assert.equal(calls, 0, 'status, queues and buildings');
    assert.equal(names(rows).join(','), 'ProvisionHouse,Fishhouse');
    var scan = b.m.onOff();
    assert.ok(calls >= 1, 'onOff reads the mining flag');
    assert.equal(scan.counts.stopped, 1);
});
