/*
 * A booted world for the economy module tests.
 *
 *   var EC = require('../stubs/economy');
 *   var w = EC.world({
 *       star:     [{ resource: 'Wood', amount: 100, uid: 'w1' }],
 *       store:    { Wood: 400 },
 *       capacity: 1000,
 *       groups:   { Wood: 'CL1' },          // group_string per resource
 *       events:   { Egg: 'Easter' },        // requiredEventName_string
 *       live:     ['Easter_Content'],       // GetActiveEventNames()
 *       home:     true,
 *       bounce:   { StarDust: { after: 7000, back: 50 } },
 *       items:    { Wood: true },           // the stored selection
 *       enabled:  true
 *   });
 *   var q = w.plan();            // the economy.transfer entries one pass queued
 *   w.fire('Wood');              // runs the queued action and plays its attempt
 *   w.cycle();                   // plan, then fire everything it queued
 *
 * The host parts are the ones the module reads through core: the star menu
 * (army stub buff entries), getResources() with GetResourceAmount and
 * GetWareHouseCapacity, game.def('ServerState::gEconomics') definitions with
 * requiredEventName_string and group_string, the host global
 * ResourceGroupToWarehouseTab, mEventManager.GetActiveEventNames,
 * isOnHomzone and a writable steward folder for the send ledger. Every
 * resource has a definition unless w.env.noDef names it.
 *
 * A star-to-store packet (61) moves its amount from the entry it names into
 * the store, unless env.apply is false (nothing happens: the send is never
 * seen) or env.bounce names the resource: the stack leaves the entry and,
 * after `after` ms of ledger clock, `back` of it (default all) comes back to
 * the entry with the store unchanged. env.partial ({ name: { after, take } })
 * lets the store take part at once and returns the rest.
 *
 * Settings writes deep-merge like the host's settings.store, so a write of
 * one key keeps the others. The ledger clock is env.now; every queued step
 * played advances it by one queue gap, so attempt polls and the clock agree.
 */

'use strict';

var harness = require('../harness');
var airfs = require('./airfs');
var A = require('./army');
var AC = require('./actions');

var T0 = 1700000000000;

var TAB_MAP = {
    CL1: 'WarehouseTab1',
    CL2: 'WarehouseTab2',
    CL3: 'WarehouseTab3',
    CL4: 'WarehouseTab4',
    CL5: 'WarehouseTab8',
    Event: 'WarehouseTab6',
    Collectibles: 'WarehouseTab7'
};

function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

function plain(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function deepMerge(into, from) {
    for (var k in from) {
        if (!has(from, k)) continue;
        if (isObj(from[k])) {
            if (!isObj(into[k])) into[k] = {};
            deepMerge(into[k], from[k]);
        } else {
            into[k] = from[k];
        }
    }
    return into;
}

function entry(e) {
    return { type: 'AddResource', resource: e.resource, amount: e.amount, uid: e.uid || e.resource };
}

function world(o) {
    o = o || {};
    var disk = o.disk || airfs.make();
    var H = harness.boot({ host: { air: disk.air } });
    var menu = (o.star || []).map(entry);
    A.install(H, { buffs: menu });
    var sent = AC.wire(H);
    var S = H.Steward;
    var game = H.host.game;
    var gi = game.gi;
    var events = [];

    var env = {
        home:     o.home !== false,
        apply:    true,
        capacity: typeof o.capacity === 'number' || o.capacity === null ? o.capacity : 1000,
        store:    o.store || {},
        groups:   o.groups || {},
        events:   o.events || {},
        live:     o.live || [],
        bounce:   o.bounce || {},
        partial:  o.partial || {},
        noDef:    {},
        defs:     true,
        now:      typeof o.now === 'number' ? o.now : T0,
        onSend:   null
    };
    env.later = function (ms, fn) { events.push({ at: env.now + ms, fn: fn }); };
    env.tick = function (ms) {
        env.now += ms;
        var due = events.filter(function (e) { return e.at <= env.now; });
        events = events.filter(function (e) { return e.at > env.now; });
        due.forEach(function (e) { e.fn(); });
    };
    S.core.ledger.clock = function () { return env.now; };

    // Settings: the host's store deep-merges, so a one-key write keeps the rest.
    var store = H.settings.store;
    S.kernel.settings.write = function (id, val) {
        if (!isObj(store[id])) store[id] = {};
        deepMerge(store[id], plain(val));
        return true;
    };

    game.getResources = function () {
        return {
            GetResourceAmount: function (name) {
                return has(env.store, name) ? env.store[name] : null;
            },
            GetWareHouseCapacity: function () { return env.capacity; }
        };
    };

    var econ = {
        GetResourcesDefaultDefinition: function (name) {
            if (!env.defs || env.noDef[name]) return null;
            return {
                requiredEventName_string: has(env.events, name) ? env.events[name] : '',
                group_string: has(env.groups, name) ? env.groups[name] : 'CL1'
            };
        }
    };
    var wiredDef = game.def;
    game.def = function (name) {
        if (name === 'ServerState::gEconomics') return econ;
        return wiredDef(name);
    };
    H.ctx.ResourceGroupToWarehouseTab = o.tabMap || TAB_MAP;
    gi.mEventManager = gi.mEventManager || {};
    gi.mEventManager.GetActiveEventNames = function () { return env.live.slice(); };

    var send = gi.SendServerAction;
    gi.SendServerAction = function () {
        send.apply(this, arguments);
        var a = sent.actions[sent.actions.length - 1];
        var key = a.data && a.data.toKeyString ? a.data.toKeyString() : null;
        menu.forEach(function (b) {
            if (b.uid !== key) return;
            var bounce = has(env.bounce, b.resource) ? env.bounce[b.resource] : null;
            var part = has(env.partial, b.resource) ? env.partial[b.resource] : null;
            if (bounce || part) {
                var take = part ? part.take : 0;
                var back = bounce && typeof bounce.back === 'number' ? bounce.back : a.p3 - take;
                b.amount -= a.p3;
                if (take) env.store[b.resource] = (env.store[b.resource] || 0) + take;
                env.later((bounce || part).after, function () { b.amount += back; });
            } else if (env.apply) {
                b.amount -= a.p3;
                env.store[b.resource] = (env.store[b.resource] || 0) + a.p3;
            }
        });
        if (env.onSend) env.onSend(a);
    };
    gi.mCurrentViewedZoneID = 1;
    if (!gi.mCurrentPlayerZone) gi.mCurrentPlayerZone = {};
    gi.isOnHomzone = function () { return env.home; };

    if (o.settings !== false) {
        S.kernel.settings.write('economy', {
            enabled: o.enabled !== false,
            items:   o.items || {}
        });
    }

    // Boots the module and captures its queue action.
    var q = S.kernel.queue;
    var orig = q.action;
    var handlers = {};
    q.action = function (name, f) {
        handlers[name] = f;
        return orig.apply(q, arguments);
    };
    H.module('economy').boot();
    q.action = orig;
    H.clearQueued();
    H.clearLogs();

    var w = {
        H: H, S: S, env: env, sent: sent, menu: menu, disk: disk, handlers: handlers,
        E: S.modules.economy, T0: T0
    };

    // Plays the queued 'core.attempt' steps to their end, one queue gap of
    // clock per step (AC.drive clears the queue, so call it with nothing else
    // queued: plan() clears its own entries).
    w.drain = function (max) {
        var gap = S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS;
        return AC.drive(H, {
            max:    typeof max === 'number' ? max : 400,
            onStep: function () { env.tick(gap); }
        }).steps;
    };

    // One plan pass at home; returns [{ name, delay }] of the transfers it queued.
    w.plan = function (ctx) {
        H.clearQueued();
        S.kernel.hostRead.pass(function () {
            H.module('economy').plan(ctx || { zone: { isHome: env.home } });
        });
        var out = H.queued().filter(function (e) { return e.name === 'economy.transfer'; })
            .map(function (e) { return { name: e.params[0], delay: e.delay }; });
        H.clearQueued();
        return out;
    };

    // Runs the queued transfer of name and plays its attempt to its end.
    w.fire = function (name) {
        handlers['economy.transfer']([name]);
        return w.drain();
    };

    // One plan pass and every transfer it queued, fired in order.
    w.cycle = function () {
        var q = w.plan();
        q.forEach(function (e) { w.fire(e.name); });
        return q;
    };

    w.ledgerFile = function () {
        var keys = Object.keys(disk.disk).filter(function (k) { return /\/state\/ledger\.json$/.test(k); });
        return keys.length ? JSON.parse(disk.disk[keys[0]]) : null;
    };
    w.fileEntries = function () {
        var f = w.ledgerFile();
        return f ? f.entries : {};
    };
    w.logged = function (level, category, re) {
        return H.logs().filter(function (l) {
            return l.level === level && l.category === category && re.test(l.args.join(' '));
        });
    };
    w.stack = function (uid) {
        for (var i = 0; i < menu.length; i++) if (menu[i].uid === uid) return menu[i];
        return null;
    };
    w.settings = function () { return plain(store.economy); };
    return w;
}

module.exports = {
    world: world,
    plain: plain,
    T0:    T0,
    TAB_MAP: TAB_MAP
};
