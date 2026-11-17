'use strict';

var t = require('../runner');
var harness = require('../harness');
var AC = require('../stubs/actions');
var Z = require('../stubs/zone');

var assert = t.assert;

// A home zone holding one unrelated building (so the building list reads) and,
// when o.mine is set, a mine on grid 12. o.empty leaves the zone without any
// building, which the client reports the same way as an unreadable list.
function setup(o) {
    o = o || {};
    var H = harness.boot();
    var sent = AC.wire(H);
    var gi = H.host.game.gi;
    var z = Z.zone();
    var mineOpts = o.mine || null;
    var mine = null;
    if (!o.empty) z.building(Z.building({ name: 'Quarry', grid: 3 }));
    if (mineOpts) {
        mine = Z.building(mineOpts);
        z.building(mine);
    }
    z.mountOnPlayer((gi.mCurrentPlayer = {}));
    gi.mCurrentPlayerZone = z.zone;
    gi.isOnHomzone = function () { return o.home !== false; };
    gi.mCurrentViewedZoneID = 1;
    var host = { upgrades: [] };
    H.host.game.zone.UpgradeBuildingOnGridPosition = function (grid) {
        host.upgrades.push(grid);
        if (o.throwUpgrade) throw new Error('host refused');
    };
    if (o.noUpgradeMethod) delete H.host.game.zone.UpgradeBuildingOnGridPosition;
    return { H: H, S: H.Steward, sent: sent, z: z, host: host, mineOpts: mineOpts, mine: mine, gi: gi };
}

function run(s, def, drive) {
    var result = null;
    assert.strictEqual(s.S.core.actions.attempt(def, function (r) { result = r; }), true);
    AC.drive(s.H, drive || { max: 300 });
    return result;
}

function json(x) { return JSON.parse(JSON.stringify(x)); }

t.test('place: label, category, timeout and no retry', function () {
    var s = setup();
    var def = s.S.core.construction.place(50, 12, 'IronMine');
    assert.strictEqual(def.label, 'build IronMine 12');
    assert.strictEqual(def.category, 'construction');
    assert.strictEqual(def.timeoutMs, 30000);
    assert.strictEqual(def.retries, 0);
});

t.test('place: away from home is refused', function () {
    var s = setup({ home: false });
    assert.strictEqual(s.S.core.construction.place(50, 12, 'IronMine').precheck(), 'not on the home island');
});

t.test('place: an occupied grid is refused', function () {
    var s = setup({ mine: { name: 'IronMine', grid: 12 } });
    assert.strictEqual(s.S.core.construction.place(50, 12, 'IronMine').precheck(), 'grid occupied');
});

t.test('place: a zone without any building is unreadable, not empty', function () {
    var s = setup({ empty: true });
    assert.strictEqual(s.S.core.construction.place(50, 12, 'IronMine').precheck(), 'buildings unreadable');
});

t.test('place: a missing or non-positive building id is refused', function () {
    var s = setup();
    var c = s.S.core.construction;
    assert.strictEqual(c.place(undefined, 12, 'IronMine').precheck(), 'unknown building id');
    assert.strictEqual(c.place('50', 12, 'IronMine').precheck(), 'unknown building id');
    assert.strictEqual(c.place(0, 12, 'IronMine').precheck(), 'unknown building id');
});

t.test('place: an empty readable grid passes the precheck', function () {
    var s = setup();
    assert.strictEqual(s.S.core.construction.place(50, 12, 'IronMine').precheck(), null);
});

t.test('place: sends (50, id, grid, 0, null) once and verifies when the mine shows up', function () {
    var s = setup();
    var r = run(s, s.S.core.construction.place(50, 12, 'IronMine'), {
        max: 300,
        onStep: function () {
            if (s.sent.actions.length === 1 && !s.mineOpts) {
                s.mineOpts = { name: 'IronMine', grid: 12 };
                s.z.building(Z.building(s.mineOpts));
            }
        }
    });
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
    assert.deepStrictEqual(json(s.sent.actions), [{ id: 50, p1: 50, p2: 12, p3: 0, data: null }]);
});

t.test('place: a mine that never appears ends unseen after one send', function () {
    var s = setup();
    var r = run(s, s.S.core.construction.place(50, 12, 'IronMine'));
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.unseen, true);
    assert.strictEqual(r.sends, 1);
    assert.strictEqual(s.sent.actions.length, 1);
});

t.test('place: a mine already on the grid is verified with no send', function () {
    var s = setup({ mine: { name: 'IronMine', grid: 12 } });
    var r = run(s, s.S.core.construction.place(50, 12, 'IronMine'));
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 0);
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('upgrade: label, category, timeout and no retry', function () {
    var s = setup({ mine: { name: 'IronMine', grid: 12, level: 1 } });
    var def = s.S.core.construction.upgrade(12, 'IronMine', 2);
    assert.strictEqual(def.label, 'upgrade IronMine 12 to 2');
    assert.strictEqual(def.category, 'construction');
    assert.strictEqual(def.timeoutMs, 30000);
    assert.strictEqual(def.retries, 0);
});

t.test('upgrade: calls the host once and verifies on a running upgrade', function () {
    var o = { name: 'IronMine', grid: 12, level: 1, upgradable: true, upgrading: false };
    var s = setup({ mine: o });
    var r = run(s, s.S.core.construction.upgrade(12, 'IronMine', 2), {
        max: 300,
        onStep: function () { if (s.host.upgrades.length === 1) o.upgrading = true; }
    });
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
    assert.deepStrictEqual(s.host.upgrades, [12]);
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('upgrade: verifies when the level reaches the next one', function () {
    var o = { name: 'IronMine', grid: 12, level: 1, upgradable: true, upgrading: false };
    var s = setup({ mine: o });
    var r = run(s, s.S.core.construction.upgrade(12, 'IronMine', 2), {
        max: 300,
        onStep: function () { if (s.host.upgrades.length === 1) o.level = 2; }
    });
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(s.host.upgrades.length, 1);
});

t.test('upgrade: an upgrade that never shows ends unseen after one host call', function () {
    var s = setup({ mine: { name: 'IronMine', grid: 12, level: 1, upgradable: true, upgrading: false } });
    var r = run(s, s.S.core.construction.upgrade(12, 'IronMine', 2));
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.unseen, true);
    assert.strictEqual(r.sends, 1);
    assert.strictEqual(s.host.upgrades.length, 1);
});

t.test('upgrade: a building that cannot report an upgrade is refused', function () {
    var s = setup({ mine: { name: 'IronMine', grid: 12, level: 1, upgradable: true } });
    var r = run(s, s.S.core.construction.upgrade(12, 'IronMine', 2));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(r.reason, 'upgrade state unreadable');
    assert.strictEqual(s.S.kernel.read.isReadRefusal(r.reason), true);
    assert.strictEqual(s.host.upgrades.length, 0);
});

t.test('upgrade: a running upgrade is refused as already upgrading', function () {
    var s = setup({ mine: { name: 'IronMine', grid: 12, level: 1, upgradable: true, upgrading: true } });
    var def = s.S.core.construction.upgrade(12, 'IronMine', 3);
    assert.strictEqual(def.precheck(), 'already upgrading');
    assert.strictEqual(s.S.kernel.read.isReadRefusal('already upgrading'), false);
});

t.test('upgrade: a building that may not be upgraded is refused', function () {
    var s = setup({ mine: { name: 'IronMine', grid: 12, level: 1, upgradable: false, upgrading: false } });
    var r = run(s, s.S.core.construction.upgrade(12, 'IronMine', 2));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(r.reason, 'upgrade not allowed');
    assert.strictEqual(s.host.upgrades.length, 0);
});

t.test('upgrade: a different building on the grid is refused', function () {
    var s = setup({ mine: { name: 'Quarry', grid: 12, level: 1, upgradable: true, upgrading: false } });
    var r = run(s, s.S.core.construction.upgrade(12, 'IronMine', 2));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(r.reason, 'building changed');
    assert.strictEqual(s.host.upgrades.length, 0);
});

t.test('upgrade: away from home is refused', function () {
    var s = setup({ home: false, mine: { name: 'IronMine', grid: 12, level: 1, upgradable: true, upgrading: false } });
    assert.strictEqual(s.S.core.construction.upgrade(12, 'IronMine', 2).precheck(), 'not on the home island');
});

t.test('upgrade: a missing host method makes no send and is refused', function () {
    var s = setup({ noUpgradeMethod: true,
        mine: { name: 'IronMine', grid: 12, level: 1, upgradable: true, upgrading: false } });
    var r = run(s, s.S.core.construction.upgrade(12, 'IronMine', 2));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(r.reason, s.S.core.actions.NOT_SENT);
    assert.strictEqual(r.sends, 0);
});

t.test('upgrade: a throwing host call ends failed after one send and is not retried', function () {
    var s = setup({ throwUpgrade: true,
        mine: { name: 'IronMine', grid: 12, level: 1, upgradable: true, upgrading: false } });
    var r = run(s, s.S.core.construction.upgrade(12, 'IronMine', 2));
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.reason, 'send failed');
    assert.strictEqual(r.sends, 1);
    assert.strictEqual(s.host.upgrades.length, 1);
});

function upMine() {
    return { name: 'IronMine', grid: 12, level: 1, upgradable: true, upgrading: false };
}

// A precheck that refuses with a read refusal and a def that never verifies.
function assertReadRefused(s, def, reason) {
    var got = def.precheck();
    assert.strictEqual(got, reason);
    assert.strictEqual(s.S.kernel.read.isReadRefusal(got), true);
    assert.strictEqual(def.satisfied(), false);
    assert.strictEqual(def.check(), false);
}

t.test('place: a loading zone refuses as a read refusal and is never satisfied', function () {
    var s = setup({ mine: { name: 'IronMine', grid: 12 } });
    s.gi.mCurrentPlayerZone = null;
    var def = s.S.core.construction.place(50, 12, 'IronMine');
    assertReadRefused(s, def, s.S.core.zone.UNREADABLE);
    assert.strictEqual(def.observable(), false);
    var r = run(s, s.S.core.construction.place(50, 12, 'IronMine'));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('place: an unreadable viewed zone id refuses as a read refusal', function () {
    var s = setup({ mine: { name: 'IronMine', grid: 12 } });
    s.gi.mCurrentViewedZoneID = null;
    var def = s.S.core.construction.place(50, 12, 'IronMine');
    assertReadRefused(s, def, s.S.core.zone.UNREADABLE);
    assert.strictEqual(def.observable(), false);
});

t.test('place: buildings unreadable is a read refusal', function () {
    var s = setup({ empty: true });
    var reason = s.S.core.construction.place(50, 12, 'IronMine').precheck();
    assert.strictEqual(reason, 'buildings unreadable');
    assert.strictEqual(s.S.kernel.read.isReadRefusal(reason), true);
    assert.strictEqual(s.S.kernel.read.isReadRefusal('not on the home island'), false);
});

t.test('upgrade: a loading or unreadable zone refuses as a read refusal and never verifies', function () {
    var s = setup({ mine: { name: 'IronMine', grid: 12, level: 2, upgradable: true, upgrading: true } });
    s.gi.mCurrentPlayerZone = null;
    var def = s.S.core.construction.upgrade(12, 'IronMine', 2);
    assertReadRefused(s, def, s.S.core.zone.UNREADABLE);
    assert.strictEqual(def.observable(), false);

    var s2 = setup({ mine: { name: 'IronMine', grid: 12, level: 2, upgradable: true, upgrading: true } });
    s2.gi.mCurrentViewedZoneID = null;
    var def2 = s2.S.core.construction.upgrade(12, 'IronMine', 2);
    assertReadRefused(s2, def2, s2.S.core.zone.UNREADABLE);
    assert.strictEqual(def2.observable(), false);
});

t.test('upgrade: an unreadable level refuses and never counts as reached', function () {
    var s = setup({ mine: upMine() });
    var b = s.S.core.buildings.byGrid(12);
    b.GetUpgradeLevel = function () { throw new Error('no level'); };
    var def = s.S.core.construction.upgrade(12, 'IronMine', 0);
    assertReadRefused(s, def, 'upgrade level unreadable');
    var r = run(s, s.S.core.construction.upgrade(12, 'IronMine', 0));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(r.reason, 'upgrade level unreadable');
    assert.strictEqual(s.host.upgrades.length, 0);
});

t.test('upgrade: a missing or throwing IsUpgradeAllowed refuses as a read refusal', function () {
    var s = setup({ mine: upMine() });
    delete s.S.core.buildings.byGrid(12).IsUpgradeAllowed;
    var r = run(s, s.S.core.construction.upgrade(12, 'IronMine', 2));
    assert.strictEqual(r.status, s.S.ActionResult.Refused);
    assert.strictEqual(r.reason, 'upgrade permission unreadable');
    assert.strictEqual(s.S.kernel.read.isReadRefusal(r.reason), true);
    assert.strictEqual(s.host.upgrades.length, 0);

    var s2 = setup({ mine: upMine() });
    s2.S.core.buildings.byGrid(12).IsUpgradeAllowed = function () { throw new Error('no answer'); };
    var r2 = run(s2, s2.S.core.construction.upgrade(12, 'IronMine', 2));
    assert.strictEqual(r2.status, s2.S.ActionResult.Refused);
    assert.strictEqual(r2.reason, 'upgrade permission unreadable');
    assert.strictEqual(s2.host.upgrades.length, 0);
});

t.test('capacity: ok with the four counts, notReady without a player, unreadable for a non-number or throwing member', function () {
    var s = setup();
    var R = s.S.kernel.read;
    s.z.buildQueue(1, 3);
    var c = s.S.core.construction.capacity();
    assert.strictEqual(c.state, R.OK);
    assert.deepStrictEqual(json(c.value), { slotsTotal: 3, slotsUsed: 1, licMax: 100, licUsed: 1 });
    assert.strictEqual(c.zoneId, 1);

    var player = s.gi.mCurrentPlayer;
    player.mCurrentBuildingsCountAll = 'x';
    assert.strictEqual(s.S.core.construction.capacity().state, R.UNREADABLE);
    player.mCurrentBuildingsCountAll = 1;

    var slots = player.mBuildQueue.GetTotalAvailableSlots;
    player.mBuildQueue.GetTotalAvailableSlots = function () { return 'x'; };
    assert.strictEqual(s.S.core.construction.capacity().state, R.UNREADABLE);
    player.mBuildQueue.GetTotalAvailableSlots = function () { throw new Error('queue gone'); };
    assert.strictEqual(s.S.core.construction.capacity().state, R.UNREADABLE);
    player.mBuildQueue.GetTotalAvailableSlots = slots;

    var queue = player.mBuildQueue;
    player.mBuildQueue = null;
    assert.strictEqual(s.S.core.construction.capacity().state, R.UNREADABLE);
    player.mBuildQueue = queue;
    assert.strictEqual(s.S.core.construction.capacity().state, R.OK);

    s.gi.mCurrentPlayer = null;
    assert.strictEqual(s.S.core.construction.capacity().state, R.NOT_READY);
});

var SHELL = 'DepletedWell';

// A home zone with a depleted shell on grid 10 (constructing false unless
// o.shell says otherwise), a street map that calls it depleted (o.dep) and a
// build queue of o.used of o.slots.
function rebuildSetup(o) {
    o = o || {};
    var shellOpts = { name: SHELL, grid: 10, level: 1, constructing: false };
    for (var k in (o.shell || {})) shellOpts[k] = o.shell[k];
    var s = setup({ mine: shellOpts, home: o.home });
    s.shellOpts = shellOpts;
    s.z.buildQueue(typeof o.used === 'number' ? o.used : 1, typeof o.slots === 'number' ? o.slots : 3);
    var dep = o.dep === undefined ? function () { return true; } : o.dep;
    if (dep) s.z.zone.mStreetDataMap.IsADepletedDeposit = dep;
    return s;
}

function rebuildDef(s) {
    return s.S.core.construction.rebuild(176, 10, 'Well_03', SHELL);
}

t.test('rebuild: label, category, timeout and no retry', function () {
    var def = rebuildDef(rebuildSetup());
    assert.strictEqual(def.label, 'rebuild Well_03 10');
    assert.strictEqual(def.category, 'construction');
    assert.strictEqual(def.timeoutMs, 30000);
    assert.strictEqual(def.retries, 0);
});

t.test('rebuild: an idle depleted shell with a free slot passes the precheck', function () {
    assert.strictEqual(rebuildDef(rebuildSetup()).precheck(), null);
});

t.test('rebuild: precheck refuses off home and on an unreadable zone first', function () {
    var s = rebuildSetup({ home: false });
    assert.strictEqual(s.S.core.construction.rebuild('x', 10, 'Well_03', SHELL).precheck(),
                       'not on the home island');
    var s2 = rebuildSetup();
    s2.gi.mCurrentViewedZoneID = 'x';
    var r = s2.S.core.construction.rebuild('x', 10, 'Well_03', SHELL).precheck();
    assert.strictEqual(r, s2.S.core.zone.UNREADABLE);
    assert.strictEqual(s2.S.kernel.read.isReadRefusal(r), true);
});

t.test('rebuild: precheck refuses a missing building id', function () {
    var s = rebuildSetup();
    var c = s.S.core.construction;
    assert.strictEqual(c.rebuild(undefined, 10, 'Well_03', SHELL).precheck(), 'unknown building id');
    assert.strictEqual(c.rebuild('176', 10, 'Well_03', SHELL).precheck(), 'unknown building id');
    assert.strictEqual(c.rebuild(0, 10, 'Well_03', SHELL).precheck(), 'unknown building id');
});

t.test('rebuild: a throwing building list is a read refusal', function () {
    var s = rebuildSetup();
    s.z.zone.mStreetDataMap.GetBuildings_vector = function () { throw new Error('list gone'); };
    var r = rebuildDef(s).precheck();
    assert.strictEqual(r, 'buildings unreadable');
    assert.strictEqual(s.S.kernel.read.isReadRefusal(r), true);
});

t.test('rebuild: shell gone, constructing and depleted false or throwing are refused', function () {
    var s = rebuildSetup({ shell: { name: 'Well_03' } });
    assert.strictEqual(rebuildDef(s).precheck(), 'shell gone');
    var s2 = rebuildSetup({ shell: { constructing: true } });
    assert.strictEqual(rebuildDef(s2).precheck(), 'under construction');
    var s3 = rebuildSetup({ dep: function () { return false; } });
    assert.strictEqual(rebuildDef(s3).precheck(), 'not depleted');
    var s4 = rebuildSetup({ dep: function () { throw new Error('x'); } });
    var r = rebuildDef(s4).precheck();
    assert.strictEqual(r, s4.S.core.shells.DEPLETED_UNREADABLE);
    assert.strictEqual(s4.S.kernel.read.isReadRefusal(r), true);
});

t.test('rebuild: an unreadable or full build queue is refused', function () {
    var s = rebuildSetup();
    s.gi.mCurrentPlayer.mBuildQueue = null;
    var r = rebuildDef(s).precheck();
    assert.strictEqual(r, 'build queue unreadable');
    assert.strictEqual(s.S.kernel.read.isReadRefusal(r), true);
    var s2 = rebuildSetup({ used: 3, slots: 3 });
    var r2 = rebuildDef(s2).precheck();
    assert.strictEqual(r2, 'build queue full');
    assert.strictEqual(s2.S.kernel.read.isReadRefusal(r2), false);
});

t.test('rebuild: sends (50, id, grid, 0, null) once and verifies on another name', function () {
    var s = rebuildSetup();
    var r = run(s, rebuildDef(s), {
        max: 300,
        onStep: function () { if (s.sent.actions.length === 1) s.shellOpts.name = 'Well_03'; }
    });
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
    assert.deepStrictEqual(json(s.sent.actions), [{ id: 50, p1: 176, p2: 10, p3: 0, data: null }]);
});

t.test('rebuild: verifies when the shell goes under construction; log carries the diagnostic', function () {
    var s = rebuildSetup();
    var r = run(s, rebuildDef(s), {
        max: 300,
        onStep: function () {
            if (s.sent.actions.length === 1 && !s.shellOpts.constructing) {
                s.shellOpts.constructing = true;
                s.z.buildQueue(2, 3);
            }
        }
    });
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
    var line = s.H.logs().filter(function (l) {
        return l.category === 'construction' && String(l.args[0]).indexOf('rebuild Well_03 10') === 0;
    }).pop();
    var text = String(line.args[0]);
    assert.ok(text.indexOf('preplace ') >= 0, text);
    assert.ok(text.indexOf('lookup ') >= 0, text);
    assert.ok(text.indexOf('queue 1/3 -> 2/3') >= 0, text);
    assert.ok(text.indexOf('id 176') >= 0, text);
});

t.test('rebuild: a grid that empties or reads an empty name never verifies', function () {
    var s = rebuildSetup();
    var r = run(s, rebuildDef(s), {
        max: 300,
        onStep: function () { if (s.sent.actions.length === 1) s.shellOpts.grid = 99; }
    });
    assert.strictEqual(r.status, s.S.ActionResult.Failed);
    assert.strictEqual(r.unseen, true);
    assert.strictEqual(r.sends, 1);

    var s2 = rebuildSetup();
    var b = s2.S.core.buildings.byGrid(10);
    var r2 = run(s2, rebuildDef(s2), {
        max: 300,
        onStep: function () {
            if (s2.sent.actions.length === 1) b.GetBuildingName_string = function () { return ''; };
        }
    });
    assert.strictEqual(r2.status, s2.S.ActionResult.Failed);
    assert.strictEqual(r2.unseen, true);
    assert.strictEqual(s2.sent.actions.length, 1);
});

t.test('rebuild: a grid already rebuilt is satisfied with zero sends', function () {
    var s = rebuildSetup({ shell: { name: 'Well_03' } });
    var r = run(s, rebuildDef(s));
    assert.strictEqual(r.status, s.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 0);
    assert.strictEqual(s.sent.actions.length, 0);
});

t.test('rebuild: never satisfied or observable off a readable home view', function () {
    var s = rebuildSetup({ shell: { name: 'Well_03' } });
    s.gi.mCurrentPlayerZone = null;
    var def = rebuildDef(s);
    assert.strictEqual(def.satisfied(), false);
    assert.strictEqual(def.check(), false);
    assert.strictEqual(def.observable(), false);
});

t.test('rebuild: failedProof only on the idle shell at home', function () {
    var s = rebuildSetup();
    var def = rebuildDef(s);
    assert.strictEqual(def.failedProof(), 'grid 10 still shows ' + SHELL + ', not under construction');
    s.shellOpts.constructing = true;
    assert.strictEqual(def.failedProof(), null);
    s.shellOpts.constructing = false;
    s.shellOpts.name = 'Well_03';
    assert.strictEqual(def.failedProof(), null);
    s.shellOpts.name = SHELL;
    s.z.zone.mStreetDataMap.IsADepletedDeposit = function () { throw new Error('x'); };
    assert.strictEqual(def.failedProof(), null);
    s.z.zone.mStreetDataMap.IsADepletedDeposit = function () { return true; };
    s.gi.mCurrentPlayerZone = null;
    assert.strictEqual(def.failedProof(), null);
});

t.test('rebuild: describe never throws without a baseline', function () {
    var s = rebuildSetup();
    var text = rebuildDef(s).describe(undefined);
    assert.ok(text.indexOf('queue ? -> 1/3') >= 0, text);
});
