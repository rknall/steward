'use strict';

var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');
var A = require('../stubs/army');
var AC = require('../stubs/actions');
var Z = require('../stubs/zone');

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

t.test('mining.setProduction sends a verified pause through sendAction', function () {
    var H = harness.boot();
    var state = { on: true };
    var mine = H.zone.building({ name: 'IronMine', grid: 12 });
    mine.IsProductionActive = function () { return state.on; };
    H.installZone(H.zone.zone().building(mine).buildQueue(0, 4));
    var sent = AC.wire(H);
    // The host takes the absolute state action 107 asks for.
    var gi = H.host.game.gi;
    var base = gi.SendServerAction;
    gi.SendServerAction = function (id, p1) {
        base.apply(this, arguments);
        if (id === 107) state.on = p1 === 1;
    };
    // The registered handler, captured while the module boots.
    var q = H.Steward.kernel.queue;
    var orig = q.action;
    var fn = null;
    q.action = function (name, f) {
        if (name === 'mining.setProduction') fn = f;
        return orig.apply(q, arguments);
    };
    H.module('mining').boot();
    q.action = orig;

    H.clearQueued();
    fn([12, 'IronMine', false]);
    AC.drive(H);
    t.assert.deepStrictEqual(JSON.parse(JSON.stringify(sent.actions)),
        [{ id: 107, p1: 0, p2: 12, p3: 0, data: null }]);
    var paused = H.logs().filter(function (l) {
        return l.level === 'log' && l.category === 'mining' &&
               l.args.join(' ') === 'paused IronMine on grid 12';
    });
    t.assert.strictEqual(paused.length, 1);
});

t.test('tryBuild enqueues nothing when byType fails', function () {
    var H = harness.boot();
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .buildQueue(0, 4)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    z.zone.mStreetDataMap.getDeposits_vectorByType = function () {
        throw new Error('[undefined] is not a function');
    };
    H.settings.write('mining', onlyMiningEnabled('IronOre', true));
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

// --- dashboard surface ----------------------------------------------------

// The settings column (side) or the main column (render) of the module,
// built with the real helpers over the element-tree jq fake.
function build(H, part) {
    jq.install(H);
    var $el = H.ctx.$('<div>');
    H.Steward.modules.mining[part]($el, H.Steward.kernel.ui.helpers);
    return $el;
}

// The table row whose first cell carries the raw `name` as its tooltip.
function rowFor($el, name) {
    var $rows = $el.find('tbody tr');
    for (var i = 0; i < $rows.length; i++) {
        if ($rows.eq(i).find('td').eq(0).attr('title') === name) return $rows.eq(i);
    }
    return null;
}

function mountQueue(H, used, max, buildings) {
    var z = H.zone.zone().buildQueue(used, max);
    for (var i = 0; i < (buildings || []).length; i++) z.building(buildings[i]);
    z.mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
}

t.test('mining registers on its own tab with a screen spec', function () {
    var mod = harness.boot().module('mining');
    t.assert.strictEqual(mod.ui.tab, 'mining');
    t.assert.strictEqual(mod.ui.section.id, 'mining');
    t.assert.strictEqual(mod.ui.section.title, 'Mining');
    t.assert.strictEqual(typeof mod.ui.section.side, 'function');
    t.assert.strictEqual(typeof mod.ui.section.render, 'function');
    t.assert.strictEqual(typeof mod.ui.section.tiles, 'function');
    t.assert.strictEqual(mod.ui.section.action, undefined);
});

t.test('the deposit table lists mine rows and the managed mason rows', function () {
    var H = harness.boot();
    mountQueue(H, 0, 4);
    var types = H.Steward.core.deposits.types();
    var $main = build(H, 'render');
    var rows = $main.find('tbody tr');
    t.assert.strictEqual(rows.length, types.length);
    types.forEach(function (info) {
        var $r = rowFor($main, info.name);
        t.assert.ok($r, info.name);
        // Every row picks a buff; mine rows also carry three switches and a
        // level box, mason rows nothing else.
        t.assert.strictEqual($r.find('select').length, 1, info.name);
        t.assert.strictEqual($r.find('input').length, info.mineName ? 4 : 0, info.name);
    });
    t.assert.strictEqual($main.find('.steward-subhead span').eq(0).text(), 'MASONS');
    t.assert.strictEqual($main.find('.steward-subhead-meta').text(),
        'buff only · steward does not build masons');
    t.assert.ok(/^\d+ mines active · none paused · \d+ buffed$/.test($main.find('.steward-card-meta').text()),
        $main.find('.steward-card-meta').text());
});

// --- Buff column -----------------------------------------------------------

function buffDef(targets, type) {
    return {
        GetBuffType:                 function () { return type; },
        GetTargetDescription_string: function () { return targets; },
        GetTargetGroup_string:       function () { return ''; }
    };
}

// A home island with buff definitions and stock for the Buff column. o:
// buildings, settings (stored mining settings), stock (MineBuff, default 5).
// MineBuff and EmptyBuff (none in stock) reach every workyard; ZoneBuff
// (type 8) and BakeryBuff (another building) are never offered.
function withBuffs(o) {
    o = o || {};
    var H = harness.boot();
    A.install(H, {
        buffs: [{ type: 'MineBuff', amount: typeof o.stock === 'number' ? o.stock : 5, uid: 'u1' },
                { type: 'ZoneBuff', amount: 3, uid: 'u2' }],
        buffDefs: {
            MineBuff:   buffDef('Workyard', 0),
            EmptyBuff:  buffDef('Workyard', 0),
            ZoneBuff:   buffDef('Workyard', 8),
            BakeryBuff: buffDef('Bakery', 0)
        }
    });
    var z = H.zone.zone().buildQueue(0, 4);
    var bl = o.buildings || [];
    for (var i = 0; i < bl.length; i++) z.building(bl[i]);
    H.installZone(z);
    H.Steward.core.locale.res = function (name) { return name; };
    H.settings.write('mining', o.settings || onlyMiningEnabled('IronOre', true));
    return H;
}

function withBuff(map) {
    var s = onlyMiningEnabled('IronOre', true);
    for (var k in map) s.deposits[k].buff = map[k];
    return s;
}

function optionLabels($r) {
    var out = [];
    var $o = $r.find('option');
    for (var i = 0; i < $o.length; i++) out.push($o.eq(i).text());
    return out;
}

function statusOf($r) {
    return $r.find('select').parent().find('.steward-muted').eq(0);
}

function openBreaker(H) {
    var b = H.Steward.modules.mining.buffBreaker;
    for (var i = 0; i < b.MISSES; i++) b.miss();
    t.assert.strictEqual(b.isOpen(), true);
    return b;
}

t.test('choosing a buff writes deposits.<Type>.buff and keeps the row', function () {
    var H = withBuffs();
    var h = H.Steward.kernel.ui.helpers;
    var $main = build(H, 'render');
    rowFor($main, 'IronOre').find('select').val('MineBuff').trigger('change');
    var row = h.get('mining', 'deposits.IronOre');
    t.assert.strictEqual(row.buff, 'MineBuff');
    t.assert.strictEqual(row.build, true);
    t.assert.strictEqual(row.upgrade, false);
    t.assert.strictEqual(row.targetLevel, 3);
    t.assert.strictEqual(row.pause, false);
    t.assert.strictEqual(row.refill, '');
    // A mason row writes its own deposit the same way.
    rowFor($main, 'Granite').find('select').val('MineBuff').trigger('change');
    t.assert.strictEqual(h.get('mining', 'deposits.Granite.buff'), 'MineBuff');
    t.assert.strictEqual(h.get('mining', 'deposits.Granite.enabled'), false);
    // Back to None clears the choice.
    rowFor($main, 'IronOre').find('select').val('').trigger('change');
    t.assert.strictEqual(h.get('mining', 'deposits.IronOre.buff'), '');
});

t.test('the buff list offers None first and only offered buffs with stock', function () {
    var H = withBuffs();
    var $main = build(H, 'render');
    ['IronOre', 'Granite'].forEach(function (name) {
        var $r = rowFor($main, name);
        t.assert.deepStrictEqual(optionLabels($r), ['None', 'EmptyBuff (0)', 'MineBuff (5)'], name);
        t.assert.strictEqual($r.find('option').eq(0).attr('value'), '', name);
        t.assert.strictEqual($r.find('select').val(), '', name);
        t.assert.strictEqual(statusOf($r).text(), 'off', name);
    });
});

t.test('a stored buff that is no longer offered stays selectable', function () {
    var H = withBuffs({ settings: withBuff({ IronOre: 'OldBuff', Marble: 'BakeryBuff' }) });
    var h = H.Steward.kernel.ui.helpers;
    var $main = build(H, 'render');
    [['IronOre', 'OldBuff'], ['Marble', 'BakeryBuff']].forEach(function (c) {
        var $r = rowFor($main, c[0]);
        var labels = optionLabels($r);
        t.assert.strictEqual(labels[labels.length - 1], c[1] + ' (not offered)', c[0]);
        t.assert.strictEqual($r.find('select').val(), c[1], c[0]);
        t.assert.strictEqual(statusOf($r).find('.steward-badge').text(), 'not offered for this building', c[0]);
        // Showing the row does not touch the stored choice.
        t.assert.strictEqual(h.get('mining', 'deposits.' + c[0] + '.buff'), c[1], c[0]);
    });
});

t.test('out of stock and breaker paused show their badges', function () {
    var H = withBuffs({
        settings: withBuff({ IronOre: 'EmptyBuff', Granite: 'MineBuff' }),
        buildings: [
            Z.building({ name: 'IronMine', grid: 3, productionState: 0 }),
            Z.building({ name: 'GraniteMason', grid: 4, productionState: 0, productionBuff: {} }),
            Z.building({ name: 'GraniteMason', grid: 5, productionState: 0 })
        ]
    });
    var $main = build(H, 'render');
    var $iron = statusOf(rowFor($main, 'IronOre'));
    var $granite = statusOf(rowFor($main, 'Granite'));
    t.assert.strictEqual($iron.find('.steward-badge').text(), 'out of stock');
    t.assert.strictEqual($iron.text(), 'out of stock 0 of 1 buffed');
    t.assert.strictEqual($granite.find('.steward-badge').length, 0);
    t.assert.strictEqual($granite.text(), '5 in stock · 1 of 2 buffed');
    t.assert.ok(/ · 1 buffed$/.test($main.find('.steward-card-meta').text()),
        $main.find('.steward-card-meta').text());

    openBreaker(H);
    $main = build(H, 'render');
    $iron = statusOf(rowFor($main, 'IronOre'));
    $granite = statusOf(rowFor($main, 'Granite'));
    // Out of stock still wins over paused.
    t.assert.strictEqual($iron.find('.steward-badge').text(), 'out of stock');
    t.assert.strictEqual($granite.find('.steward-badge').text(), 'paused');
    t.assert.ok($granite.find('.steward-badge').hasClass('steward-b-paused'));
    t.assert.strictEqual($granite.text(), 'paused 5 in stock · 1 of 2 buffed');
});

t.test('an unreadable stock says so', function () {
    var H = withBuffs({ settings: withBuff({ IronOre: 'MineBuff' }) });
    H.Steward.core.buffs.stock = function () { return null; };
    var $r = rowFor(build(H, 'render'), 'IronOre');
    t.assert.strictEqual(statusOf($r).text(), 'stock unreadable');
});

t.test('the breaker banner shows only while open', function () {
    var H = withBuffs({ settings: withBuff({ IronOre: 'MineBuff' }) });
    t.assert.strictEqual(build(H, 'render').find('.steward-banner').length, 0);
    var b = openBreaker(H);
    var $main = build(H, 'render');
    var $banner = $main.find('.steward-banner');
    t.assert.strictEqual($banner.length, 1);
    t.assert.strictEqual($banner.text(), '⚠Buffing paused: 5 buff applies in a row were not seen on ' +
        'their building. One probe every 5 min; reloading scripts resets it. Build, upgrade and ' +
        'pause keep running.');
    b.verify('test');
    t.assert.strictEqual(build(H, 'render').find('.steward-banner').length, 0);
});

t.test('the settings column shows buffed buildings and the breaker state', function () {
    var H = withBuffs({
        buildings: [
            Z.building({ name: 'IronMine', grid: 3, productionState: 0, productionBuff: {} }),
            Z.building({ name: 'Mason', grid: 4, productionState: 0 })
        ]
    });
    var $side = build(H, 'side');
    var $stats = $side.find('.steward-stat');
    t.assert.strictEqual($stats.length, 4);
    t.assert.strictEqual($stats.eq(2).find('.steward-stat-k').text(), 'Buffed now');
    t.assert.strictEqual($stats.eq(2).find('.steward-stat-v').text(), '1 of 2');
    t.assert.strictEqual($stats.eq(3).find('.steward-badge').text(), 'closed');
    t.assert.ok($stats.eq(3).find('.steward-badge').hasClass('steward-b-ok'));
    t.assert.strictEqual($side.find('.steward-field-name').eq(0).text(), 'Build, upgrade and buff mines');
    openBreaker(H);
    $stats = build(H, 'side').find('.steward-stat');
    t.assert.strictEqual($stats.eq(3).find('.steward-badge').text(), 'open');
    t.assert.ok($stats.eq(3).find('.steward-badge').hasClass('steward-b-paused'));
});

t.test('tiles add the breaker line only while open', function () {
    var H = withBuffs();
    jq.install(H);
    var h = H.Steward.kernel.ui.helpers;
    t.assert.strictEqual(H.Steward.modules.mining.tiles(h)[0].lines.length, 2);
    var b = openBreaker(H);
    var lines = H.Steward.modules.mining.tiles(h)[0].lines;
    t.assert.strictEqual(lines.length, 3);
    t.assert.strictEqual(lines[2], 'Buffing paused (breaker)');
    b.verify('test');
    t.assert.strictEqual(H.Steward.modules.mining.tiles(h)[0].lines.length, 2);
});

t.test('deposit names go through the locale and keep the raw name as the tooltip', function () {
    var H = harness.boot();
    mountQueue(H, 0, 4);
    H.Steward.core.locale.res = function (name) { return 'Res ' + name; };
    var $first = build(H, 'render').find('tbody tr').eq(0).find('td').eq(0);
    t.assert.strictEqual($first.text(), 'Res ' + $first.attr('title'));
});

t.test('the level box takes any whole level from 1 and rejects the rest', function () {
    var H = harness.boot();
    mountQueue(H, 0, 4);
    H.settings.write('mining', onlyMiningEnabled('IronOre', true));
    var h = H.Steward.kernel.ui.helpers;
    var $level = rowFor(build(H, 'render'), 'IronOre').find('input').eq(2);
    ['0', '-1', 'abc', ''].forEach(function (bad) {
        $level.val(bad).trigger('change');
        t.assert.strictEqual(h.get('mining', 'deposits.IronOre.targetLevel'), 3, 'bad ' + bad);
    });
    $level.val('6').trigger('change');
    t.assert.strictEqual(h.get('mining', 'deposits.IronOre.targetLevel'), 6);
    $level.val('5').trigger('change');
    t.assert.strictEqual(h.get('mining', 'deposits.IronOre.targetLevel'), 5);
    $level.val('1').trigger('change');
    t.assert.strictEqual(h.get('mining', 'deposits.IronOre.targetLevel'), 1);
});

t.test('switching Pause on keeps the rest of the stored deposit row', function () {
    var H = harness.boot();
    mountQueue(H, 0, 4);
    H.settings.write('mining', onlyMiningEnabled('IronOre', true));
    var $r = rowFor(build(H, 'render'), 'IronOre');
    var $boxes = $r.find('input');
    // Build, Upgrade, level, Pause in column order.
    $boxes.eq(3).prop('checked', true).trigger('change');
    var row = H.Steward.kernel.ui.helpers.get('mining', 'deposits.IronOre');
    t.assert.strictEqual(row.pause, true);
    t.assert.strictEqual(row.build, true);
    t.assert.strictEqual(row.targetLevel, 3);
    t.assert.strictEqual(row.upgrade, false);
});

t.test('tiles give the queue and licence line and the mines line', function () {
    var H = harness.boot();
    mountQueue(H, 1, 4);
    H.settings.write('mining', onlyMiningEnabled('IronOre', true));
    jq.install(H);
    var h = H.Steward.kernel.ui.helpers;
    var tiles = H.Steward.modules.mining.tiles(h);
    t.assert.strictEqual(tiles.length, 1);
    t.assert.strictEqual(tiles[0].title, 'Mining');
    t.assert.ok(/^Build queue \d+ of \d+ · licences 0 of 100$/.test(tiles[0].lines[0]), tiles[0].lines[0]);
    t.assert.strictEqual(tiles[0].lines[1], '0 mines active, none paused');

    h.set('mining', 'deposits.IronOre.pause', true);
    tiles = H.Steward.modules.mining.tiles(h);
    t.assert.strictEqual(tiles[0].lines[1], '0 mines active, 1 paused');
});

t.test('the settings column shows the queue and licence counts', function () {
    var H = harness.boot();
    mountQueue(H, 0, 4);
    var $side = build(H, 'side');
    // Queue and licences, then buffed buildings and the buff breaker.
    t.assert.strictEqual($side.find('.steward-stat').length, 4);
    t.assert.ok(/of 100$/.test($side.find('.steward-stat').eq(1).text()), $side.find('.steward-stat').eq(1).text());
});

// Wraps the star menu so each read is counted; `mutate` may edit the entries.
function countMenu(H, mutate) {
    var pl = H.host.game.gi.mCurrentPlayer;
    var orig = pl.getAvailableBuffs_vector;
    var c = { n: 0 };
    pl.getAvailableBuffs_vector = function () {
        c.n++;
        var out = orig.call(pl);
        if (mutate) mutate(out);
        return out;
    };
    return c;
}

t.test('a mining draw in a read pass reads the star menu once', function () {
    var H = withBuffs({ settings: withBuff({ IronOre: 'MineBuff', Granite: 'MineBuff' }) });
    var c = countMenu(H);
    H.Steward.kernel.hostRead.pass(function () { build(H, 'render'); });
    t.assert.strictEqual(c.n, 1);
});

t.test('an unreadable stock shows ? in every option and the status says unreadable', function () {
    var H = withBuffs({ settings: withBuff({ IronOre: 'MineBuff' }) });
    // An entry whose type cannot be read makes every stock unreadable.
    countMenu(H, function (out) {
        out.push({ amount: 1, GetType: function () { throw new Error('boom'); } });
    });
    var $main;
    H.Steward.kernel.hostRead.pass(function () { $main = build(H, 'render'); });
    var $r = rowFor($main, 'IronOre');
    var labels = optionLabels($r);
    t.assert.ok(labels.length > 1);
    for (var i = 1; i < labels.length; i++) {
        t.assert.ok(/\(\?\)$/.test(labels[i]), labels[i]);
    }
    t.assert.strictEqual(statusOf($r).text(), 'stock unreadable');
});

t.test('plan runs inside a read pass', function () {
    var H = withBuffs();
    var hr = H.Steward.kernel.hostRead;
    var seen = [];
    H.Steward.modules.mining._phases = {
        tryBuff: function () { seen.push(hr.inPass()); }
    };
    H.module('mining').plan({ zone: { isHome: true } });
    t.assert.ok(seen.length > 0);
    t.assert.strictEqual(seen[0], true);
    t.assert.strictEqual(hr.inPass(), false);
});
