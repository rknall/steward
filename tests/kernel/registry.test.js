'use strict';

var t = require('../runner');
var harness = require('../harness');

function validSpec(id) {
    return {
        id:       id,
        priority: 'PriorityNormal',
        isReady:  function () { return true; },
        plan:     function () {}
    };
}

t.test('register accepts a valid spec', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var ok = H.Steward.kernel.register(validSpec('alpha'));
    t.assert.strictEqual(ok, true);
    t.assert.strictEqual(H.Steward.kernel.registry.count(), 1);
    t.assert.strictEqual(H.Steward.kernel.registry.get('alpha').id, 'alpha');
});

t.test('register rejects duplicate ids', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.register(validSpec('dup'));
    var second = H.Steward.kernel.register(validSpec('dup'));
    t.assert.strictEqual(second, false);
    t.assert.strictEqual(H.Steward.kernel.registry.count(), 1);
});

t.test('register rejects an invalid priority', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var spec = validSpec('bad');
    spec.priority = 'PriorityBogus';
    t.assert.strictEqual(H.Steward.kernel.register(spec), false);
    t.assert.strictEqual(H.Steward.kernel.registry.count(), 0);
});

t.test('register rejects spec missing isReady or plan', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var noReady = validSpec('noReady'); noReady.isReady = null;
    var noPlan  = validSpec('noPlan');  noPlan.plan    = null;
    t.assert.strictEqual(H.Steward.kernel.register(noReady), false);
    t.assert.strictEqual(H.Steward.kernel.register(noPlan),  false);
});
