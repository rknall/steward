'use strict';

var t = require('../runner');
var harness = require('../harness');

t.test('plan no-ops when module is disabled', function () {
    var H = harness.boot();
    H.settings.write('mining', { enabled: false });
    var mod = H.module('mining');
    t.assert.ok(mod, 'mining module should be registered');
    mod.plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('plan visits each phase function for mine-bearing types', function () {
    var H = harness.boot();
    var calls = { build: 0, upgrade: 0, pause: 0, buff: 0, refill: 0 };
    H.Steward.modules.mining._phases = {
        tryBuild:   function () { calls.build++; },
        tryUpgrade: function () { calls.upgrade++; },
        tryPause:   function () { calls.pause++; },
        tryBuff:    function () { calls.buff++; },
        tryRefill:  function () { calls.refill++; }
    };
    var z = H.zone.zone()
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('mining', { enabled: true });
    H.module('mining').plan({ zone: { isHome: true } });
    // 6 mine-bearing types: build/upgrade/pause each called 6 times.
    t.assert.strictEqual(calls.build,   6);
    t.assert.strictEqual(calls.upgrade, 6);
    t.assert.strictEqual(calls.pause,   6);
    // buff and refill apply to all 9 deposit types.
    t.assert.strictEqual(calls.buff,   9);
    t.assert.strictEqual(calls.refill, 9);
});

function onlyMiningEnabled(depositName, build) {
    var names = ['Stone', 'BronzeOre', 'Marble', 'IronOre', 'GoldOre',
                 'Coal', 'Granite', 'TitaniumOre', 'Salpeter'];
    var deposits = {};
    for (var i = 0; i < names.length; i++) {
        var entry = { enabled: false, build: false, upgrade: false,
                      targetLevel: 3, pause: false, buff: '', refill: '' };
        if (names[i] === depositName) { entry.enabled = true; entry.build = !!build; }
        deposits[names[i]] = entry;
    }
    return { enabled: true, actionDelay: 0, deposits: deposits };
}

t.test('tryBuild enqueues nothing when no on-map deposits exist', function () {
    var H = harness.boot();
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .buildQueue(0, 4)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('mining', onlyMiningEnabled('IronOre', true));
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('tryBuild enqueues one mining.buildMine per fresh deposit', function () {
    var H = harness.boot();
    var depo = H.zone.deposit({ name: 'IronOre', grid: 12 });
    var z = H.zone.zone()
        .deposits('IronOre', [depo])
        .buildQueue(0, 4)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('mining', onlyMiningEnabled('IronOre', true));
    H.module('mining').plan({ zone: { isHome: true } });
    var q = H.queued();
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].name, 'mining.buildMine');
    t.assert.strictEqual(q[0].params[1], 12);                 // grid
    t.assert.strictEqual(q[0].params[3], 'IronMine');         // mineName
});

t.test('tryBuild skips deposit grids that already host a building', function () {
    var H = harness.boot();
    var depo = H.zone.deposit({ name: 'IronOre', grid: 7 });
    var existing = H.zone.building({ name: 'IronMine', grid: 7 });
    var z = H.zone.zone()
        .deposits('IronOre', [depo])
        .building(existing)
        .buildQueue(0, 4)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('mining', onlyMiningEnabled('IronOre', true));
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('tryBuild skips when build queue has no remaining slots', function () {
    var H = harness.boot();
    var depo = H.zone.deposit({ name: 'IronOre', grid: 12 });
    var z = H.zone.zone()
        .deposits('IronOre', [depo])
        .buildQueue(4, 4)                                    // queue full
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('mining', onlyMiningEnabled('IronOre', true));
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('tryBuild skips when build flag is false for the deposit', function () {
    var H = harness.boot();
    var depo = H.zone.deposit({ name: 'IronOre', grid: 12 });
    var z = H.zone.zone()
        .deposits('IronOre', [depo])
        .buildQueue(0, 4)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('mining', onlyMiningEnabled('IronOre', false));   // build:false
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

// --- tryUpgrade ---------------------------------------------------------

function withMineOnDeposit(depoName, gridN, mineName, level, upgradable, settingsTweaks) {
    var H = harness.boot();
    var depo = H.zone.deposit({ name: depoName, grid: gridN });
    var mine = H.zone.building({
        name:       mineName,
        grid:       gridN,
        level:      typeof level === 'number' ? level : 0,
        upgradable: typeof upgradable === 'undefined' ? true : !!upgradable
    });
    var z = H.zone.zone()
        .deposits(depoName, [depo])
        .building(mine)
        .buildQueue(0, 4)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var settings = onlyMiningEnabled(depoName, false);
    settings.deposits[depoName].upgrade     = true;
    settings.deposits[depoName].targetLevel = 3;
    if (settingsTweaks) {
        for (var k in settingsTweaks) settings.deposits[depoName][k] = settingsTweaks[k];
    }
    H.settings.write('mining', settings);
    return H;
}

t.test('tryUpgrade enqueues mining.upgradeMine when level below target', function () {
    var H = withMineOnDeposit('IronOre', 12, 'IronMine', 1, true);
    H.module('mining').plan({ zone: { isHome: true } });
    var q = H.queued();
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].name, 'mining.upgradeMine');
    t.assert.strictEqual(q[0].params[0], 12);             // grid
    t.assert.strictEqual(q[0].params[1], 'IronMine');     // mineName
    t.assert.strictEqual(q[0].params[2], 2);              // nextLevel = current + 1
});

t.test('tryUpgrade skips when current level already at target', function () {
    var H = withMineOnDeposit('IronOre', 12, 'IronMine', 3, true);
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('tryUpgrade skips when IsUpgradeAllowed is false', function () {
    var H = withMineOnDeposit('IronOre', 12, 'IronMine', 1, false);
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('tryUpgrade skips when upgrade flag is false in settings', function () {
    var H = withMineOnDeposit('IronOre', 12, 'IronMine', 1, true, { upgrade: false });
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('tryUpgrade skips when build queue has no remaining slots', function () {
    var H = harness.boot();
    var depo = H.zone.deposit({ name: 'IronOre', grid: 12 });
    var mine = H.zone.building({ name: 'IronMine', grid: 12, level: 1, upgradable: true });
    var z = H.zone.zone()
        .deposits('IronOre', [depo])
        .building(mine)
        .buildQueue(4, 4)                             // queue full
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var settings = onlyMiningEnabled('IronOre', false);
    settings.deposits.IronOre.upgrade     = true;
    settings.deposits.IronOre.targetLevel = 3;
    H.settings.write('mining', settings);
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

// --- tryPause -----------------------------------------------------------

// Build a single-IronOre fixture with both deposit and mine on the same grid.
// Pause-direction tests rely on deposit.GetAmount() — walking buildings alone
// is not enough since the threshold gate reads the deposit's remaining count.
function withPauseFixture(opts) {
    var H = harness.boot();
    var depo = H.zone.deposit({
        name:   'IronOre',
        grid:   12,
        amount: typeof opts.amount === 'number' ? opts.amount : 100
    });
    var mine = H.zone.building({
        name:      'IronMine',
        grid:      12,
        producing: typeof opts.producing === 'undefined' ? true : !!opts.producing
    });
    var z = H.zone.zone()
        .deposits('IronOre', [depo])
        .building(mine)
        .buildQueue(0, 4)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var settings = onlyMiningEnabled('IronOre', false);
    settings.actionDelay = 0;
    if (typeof opts.threshold === 'number') settings.pauseThreshold = opts.threshold;
    if (typeof opts.pause !== 'undefined') {
        settings.deposits.IronOre.pause = opts.pause;
    } else {
        delete settings.deposits.IronOre.pause;
    }
    H.settings.write('mining', settings);
    return H;
}

t.test('tryPause pauses producing mine when cfg.pause=true and amount < threshold', function () {
    var H = withPauseFixture({ pause: true, producing: true, amount: 20 });   // threshold default 50
    H.module('mining').plan({ zone: { isHome: true } });
    var q = H.queued();
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].name, 'mining.setProduction');
    t.assert.strictEqual(q[0].params[0], 12);
    t.assert.strictEqual(q[0].params[1], 'IronMine');
    t.assert.strictEqual(q[0].params[2], false);          // active = false (paused)
});

t.test('tryPause does NOT pause when cfg.pause=true but amount >= threshold', function () {
    var H = withPauseFixture({ pause: true, producing: true, amount: 80 });   // above default 50
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('tryPause threshold is configurable globally via pauseThreshold', function () {
    // amount 80 is above default 50 (would skip), but with threshold 100 it pauses.
    var H = withPauseFixture({ pause: true, producing: true, amount: 80, threshold: 100 });
    H.module('mining').plan({ zone: { isHome: true } });
    var q = H.queued();
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].params[2], false);
});

t.test('tryPause does nothing when cfg.pause=false (manual user pauses preserved)', function () {
    // Steward only undoes what Steward did. Auto-unpause is a job for
    // tryRefill (when refill crosses the threshold), not tryPause. With
    // cfg.pause=false the phase is fully inert for that type.
    var H = withPauseFixture({ pause: false, producing: false, amount: 200 });
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('tryPause skips when mine already in desired state', function () {
    // pause=true, mine already paused, amount low → already in desired state.
    var H = withPauseFixture({ pause: true, producing: false, amount: 10 });
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('tryPause skips when no deposits of this type on map', function () {
    var H = harness.boot();
    var z = H.zone.zone()
        .buildQueue(0, 4)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var settings = onlyMiningEnabled('IronOre', false);
    settings.actionDelay              = 0;
    settings.deposits.IronOre.pause   = true;
    H.settings.write('mining', settings);
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('tryPause skips when cfg.pause is undefined', function () {
    var H = withPauseFixture({ producing: true, amount: 10 });   // pause is undefined
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});
