'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var A = require('../stubs/army');
var AC = require('../stubs/actions');
var Z = require('../stubs/zone');

var assert = t.assert;

function bdef(type, targets) {
    return {
        GetTargetDescription_string: function () { return targets || ''; },
        GetTargetGroup_string:       function () { return ''; },
        GetBuffType:                 function () { return type; }
    };
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

// A booted setup with an in-memory disk, a packet recorder, a controllable
// clock (the dump file name carries the epoch ms) and a zone holding the
// given buildings. The caller restores the clock.
function setup(buildings) {
    var RealDate = Date;
    var clock = { now: 1000000 };
    function FakeDate(a) {
        if (arguments.length) return new RealDate(a);
        return new RealDate(clock.now);
    }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = function () { return clock.now; };
    global.Date = FakeDate;

    var fs = airfs.make();
    var H = harness.boot({ host: { air: fs.air } });
    A.install(H, {
        buffs: [{ type: 'MineBuff', amount: 2, uid: 'u1' }, { type: 'ZoneBuff', amount: 1 }],
        buffDefs: { MineBuff: bdef(0, 'Workyard'), ZoneBuff: bdef(8, 'IronMine, Workyard') }
    });
    var sent = AC.wire(H);
    var z = H.zone.zone();
    for (var i = 0; i < buildings.length; i++) z.building(buildings[i]);
    H.installZone(z);
    H.Steward.core.zone.isHome = function () { return true; };
    return {
        H: H, fs: fs, clock: clock, sent: sent,
        mb: H.Steward.modules.diagnostics.mineBuffs,
        restore: function () { global.Date = RealDate; }
    };
}

function withSetup(buildings, fn) {
    var s = setup(buildings);
    try { fn(s); } finally { s.restore(); }
}

function files(s) {
    return Object.keys(s.fs.disk).filter(function (k) {
        return /\/steward\/dumps\/minebuffs-[A-Za-z0-9_-]+-\d+\.json$/.test(k);
    });
}

function typeOf(doc, deposit) {
    for (var i = 0; i < doc.types.length; i++) if (doc.types[i].deposit === deposit) return doc.types[i];
    return null;
}

function mine(grid, extra) {
    var o = { name: 'IronMine', grid: grid, level: 2, productionState: 0, upgrading: false };
    for (var k in extra) o[k] = extra[k];
    return Z.building(o);
}

t.test('record lists every mine and mason with state, block and presence flags', function () {
    withSetup([mine(9), mine(3, { upgrading: true }), Z.building({ name: 'Mason', grid: 4 })], function (s) {
        var doc = plain(s.mb.record());
        assert.strictEqual(doc.home, true);
        var iron = typeOf(doc, 'IronOre');
        assert.strictEqual(iron.building, 'IronMine');
        assert.deepStrictEqual(iron.buildings.map(function (b) { return b.grid; }), [3, 9]);
        assert.strictEqual(iron.buildings[0].level, 2);
        assert.ok(iron.buildings[0].block);
        assert.strictEqual(iron.buildings[1].block, null);
        assert.strictEqual(iron.buildings[1].state.productionState, 0);
        assert.strictEqual(iron.buildings[1].state.blockers[0].present, true);
        assert.strictEqual(iron.buildings[1].productionBuff, null);
        assert.strictEqual(typeOf(doc, 'Stone').building, 'Mason');
        assert.strictEqual(typeOf(doc, 'Stone').buildings.length, 1);
        assert.strictEqual(typeOf(doc, 'BronzeOre').buildings.length, 0);
        assert.strictEqual(Object.keys(doc.settings).length, doc.types.length);
    });
});

t.test('record lists candidates with buff type and offered flag, same as buildingBuffs', function () {
    withSetup([mine(1)], function (s) {
        var doc = plain(s.mb.record());
        var cand = typeOf(doc, 'IronOre').candidates;
        var buffs = s.H.Steward.core.buffs;
        assert.deepStrictEqual(cand, plain(buffs.buildingBuffCandidates('IronMine', true)));
        var byName = {};
        cand.forEach(function (c) { byName[c.name] = c; });
        assert.strictEqual(byName.MineBuff.offered, true);
        assert.strictEqual(byName.MineBuff.buffType, 0);
        assert.strictEqual(byName.ZoneBuff.offered, false);
        assert.strictEqual(byName.ZoneBuff.buffType, 8);
        var offered = cand.filter(function (c) { return c.offered; }).map(function (c) { return c.name; });
        var viaApi = plain(buffs.buildingBuffs('IronMine', true).map(function (c) { return c.name; }));
        assert.deepStrictEqual(offered, viaApi);
    });
});

t.test('record includes inventory GetType, GetBuffType, targets and stock', function () {
    withSetup([], function (s) {
        var doc = plain(s.mb.record());
        assert.deepStrictEqual(doc.inventory.map(function (e) { return e.type; }), ['MineBuff', 'ZoneBuff']);
        assert.strictEqual(doc.inventory[0].buffType, 0);
        assert.strictEqual(doc.inventory[0].amount, 2);
        assert.deepStrictEqual(doc.inventory[0].targets, ['Workyard']);
        assert.strictEqual(doc.inventory[1].buffType, 8);
        assert.deepStrictEqual(doc.inventory[1].targets, ['IronMine', 'Workyard']);
    });
});

t.test('dump writes a timestamped file and two dumps do not overwrite', function () {
    withSetup([mine(1)], function (s) {
        s.mb.dump();
        s.clock.now += 5;
        s.mb.dump();
        var found = files(s);
        assert.strictEqual(found.length, 2);
        assert.ok(found.some(function (k) { return /-1000000\.json$/.test(k); }));
        assert.ok(found.some(function (k) { return /-1000005\.json$/.test(k); }));
        var doc = JSON.parse(s.fs.disk[found[0]]);
        assert.strictEqual(typeOf(doc, 'IronOre').buildings.length, 1);
    });
});

t.test('dump logs the document in chunks when no folder is writable', function () {
    withSetup([mine(1)], function (s) {
        s.H.Steward.kernel.files.stewardDir = function () { return null; };
        s.H.clearLogs();
        s.mb.dump();
        assert.strictEqual(files(s).length, 0);
        var logs = s.H.logs().filter(function (l) { return l.category === 'diag:minebuffs'; });
        assert.ok(logs.some(function (l) { return /^IronOre 1\/\d+: /.test(String(l.args[0])); }));
    });
});

t.test('dump never sends a packet', function () {
    withSetup([mine(1)], function (s) {
        s.mb.dump();
        assert.strictEqual(s.sent.actions.length, 0);
        assert.strictEqual(s.sent.messages.length, 0);
        assert.strictEqual(s.H.queued().length, 0);
    });
});

t.test('dump survives a throwing building', function () {
    var bad = mine(5);
    withSetup([mine(1), bad], function (s) {
        bad.GetUpgradeLevel = function () { throw new Error('boom'); };
        bad.GetGrid = function () { throw new Error('boom'); };
        s.H.Steward.core.buffs.inventory = function () { throw new Error('inv'); };
        s.mb.dump();
        var found = files(s);
        assert.strictEqual(found.length, 1);
        var doc = JSON.parse(s.fs.disk[found[0]]);
        assert.ok(/inv/.test(doc.inventory.error));
        assert.ok(typeOf(doc, 'IronOre').buildings.length >= 1);
    });
});
