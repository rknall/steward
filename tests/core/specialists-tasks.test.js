'use strict';

// The explorer task table: the packet each task sends, the decoding of a
// host (taskId, subTaskId) pair and the list of tasks that need no skill.

var t = require('../runner');
var harness = require('../harness');

function boot() {
    return harness.boot({ sections: ['kernel', 'core'] });
}

// Task name -> [taskId, subTaskId], written out here on purpose: the table
// in core is the thing under test, so it must not be the source of the pairs.
var PAIRS = [
    ['Short', 1, 0],
    ['Medium', 1, 1],
    ['Long', 1, 2],
    ['EvenLonger', 1, 3],
    ['TravellingErudite', 1, 4],
    ['BeanACollada', 1, 5],
    ['Prolonged', 1, 6],
    ['AdventureZoneShort', 2, 0],
    ['AdventureZoneMedium', 2, 1],
    ['AdventureZoneLong', 2, 2],
    ['AdventureZoneVeryLong', 2, 3]
];

t.test('send sends the literal packet pair of every explorer task', function () {
    var H = boot();
    var S = H.Steward;
    var sent = [];
    S.core.specialists.dispatch.send = function (spec, taskId, subTaskId) {
        sent.push([taskId, subTaskId]);
    };
    for (var i = 0; i < PAIRS.length; i++) {
        sent.length = 0;
        t.assert.ok(S.ExplorerTask[PAIRS[i][0]], 'enum exists: ' + PAIRS[i][0]);
        S.core.specialists.send({}, S.ExplorerTask[PAIRS[i][0]]);
        t.assert.deepStrictEqual(sent.slice(), [[PAIRS[i][1], PAIRS[i][2]]], PAIRS[i][0]);
    }
});

t.test('rawToExplorerTask returns each task for its literal pair', function () {
    var H = boot();
    var S = H.Steward;
    for (var i = 0; i < PAIRS.length; i++) {
        t.assert.strictEqual(S.core.specialists.rawToExplorerTask(PAIRS[i][1], PAIRS[i][2]),
            S.ExplorerTask[PAIRS[i][0]], PAIRS[i][0]);
    }
});

t.test('rawToExplorerTask is null for an unknown family, variant or a non-number', function () {
    var c = boot().Steward.core.specialists;
    t.assert.strictEqual(c.rawToExplorerTask(3, 0), null);
    t.assert.strictEqual(c.rawToExplorerTask(1, 7), null);
    t.assert.strictEqual(c.rawToExplorerTask('1', 0), null);
    t.assert.strictEqual(c.rawToExplorerTask(1, null), null);
});

t.test('unskilledTasks lists the tasks that need no skill, in dropdown order', function () {
    var S = boot().Steward;
    var E = S.ExplorerTask;
    var want = [E.Short, E.Medium, E.Long, E.EvenLonger, E.Prolonged,
        E.AdventureZoneShort, E.AdventureZoneMedium, E.AdventureZoneLong, E.AdventureZoneVeryLong];
    var a = S.core.specialists.unskilledTasks();
    t.assert.deepStrictEqual(Array.prototype.slice.call(a), want);
    var b = S.core.specialists.unskilledTasks();
    t.assert.deepStrictEqual(Array.prototype.slice.call(b), want);
    t.assert.ok(a !== b, 'a new array per call');
});
