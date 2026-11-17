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
    return { H: H, S: H.Steward, sent: sent, z: z, host: host, mineOpts: mineOpts };
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
    assert.strictEqual(s.host.upgrades.length, 0);
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

t.test('upgrading: true, false and null from IsUpgradeInProgress', function () {
    var s = setup();
    var up = s.S.core.construction.upgrading;
    assert.strictEqual(up(Z.building({ upgrading: true })), true);
    assert.strictEqual(up(Z.building({ upgrading: false })), false);
    assert.strictEqual(up(Z.building({})), null);
    assert.strictEqual(up(null), null);
});
