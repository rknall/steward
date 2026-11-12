'use strict';

var t = require('../runner');
var harness = require('../harness');

function setup(buildings, home) {
    var H = harness.boot();
    var zb = H.zone.zone();
    for (var i = 0; i < buildings.length; i++) zb.building(buildings[i]);
    var z = zb.mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.host.game.gi.isOnHomzone = function () { return home !== false; };
    z.zone.sent = [];
    z.zone.SendDestructBuildingCommand = function (b, src) { z.zone.sent.push([b.GetGrid(), src]); };
    return { H: H, zone: z.zone };
}

function settings(on) {
    return { enabled: true, dispatchDelay: 0, removeDepleted: on };
}

t.test('removeDepleted setting defaults to off', function () {
    var H = harness.boot();
    t.assert.strictEqual(H.Steward.modules.geologists.defaultSettings.removeDepleted, false);
});

t.test('plan queues one removal for a managed depleted deposit when enabled', function () {
    var s = setup([
        harness.boot().zone.building({ name: 'DepletedIronOre', grid: 7 }),
        harness.boot().zone.building({ name: 'IronMine', grid: 8 })
    ]);
    s.H.settings.write('geologists', settings(true));
    s.H.module('geologists').plan({ zone: { isHome: true } });
    var q = s.H.queued().filter(function (e) { return e.name === 'geologists.removeDepleted'; });
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].params[0], 7);
});

t.test('plan queues no removal when the setting is off', function () {
    var s = setup([harness.boot().zone.building({ name: 'DepletedIronOre', grid: 7 })]);
    s.H.settings.write('geologists', settings(false));
    s.H.module('geologists').plan({ zone: { isHome: true } });
    t.assert.strictEqual(s.H.queued().length, 0);
});

t.test('core removeDepleted sends the destruct command for a managed depleted deposit only', function () {
    var B = harness.boot().zone;
    var s = setup([
        B.building({ name: 'DepletedIronOre', grid: 7 }),
        B.building({ name: 'DepletedFoo', grid: 8 }),
        B.building({ name: 'IronMine', grid: 9 })
    ]);
    var d = s.H.Steward.core.deposits;
    t.assert.strictEqual(d.removeDepleted(s.zone.GetBuildingFromGridPosition(7)), true);
    t.assert.strictEqual(d.removeDepleted(s.zone.GetBuildingFromGridPosition(8)), false);
    t.assert.strictEqual(d.removeDepleted(s.zone.GetBuildingFromGridPosition(9)), false);
    t.assert.strictEqual(s.zone.sent.length, 1);
    t.assert.strictEqual(s.zone.sent[0][1], 'minimalInfoPanel');
});

t.test('core removeDepleted refuses off the home island', function () {
    var s = setup([harness.boot().zone.building({ name: 'DepletedIronOre', grid: 7 })], false);
    t.assert.strictEqual(s.H.Steward.core.deposits.removeDepleted(s.zone.GetBuildingFromGridPosition(7)), false);
    t.assert.strictEqual(s.zone.sent.length, 0);
});
