'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var A = require('../stubs/army');
var AC = require('../stubs/actions');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function def(name, group, category, extra) {
    var d = { resourceName_string: name, tradable: true, requiredEventName_string: '' };
    if (group !== null) d.group_string = group;
    if (category !== null) d.category_string = category;
    for (var k in extra) d[k] = extra[k];
    return d;
}

// Wood needs a non-empty category, or the mayor's house would list it.
var DEFS = [
    def('Wood', 'CL1', 'Basic'),
    def('EliteThing', 'CL5', 'Elite'),
    def('EggX', 'Event', '', { requiredEventName_string: 'Easter' }),
    def('Barrel', '', ''),
    def('Trophy', 'Collectibles', 'Food'),
    def('DefThing', 'DEF_MODE', 'Basic'),
    def('CrystalShard', '', 'Intermediates', { tradable: false }),
    def('NoGroup', null, 'Food'),
    def('StarfallStarDust', 'CL1', 'Basic', { tradable: false })
];

// Held amounts above zero, or the mayor's house skips the row. Only Wood
// carries a vector group, and it differs from the definition's.
var HELD = [
    { name_string: 'Wood', amount: 10, group_string: 'CL9' },
    { name_string: 'EggX', amount: 5 },
    { name_string: 'Barrel', amount: 3 },
    { name_string: 'Trophy', amount: 2 },
    { name_string: 'CrystalShard', amount: 1 },
    { name_string: 'StarfallStarDust', amount: 4 }
];

// A booted setup with an in-memory disk, a packet recorder and a controllable
// clock. The caller restores the clock.
function setup() {
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
    var ADD = H.Steward.core.buffs.ADD_RESOURCE_TYPE;
    A.install(H, {
        buffs: [
            { type: ADD, resource: 'Wood', amount: 100, uid: 'a1' },
            { type: ADD, resource: 'Wood', amount: 50, uid: 'a2' },
            { type: ADD, resource: 'StarfallStarDust', amount: 5, uid: 'a3' },
            { type: 'MineBuff', amount: 2, uid: 'u1' }
        ],
        buffDefs: {}
    });
    var sent = AC.wire(H);

    var prevDef = H.host.game.def;
    var byName = {};
    DEFS.forEach(function (d) { byName[d.resourceName_string] = d; });
    H.host.game.def = function (name) {
        if (name === 'ServerState::gEconomics') {
            return {
                mResourceDefaultDefinition_vector: DEFS,
                GetResourcesDefaultDefinition: function (n) { return byName[n] || null; }
            };
        }
        return prevDef(name);
    };
    H.host.game.getResources = function () {
        return {
            GetPlayerResources_vector: function () { return HELD; },
            GetResourceAmount: function (n) {
                for (var i = 0; i < HELD.length; i++) if (HELD[i].name_string === n) return HELD[i].amount;
                return 0;
            },
            GetWareHouseCapacity: function () { return 5000; },
            GetMaxStarCap: function (n) { return n === 'StarfallStarDust' ? 900 : 0; },
            GetMaxBroken: function () { throw new Error('no such getter'); }
        };
    };
    H.ctx.assets = {
        GetResourceIcon: function () { return { bitmapData: { width: 32, height: 32 } }; },
        GetBitmapData: function () { return null; }
    };
    H.ctx.ResourceGroupToWarehouseTab = { CL1: 'WarehouseTab1', Event: 'WarehouseTab6' };
    H.Steward.core.zone.isHome = function () { return true; };
    return {
        H: H, fs: fs, clock: clock, sent: sent,
        sh: H.Steward.modules.diagnostics.storehouse,
        restore: function () { global.Date = RealDate; }
    };
}

function withSetup(fn) {
    var s = setup();
    try { fn(s); } finally { s.restore(); }
}

function files(s) {
    return Object.keys(s.fs.disk).filter(function (k) {
        return /\/steward\/dumps\/storehouse-[A-Za-z0-9_-]+-\d+\.json$/.test(k);
    });
}

function byName(list, name) {
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
    return null;
}

t.test('record maps each definition to the trader tab', function () {
    withSetup(function (s) {
        var d = plain(s.sh.record()).definitions;
        assert.strictEqual(byName(d, 'Wood').tabKey, 'WarehouseTab1');
        assert.strictEqual(byName(d, 'EliteThing').tabKey, 'WarehouseTab8');
        assert.strictEqual(byName(d, 'EggX').tabKey, 'WarehouseTab6');
        assert.strictEqual(byName(d, 'Barrel').tabKey, 'WarehouseTab7');
        assert.strictEqual(byName(d, 'Trophy').tabKey, 'WarehouseTab7');
        assert.strictEqual(byName(d, 'DefThing').tabKey, 'DEF_MODE');
        assert.strictEqual(byName(d, 'CrystalShard').tabKey, 'Intermediates');
        assert.strictEqual(byName(d, 'NoGroup').group, null);
        assert.strictEqual(byName(d, 'NoGroup').tabKey, 'Food');
    });
});

t.test('record reads the warehouse cap and cap-like getters', function () {
    withSetup(function (s) {
        var c = plain(s.sh.record()).capacity;
        assert.strictEqual(c.warehouse, 5000);
        assert.ok(c.methods.indexOf('GetMaxStarCap') >= 0);
        assert.ok(c.methods.indexOf('GetMaxBroken') >= 0);
        assert.strictEqual(c.perItem.StarfallStarDust.GetMaxStarCap, 900);
        assert.ok(c.global.GetMaxBroken.error);
    });
});

t.test('record lists held rows with vector and definition fields', function () {
    withSetup(function (s) {
        var doc = plain(s.sh.record());
        var wood = byName(doc.held, 'Wood');
        assert.strictEqual(wood.vector.group, 'CL9');
        assert.strictEqual(wood.def.group, 'CL1');
        assert.strictEqual(wood.mayorHouse, false);
        assert.strictEqual(byName(doc.held, 'Barrel').mayorHouse, true);
        assert.strictEqual(byName(doc.held, 'EggX').mayorHouse, true);
        assert.deepStrictEqual(wood.icon.resourceIcon, { kind: 'bitmap', w: 32, h: 32 });
        assert.strictEqual(wood.icon.bitmapData, null);
        assert.ok(doc.heldItemKeys);
        assert.deepStrictEqual(doc.hostTabMap, { CL1: 'WarehouseTab1', Event: 'WarehouseTab6' });
    });
});

t.test('record sums star AddResource entries per resource', function () {
    withSetup(function (s) {
        var star = plain(s.sh.record()).star;
        assert.strictEqual(star.length, 2);
        var wood = star.filter(function (r) { return r.resource === 'Wood'; })[0];
        assert.strictEqual(wood.amount, 150);
        assert.strictEqual(wood.entries, 2);
        assert.strictEqual(wood.held, true);
        var dust = star.filter(function (r) { return r.resource === 'StarfallStarDust'; })[0];
        assert.strictEqual(dust.amount, 5);
        assert.ok(!star.some(function (r) { return r.resource === 'MineBuff'; }));
    });
});

t.test('summary lists where trader and mayor\'s house differ', function () {
    withSetup(function (s) {
        var sum = plain(s.sh.record()).summary;
        assert.ok(sum.groupEmptyCategorySet.indexOf('CrystalShard') >= 0);
        assert.ok(sum.collectiblesNotMayor.indexOf('Trophy') >= 0);
        assert.ok(sum.mayorNotCollectibles.indexOf('EggX') >= 0);
        assert.deepStrictEqual(sum.vectorGroupDiffers, ['Wood']);
    });
});

t.test('dump writes a timestamped file and two dumps do not overwrite', function () {
    withSetup(function (s) {
        s.sh.dump();
        s.clock.now += 5;
        s.sh.dump();
        var found = files(s);
        assert.strictEqual(found.length, 2);
        assert.ok(found.some(function (k) { return /-1000000\.json$/.test(k); }));
        assert.ok(found.some(function (k) { return /-1000005\.json$/.test(k); }));
        var doc = JSON.parse(s.fs.disk[found[0]]);
        assert.strictEqual(doc.capacity.warehouse, 5000);
    });
});

t.test('dump logs the document in chunks when no folder is writable', function () {
    withSetup(function (s) {
        s.H.Steward.kernel.files.stewardDir = function () { return null; };
        s.H.clearLogs();
        s.sh.dump();
        assert.strictEqual(files(s).length, 0);
        var logs = s.H.logs().filter(function (l) { return l.category === 'diag:storehouse'; });
        assert.ok(logs.some(function (l) { return /^head 1\/\d+: /.test(String(l.args[0])); }));
    });
});

t.test('dump never sends a packet', function () {
    withSetup(function (s) {
        s.sh.dump();
        assert.strictEqual(s.sent.actions.length, 0);
        assert.strictEqual(s.sent.messages.length, 0);
        assert.strictEqual(s.H.queued().length, 0);
    });
});

t.test('dump survives a throwing host', function () {
    withSetup(function (s) {
        var prev = s.H.host.game.def;
        s.H.host.game.def = function (name) {
            if (name === 'ServerState::gEconomics') throw new Error('econ');
            return prev(name);
        };
        s.H.host.game.getResources = function () { throw new Error('res'); };
        s.sh.dump();
        var found = files(s);
        assert.strictEqual(found.length, 1);
        var doc = JSON.parse(s.fs.disk[found[0]]);
        assert.ok(/econ/.test(doc.definitions.error));
        assert.ok(/res/.test(doc.capacity.error));
    });
});

t.test('record without assets gives null icons', function () {
    withSetup(function (s) {
        delete s.H.ctx.assets;
        var doc = plain(s.sh.record());
        assert.ok(doc.held.length > 0);
        doc.held.forEach(function (r) { assert.strictEqual(r.icon, null); });
    });
});
