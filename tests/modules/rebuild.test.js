'use strict';

var t = require('../runner');
var harness = require('../harness');

var HOME = { zone: { isHome: true } };

function setup(names, used, max) {
    var H = harness.boot();
    var z = H.zone.zone();
    names.forEach(function (n, i) {
        z.building(H.zone.building({ name: n, grid: 10 + i }));
    });
    z.buildQueue(used, max);
    H.installZone(z);
    H.host.game.gi.mCurrentPlayerZone.mStreetDataMap.IsADepletedDeposit = function (b) {
        return b.GetBuildingName_string().indexOf('Depleted') > -1;
    };
    H.settings.write('rebuild', { enabled: true, wellType: 'Well_03', fieldType: 'Farmfield', actionDelay: 0 });
    return H;
}

t.test('plan queues a rebuild for each depleted well and field', function () {
    var H = setup(['MineDepletedDepositWater', 'MineDepletedDepositCorn', 'Farmfield'], 0, 4);
    H.module('rebuild').plan(HOME);
    var q = H.queued();
    t.assert.strictEqual(q.length, 2);
    t.assert.strictEqual(q[0].name, 'rebuild.place');
    t.assert.strictEqual(q[0].params[0], 10);
    t.assert.strictEqual(q[0].params[1], 'Well_03');
    t.assert.strictEqual(q[1].params[0], 11);
    t.assert.strictEqual(q[1].params[1], 'Farmfield');
});

t.test('plan queues no more than the free build-queue slots', function () {
    var H = setup(['MineDepletedDepositWater', 'MineDepletedDepositCorn'], 3, 4);
    H.module('rebuild').plan(HOME);
    t.assert.strictEqual(H.queued().length, 1);
});

t.test('plan queues nothing when the build queue is full', function () {
    var H = setup(['MineDepletedDepositWater'], 4, 4);
    H.module('rebuild').plan(HOME);
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('isReady needs the module enabled on the home zone', function () {
    var H = setup([], 0, 4);
    t.assert.strictEqual(H.module('rebuild').isReady(HOME), true);
    t.assert.strictEqual(H.module('rebuild').isReady({ zone: { isHome: false } }), false);
    H.settings.write('rebuild', { enabled: false });
    t.assert.strictEqual(H.module('rebuild').isReady(HOME), false);
});

t.test('the queued action sends command 50 and skips a grid that is no longer depleted', function () {
    var H = setup(['MineDepletedDepositWater', 'Well'], 0, 4);
    var sent = [];
    H.host.game.gi.SendServerAction = function () { sent.push([].slice.call(arguments)); };
    var fn = null;
    var q = H.Steward.kernel.queue;
    var orig = q.action;
    q.action = function (name, f) { if (name === 'rebuild.place') fn = f; return orig.apply(q, arguments); };
    H.module('rebuild').boot();
    q.action = orig;

    fn([11, 'Well']);
    t.assert.strictEqual(sent.length, 0);
    fn([10, 'Well_03']);
    t.assert.strictEqual(sent.length, 1);
    t.assert.strictEqual(sent[0][0], 50);
    t.assert.strictEqual(sent[0][1], 176);
    t.assert.strictEqual(sent[0][2], 10);
});
