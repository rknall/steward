/*
 * Production module.
 *
 * Keeps the timed production queues of the home zone busy. Each plan pass
 * runs two phases, each capped per pass and each in its own try/catch:
 *
 *   complete  (bookComplete) finishes the head entry of a queue that waits
 *             for completion (the Bookbinder), at most one per pass, and
 *             only while that building's row is enabled.
 *   standing  (standing) runs the automatic queues: one need per enabled
 *             row goes into the demand ledger, and the planner orders it
 *             only while that building's queue holds no entry. The order
 *             is one message of the row's Items runs (itemsFor), at most
 *             ordersPerPass orders, each verified through
 *             S.core.production.orderIn. A building that is producing
 *             anything needs nothing added.
 *
 *             (buffs) Each order of an enabled row with a buff carries that
 *             buff when the producer shows no running production buff, at
 *             most buffsPerPass per pass. A buff is spent only on a
 *             building this module just gave work, never on one that
 *             already has a buff. The buff is queued only after the order
 *             is verified, because S.core.actions.attempt queues its steps
 *             at the end of the kernel queue: a buff queued in the same
 *             pass would run before the order is sent, against an idle
 *             building. The shared S.core.buffing engine re-checks the
 *             building then, so each apply is verified on it. A row with a
 *             buff but no item is never buffed.
 *
 * A row acts only while its own switch (enabled) is on. An item the host
 * would not let the player order now (S.core.production.isProducible gives
 * false) is not ordered, and that is said once per row until it changes;
 * an unreadable check never stops an order.
 *
 * One producer per name: the host queue is per production type and runs at
 * one building, and autoTSO picks the highest-level building of a name for
 * both orders and buffs. highest(name) is that building, as
 * S.core.production.producer(name) picks it. It is the only
 * order grid and the only buff target, and a lower-level building of the
 * same name is never used as a fallback, because it does not run the
 * queue.
 *
 * Scope: only names whose buildings have a productionQueue (queueNames()).
 * Continuous resource production without a queue (sawmills, farms) is
 * buffed and run elsewhere. Mines and masons belong to the mining module,
 * which derives them from S.core.deposits.types(); this module derives the
 * same names and never orders into or buffs them. A name the manager
 * hides by name (the model's list) is never ordered or buffed either, even
 * when a saved row of it is enabled.
 *
 * Automatic queues are priced by the planner against every other owner's
 * needs in priority order, so an adventure run's RunNow need keeps its
 * resources and an automatic queue waits. A kind or item another owner
 * holds (adventure troops while a run is active) is not ordered here.
 *
 * Guards: an order not seen in its queue holds that building for 30 min
 * and counts a miss on the order breaker. The hold is a planner hold, so a
 * held name reads Held and takes no ordersPerPass slot or resources from
 * another name. Five misses in a row pause all
 * automatic queues until a probe is verified or the user resets the
 * breaker. The buff engine keeps its own breaker and grid holds the same
 * way. Breakers, holds and the placed set are memory only, so a script
 * reload resets them.
 *
 * Off (enabled false) stops only this module's own work: its queued
 * actions are cancelled and its needs dropped. Adventure runs keep
 * ordering their own items and troops. Automatic queues off drops the
 * needs only. A queued action re-checks its own switch when it runs, so a
 * sub-switch turned off needs no cancel.
 *
 * Settings stored before the automatic-queue shape are migrated once at
 * boot (migrateSettings), because a deep merge alone never drops the old
 * keys or shows a new default.
 *
 * Honours the kernel's busy contract: the queued actions keep the module
 * busy until they drain, so a second plan() never piles work on top.
 */

(function (S) {

    if (!S.modules.production) S.modules.production = {};

    var OWNER = 'production';

    // An order not seen in its queue may still have landed; waiting 30 min
    // keeps a wrong assumption to one order per building per half hour.
    var ORDER_HOLD_MS    = 1800000;
    // A completion that failed is not resent for 30 min, since what the
    // message does is not confirmed live.
    var COMPLETE_HOLD_MS = 1800000;
    // The order's entry can need a host tick before the building reads
    // producing, so a buff waits this many retries before the engine judges it.
    var BUFF_START_RETRIES = 1;
    // The hold label of a name whose last order was not seen or failed.
    var UNSEEN_HOLD      = 'an unseen order';

    var orderBreaker = S.core.breaker.create({
        category:   'production',
        label:      'order breaker',
        missText:   'orders in a row were not seen in their queue',
        pausedText: 'automatic queues are paused',
        resumeText: 'automatic queues resume'
    });

    var buffEngine = S.core.buffing.create({
        category:   'production',
        label:      'buff breaker',
        missText:   'buff applies in a row were not seen on their building',
        pausedText: 'production building buffing is paused',
        resumeText: 'buffing resumes'
    });

    var holds         = {};   // building name -> order hold until, on the order breaker clock
    var completeHolds = {};   // type -> completion hold until, on the order breaker clock
    var placed        = {};   // 'type|item' -> true for entries this module placed this session
    var unproducible  = {};   // building name -> the item last said to be not producible
    var lastPass      = { at: 0, rows: [] };
    var said          = {};   // debug lines already written this session

    function has(o, k) {
        return Object.prototype.hasOwnProperty.call(o, k);
    }

    function debugOnce(key) {
        if (said[key]) return;
        said[key] = true;
        S.kernel.debug.apply(S.kernel, ['production'].concat(Array.prototype.slice.call(arguments, 1)));
    }

    function readSettings() {
        var stored = S.kernel.settings.read('production') || {};
        var defaults = S.modules.production.defaultSettings || {};
        var blank = S.modules.production.defaultBuilding || {};
        var merged = {};
        var key, f;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        // Merge per building so a partly stored entry keeps the default
        // fields it lacks.
        var out = {};
        var defaultMap = defaults.buildings || {};
        var storedMap  = stored.buildings  || {};
        var names = [];
        for (key in defaultMap) if (has(defaultMap, key)) names.push(key);
        for (key in storedMap)  if (has(storedMap, key) && !has(defaultMap, key)) names.push(key);
        for (var i = 0; i < names.length; i++) {
            var row = {};
            for (f in blank) row[f] = blank[f];
            var d = defaultMap[names[i]] || {};
            var st = storedMap[names[i]] || {};
            for (f in d)  row[f] = d[f];
            for (f in st) row[f] = st[f];
            out[names[i]] = row;
        }
        merged.buildings = out;
        return merged;
    }

    // One stored row in the automatic-queue shape. The old shape kept an
    // amount to top up to; that amount becomes the runs of one order, so a
    // row that ordered before keeps ordering about as much. A row that
    // already has its switch was written in the new shape and keeps it.
    function migrateRow(row) {
        var out = {};
        var f;
        for (f in row) out[f] = row[f];
        out.item = typeof row.item === 'string' ? row.item : '';
        out.buff = typeof row.buff === 'string' ? row.buff : '';
        if (typeof row.enabled === 'boolean') return out;
        var amount = typeof row.amount === 'number' ? Math.floor(row.amount) : 0;
        out.items = amount > 0 ? Math.min(amount, S.core.production.maxProductionAmount()) : 1;
        out.enabled = !!((out.item && row.amount > 0) || out.buff);
        return out;
    }

    // Once per stored settings shape: rows move to { item, items, buff,
    // enabled }, and Bookbinder collection is switched on, since it now
    // follows the Bookbinder row's own switch. A fresh install has nothing
    // stored and gets the defaults instead. A failed write leaves the
    // version as it was, so the next boot tries again.
    function migrateSettings() {
        try {
            var raw = S.kernel.settings.read('production');
            var version = (S.modules.production.defaultSettings || {}).settingsVersion;
            if (!raw || raw.settingsVersion === version) return;
            var next = {};
            var key;
            for (key in raw) next[key] = raw[key];
            var rows = {};
            var count = 0;
            var stored = raw.buildings || {};
            for (key in stored) {
                if (!has(stored, key)) continue;
                var row = stored[key];
                if (!row || typeof row !== 'object') { rows[key] = row; continue; }
                rows[key] = migrateRow(row);
                count++;
            }
            next.buildings = rows;
            next.bookComplete = true;
            next.settingsVersion = version;
            if (S.kernel.settings.write('production', next)) {
                S.kernel.log('production', 'production settings moved to automatic queues: ' + count +
                             ' rows; Bookbinder auto-complete on');
            } else {
                S.kernel.warn('production', 'production settings could not be moved to automatic queues;' +
                              ' trying again on the next boot');
            }
        } catch (e) {
            S.kernel.error('production', 'settings migration threw:', e);
        }
    }

    function clock() {
        return orderBreaker.clock();
    }

    // True only while the module and the given sub-switch are both on.
    function switchOn(key) {
        var s = readSettings();
        return !!(s && s.enabled && s[key]);
    }

    function rowOn(cfg) {
        return !!(cfg && cfg.enabled === true);
    }

    function orderHeld(key) {
        return holds[key] > clock();
    }

    // The runs one order message of the type can carry, normalized once: a
    // number above 0, else 1. itemsFor and the window's fixed-1 decision
    // both read it.
    function runsMax(type) {
        var max = S.core.production.orderMax(type);
        return typeof max === 'number' && max > 0 ? max : 1;
    }

    // The runs of one order for a row: its Items value, whole and at least
    // 1, never more than one order message of the type can carry. The one
    // clamp, so a stored value is never trusted as is.
    function itemsFor(cfg, type) {
        var v = cfg ? Math.floor(cfg.items) : NaN;
        if (!(v > 0)) v = 1;
        return Math.min(v, runsMax(type));
    }

    // Mines and masons are the mining module's; their names come from the
    // deposit types it manages.
    function ownedByMining(name) {
        var types;
        try { types = S.core.deposits.types(); }
        catch (e) { return false; }
        for (var i = 0; i < (types ? types.length : 0); i++) {
            if (types[i] && (types[i].mineName === name || types[i].masonName === name)) return true;
        }
        return false;
    }

    // Names the manager hides are never ordered or buffed, even from a
    // stale saved row: the model's hidden list is the one gate.
    function hiddenName(name) {
        var m = S.modules.production.model;
        return !!(m && typeof m.hiddenByName === 'function' && m.hiddenByName(name));
    }

    // The producer of a name; the rule lives in core.
    function highest(name) {
        return S.core.production.producer(name);
    }

    // name -> production type for every queue building name on the home
    // zone, mines and masons left out. {} when the buildings cannot be read.
    function queueNames() {
        var out = {};
        var types = S.core.production.queueTypes();
        for (var i = 0; i < (types ? types.length : 0); i++) {
            var bs = types[i].buildings || [];
            for (var j = 0; j < bs.length; j++) {
                var n = bs[j].name;
                if (typeof n !== 'string' || !n || has(out, n) || ownedByMining(n)) continue;
                out[n] = types[i].type;
            }
        }
        return out;
    }

    // True when a name of the given type has its row enabled. Collection
    // of a queue follows the switch of the building that runs it.
    function typeRowOn(s, names, type) {
        var cfgs = s.buildings || {};
        for (var name in names) {
            if (has(names, name) && names[name] === type && rowOn(cfgs[name])) return true;
        }
        return false;
    }

    function sortedKeys(o) {
        var out = [];
        for (var k in o) if (has(o, k)) out.push(k);
        out.sort();
        return out;
    }

    function isReady(ctx) {
        var s = readSettings();
        if (!s || !s.enabled) return false;
        if (!ctx || !ctx.zone || !ctx.zone.isHome) return false;
        return true;
    }

    function enqueue(ctx, name, params) {
        ctx.queued++;
        S.kernel.queue.add(name, params, ctx.queued === 1 ? 0 : ctx.delay);
    }

    function tryComplete(s, ctx, names) {
        if (!s.bookComplete) return;
        var types = S.core.production.queueTypes() || [];
        for (var i = 0; i < types.length; i++) {
            var type = types[i].type;
            var pr = S.core.production.profile(type);
            if (!pr || !pr.needsComplete) continue;
            if (!typeRowOn(s, names, type)) continue;
            if (completeHolds[type] > clock()) continue;
            var list = S.core.production.entries(type);
            if (!list || !list.length || !list[0].finished) continue;
            enqueue(ctx, 'production.complete', [type]);
            return;                               // one completion per pass
        }
    }

    // The buff to send with the order this pass places for a name, or ''.
    // A buff goes only with an own order and only to a producer that shows
    // no running production buff, so none is spent on top of a running one.
    // The engine is not asked here: the queue is idle by construction at
    // plan time, so the building would always read "not producing"; the
    // buff action asks it once the order has landed. A throw costs only the
    // buff, never the order.
    function buffFor(s, ctx, names, name) {
        try {
            if (!s.buffs) return '';
            if (!(ctx.buffs < (s.buffsPerPass > 0 ? s.buffsPerPass : 0))) return '';
            var cfg = (s.buildings || {})[name];
            if (!rowOn(cfg)) return '';
            if (hiddenName(name)) return '';   // refreshNeeds already said so
            var buff = cfg.buff;
            if (typeof buff !== 'string' || !buff) return '';
            if (ownedByMining(name)) {
                debugOnce('mining|' + name, name, 'is buffed by mining — skipping buff');
                return '';
            }
            if (!has(names, name)) {
                debugOnce('scope|' + name, name, 'has no production queue — its buff is not managed here');
                return '';
            }
            if (!S.core.buffs.buildingBuffMatch(buff, name, false)) {
                debugOnce('match|' + name + '|' + buff, 'buff', buff, 'does not target', name, '— skipping buff');
                return '';
            }
            // Stock is read once per buff per pass and counted down locally,
            // because the buffs chosen so far have not left the stock yet.
            var stock = has(ctx.buffStock, buff) ? ctx.buffStock[buff] : S.core.buffs.stock(buff, '');
            // An unreadable stock is not an empty one: skip, say so once, and
            // leave ctx.buffStock alone so a null is never cached or counted down.
            if (typeof stock !== 'number') {
                debugOnce('stock|' + buff, 'buff', buff, 'stock unreadable — skipping buff');
                return '';
            }
            if (!(stock > 0)) return '';
            var b = highest(name);
            if (!b) return '';
            var on = S.core.buildings.hasProductionBuff(b);
            if (on === true) {
                debugOnce('buffed|' + name, name, 'already has a production buff — no buff with this order');
                return '';
            }
            if (on !== false) {
                debugOnce('buffread|' + name, 'buff state of', name, 'unreadable — no buff with this order');
                return '';
            }
            // Readable and unbuffed: the next running buff or unreadable
            // state is said again.
            delete said['buffed|' + name];
            delete said['buffread|' + name];
            var grid = S.core.buildings.grid(b);
            if (ctx.assigned[grid]) return '';
            ctx.assigned[grid] = true;
            ctx.buffs++;
            ctx.buffStock[buff] = stock - 1;
            return buff;
        } catch (e) {
            S.kernel.error('production', 'buff choice threw:', e);
            return '';
        }
    }

    // Drops this module's needs and, when automatic queues are on, puts one
    // need per enabled row with an item whose name has a producer. An item
    // the host would not let the player order now puts no need; that is
    // said once, and again only after the row was orderable or changed in
    // between. A null (unreadable) check still puts the need.
    function refreshNeeds(s, names) {
        var demand = S.core.production.demand;
        demand.dropOwner(OWNER);
        if (!s.standing) return;
        var cfgs = s.buildings;
        var keys = sortedKeys(cfgs);
        var stillOut = {};
        for (var i = 0; i < keys.length; i++) {
            var name = keys[i];
            var cfg = cfgs[name];
            if (!rowOn(cfg) || typeof cfg.item !== 'string' || !cfg.item) continue;
            if (hiddenName(name)) {
                debugOnce('hidden|' + name, name, 'is hidden by name — not ordered or buffed');
                continue;
            }
            if (!has(names, name) || !highest(name)) continue;
            var type = names[name];
            if (S.core.production.isProducible(type, cfg.item) === false) {
                stillOut[name] = cfg.item;
                if (unproducible[name] !== cfg.item) {
                    S.kernel.debug('production', name + ' automatic queue ' + cfg.item +
                                   ' is not producible now - not ordering');
                }
                continue;
            }
            demand.put(OWNER, name, {
                label:    'Automatic queue: ' + S.core.locale.bui(name),
                type:     type,
                item:     cfg.item,
                items:    itemsFor(cfg, type),
                basis:    S.DemandBasis.Queue,
                priority: S.ProductionPriority.Standing
            });
        }
        unproducible = stillOut;
    }

    // An order hold is a planner hold, so a held name reads Held and is
    // neither priced nor counted against maxOrders. The planner's hook is
    // keyed by item, so two names standing on the same item are both held
    // while one of them is: an unseen order of that item may still land,
    // and holding both is the safe side. orderRuns makes every own need an
    // idle-only order of the row's Items runs.
    function planOpts(s) {
        var heldItems = {};
        var cfgs = s.buildings || {};
        for (var key in cfgs) {
            if (!has(cfgs, key) || !orderHeld(key)) continue;
            var item = cfgs[key] && cfgs[key].item;
            if (typeof item === 'string' && item) heldItems[item] = true;
        }
        return {
            actFor:    OWNER,
            maxOrders: s.ordersPerPass > 0 ? s.ordersPerPass : 0,
            orderRuns: function (n) { return n.owner === OWNER ? itemsFor(cfgs[n.key], n.type) : null; },
            isHeld:    function (kind, it) {
                return S.core.production.demand.isHeld(kind, it, OWNER) ||
                    (has(heldItems, it) ? { owner: OWNER, label: UNSEEN_HOLD } : null);
            }
        };
    }

    function tryStanding(s, ctx, names) {
        refreshNeeds(s, names);
        if (!s.standing) {
            lastPass = { at: Date.now(), rows: [] };
            return;
        }
        var r = S.core.production.plan(S.core.production.demand.list(), planOpts(s));
        lastPass = { at: Date.now(), rows: r.rows };
        for (var i = 0; i < r.orders.length; i++) {
            var o = r.orders[i];
            if (orderBreaker.admit(1) === 0) return;         // open and no probe due
            ctx.orders++;
            var buff = buffFor(s, ctx, names, o.key);
            // The stack equals the runs, so one message carries the whole order.
            enqueue(ctx, 'production.order', [o.type, o.item, o.runs, o.runs, o.key, buff]);
        }
    }

    // The gap between queued actions; s defaults to the stored settings.
    function delayOf(s) {
        if (!s) s = readSettings();
        return typeof s.actionDelay === 'number' ? s.actionDelay : 1500;
    }

    // The two phases share one read pass, so queueNames(), the phases and
    // the producer lookups read the queue types, each type's entries and the
    // building name index once per plan instead of once per caller. The pass
    // is safe because nothing in it sends: enqueue only adds to the kernel
    // queue, whose actions run later, outside this pass, and read fresh.
    function planPass(s) {
        var ctx = { assigned: {}, queued: 0, orders: 0, buffs: 0, buffStock: {},
                    delay: delayOf(s) };
        var names = {};
        try { names = queueNames(); }
        catch (e) { S.kernel.warn('production', 'queueNames threw:', e); }

        try { tryComplete(s, ctx, names); }
        catch (e1) { S.kernel.error('production', 'complete phase threw:', e1); }
        try { tryStanding(s, ctx, names); }
        catch (e3) { S.kernel.error('production', 'standing phase threw:', e3); }
        return ctx;
    }

    function plan() {
        var s = readSettings();
        if (!s || !s.enabled) return;
        var ctx = S.kernel.hostRead.pass(function () { return planPass(s); });
        if (ctx.queued > 0) S.kernel.log('production', 'queued', ctx.queued, 'action(s)');
        return ctx;
    }

    function orderAction(params) {
        var type  = params[0];
        var item  = params[1];
        var runs  = params[2];
        var stack = params[3];
        var name  = params[4];
        var buff  = typeof params[5] === 'string' ? params[5] : '';

        if (!switchOn('standing')) {
            S.kernel.debug('production', 'automatic queues are off - skipping order of', item);
            return;
        }
        // Re-check: the producer may have changed since plan() queued.
        var b = highest(name);
        if (!b) {
            S.kernel.log('production', 'no', name, 'left — skipping order of', item);
            return;
        }
        var grid = S.core.buildings.grid(b);
        var def = S.core.production.orderIn(type, item, runs, { stack: stack, grid: grid });

        function onDone(r) {
            var R = S.ActionResult;
            if (r.status === R.Verified) {
                orderBreaker.verify(name);
                delete holds[name];
                placed[type + '|' + item] = true;
                // Only now does the building have work to buff. This runs
                // inside a queued action, so the kernel files the buff under
                // this module: it stays cancellable and keeps it busy.
                if (buff) S.kernel.queue.add('production.buff', [grid, name, buff, 0], delayOf());
            } else if (r.status === R.Failed && r.unseen) {
                holds[name] = clock() + ORDER_HOLD_MS;
                orderBreaker.miss();
                S.kernel.warn('production', r.label, 'was not seen in the queue — holding', name);
            } else if (r.status === R.Failed) {
                holds[name] = clock() + ORDER_HOLD_MS;
            } else if (r.status === R.Refused) {
                S.kernel.debug('production', r.label, 'refused:', r.reason);
            }
        }

        if (!S.core.actions.attempt(def, onDone)) {
            S.kernel.error('production', 'could not start', def.label);
        }
    }

    function buffAction(params) {
        var grid = params[0];
        var name = params[1];
        var buff = params[2];
        var tries = typeof params[3] === 'number' ? params[3] : 0;

        if (!switchOn('buffs')) {
            S.kernel.debug('production', 'buffs are off — skipping buff of', name);
            return;
        }
        // The producer may have changed (a building upgraded past it) since
        // the order was queued.
        var b = highest(name);
        if (!b || S.core.buildings.grid(b) !== grid) {
            S.kernel.debug('production', 'producer of', name, 'changed — skipping buff on grid', grid);
            return;
        }
        var st = S.core.buildings.productionState(b);
        if (st !== S.core.buildings.PRODUCING_STATE && tries < BUFF_START_RETRIES) {
            S.kernel.queue.add('production.buff', [grid, name, buff, tries + 1], delayOf());
            return;
        }
        // The engine holds the building checks (already buffed, not
        // producing, blockers), the grid hold and the breaker.
        var verdict = buffEngine.eligible(b, null);
        if (verdict !== S.BuffVerdict.Ok) {
            S.kernel.debug('production', name, 'grid', grid, 'cannot take', buff, 'now:',
                           S.core.buildings.buffBlock(b) || verdict);
            return;
        }
        buffEngine.apply(grid, name, buff, false);
    }

    // Completes the head entry of a type's queue. A failure holds the
    // queue, since what the message does is not confirmed live.
    function completeNow(type) {
        var def = S.core.production.complete(type);
        var ok = S.core.actions.attempt(def, function (r) {
            if (r && r.status === S.ActionResult.Failed) completeHolds[type] = clock() + COMPLETE_HOLD_MS;
        });
        if (!ok) S.kernel.error('production', 'could not start', def.label);
    }

    // The switch and the Bookbinder row are both read again here, because
    // either may have been turned off since plan() queued the completion.
    function completeAction(params) {
        var type = params[0];
        var s = readSettings();
        if (!s.enabled || !s.bookComplete) {
            S.kernel.debug('production', 'book completion is off — skipping completion of queue', type);
            return;
        }
        if (!typeRowOn(s, queueNames(), type)) {
            S.kernel.debug('production', 'the row of queue', type, 'is not enabled — skipping completion');
            return;
        }
        completeNow(type);
    }

    function boot() {
        migrateSettings();
        if (!S.kernel.settings.read('production')) {
            S.kernel.settings.write('production', S.modules.production.defaultSettings);
        }
        S.kernel.queue.action('production.order', orderAction);
        S.kernel.queue.action('production.buff', buffAction);
        S.kernel.queue.action('production.complete', completeAction);
    }

    // The one off path, called after a dashboard Save and after every
    // submenu flip. The module off stops its own queued work and withdraws
    // its needs at once, instead of waiting for them to expire; automatic
    // queues off withdraws the needs. Other sub-switches need no cancel,
    // because each queued action re-checks its switch when it runs.
    function applySettings() {
        var s = readSettings();
        var demand = S.core.production.demand;
        if (!s.enabled) {
            if (S.kernel.queue && S.kernel.queue.cancelByModule) S.kernel.queue.cancelByModule(OWNER);
            if (demand) demand.dropOwner(OWNER);
            return;
        }
        if (!s.standing && demand) demand.dropOwner(OWNER);
    }

    if (S.kernel.lifecycle && S.kernel.lifecycle.applySettings) {
        S.kernel.lifecycle.applySettings.production = applySettings;
    }

    var P = S.modules.production;
    P.readSettings  = readSettings;
    P.orderBreaker  = orderBreaker;
    P.buffEngine    = buffEngine;
    P.orderHolds    = function () { return holds; };
    P.completeHolds = function () { return completeHolds; };
    P.isPlaced      = function (type, item) { return placed[type + '|' + item] === true; };
    P.ownedByMining = ownedByMining;
    P.hiddenName    = hiddenName;
    P.highest       = highest;
    P.queueNames    = queueNames;
    P.itemsFor      = itemsFor;
    P.runsMax       = runsMax;
    P.lastPass      = function () { return lastPass; };

    S.kernel.register({
        id:       'production',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        ui: {
            tab: 'production',
            section: {
                id:    'production',
                title: 'Production',
                icon:  '⚙',
                side: function ($side, h) {
                    if (S.modules.production.side) return S.modules.production.side($side, h);
                },
                render: function ($main, h) {
                    if (S.modules.production.render) return S.modules.production.render($main, h);
                },
                summary: function (h) {
                    return S.modules.production.summary ? S.modules.production.summary(h) : '';
                },
                tiles: function (h) {
                    return S.modules.production.tiles ? S.modules.production.tiles(h) : [];
                }
            }
        },
        menu: {
            title: 'Production',
            items: function () {
                return S.modules.production.menu ? S.modules.production.menu.items() : [];
            }
        }
    });

}(Steward));
