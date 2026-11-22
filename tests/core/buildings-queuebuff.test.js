'use strict';

// Buff eligibility of a queue building as the live client shapes it: a
// productionQueue, no production state and no ResourceCreation. The world is
// the shared production stub, so the real queue readers and buffBlock run.

var t = require('../runner');
var harness = require('../harness');
var PS = require('../stubs/production');

var assert = t.assert;

var HOUSE = { name: 'ProvisionHouse2', grid: 1005, level: 1, type: 5 };

function head(extra) {
    var e = { type: 'AddResource_Manuscript', amount: 3, produced: 1, timeMs: 1000, collectedMs: 0, bonus: 1 };
    for (var k in (extra || {})) e[k] = extra[k];
    return e;
}

// opts is the world's options; the building list defaults to the one house.
function boot(opts) {
    opts = opts || {};
    if (!opts.buildings) opts.buildings = [HOUSE];
    if (!opts.enumNames) opts.enumNames = { 5: 'provisionhouse2', 2: 'bookbinder' };
    var w = PS.world(opts);
    var H = harness.boot({ sections: ['kernel', 'core'], host: { swmmo: w.swmmo } });
    PS.install(H, w);
    w.reset();
    return { H: H, S: H.Steward, w: w };
}

function building(env, name, grid) {
    var list = env.S.core.buildings.byName(name);
    for (var i = 0; i < list.length; i++) {
        if (env.S.core.buildings.grid(list[i]) === grid) return list[i];
    }
    throw new Error('no building ' + name + ' at ' + grid);
}

// Counts every call of the queue readers buffState and buffBlock could reach.
function spyQueueReads(env) {
    var P = env.S.core.production;
    var spy = { reads: 0 };
    var producing = P.producing;
    var entries = P.entries;
    P.producing = function () { spy.reads++; return producing.apply(P, arguments); };
    P.entries = function () { spy.reads++; return entries.apply(P, arguments); };
    return spy;
}

t.test('a queue building with an unfinished head is producing and may be buffed', function () {
    var env = boot({ queues: { 5: [head()] } });
    var b = building(env, 'ProvisionHouse2', 1005);
    assert.strictEqual(env.S.core.production.producing(b), true);
    assert.strictEqual(env.S.core.buildings.buffBlock(b), null);
});

t.test('an empty queue and a finished head are not producing', function () {
    var empty = boot({ queues: { 5: [] } });
    var b = building(empty, 'ProvisionHouse2', 1005);
    assert.strictEqual(empty.S.core.production.producing(b), false);
    assert.strictEqual(empty.S.core.buildings.buffBlock(b), 'queue not producing');

    var done = boot({ queues: { 5: [head({ produced: 3 })] } });
    b = building(done, 'ProvisionHouse2', 1005);
    assert.strictEqual(done.S.core.production.producing(b), false);
    assert.strictEqual(done.S.core.buildings.buffBlock(b), 'queue not producing');
});

t.test('the other building of a type, which the queue does not run at, is not producing', function () {
    var env = boot({
        queues: { 5: [head()] },
        buildings: [HOUSE, { name: 'ProvisionHouse2', grid: 2000, level: 1, type: 5 }]
    });
    assert.strictEqual(env.S.core.production.producing(building(env, 'ProvisionHouse2', 1005)), true);
    var other = building(env, 'ProvisionHouse2', 2000);
    assert.strictEqual(env.S.core.production.producing(other), false);
    assert.strictEqual(env.S.core.buildings.buffBlock(other), 'queue not producing');
});

t.test('an unreadable queue or produced count is unreadable, not producing', function () {
    var none = boot({ queues: {} });
    var b = building(none, 'ProvisionHouse2', 1005);
    assert.strictEqual(none.S.core.production.producing(b), null);
    assert.strictEqual(none.S.core.buildings.buffBlock(b), 'queue state unreadable');

    // An entry without a produced count reads produced null.
    var noCount = boot({ queues: { 5: [head({ produced: undefined })] } });
    b = building(noCount, 'ProvisionHouse2', 1005);
    assert.strictEqual(noCount.S.core.production.producing(b), null);
    assert.strictEqual(noCount.S.core.buildings.buffBlock(b), 'queue state unreadable');
});

t.test('a books queue reads its count from the order, not from produced', function () {
    function run(producedItems) {
        var env = boot({
            queues: { 2: [head({ amount: 1, produced: 0, producedItems: producedItems })] },
            buildings: [{ name: 'Bookbinder', grid: 1002, level: 1, type: 2 }]
        });
        return env.S.core.production.producing(building(env, 'Bookbinder', 1002));
    }
    assert.strictEqual(run(undefined), null);
    assert.strictEqual(run(0), true);
    assert.strictEqual(run(1), false);
});

t.test('a throwing ResourceCreation is an unreadable production state and the queue is not read', function () {
    var env = boot({
        queues: { 5: [head()] },
        buildings: [{ name: 'ProvisionHouse2', grid: 1005, level: 1, type: 5, rcThrows: true }]
    });
    var spy = spyQueueReads(env);
    var b = building(env, 'ProvisionHouse2', 1005);
    assert.strictEqual(env.S.core.buildings.buffBlock(b), 'production state unreadable');
    assert.strictEqual(env.S.core.buildings.buffState(b).queueBuilding, false);
    assert.strictEqual(spy.reads, 0);
});

t.test('a running buff is reported before any queue read', function () {
    var env = boot({
        queues: { 5: [head()] },
        buildings: [{ name: 'ProvisionHouse2', grid: 1005, level: 1, type: 5, buff: 'BB_2' }]
    });
    var spy = spyQueueReads(env);
    var b = building(env, 'ProvisionHouse2', 1005);
    assert.strictEqual(env.S.core.buildings.buffBlock(b), 'already buffed');
    assert.strictEqual(env.S.core.buildings.buffState(b).queueBuilding, true);
    assert.strictEqual(spy.reads, 0);
});

t.test('buffState makes no queue read; buffBlock reads the queue only after the cheaper checks', function () {
    var env = boot({ queues: { 5: [head()] } });
    var spy = spyQueueReads(env);
    var b = building(env, 'ProvisionHouse2', 1005);
    assert.strictEqual(env.S.core.buildings.buffState(b).queueBuilding, true);
    assert.strictEqual(spy.reads, 0);
    assert.strictEqual(env.S.core.buildings.buffBlock(b), null);
    assert.ok(spy.reads > 0);
});

t.test('a building without a queue keeps the production state rule', function () {
    function block(state) {
        var spec = { name: 'Mine', grid: 40, level: 1 };
        if (typeof state === 'number') spec.state = state;
        var env = boot({ buildings: [spec], queues: {} });
        var b = building(env, 'Mine', 40);
        return { why: env.S.core.buildings.buffBlock(b), q: env.S.core.buildings.buffState(b).queueBuilding };
    }
    assert.strictEqual(block(1).why, 'not producing (state 1)');
    assert.strictEqual(block(0).why, null);
    assert.strictEqual(block().why, 'production state unreadable');
    [block(1), block(0), block()].forEach(function (r) { assert.strictEqual(r.q, false); });
});

t.test('a queue building that reports a production state follows the state rule', function () {
    var env = boot({ queues: {}, buildings: [{ name: 'Airship', grid: 1005, level: 1, type: 5, state: 0 }] });
    var b = building(env, 'Airship', 1005);
    assert.strictEqual(env.S.core.buildings.buffBlock(b), null);
    assert.strictEqual(env.S.core.buildings.buffState(b).queueBuilding, false);
});
