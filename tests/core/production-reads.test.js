'use strict';

// Host-read counts of the core production readers: the buff list is read once
// and each definition's name and group once, members are read once per call,
// a failed entries read is retried once, and the readers memoize only inside
// a read pass.

var t = require('../runner');
var harness = require('../harness');
var PS = require('../stubs/production');

var assert = t.assert;

var ENUMS = { 1: 'provisionhouse', 2: 'bookbinder', 6: 'fishhouse', 11: 'winery' };

function setup(opts) {
    opts = opts || {};
    if (!opts.enumNames) opts.enumNames = ENUMS;
    var w = PS.world(opts);
    var H = harness.boot({ sections: ['kernel', 'core'], host: { swmmo: w.swmmo } });
    var sent = PS.install(H, w);
    w.reset();
    return { H: H, S: H.Steward, P: H.Steward.core.production, w: w, sent: sent };
}

function names(list) {
    return list.map(function (x) { return x.name; }).join(',');
}

function logsWith(b, text) {
    return b.H.logs().filter(function (l) {
        return l.category === 'production' && String(l.args[0]).indexOf(text) !== -1;
    });
}

// Replaces the queue of one type with a fixed vector of entry objects, so a
// test can give an entry members that change between reads.
function fixedQueue(b, type, vec) {
    var zone = b.H.host.game.gi.mCurrentPlayerZone;
    var base = zone.GetProductionQueue;
    zone.GetProductionQueue = function (t2) {
        if (t2 !== type) return base(t2);
        b.w.counts.queue[t2] = (b.w.counts.queue[t2] || 0) + 1;
        return { mProductionType: type, productionBuilding: { GetGrid: function () { return 1001; } },
            mTimedProductions_vector: vec };
    };
}

function entry(type, amount) {
    return {
        GetType_string:    function () { return type; },
        GetProducedItems:  function () { return 0; },
        GetProductionTime: function () { return 1000; },
        GetCollectedTime:  function () { return 0; },
        GetProductionOrder: function () {
            return { GetTimeBonus: function () { return 1; }, GetProductionVO: function () { return { producedItems: 0 }; } };
        }
    };
}

function flakyEntry(type, amount) {
    var e = entry(type, amount);
    return PS.flaky(e, 'GetAmount', function () { return amount; });
}

function passReads(n) {
    var b = setup({ buffs: PS.buffDefs(n, ['3', '5', '11']) });
    b.S.kernel.hostRead.pass(function () {
        b.P.itemsOf(1);
        b.P.itemsOf(6);
        b.P.itemsOf(11);
        b.P.queueIdFor('BB_3');
        b.P.yieldOf('BB_3');
        b.P.costs('BB_3');
    });
    return b.w.counts;
}

t.test('itemsOf(1) with 200 defs reads the list once and each name and group at most once', function () {
    var b = setup({ buffs: PS.buffDefs(200, ['3', '5', '11']) });
    var items = b.P.itemsOf(1);
    assert.strictEqual(b.w.counts.buffVector, 1);
    assert.ok(b.w.counts.buffName <= 200, 'buffName ' + b.w.counts.buffName);
    assert.ok(b.w.counts.buffGroup <= 200, 'buffGroup ' + b.w.counts.buffGroup);
    var want = [];
    for (var i = 0; i < 200; i += 3) want.push('BB_' + i);
    assert.strictEqual(names(items), want.join(','));
});

// Every def has a recipe lock, so each one costs a requirement call.
function lockAll(n) {
    var req = {};
    for (var i = 0; i < n; i++) req['BB_' + i] = true;
    return req;
}

t.test('itemsOf(1) checks each def at most once and reads the skills once per pass', function () {
    var b = setup({ buffs: PS.buffDefs(200, ['3', '5', '11']), requirements: lockAll(200) });
    var items;
    b.S.kernel.hostRead.pass(function () {
        items = b.P.itemsOf(1);
        assert.strictEqual(b.w.counts.buffVector, 1);
        assert.ok(b.w.counts.buffName <= 200, 'buffName ' + b.w.counts.buffName);
        assert.ok(b.w.counts.buffGroup <= 200, 'buffGroup ' + b.w.counts.buffGroup);
        assert.ok(b.w.counts.adventure <= items.length, 'adventure ' + b.w.counts.adventure);
        assert.ok(b.w.counts.requirement <= items.length, 'requirement ' + b.w.counts.requirement);
        assert.ok(b.w.counts.adventure > 0, 'adventure counted');
        assert.strictEqual(b.w.counts.skills, 1);

        var before = JSON.stringify(b.w.counts);
        b.P.itemsOf(1);
        assert.strictEqual(JSON.stringify(b.w.counts), before, 'a second itemsOf in the pass is free');
    });
    assert.strictEqual(items.length, 67);
    assert.strictEqual(items[0].producible, true);
});

t.test('isProducible in a fresh pass checks only its own item', function () {
    var b = setup({ buffs: PS.buffDefs(200, ['3']), requirements: lockAll(200) });
    b.S.kernel.hostRead.pass(function () {
        assert.strictEqual(b.P.isProducible(1, 'BB_42'), true);
    });
    assert.ok(b.w.counts.adventure <= 1, 'adventure ' + b.w.counts.adventure);
    assert.ok(b.w.counts.requirement <= 1, 'requirement ' + b.w.counts.requirement);
    assert.ok(b.w.counts.skills <= 1, 'skills ' + b.w.counts.skills);
});

t.test('one pass over every buff reader reads the list once', function () {
    var c = passReads(200);
    assert.strictEqual(c.buffVector, 1);
    assert.ok(c.buffName <= 200, 'buffName ' + c.buffName);
});

t.test('buff name reads grow linearly with the definition count', function () {
    var c100 = passReads(100).buffName;
    var c200 = passReads(200).buffName;
    assert.ok(c100 > 0, 'buffName counted');
    assert.ok(c200 <= 2 * c100, '200 defs: ' + c200 + ', 100 defs: ' + c100);
});

t.test('a def whose name throws and a def without a name are skipped', function () {
    var b = setup({ buffs: PS.buffDefs(4, ['3']) });
    var base = b.H.host.game.def('BuffSystem::cBuff');
    var orig = base.GetProduceableBuffDefinitions;
    b.sent.registerDef('BuffSystem::cBuff', {
        GetProduceableBuffDefinitions: function (gi) {
            var list = orig.call(base, gi);
            list.push({ GetName_string: function () { throw new Error('bridge'); }, GetGroup_string: function () { return '3'; } });
            list.push({ GetGroup_string: function () { return '3'; } });
            return list;
        }
    });
    b.H.clearLogs();
    var items = b.P.itemsOf(1);
    assert.ok(items !== null, 'itemsOf is not null');
    assert.strictEqual(names(items), 'BB_0,BB_1,BB_2,BB_3');
    var lines = logsWith(b, 'unreadable - skipped');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].level, 'debug');
    assert.strictEqual(String(lines[0].args[0]).indexOf('2 '), 0);
});

t.test('a flaky GetAmount is read once by entries and once by queuedIn', function () {
    var b = setup({ buffs: PS.buffDefs(2, ['3']) });
    var e1 = flakyEntry('BB_0', 4);
    fixedQueue(b, 1, [e1]);
    var list = b.P.entries(1);
    assert.ok(list !== null, 'entries read');
    assert.strictEqual(list[0].amount, 4);
    assert.strictEqual(e1.__reads.GetAmount, 1);

    var e2 = flakyEntry('BB_0', 5);
    fixedQueue(b, 1, [e2]);
    assert.strictEqual(b.P.queuedIn(1, 'BB_0'), 5);
    assert.strictEqual(e2.__reads.GetAmount, 1);
});

t.test('an entry that throws on the first read only is recovered on retry', function () {
    var b = setup({ buffs: PS.buffDefs(2, ['3']) });
    var reads = 0;
    var e = entry('BB_0', 3);
    e.GetAmount = function () { return 3; };
    e.GetType_string = function () {
        reads++;
        if (reads === 1) throw new Error('bridge');
        return 'BB_0';
    };
    fixedQueue(b, 1, [e]);
    b.H.clearLogs();
    var list = b.P.entries(1);
    assert.ok(list !== null, 'entries recovered');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].item, 'BB_0');
    assert.strictEqual(logsWith(b, 'recovered on retry').length, 1);
    assert.strictEqual(logsWith(b, 'threw').length, 0);
});

t.test('an entry unreadable on both reads gives null and one debug line per type', function () {
    var b = setup({ buffs: PS.buffDefs(2, ['3']) });
    var e = entry('BB_0', 3);
    fixedQueue(b, 1, [e]);
    b.H.clearLogs();
    assert.strictEqual(b.P.entries(1), null);
    assert.strictEqual(b.P.entries(1), null);
    var lines = logsWith(b, 'has an unreadable entry');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].level, 'debug');
});

t.test('in one pass the queue and the building list are read once', function () {
    var b = setup({
        buffs: PS.buffDefs(2, ['3']),
        queues: { 1: [{ type: 'BB_0', amount: 2, produced: 0, timeMs: 1000, collectedMs: 0, bonus: 1, producedItems: 0 }] },
        buildings: [{ name: 'ProvisionHouse', grid: 5, level: 3, type: 1 }]
    });
    b.S.kernel.hostRead.pass(function () {
        b.P.queueTypes();
        b.P.queueTypes();
        assert.ok(b.P.entries(1) !== null, 'entries read');
        b.P.entries(1);
        b.P.remainingMs(1);
        b.P.cooldownMs(1);
    });
    assert.ok(b.w.counts.zoneBuildings <= 1, 'zoneBuildings ' + b.w.counts.zoneBuildings);
    assert.strictEqual(b.w.counts.queue[1], 1);
});

t.test('outside a pass entries reads the queue every time', function () {
    var b = setup({
        buffs: PS.buffDefs(2, ['3']),
        queues: { 1: [{ type: 'BB_0', amount: 2, produced: 0, timeMs: 1000, collectedMs: 0, bonus: 1, producedItems: 0 }] }
    });
    b.P.entries(1);
    b.P.entries(1);
    assert.strictEqual(b.w.counts.queue[1], 2);
});

t.test('the readers never open a pass and order verification stays live', function () {
    var b = setup({
        buffs: PS.buffDefs(2, ['3']),
        queues: { 1: [{ type: 'BB_0', amount: 2, produced: 0, timeMs: 1000, collectedMs: 0, bonus: 1, producedItems: 0 }] },
        buildings: [{ name: 'ProvisionHouse', grid: 5, level: 3, type: 1 }]
    });
    var hr = b.S.kernel.hostRead;
    b.P.itemsOf(1);
    assert.strictEqual(hr.inPass(), false);
    b.P.entries(1);
    assert.strictEqual(hr.inPass(), false);
    b.P.queueTypes();
    assert.strictEqual(hr.inPass(), false);
    var def = b.P.orderIn(1, 'BB_0', 1);
    b.w.reset();
    def.check(0);
    def.check(0);
    assert.strictEqual(b.w.counts.queue[1], 2);
});

function countingEntry(type, amount, counter) {
    var e = entry(type, amount);
    e.GetAmount = function () { counter.n++; return amount; };
    return e;
}

t.test('inside one pass queuedIn walks the queue vector once', function () {
    var b = setup({ buffs: PS.buffDefs(2, ['3']) });
    var c = { n: 0 };
    fixedQueue(b, 1, [countingEntry('BB_0', 2, c), countingEntry('BB_0', 3, c)]);
    b.S.kernel.hostRead.pass(function () {
        assert.strictEqual(b.P.queuedIn(1, 'BB_0'), 5);
        assert.strictEqual(b.P.queuedIn(1, 'BB_0'), 5);
        assert.strictEqual(b.P.queuedIn(1, 'BB_0'), 5);
    });
    assert.strictEqual(c.n, 2);
});

t.test('outside a pass queuedIn reads live and sees an added entry', function () {
    var b = setup({ buffs: PS.buffDefs(2, ['3']) });
    var c = { n: 0 };
    var vec = [countingEntry('BB_0', 2, c)];
    fixedQueue(b, 1, vec);
    assert.strictEqual(b.P.queuedIn(1, 'BB_0'), 2);
    vec.push(countingEntry('BB_0', 3, c));
    assert.strictEqual(b.P.queuedIn(1, 'BB_0'), 5);
    assert.strictEqual(c.n, 3);
});

