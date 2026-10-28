'use strict';

var t = require('../runner');
var harness = require('../harness');

var BUILDINGS = ['pumpkinfield_01', 'pumpkinfield_02', 'pumpkinfield_03'];
var WORK_TIME = { pumpkinfield_01: 19200, pumpkinfield_02: 9600, pumpkinfield_03: 2400 };

// Wiki / live fixtures: remaining seconds and the per-type deposits.
var WIKI = { T: 2376000, route: 6, deposits: [45, 80, 100], units: [78, 167, 885], total: 3390 };
var LIVE = { T: 2196600, route: 6, deposits: [56, 86, 75],  units: [58, 142, 835], total: 3105 };

function bootRefill() {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    H.host.game.def = function (name) {
        if (name === 'ServerState::gEconomics') {
            return {
                GetResourcesCreationDefinitionForBuilding: function (b) {
                    return Object.prototype.hasOwnProperty.call(WORK_TIME, b)
                        ? { workTime: WORK_TIME[b] } : null;
                }
            };
        }
        return null;
    };
    return H;
}

function liveHalloween(H, now) {
    var stops = {};
    stops['HW2017plus_Content'] = now + 1000000;
    stops['HW2017plus_Shop']    = now + 5000000;
    var em = H.host.game.gi.mEventManager;
    em.GetActiveEventNames = function () { return ['HW2017plus_Content', 'HW2017plus_Shop']; };
    em.GetEventStopDate    = function (n) { return stops[n] || null; };
}

// Template rows carry deposit 0; the fixtures set the per-type deposit.
function withDeposits(rows, deposits) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
        var r = {};
        for (var k in rows[i]) r[k] = rows[i][k];
        r.deposit = deposits[BUILDINGS.indexOf(r.building)];
        out.push(r);
    }
    return out;
}

t.test('buildings.workTime reads the economy definition', function () {
    var H = bootRefill();
    t.assert.strictEqual(H.Steward.core.buildings.workTime('pumpkinfield_01'), 19200);
});

t.test('buildings.workTime is null when the definition is unavailable', function () {
    var H = bootRefill();
    var B = H.Steward.core.buildings;

    H.host.game.def = function () { return null; };
    t.assert.strictEqual(B.workTime('pumpkinfield_01'), null);

    H.host.game.def = function () { return {}; };
    t.assert.strictEqual(B.workTime('pumpkinfield_01'), null);

    H.host.game.def = function () { throw new Error('boom'); };
    t.assert.strictEqual(B.workTime('pumpkinfield_01'), null);

    H.host.game.def = function () {
        return { GetResourcesCreationDefinitionForBuilding: function () { return { workTime: 0 }; } };
    };
    t.assert.strictEqual(B.workTime('pumpkinfield_01'), null);
});

t.test('remainingSeconds floors and clamps at zero', function () {
    var R = bootRefill().Steward.core.events.refill;
    t.assert.strictEqual(R.remainingSeconds(10500, 0), 10);
    t.assert.strictEqual(R.remainingSeconds(0, 5000), 0);
    t.assert.strictEqual(R.remainingSeconds(null, 0), null);
});

t.test('wiki defaults give 78/167/885 per row and 3390 in total', function () {
    var R = bootRefill().Steward.core.events.refill;
    var res = R.compute(withDeposits(R.rows('HW').rows, WIKI.deposits), WIKI.T, WIKI.route, 1);

    t.assert.strictEqual(res.rows.length, 9);
    for (var i = 0; i < res.rows.length; i++) {
        t.assert.strictEqual(res.rows[i].units, WIKI.units[BUILDINGS.indexOf(res.rows[i].building)]);
    }
    t.assert.strictEqual(res.totalUnits, WIKI.total);
    t.assert.strictEqual(res.totalItems, WIKI.total);
});

t.test('live example gives 58/142/835 per row and 3105 in total', function () {
    var R = bootRefill().Steward.core.events.refill;
    var res = R.compute(withDeposits(R.rows('HW').rows, LIVE.deposits), LIVE.T, LIVE.route, 1);

    for (var i = 0; i < res.rows.length; i++) {
        t.assert.strictEqual(res.rows[i].units, LIVE.units[BUILDINGS.indexOf(res.rows[i].building)]);
    }
    t.assert.strictEqual(res.totalUnits, LIVE.total);
});

t.test('units clamp at 0 when the deposit already covers the yield', function () {
    var R = bootRefill().Steward.core.events.refill;
    t.assert.strictEqual(R.units(100, 19200, 6, 45), 0);
    t.assert.strictEqual(R.units(WIKI.T, 19200, 6, 5000), 0);
    t.assert.strictEqual(R.units(WIKI.T, null, 6, 0), null);
});

t.test('items round up per unitsPerItem', function () {
    var R = bootRefill().Steward.core.events.refill;
    t.assert.strictEqual(R.items(885, 1), 885);
    t.assert.strictEqual(R.items(158, 79), 2);
    t.assert.strictEqual(R.items(159, 79), 3);
    t.assert.strictEqual(R.items(0, 79), 0);
    t.assert.strictEqual(R.items(null, 1), null);
});

t.test('compute does not mutate its input rows', function () {
    var R = bootRefill().Steward.core.events.refill;
    var input = [{ key: 'a', building: 'pumpkinfield_01', workTime: 19200, deposit: 'x' }];
    var res = R.compute(input, WIKI.T, 6, 1);
    t.assert.strictEqual(typeof input[0].units, 'undefined');
    t.assert.strictEqual(res.rows[0].units, 123);   // non-number deposit counts as 0
    t.assert.strictEqual(res.rows[0].deposit, 'x');
});

t.test('home zone with 9 fields and 9 deposits gives 9 game rows', function () {
    var H = bootRefill();
    var grids = { pumpkinfield_01: [30, 10, 20], pumpkinfield_02: [60, 40, 50], pumpkinfield_03: [90, 70, 80] };
    var z = H.zone.zone();
    var deps = [];
    var expected = {};
    var n = 1;
    for (var b = 0; b < BUILDINGS.length; b++) {
        for (var i = 0; i < 3; i++) {
            var g = grids[BUILDINGS[b]][i];
            z.building(H.zone.building({ name: BUILDINGS[b], grid: g }));
            deps.push(H.zone.deposit({ name: 'HalloweenResource', grid: g, amount: n * 7 }));
            expected[g] = n * 7;
            n++;
        }
    }
    z.deposits('HalloweenResource', deps);
    H.installZone(z);

    var res = H.Steward.core.events.refill.rows('HW');
    t.assert.strictEqual(res.source, 'game');
    t.assert.strictEqual(res.rows.length, 9);
    // Building order, then grid ascending.
    t.assert.strictEqual(res.rows[0].building, 'pumpkinfield_01');
    t.assert.strictEqual(res.rows[0].grid, 10);
    t.assert.strictEqual(res.rows[2].grid, 30);
    t.assert.strictEqual(res.rows[3].building, 'pumpkinfield_02');
    t.assert.strictEqual(res.rows[8].grid, 90);
    for (var r = 0; r < res.rows.length; r++) {
        t.assert.strictEqual(res.rows[r].source, 'game');
        t.assert.strictEqual(res.rows[r].deposit, expected[res.rows[r].grid]);
        t.assert.strictEqual(res.rows[r].key, 'g' + res.rows[r].grid);
        t.assert.strictEqual(res.rows[r].workTime, WORK_TIME[res.rows[r].building]);
    }
});

t.test('fields without readable deposits become manual rows with deposit 0', function () {
    var H = bootRefill();
    var z = H.zone.zone();
    for (var i = 0; i < 3; i++) {
        z.building(H.zone.building({ name: 'pumpkinfield_01', grid: 10 + i }));
    }
    H.installZone(z);

    var res = H.Steward.core.events.refill.rows('HW');
    t.assert.strictEqual(res.source, 'manual');
    t.assert.strictEqual(res.rows.length, 3);
    for (var r = 0; r < res.rows.length; r++) {
        t.assert.strictEqual(res.rows[r].source, 'manual');
        t.assert.strictEqual(res.rows[r].deposit, 0);
        t.assert.strictEqual(res.rows[r].workTime, 19200);
    }
});

t.test('off the home island rows are the 3x3 template', function () {
    var H = bootRefill();
    H.installZone(H.zone.zone().building(H.zone.building({ name: 'pumpkinfield_01', grid: 10 })));
    H.host.game.gi.isOnHomzone = function () { return false; };

    var res = H.Steward.core.events.refill.rows('HW');
    t.assert.strictEqual(res.source, 'manual');
    t.assert.strictEqual(res.rows.length, 9);
    t.assert.strictEqual(res.rows[0].key, 'pumpkinfield_01#1');
    t.assert.strictEqual(res.rows[0].grid, null);
    t.assert.strictEqual(res.rows[8].key, 'pumpkinfield_03#3');
    t.assert.strictEqual(res.rows[8].workTime, 2400);
});

t.test('home island without any field falls back to the template', function () {
    var H = bootRefill();
    H.installZone(H.zone.zone());

    var res = H.Steward.core.events.refill.rows('HW');
    t.assert.strictEqual(res.source, 'manual');
    t.assert.strictEqual(res.rows.length, 9);
});

t.test('rows never throws when the host fails', function () {
    var H = bootRefill();
    H.host.game.gi.isOnHomzone = function () { throw new Error('boom'); };
    H.host.game.def = function () { throw new Error('boom'); };

    var res = H.Steward.core.events.refill.rows('HW');
    t.assert.strictEqual(res.rows.length, 9);
    t.assert.strictEqual(res.rows[0].workTime, null);
});

t.test('depositEvent returns the live deposit event with the shop end time', function () {
    var H = bootRefill();
    var now = 1700000000000;
    liveHalloween(H, now);

    var ev = H.Steward.core.events.refill.depositEvent(now);
    t.assert.strictEqual(ev.code, 'HW');
    t.assert.strictEqual(ev.resource, 'HalloweenResource');
    t.assert.strictEqual(ev.endTime, now + 5000000);
    t.assert.strictEqual(ev.remainingSec, 5000);
    t.assert.strictEqual(ev.info.fieldsPerType, 3);
});

t.test('depositEvent is null without a live event or for a non-deposit event', function () {
    var H = bootRefill();
    t.assert.strictEqual(H.Steward.core.events.refill.depositEvent(0), null);

    H.host.game.gi.mEventManager.GetActiveEventNames = function () { return ['XMASContent2025']; };
    t.assert.strictEqual(H.Steward.core.events.refill.depositEvent(0), null);
});
