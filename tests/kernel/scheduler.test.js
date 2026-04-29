'use strict';

var t = require('../runner');
var harness = require('../harness');

t.test('tick visits ready modules in registration order on first walk', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var seen = [];
    H.Steward.kernel.register({
        id: 'a', priority: H.Steward.Priority.Normal,
        isReady: function () { return true; },
        plan: function () { seen.push('a'); }
    });
    H.Steward.kernel.register({
        id: 'b', priority: H.Steward.Priority.Normal,
        isReady: function () { return true; },
        plan: function () { seen.push('b'); }
    });
    H.Steward.kernel.scheduler.state.running = true;
    H.Steward.kernel.scheduler.tick();
    t.assert.deepStrictEqual(seen, ['a', 'b']);
});

t.test('isReady=false skips plan', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var planned = false;
    H.Steward.kernel.register({
        id: 'gated', priority: H.Steward.Priority.Normal,
        isReady: function () { return false; },
        plan: function () { planned = true; }
    });
    H.Steward.kernel.scheduler.state.running = true;
    H.Steward.kernel.scheduler.tick();
    t.assert.strictEqual(planned, false);
});

t.test('plan throw is caught and logged, not propagated', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.register({
        id: 'bomb', priority: H.Steward.Priority.Normal,
        isReady: function () { return true; },
        plan: function () { throw new Error('boom'); }
    });
    H.Steward.kernel.scheduler.state.running = true;
    H.Steward.kernel.scheduler.tick();   // should not throw
    var errors = H.logs().filter(function (l) {
        return l.level === 'error' && l.category === 'scheduler';
    });
    t.assert.strictEqual(errors.length, 1);
});

t.test('tick invalidates core snapshot caches before plan() runs', function () {
    // Loads kernel + core so the snapshot caches actually exist. The test
    // pins the per-tick invalidation contract — without it, snapshots
    // accumulate stale host-VO references across thousands of ticks and
    // the AIR host eventually crashes from GC pressure.
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var calls = { buildings: 0, buffs: 0, resources: 0 };

    var origB = H.Steward.core.buildings.invalidate;
    var origF = H.Steward.core.buffs.invalidate;
    var origR = H.Steward.core.resources.invalidate;
    H.Steward.core.buildings.invalidate = function () { calls.buildings++; return origB.apply(this, arguments); };
    H.Steward.core.buffs.invalidate     = function () { calls.buffs++;     return origF.apply(this, arguments); };
    H.Steward.core.resources.invalidate = function () { calls.resources++; return origR.apply(this, arguments); };

    // Capture invalidation count BEFORE tick runs (in case any boot path
    // calls invalidate). The contract is "tick adds at least one call".
    var before = { buildings: calls.buildings, buffs: calls.buffs, resources: calls.resources };

    H.Steward.kernel.scheduler.state.running = true;
    H.Steward.kernel.scheduler.tick();

    t.assert.ok(calls.buildings > before.buildings, 'tick must invalidate buildings cache');
    t.assert.ok(calls.buffs     > before.buffs,     'tick must invalidate buffs cache');
    t.assert.ok(calls.resources > before.resources, 'tick must invalidate resources cache');
});
