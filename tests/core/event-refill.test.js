'use strict';

var t = require('../runner');
var harness = require('../harness');

var BUILDINGS = ['pumpkinfield_01', 'pumpkinfield_02', 'pumpkinfield_03'];
var WORK_TIME = { pumpkinfield_01: 19200, pumpkinfield_02: 9600, pumpkinfield_03: 2400 };

// Wiki / live fixtures: remaining seconds and the per-type deposits.
var WIKI = { T: 2376000, route: 6, deposits: [45, 80, 100], units: [78, 167, 885], total: 3390 };
var LIVE = { T: 2196600, route: 6, deposits: [56, 86, 75],  units: [58, 142, 835], total: 3105 };

function bootRefill(hostOpts) {
    var H = harness.boot({ sections: ['kernel', 'core'], host: hostOpts || {} });
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

// Buff fixtures: T = 2186000 s, route 6, deposits 56/85/71 (cycles 113/227/906).
var BUF = { T: 2186000, route: 6, deposits: [56, 85, 71] };
var BUF_NOW = 1700000000000;
var NINE_HOURS = 32400000;

function buffedRows(R, extra) {
    var rows = withDeposits(R.rows('HW').rows, BUF.deposits);
    for (var i = 0; i < rows.length; i++) {
        rows[i].perCycle = 1;
        rows[i].buffedPerCycle = 10;
        rows[i].buffEndMs = BUF_NOW + NINE_HOURS;
        if (extra) for (var k in extra) rows[i][k] = extra[k];
    }
    return rows;
}

function byBuilding(res) {
    var out = {};
    for (var i = 0; i < res.rows.length; i++) {
        if (!out[res.rows[i].building]) out[res.rows[i].building] = res.rows[i];
    }
    return out;
}

t.test('cycles floors remaining time over the cycle length', function () {
    var R = bootRefill().Steward.core.events.refill;
    t.assert.strictEqual(R.cycles(BUF.T, 19200, 6), 113);
    t.assert.strictEqual(R.cycles(BUF.T, 9600, 6), 227);
    t.assert.strictEqual(R.cycles(BUF.T, 2400, 6), 906);
    t.assert.strictEqual(R.cycles(BUF.T, null, 6), null);
    t.assert.strictEqual(R.cycles(BUF.T, 0, 6), null);
});

t.test('unbuffed rows give rate, until end and refill per field', function () {
    var R = bootRefill().Steward.core.events.refill;
    var res = R.compute(withDeposits(R.rows('HW').rows, BUF.deposits), BUF.T, BUF.route, 1, BUF_NOW);
    var by = byBuilding(res);

    t.assert.strictEqual(by.pumpkinfield_01.cycles, 113);
    t.assert.strictEqual(by.pumpkinfield_02.cycles, 227);
    t.assert.strictEqual(by.pumpkinfield_03.cycles, 906);
    t.assert.strictEqual(by.pumpkinfield_01.rate12h, 2.25);
    t.assert.strictEqual(by.pumpkinfield_02.rate12h, 4.49);
    t.assert.strictEqual(by.pumpkinfield_03.rate12h, 17.91);
    t.assert.strictEqual(by.pumpkinfield_01.untilEnd, 113);
    t.assert.strictEqual(by.pumpkinfield_02.untilEnd, 227);
    t.assert.strictEqual(by.pumpkinfield_03.untilEnd, 906);
    t.assert.strictEqual(by.pumpkinfield_01.units, 57);
    t.assert.strictEqual(by.pumpkinfield_02.units, 142);
    t.assert.strictEqual(by.pumpkinfield_03.units, 835);
    t.assert.strictEqual(by.pumpkinfield_01.rate12hBuffed, null);
    t.assert.strictEqual(by.pumpkinfield_01.untilEndBuffed, null);

    t.assert.strictEqual(res.totalDeposit, 636);
    t.assert.strictEqual(res.totalRate12h, 73.96);
    t.assert.strictEqual(res.totalUntilEnd, 3738);
    t.assert.strictEqual(res.totalUnits, 3102);
    t.assert.strictEqual(res.totalRate12hBuffed, null);
    t.assert.strictEqual(res.totalUntilEndBuffed, null);
});

t.test('buffed rows count the extra yield only inside the buff window', function () {
    var R = bootRefill().Steward.core.events.refill;
    var res = R.compute(buffedRows(R), BUF.T, BUF.route, 1, BUF_NOW);
    var by = byBuilding(res);

    t.assert.strictEqual(by.pumpkinfield_01.rate12hBuffed, 22.49);
    t.assert.strictEqual(by.pumpkinfield_02.rate12hBuffed, 44.94);
    t.assert.strictEqual(by.pumpkinfield_03.rate12hBuffed, 179.1);
    t.assert.strictEqual(by.pumpkinfield_01.untilEndBuffed, 122);
    t.assert.strictEqual(by.pumpkinfield_02.untilEndBuffed, 254);
    t.assert.strictEqual(by.pumpkinfield_03.untilEndBuffed, 1023);
    // The refill stays in unbuffed deposit units.
    t.assert.strictEqual(by.pumpkinfield_01.units, 57);
    t.assert.strictEqual(res.totalRate12hBuffed, 739.6);
    t.assert.strictEqual(res.totalUntilEndBuffed, 4197);
    t.assert.strictEqual(res.totalUnits, 3102);
});

t.test('a buffed factor equal to the base factor gives no buffed values', function () {
    var R = bootRefill().Steward.core.events.refill;
    var res = R.compute(buffedRows(R, { buffedPerCycle: 1 }), BUF.T, BUF.route, 1, BUF_NOW);
    for (var i = 0; i < res.rows.length; i++) {
        t.assert.strictEqual(res.rows[i].rate12hBuffed, null);
        t.assert.strictEqual(res.rows[i].untilEndBuffed, null);
    }
    t.assert.strictEqual(res.totalRate12hBuffed, null);
    t.assert.strictEqual(res.totalUntilEndBuffed, null);
});

t.test('a buff outlasting the event is clamped to the remaining time', function () {
    var R = bootRefill().Steward.core.events.refill;
    var res = R.compute(buffedRows(R, { buffEndMs: BUF_NOW + BUF.T * 1000 * 5 }),
        BUF.T, BUF.route, 1, BUF_NOW);
    var by = byBuilding(res);
    // Every cycle is buffed: cycles * buffedPerCycle.
    t.assert.strictEqual(by.pumpkinfield_01.untilEndBuffed, 1130);
    t.assert.strictEqual(by.pumpkinfield_02.untilEndBuffed, 2270);
    t.assert.strictEqual(by.pumpkinfield_03.untilEndBuffed, 9060);
});

t.test('a buff that ended since it was read leaves the row unbuffed', function () {
    var R = bootRefill().Steward.core.events.refill;
    var res = R.compute(buffedRows(R, { buffEndMs: BUF_NOW }), BUF.T, BUF.route, 1, BUF_NOW);
    for (var i = 0; i < res.rows.length; i++) {
        t.assert.strictEqual(res.rows[i].rate12hBuffed, null);
        t.assert.strictEqual(res.rows[i].untilEndBuffed, null);
    }
    t.assert.strictEqual(res.totalRate12hBuffed, null);
    t.assert.strictEqual(res.totalUntilEndBuffed, null);
});

t.test('a buffed row without a readable window shows only the buffed rate', function () {
    var R = bootRefill().Steward.core.events.refill;
    var res = R.compute(buffedRows(R, { buffEndMs: null }), BUF.T, BUF.route, 1, BUF_NOW);
    var by = byBuilding(res);
    t.assert.strictEqual(by.pumpkinfield_01.rate12hBuffed, 22.49);
    t.assert.strictEqual(by.pumpkinfield_01.untilEndBuffed, null);
    t.assert.strictEqual(res.totalRate12hBuffed, 739.6);
    t.assert.strictEqual(res.totalUntilEndBuffed, null);
});

t.test('rows with an unknown workTime carry null production figures', function () {
    var R = bootRefill().Steward.core.events.refill;
    var res = R.compute([{ key: 'a', building: 'x', workTime: null, deposit: 5, perCycle: 1 }],
        BUF.T, BUF.route, 1, BUF_NOW);
    var r = res.rows[0];
    t.assert.strictEqual(r.cycles, null);
    t.assert.strictEqual(r.rate12h, null);
    t.assert.strictEqual(r.untilEnd, null);
    t.assert.strictEqual(r.units, null);
    t.assert.strictEqual(r.items, null);
    t.assert.strictEqual(res.totalDeposit, 5);
    t.assert.strictEqual(res.totalRate12h, 0);
});

t.test('home zone fields carry the host output factor and buff end', function () {
    var clockNow = 5000000;
    var H = bootRefill({
        swmmo: { application: { mGameInterface: { GetClientTime: function () { return clockNow; } } } }
    });
    var grids = { pumpkinfield_01: [10, 20, 30], pumpkinfield_02: [40, 50, 60], pumpkinfield_03: [70, 80, 90] };
    var z = H.zone.zone();
    var deps = [];
    for (var b = 0; b < BUILDINGS.length; b++) {
        for (var i = 0; i < 3; i++) {
            var g = grids[BUILDINGS[b]][i];
            z.building(H.zone.building({
                name: BUILDINGS[b], grid: g,
                outputFactor: 10, exactOutputFactor: 1,
                buffs: [H.zone.buff({ pct: 1000, duration: NINE_HOURS, start: clockNow - 3600000 })]
            }));
            deps.push(H.zone.deposit({ name: 'HalloweenResource', grid: g, amount: 10 }));
        }
    }
    z.deposits('HalloweenResource', deps);
    H.installZone(z);

    var before = new Date().getTime();
    var game = H.Steward.core.events.refill.rows('HW');
    var after = new Date().getTime();
    t.assert.strictEqual(game.rows.length, 9);
    for (var r = 0; r < game.rows.length; r++) {
        t.assert.strictEqual(game.rows[r].perCycle, 1);
        t.assert.strictEqual(game.rows[r].buffedPerCycle, 10);
        t.assert.ok(game.rows[r].buffEndMs >= before + 28800000);
        t.assert.ok(game.rows[r].buffEndMs <= after + 28800000);
    }

    H.installZone(H.zone.zone());
    var tpl = H.Steward.core.events.refill.rows('HW');
    t.assert.strictEqual(tpl.rows.length, 9);
    for (var q = 0; q < tpl.rows.length; q++) {
        t.assert.strictEqual(tpl.rows[q].perCycle, 1);
        t.assert.strictEqual(tpl.rows[q].buffedPerCycle, null);
        t.assert.strictEqual(tpl.rows[q].buffEndMs, null);
    }
});
