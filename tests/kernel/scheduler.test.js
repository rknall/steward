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
