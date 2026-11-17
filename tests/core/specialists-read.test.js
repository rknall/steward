'use strict';

var t = require('../runner');
var harness = require('../harness');
var A = require('../stubs/army');
var specStubs = require('../stubs/specialists');

function spec(key, type) {
    return {
        GetType:     function () { return typeof type === 'number' ? type : 2; },
        GetTask:     function () { return null; },
        getPlayerID: function () { return 1; },
        GetUniqueID: function () { return { toKeyString: function () { return key; } }; }
    };
}

function zoneOf(list) {
    return { GetSpecialists_vector: function () { return list; } };
}

// A zone that counts how often its vector is read.
function countingZone(list) {
    var calls = 0;
    return {
        zone: { GetSpecialists_vector: function () { calls++; return list; } },
        reads: function () { return calls; }
    };
}

function boot() {
    return harness.boot({ sections: ['kernel', 'core'] });
}

// cSpecialist stand-in whose description for every type reports base.
function classWithBase(base) {
    return {
        GetSpecialistDescriptionForType: function () {
            return { getBaseType: function () { return base; } };
        }
    };
}

// ---- static definitions ---------------------------------------------------------

t.test('a throwing game.def once does not stick: the next call classifies type 51 as Explorer', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var calls = 0;
    H.host.game.def = function (name) {
        if (name !== 'Specialists::cSpecialist') return null;
        calls++;
        if (calls === 1) throw new Error('not ready');
        return classWithBase(1);
    };
    var s = spec('k1', 51);
    t.assert.strictEqual(c.classify(s), null);
    t.assert.strictEqual(c.classify(s), H.Steward.SpecialistType.Explorer);
});

t.test('a missing definition does not stick either, and a found one is read once', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var calls = 0;
    H.host.game.def = function (name) {
        if (name !== 'Specialists::cSpecialist') return null;
        calls++;
        return calls === 1 ? null : classWithBase(2);
    };
    var s = spec('k1', 77);
    t.assert.strictEqual(c.classify(s), null);
    t.assert.strictEqual(c.classify(s), H.Steward.SpecialistType.Geologist);
    var before = calls;
    c.classify(s);
    c.kindLabel(77);
    t.assert.strictEqual(calls, before);
});

// ---- listRead ---------------------------------------------------------------------

t.test('listRead is ok on a clean read', function () {
    var H = boot();
    var a = spec('k1');
    var r = H.Steward.core.specialists.listRead({ zone: zoneOf([a]) });
    t.assert.strictEqual(r.state, 'ok');
    t.assert.strictEqual(r.value.length, 1);
    t.assert.strictEqual(r.value[0], a);
    t.assert.strictEqual(r.lost, 0);
});

t.test('listRead is partial when an entry is dropped', function () {
    var H = boot();
    var ghost = spec('k2');
    delete ghost.GetTask;
    var r = H.Steward.core.specialists.listRead({ zone: zoneOf([spec('k1'), ghost, null]) });
    t.assert.strictEqual(r.state, 'partial');
    t.assert.strictEqual(r.value.length, 1);
    t.assert.strictEqual(r.lost, 2);
    t.assert.strictEqual(H.Steward.kernel.read.absent(r, function () { return false; }), false);
});

t.test('listRead is unreadable on a failed read and notReady without a zone', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var bad = [
        {},
        { GetSpecialists_vector: function () { return null; } },
        { GetSpecialists_vector: function () { throw new Error('boom'); } }
    ];
    for (var i = 0; i < bad.length; i++) {
        var r = c.listRead({ zone: bad[i] });
        t.assert.strictEqual(r.state, 'unreadable');
        t.assert.strictEqual(r.value, null);
    }
    H.host.game.gi.mCurrentPlayerZone = null;
    t.assert.strictEqual(c.listRead().state, 'notReady');
});

t.test('listRead is memoized in a pass, live outside', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var z = countingZone([spec('k1')]);
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.Steward.kernel.hostRead.pass(function () {
        t.assert.strictEqual(c.listRead().state, 'ok');
        t.assert.strictEqual(c.listRead().state, 'ok');
    });
    t.assert.strictEqual(z.reads(), 1);
    c.listRead();
    c.listRead();
    t.assert.strictEqual(z.reads(), 3);
    H.Steward.kernel.hostRead.pass(function () {
        c.listRead({ live: true });
        c.listRead({ live: true });
    });
    t.assert.strictEqual(z.reads(), 5);
});

t.test('the legacy readers stay live inside a pass', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var z = countingZone([spec('k1')]);
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.Steward.kernel.hostRead.pass(function () {
        c.listRead();
        c.all();
        c.byType(H.Steward.SpecialistType.Geologist);
        c.listComplete();
    });
    t.assert.strictEqual(z.reads(), 4);
});

// ---- byTypeRead -------------------------------------------------------------------

t.test('byTypeRead filters an ok list by type and keeps it ok', function () {
    var H = boot();
    var geo = spec('g1', 2);
    var expl = spec('e1', 1);
    var r = H.Steward.core.specialists.byTypeRead(H.Steward.SpecialistType.Geologist, { zone: zoneOf([geo, expl]) });
    t.assert.strictEqual(r.state, 'ok');
    t.assert.strictEqual(r.value.length, 1);
    t.assert.strictEqual(r.value[0], geo);
});

t.test('byTypeRead is partial when an entry cannot be classified', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var geo = spec('g1', 2);
    var odd = spec('x1', 51);   // needs the class definition, which reads null here
    var r = c.byTypeRead(H.Steward.SpecialistType.Geologist, { zone: zoneOf([geo, odd]) });
    t.assert.strictEqual(r.state, 'partial');
    t.assert.strictEqual(r.value.length, 1);
    t.assert.strictEqual(r.lost, 1);
    var gen = spec('c1', 0);
    gen.GetSpecialistDescription = function () {
        return { isTransportGeneral: function () { throw new Error('bridge'); } };
    };
    r = c.byTypeRead(H.Steward.SpecialistType.Geologist, { zone: zoneOf([geo, gen]) });
    t.assert.strictEqual(r.state, 'partial');
    t.assert.strictEqual(c.classify(gen), null);
});

t.test('byTypeRead keeps a non-has state of the list', function () {
    var H = boot();
    var r = H.Steward.core.specialists.byTypeRead(H.Steward.SpecialistType.Geologist, { zone: {} });
    t.assert.strictEqual(r.state, 'unreadable');
    t.assert.strictEqual(r.value, null);
});

// ---- status -----------------------------------------------------------------------

t.test('status is Unknown when GetTask throws or is gone', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var St = H.Steward.SpecialistStatus;
    t.assert.strictEqual(St.Unknown, 'StatusUnknown');
    var thrower = spec('k1');
    thrower.GetTask = function () { throw new Error('bridge'); };
    t.assert.strictEqual(c.status(thrower), St.Unknown);
    var gone = spec('k2');
    delete gone.GetTask;
    t.assert.strictEqual(c.status(gone), St.Unknown);
    var inUseThrows = spec('k3');
    inUseThrows.IsInUse = function () { throw new Error('bridge'); };
    t.assert.strictEqual(c.status(inUseThrows), St.Unknown);
    t.assert.strictEqual(c.status(spec('k4')), St.Idle);
    t.assert.strictEqual(c.status(null), St.Unavailable);
});

t.test('status is Working when a task is present and IsInUse throws', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var s = spec('k1');
    s.GetTask = function () { return {}; };
    s.IsInUse = function () { throw new Error('bridge'); };
    t.assert.strictEqual(c.status(s), H.Steward.SpecialistStatus.Working);
    var inUse = spec('k2');
    inUse.IsInUse = function () { return true; };
    t.assert.strictEqual(c.status(inUse), H.Steward.SpecialistStatus.Working);
});

t.test('busy and available exclude Unknown', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var idle = spec('g1');
    var working = spec('g2');
    working.GetTask = function () { return {}; };
    var unknown = spec('g3');
    unknown.GetTask = function () { throw new Error('bridge'); };
    var z = zoneOf([idle, working, unknown]);
    var Geo = H.Steward.SpecialistType.Geologist;
    var av = c.available(Geo, { zone: z });
    var bz = c.busy(Geo, { zone: z });
    t.assert.strictEqual(av.length, 1);
    t.assert.strictEqual(av[0], idle);
    t.assert.strictEqual(bz.length, 1);
    t.assert.strictEqual(bz[0], working);
    t.assert.strictEqual(c.isProspecting(unknown), false);
});

// ---- troop capacity and carrier flag ------------------------------------------------

t.test('troopCapacityOf is null when a getter throws', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    var a = spec('a', 0);
    a.GetMaxMilitaryUnits = function () { throw new Error('bridge'); };
    t.assert.strictEqual(c.troopCapacityOf(a), null);
    t.assert.strictEqual(c.troopCapacity(a), 0);
    var b = spec('b', 0);
    b.GetSpecialistDescription = function () {
        return { getMaxTroopCount: function () { throw new Error('bridge'); } };
    };
    t.assert.strictEqual(c.troopCapacityOf(b), null);
    var d = spec('d', 0);
    d.GetSpecialistDescription = function () { throw new Error('bridge'); };
    t.assert.strictEqual(c.troopCapacityOf(d), null);
    var e = spec('e', 0);
    e.GetMaxMilitaryUnits = function () { throw new Error('bridge'); };
    e.GetSpecialistDescription = function () {
        return { getMaxTroopCount: function () { return 250; } };
    };
    t.assert.strictEqual(c.troopCapacityOf(e), 250);
});

t.test('troopCapacityOf keeps the number paths of troopCapacity', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    t.assert.strictEqual(c.troopCapacityOf(null), 0);
    t.assert.strictEqual(c.troopCapacityOf(A.fighter({ uid: 'g', maxUnits: 270 })), 270);
    t.assert.strictEqual(c.troopCapacityOf(A.fighter({ uid: 'h', maxUnits: 0, descMax: 200 })), 200);
    t.assert.strictEqual(c.troopCapacity(A.fighter({ uid: 'i', descMax: 220 })), 220);
});

t.test('troopCapacityOf is 0 and carrierFlag false when the getters are absent (classify General, fighterList complete)', function () {
    var H = harness.boot();
    A.install(H, {});
    var c = H.Steward.core.specialists;
    var bare = spec('g1', 0);
    var withDesc = spec('g2', 0);
    withDesc.GetSpecialistDescription = function () { return {}; };
    t.assert.strictEqual(c.troopCapacityOf(bare), 0);
    t.assert.strictEqual(c.troopCapacityOf(withDesc), 0);
    t.assert.strictEqual(c.classify(bare), H.Steward.SpecialistType.General);
    t.assert.strictEqual(c.classify(withDesc), H.Steward.SpecialistType.General);
    var r = c.fighterList({ zone: zoneOf([bare, withDesc]) });
    t.assert.strictEqual(r.complete, true);
    t.assert.strictEqual(r.list.length, 2);
});

t.test('fighterList is incomplete when isTransportGeneral throws', function () {
    var H = harness.boot();
    A.install(H, {});
    var c = H.Steward.core.specialists;
    var good = A.fighter({ uid: 'g1' });
    var odd = A.fighter({ uid: 'g2' });
    odd.GetSpecialistDescription = function () {
        return { isTransportGeneral: function () { throw new Error('bridge'); } };
    };
    var r = c.fighterList({ zone: zoneOf([good, odd]) });
    t.assert.strictEqual(r.complete, false);
    t.assert.strictEqual(r.list.length, 1);
    t.assert.strictEqual(r.list[0], good);
    t.assert.strictEqual(c.classify(odd), null);
});

t.test('an explorer of unknown kind does not make fighterList incomplete', function () {
    var H = harness.boot();
    A.install(H, {});
    var list = [A.fighter({ uid: 'g1' }), specStubs.spec({ type: specStubs.TYPE.EXPLORER, uid: 'e1' })];
    var r = H.Steward.core.specialists.fighterList({ zone: zoneOf(list) });
    t.assert.strictEqual(r.complete, true);
    t.assert.strictEqual(r.list.length, 1);
});

t.test('specialist unreadable is a registered read refusal', function () {
    var H = boot();
    var c = H.Steward.core.specialists;
    t.assert.strictEqual(c.UNREADABLE, 'specialist unreadable');
    t.assert.strictEqual(H.Steward.kernel.read.isReadRefusal(c.UNREADABLE), true);
});
