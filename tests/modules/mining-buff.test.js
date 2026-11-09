'use strict';

var t = require('../runner');
var harness = require('../harness');
var A = require('../stubs/army');
var AC = require('../stubs/actions');
var Z = require('../stubs/zone');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

var TYPES = ['Stone', 'BronzeOre', 'Marble', 'IronOre', 'GoldOre',
             'Coal', 'Granite', 'TitaniumOre', 'Salpeter'];

// A production buff definition (type 0) aimed at the given targets.
function bdef(targets, type) {
    return {
        GetBuffType:                 function () { return typeof type === 'number' ? type : 0; },
        GetTargetDescription_string: function () { return targets; },
        GetTargetGroup_string:       function () { return ''; }
    };
}

var DEFS = { MineBuff: bdef('Workyard'), BakeryBuff: bdef('Bakery') };

// Mining settings with every type off except the ones in `on`
// (type name -> overrides of the deposit entry).
function settingsFor(on, extra) {
    var deposits = {};
    for (var i = 0; i < TYPES.length; i++) {
        deposits[TYPES[i]] = { enabled: false, build: false, upgrade: false, targetLevel: 3,
                               pause: false, buff: '', refill: '' };
    }
    for (var name in on) {
        deposits[name].enabled = true;
        for (var k in on[name]) deposits[name][k] = on[name][k];
    }
    // buffVersion: these settings model a user who picked buffs in the buff UI.
    var s = { enabled: true, actionDelay: 0, pauseThreshold: 50, buffVersion: 1,
              deposits: deposits };
    for (var e in (extra || {})) s[e] = extra[e];
    return s;
}

// A booted home island. o: buildings (list), deposits (type -> list),
// stock (MineBuff amount, default 5), on / extra (settings). Returns the
// harness plus the mining module, its breaker on a test clock (env.T) and
// the packet recorder.
function setup(o) {
    o = o || {};
    var H = harness.boot();
    A.install(H, {
        buffs:    [{ type: 'MineBuff', amount: typeof o.stock === 'number' ? o.stock : 5, uid: 'u1' }],
        buffDefs: DEFS
    });
    var z = H.zone.zone().buildQueue(0, 4);
    var bl = o.buildings || [];
    for (var i = 0; i < bl.length; i++) z.building(bl[i]);
    for (var type in (o.deposits || {})) z.deposits(type, o.deposits[type]);
    H.installZone(z);
    var sent = AC.wire(H);
    H.settings.write('mining', settingsFor(o.on || { IronOre: { buff: 'MineBuff' } }, o.extra));

    var env = { T: 1000000, H: H, sent: sent, onSend: null };
    var mining = H.Steward.modules.mining;
    mining.buffBreaker.clock = function () { return env.T; };
    var gi = H.host.game.gi;
    var send = gi.SendServerAction;
    gi.SendServerAction = function () {
        send.apply(this, arguments);
        if (env.onSend) env.onSend(sent.actions[sent.actions.length - 1]);
    };
    env.mining = mining;
    env.mod = H.module('mining');
    env.plan = function () {
        H.clearQueued();
        env.mod.plan({ zone: { isHome: true } });
        return H.queued();
    };
    return env;
}

function mine(grid, opts) {
    var o = { name: 'IronMine', grid: grid, productionState: 0 };
    for (var k in (opts || {})) o[k] = opts[k];
    return Z.building(o);
}

function named(list, name) {
    return list.filter(function (q) { return q.name === name; });
}

function grids(list) {
    return named(list, 'mining.buffBuilding').map(function (q) { return q.params[0]; });
}

// The registered mining.buffBuilding handler, captured while the module boots.
function buffAction(env) {
    var q = env.H.Steward.kernel.queue;
    var orig = q.action;
    var fn = null;
    q.action = function (name, f) {
        if (name === 'mining.buffBuilding') fn = f;
        return orig.apply(q, arguments);
    };
    env.mod.boot();
    q.action = orig;
    return fn;
}

// Runs one queued buffBuilding entry through its attempt to the end.
function runBuff(env, params) {
    var fn = env.handler || (env.handler = buffAction(env));
    env.H.clearQueued();
    fn(params);
    AC.drive(env.H);
}

function logsMatching(env, level, text) {
    return env.H.logs().filter(function (l) {
        return l.level === level && l.category === 'mining' && l.args.join(' ').indexOf(text) >= 0;
    });
}

t.test("buff '' queues nothing", function () {
    var env = setup({ buildings: [mine(3)], on: { IronOre: { buff: '' } } });
    assert.strictEqual(grids(env.plan()).length, 0);
});

t.test('one mining.buffBuilding per eligible mine, at most BUFFS_PER_PLAN', function () {
    var env = setup({ buildings: [mine(9), mine(3), mine(5)] });
    var q = env.plan();
    assert.deepStrictEqual(grids(q), [3, 5]);
    var first = named(q, 'mining.buffBuilding')[0];
    assert.deepStrictEqual(plain(first.params), [3, 'IronMine', 'MineBuff', 'IronOre']);
    assert.strictEqual(first.delay, 0);
});

t.test('masons are buffed for Stone/Marble/Granite via masonName', function () {
    var env = setup({
        buildings: [Z.building({ name: 'Mason', grid: 4, productionState: 0 }),
                    Z.building({ name: 'GraniteMason', grid: 6, productionState: 0 })],
        on: { Stone: { buff: 'MineBuff' }, Granite: { buff: 'MineBuff' } }
    });
    var q = named(env.plan(), 'mining.buffBuilding');
    assert.strictEqual(q.length, 2);
    assert.deepStrictEqual(plain(q[0].params.slice(0, 2)), [4, 'Mason']);
    assert.deepStrictEqual(plain(q[1].params.slice(0, 2)), [6, 'GraniteMason']);
});

t.test('skips productionBuff, state != 0, upgrading, grids claimed by build/upgrade, zero stock, off home, unmatched buff', function () {
    var env = setup({
        buildings: [mine(1, { productionBuff: {} }), mine(2, { productionState: 2 }),
                    mine(3, { upgrading: true }), mine(4, { upgradable: true }), mine(5)],
        deposits:  { IronOre: [Z.deposit({ name: 'IronOre', grid: 4, amount: 500 })] },
        on:        { IronOre: { buff: 'MineBuff', upgrade: true, targetLevel: 3 } }
    });
    var q = env.plan();
    assert.strictEqual(named(q, 'mining.upgradeMine').length, 1);
    assert.deepStrictEqual(grids(q), [5]);

    assert.strictEqual(grids(setup({ buildings: [mine(5)], stock: 0 }).plan()).length, 0);

    var away = setup({ buildings: [mine(5)] });
    away.H.host.game.gi.isOnHomzone = function () { return false; };
    assert.strictEqual(grids(away.plan()).length, 0);

    var other = setup({ buildings: [mine(5)], on: { IronOre: { buff: 'BakeryBuff' } } });
    assert.strictEqual(grids(other.plan()).length, 0);
    assert.strictEqual(logsMatching(other, 'debug', 'does not target IronMine').length, 1);
});

t.test('stock counts down within one pass', function () {
    var env = setup({
        buildings: [mine(3), mine(5), Z.building({ name: 'CoalMine', grid: 7, productionState: 0 })],
        stock: 1,
        on: { IronOre: { buff: 'MineBuff' }, Coal: { buff: 'MineBuff' } }
    });
    assert.deepStrictEqual(grids(env.plan()), [3]);
});

t.test('verified apply logs buffed and closes the breaker', function () {
    var b = mine(3);
    var env = setup({ buildings: [b] });
    var br = env.mining.buffBreaker;
    for (var i = 0; i < br.MISSES; i++) br.miss();
    assert.strictEqual(br.isOpen(), true);
    env.mining.buffHolds()[3] = env.T - 1;
    env.onSend = function () { b.productionBuff = {}; };
    runBuff(env, [3, 'IronMine', 'MineBuff', 'IronOre']);
    assert.strictEqual(env.sent.actions.length, 1);
    assert.strictEqual(env.sent.actions[0].id, 61);
    assert.strictEqual(env.sent.actions[0].p2, 3);
    assert.strictEqual(br.isOpen(), false);
    assert.strictEqual(br.snapshot().run, 0);
    assert.strictEqual(logsMatching(env, 'log', 'buffed IronMine on grid 3 with MineBuff').length, 1);
    assert.strictEqual(logsMatching(env, 'log', 'buff breaker closed').length, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(env.mining.buffHolds(), 3), false);
});

t.test('5 unseen applies open the buff breaker and hold their grids; the specialist send guard stays closed', function () {
    var list = [mine(1), mine(2), mine(3), mine(4), mine(5)];
    var env = setup({ buildings: list });
    for (var g = 1; g <= 5; g++) runBuff(env, [g, 'IronMine', 'MineBuff', 'IronOre']);
    var br = env.mining.buffBreaker;
    assert.strictEqual(env.sent.actions.length, 5);
    assert.strictEqual(br.isOpen(), true);
    assert.strictEqual(logsMatching(env, 'warn', 'buff breaker open').length, 1);
    var holds = env.mining.buffHolds();
    for (var h = 1; h <= 5; h++) assert.strictEqual(holds[h], env.T + 1800000);
    assert.strictEqual(env.H.Steward.core.specialists.sendGuard.isOpen(), false);

    // Held grids stay skipped after the breaker closes again.
    br.verify('test');
    assert.strictEqual(grids(env.plan()).length, 0);
    env.T += 1800001;
    assert.deepStrictEqual(grids(env.plan()), [1, 2]);
});

t.test('a failed send holds the grid without counting a miss', function () {
    var env = setup({ buildings: [mine(3)] });
    env.H.host.game.gi.SendServerAction = function () { throw new Error('offline'); };
    runBuff(env, [3, 'IronMine', 'MineBuff', 'IronOre']);
    assert.strictEqual(env.mining.buffBreaker.snapshot().run, 0);
    assert.strictEqual(env.mining.buffHolds()[3], env.T + 1800000);
});

t.test('open breaker queues nothing until a probe is due, then one', function () {
    var env = setup({ buildings: [mine(3), mine(5)] });
    var br = env.mining.buffBreaker;
    for (var i = 0; i < br.MISSES; i++) br.miss();
    assert.strictEqual(grids(env.plan()).length, 0);
    env.T += br.COOLDOWN_MS;
    assert.deepStrictEqual(grids(env.plan()), [3]);
    assert.strictEqual(grids(env.plan()).length, 0);
});

t.test('a mine about to be paused is not buffed in the same pass', function () {
    var env = setup({
        buildings: [mine(10), mine(11)],
        deposits:  { IronOre: [Z.deposit({ name: 'IronOre', grid: 10, amount: 10 }),
                               Z.deposit({ name: 'IronOre', grid: 11, amount: 100 })] },
        on:        { IronOre: { buff: 'MineBuff', pause: true } }
    });
    var q = env.plan();
    var pauses = named(q, 'mining.setProduction');
    assert.strictEqual(pauses.length, 1);
    assert.strictEqual(pauses[0].params[0], 10);
    assert.deepStrictEqual(grids(q), [11]);
});
