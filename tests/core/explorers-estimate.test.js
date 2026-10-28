'use strict';

var t = require('../runner');
var harness = require('../harness');

var TREASURE_END = 1794819600000;
var SHOP_END     = 1795381200000;

// Subtask durations in ms. With HW values [2.6, 3.9, 6.5, 11.8, 15.6] and
// time bonus 100 the items/hour are 1.3, 1.95, 1.625, ... so Medium wins.
// IDs 4 and 5 are skipped by treasureTaskTable.
var SUBTASKS = [
    { subTaskID: 0, duration:  7200000, taskType_string: 'Short' },
    { subTaskID: 1, duration:  7200000, taskType_string: 'Medium' },
    { subTaskID: 2, duration: 14400000, taskType_string: 'Long' },
    { subTaskID: 3, duration: 28800000, taskType_string: 'EvenLonger' },
    { subTaskID: 4, duration:  1000,    taskType_string: 'Erudite' },
    { subTaskID: 5, duration:  1000,    taskType_string: 'Bean' },
    { subTaskID: 6, duration: 57600000, taskType_string: 'Prolonged' }
];

function bootEstimate(eventNames) {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var stops = {};
    stops['HW2017plus_Content'] = TREASURE_END;
    stops['HW2017plus_Shop']    = SHOP_END;
    var em = H.host.game.gi.mEventManager;
    em.GetActiveEventNames = function () {
        return eventNames || ['HW2017plus_Content', 'HW2017plus_Shop'];
    };
    em.GetEventStopDate = function (n) { return stops[n] || null; };
    H.host.game.def = function (name) {
        if (name === 'global') {
            return { specialistTaskDefinitions_vector: [null, { subtasks_vector: SUBTASKS }] };
        }
        return null;
    };
    return H;
}

function setExplorers(H, list) {
    H.Steward.core.specialists.explorers = function () { return list; };
}

function near(actual, expected) {
    t.assert.ok(Math.abs(actual - expected) <= 1e-6,
        'expected ' + actual + ' to be near ' + expected);
}

t.test('eventTaskRates skips tasks 4 and 5 and pairs tasks with values', function () {
    var H = bootEstimate();
    var rates = H.Steward.core.specialists.eventTaskRates(H.specs.explorer(), 'HW');
    t.assert.strictEqual(rates.length, 5);
    near(rates[0].perHour, 1.3);
    near(rates[1].perHour, 1.95);
    t.assert.strictEqual(rates[1].duration, 7200000);
    t.assert.strictEqual(rates[1].timeBonus, 100);
});

t.test('eventTaskRates is empty without spec, code or host data', function () {
    var H = bootEstimate();
    var S = H.Steward.core.specialists;
    t.assert.strictEqual(S.eventTaskRates(null, 'HW').length, 0);
    t.assert.strictEqual(S.eventTaskRates(H.specs.explorer(), null).length, 0);
    H.host.game.def = function () { return null; };
    t.assert.strictEqual(S.eventTaskRates(H.specs.explorer(), 'HW').length, 0);
});

t.test('bestTaskForEvent equals the max perHour task of eventTaskRates', function () {
    var H = bootEstimate();
    var S = H.Steward.core.specialists;
    var spec = H.specs.explorer();
    var rates = S.eventTaskRates(spec, 'HW');
    var best = rates[0];
    for (var i = 1; i < rates.length; i++) {
        if (rates[i].perHour > best.perHour) best = rates[i];
    }
    t.assert.strictEqual(S.bestTaskForEvent(spec, 'HW'), best.enumVal);
    t.assert.strictEqual(best.enumVal, H.Steward.ExplorerTask.Medium);
});

t.test('bestTaskForEvent is null when no rate is computable', function () {
    var H = bootEstimate();
    H.host.game.def = function () { return null; };
    t.assert.strictEqual(H.Steward.core.specialists.bestTaskForEvent(H.specs.explorer(), 'HW'), null);
});

t.test('time bonus 300 triples perHour against 100', function () {
    var H = bootEstimate();
    var S = H.Steward.core.specialists;
    var base = S.eventTaskRates(H.specs.explorer({ timeBonus: 100 }), 'HW')[1].perHour;
    var triple = S.eventTaskRates(H.specs.explorer({ timeBonus: 300 }), 'HW')[1].perHour;
    near(triple, base * 3);
    // A spec that exposes no time bonus counts as 100.
    near(S.eventTaskRates(H.specs.explorer(), 'HW')[1].perHour, base);
});

t.test('estimateEventItems sums only the best rate per explorer', function () {
    var H = bootEstimate();
    setExplorers(H, [H.specs.explorer({ timeBonus: 100 }), H.specs.explorer({ timeBonus: 300 })]);
    var now = TREASURE_END - 10 * 3600000;

    var est = H.Steward.core.specialists.estimateEventItems(now);
    t.assert.strictEqual(est.code, 'HW');
    t.assert.strictEqual(est.resource, 'HalloweenResource');
    t.assert.strictEqual(est.explorers, 2);
    t.assert.strictEqual(est.counted, 2);
    // Best only: 1.95 + 5.85, not the sum of every task rate.
    near(est.perHour, 7.8);
    near(est.perDay, 187.2);
    t.assert.strictEqual(est.endTime, TREASURE_END);
    near(est.hoursLeft, 10);
    t.assert.ok(Math.abs(est.untilEnd - 78) <= 1);
});

t.test('estimateEventItems uses the treasure end, not the shop end', function () {
    var H = bootEstimate();
    setExplorers(H, [H.specs.explorer()]);
    var est = H.Steward.core.specialists.estimateEventItems(TREASURE_END + 3600000);
    t.assert.strictEqual(est.endTime, TREASURE_END);
    t.assert.strictEqual(est.hoursLeft, 0);
    t.assert.strictEqual(est.untilEnd, 0);
});

t.test('estimateEventItems is null for a shop-only event', function () {
    var H = bootEstimate(['HW2017plus_Shop']);
    setExplorers(H, [H.specs.explorer()]);
    t.assert.strictEqual(H.Steward.core.specialists.estimateEventItems(0), null);
});

t.test('estimateEventItems is null without any live event', function () {
    var H = bootEstimate([]);
    t.assert.strictEqual(H.Steward.core.specialists.estimateEventItems(0), null);
});

t.test('estimateEventItems counts only explorers with a computable rate', function () {
    var H = bootEstimate();
    setExplorers(H, [H.specs.explorer(), null]);
    var est = H.Steward.core.specialists.estimateEventItems(TREASURE_END - 3600000);
    t.assert.strictEqual(est.explorers, 2);
    t.assert.strictEqual(est.counted, 1);
});
