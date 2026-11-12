'use strict';

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

// The real state module is replaced by a stub run so the provider is tested
// on its own; it reads the state at call time.
function setup(run, label) {
    var H = harness.boot();
    var S = H.Steward;
    S.modules.adventures.state = {
        run: function () { return run; },
        isScenario: function (r) { return !!r.scenarioId; },
        label: function () { return label; }
    };
    return S;
}

function holds(S) { return S.core.production.demand.holds(); }

t.test('a Running template run holds the troops with the wave label', function () {
    var S = setup({ status: 'RunRunning', waveIndex: 1 }, 'wave 2/4');
    var h = holds(S).filter(function (x) { return x.owner === 'adventures'; });
    assert.strictEqual(h.length, 1);
    assert.strictEqual(h[0].key, 'troops');
    assert.strictEqual(h[0].label, 'Adventure: wave 2/4 (troops)');
    assert.strictEqual(h[0].kind, S.ProductionKind.Units);
});

t.test('a Paused template run still holds the troops', function () {
    var S = setup({ status: 'RunPaused' }, 'Close');
    assert.strictEqual(holds(S).length, 1);
});

t.test('a scenario run, a Done run and no run hold nothing', function () {
    assert.strictEqual(holds(setup({ status: 'RunRunning', scenarioId: 'x' }, 'Trip')).length, 0);
    assert.strictEqual(holds(setup({ status: 'RunDone' }, 'Done')).length, 0);
    assert.strictEqual(holds(setup(null, '')).length, 0);
});
