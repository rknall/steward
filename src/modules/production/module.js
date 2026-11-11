/*
 * Production module.
 *
 * Keeps the timed production queues of the home zone busy. Each plan pass
 * runs three phases, each capped per pass and each in its own try/catch:
 *
 *   complete  (bookComplete) finishes the head entry of a queue that waits
 *             for completion (the Bookbinder), at most one per pass.
 *   buff      (buffs) keeps the configured production buff on the
 *             producer of each configured building name, at most
 *             buffsPerPass applies, through the shared S.core.buffing
 *             engine, so each apply is verified on the building.
 *   standing  (standing) puts one "keep N queued" need per configured
 *             building into the demand ledger and orders what the planner
 *             says is missing, at most ordersPerPass orders, each verified
 *             through S.core.production.orderIn.
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
 * same names and never orders into or buffs them.
 *
 * Standing orders are priced by the planner against every other owner's
 * needs in priority order, so an adventure run's RunNow need keeps its
 * resources and a standing order waits. A kind or item another owner holds
 * (adventure troops while a run is active) is not ordered here.
 *
 * Guards: an order not seen in its queue holds that building for 30 min
 * and counts a miss on the order breaker. The hold is a planner hold, so a
 * held name reads Held and takes no ordersPerPass slot or resources from
 * another name. Five misses in a row pause all
 * standing orders until a probe is verified or the user resets the
 * breaker. The buff engine keeps its own breaker and grid holds the same
 * way. Breakers, holds, the placed set and the recent list are memory only,
 * so a script reload resets them.
 *
 * Off (enabled false) stops only this module's own work: its queued
 * actions are cancelled and its needs dropped. Adventure runs keep
 * ordering their own items and troops. Standing orders off drops the
 * needs only. A queued action re-checks its own switch when it runs, so a
 * sub-switch turned off needs no cancel.
 *
 * recent() lists what the module did, newest first:
 *   { at, kind, name, item, status, unseen, detail, text }
 * kind is an S.ProductionNote value; status an S.ActionResult value, null
 * for a Skip; unseen is true for an attempt that was not seen; detail is
 * the success detail (what an order changed, or "held by ..." for a Skip)
 * and '' otherwise; text is the full line shown to the user.
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
    var RECENT_MAX       = 50;
    // The hold label of a name whose last order was not seen or failed.
    var UNSEEN_HOLD      = 'an unseen order';

    var orderBreaker = S.core.breaker.create({
        category:   'production',
        label:      'order breaker',
        missText:   'orders in a row were not seen in their queue',
        pausedText: 'standing orders are paused',
        resumeText: 'standing orders resume'
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
    var recent        = [];   // newest first, at most RECENT_MAX
    var lastHeld      = {};   // building name -> true while its standing row reads Held
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

    function clock() {
        return orderBreaker.clock();
    }

    // True only while the module and the given sub-switch are both on.
    function switchOn(key) {
        var s = readSettings();
        return !!(s && s.enabled && s[key]);
    }

    function orderHeld(key) {
        return holds[key] > clock();
    }

    function note(e) {
        var entry = {
            at:     typeof e.at === 'number' ? e.at : Date.now(),
            kind:   e.kind,
            name:   e.name || '',
            item:   e.item || '',
            status: e.status || null,
            unseen: !!e.unseen,
            detail: e.detail || '',
            text:   e.text || ''
        };
        recent.unshift(entry);
        if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
        return entry;
    }

    // The one wording of an attempt's result; r is null when the attempt
    // did not start.
    function resultText(r, okText) {
        var R = S.ActionResult;
        if (!r) return 'failed: could not start';
        if (r.status === R.Verified) return okText;
        if (r.status === R.Failed && r.unseen) return 'failed: not seen';
        if (r.status === R.Failed) return 'failed: ' + r.reason;
        return 'refused: ' + r.reason;
    }

    // Notes an attempt's result. detail is kept only for a verified one.
    function noteResult(kind, name, item, r, okText, detail) {
        var R = S.ActionResult;
        return note({
            kind:   kind,
            name:   name,
            item:   item,
            status: r ? r.status : R.Failed,
            unseen: !!(r && r.unseen),
            detail: r && r.status === R.Verified ? (detail || '') : '',
            text:   resultText(r, okText)
        });
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

    // Items per order message when none is configured: the core stack
    // size for a stackable queue, 1 for any other.
    function defaultStack(type) {
        var pr = S.core.production.profile(type);
        return pr && pr.stackable ? S.core.production.STACK_SIZE : 1;
    }

    // Items per order message for a name: the configured stack, else the
    // type's default.
    function stackFor(name, type) {
        var cfg = readSettings().buildings[name];
        if (cfg && typeof cfg.stack === 'number' && cfg.stack > 0) return cfg.stack;
        return defaultStack(type);
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

    function tryComplete(s, ctx) {
        if (!s.bookComplete) return;
        var types = S.core.production.queueTypes() || [];
        for (var i = 0; i < types.length; i++) {
            var type = types[i].type;
            var pr = S.core.production.profile(type);
            if (!pr || !pr.needsComplete) continue;
            if (completeHolds[type] > clock()) continue;
            var list = S.core.production.entries(type);
            if (!list || !list.length || !list[0].finished) continue;
            enqueue(ctx, 'production.complete', [type]);
            return;                               // one completion per pass
        }
    }

    function tryBuffs(s, ctx, names) {
        if (!s.buffs) return;
        var cfgs = s.buildings;
        var keys = sortedKeys(cfgs);
        var max = s.buffsPerPass > 0 ? s.buffsPerPass : 0;
        for (var i = 0; i < keys.length && ctx.buffs < max; i++) {
            var name = keys[i];
            var buff = cfgs[name] && cfgs[name].buff;
            if (typeof buff !== 'string' || !buff) continue;
            if (ownedByMining(name)) {
                debugOnce('mining|' + name, name, 'is buffed by mining — skipping buff');
                continue;
            }
            if (!has(names, name)) {
                debugOnce('scope|' + name, name, 'has no production queue — its buff is not managed here');
                continue;
            }
            if (!S.core.buffs.buildingBuffMatch(buff, name, false)) {
                debugOnce('match|' + name + '|' + buff, 'buff', buff, 'does not target', name, '— skipping buff');
                continue;
            }
            // Stock is read once per buff per pass and counted down locally,
            // because the applies queued so far have not left the stock yet.
            var stock = has(ctx.buffStock, buff) ? ctx.buffStock[buff] : S.core.buffs.stock(buff, '');
            // An unreadable stock is not an empty one: skip, say so once, and
            // leave ctx.buffStock alone so a null is never cached or counted down.
            if (typeof stock !== 'number') {
                debugOnce('stock|' + buff, 'buff', buff, 'stock unreadable — skipping buff');
                continue;
            }
            if (!(stock > 0)) continue;
            // autoTSO buffs a producer only while its queue has entries.
            var list = S.core.production.entries(names[name]);
            if (!list || !list.length) continue;
            var b = highest(name);
            if (!b) continue;
            var verdict = buffEngine.eligible(b, ctx.assigned);
            if (verdict === S.BuffVerdict.Stop) return;
            if (verdict !== S.BuffVerdict.Ok) continue;   // the producer cannot take it; no fallback
            var grid = S.core.buildings.grid(b);
            ctx.assigned[grid] = true;
            ctx.buffs++;
            ctx.buffStock[buff] = stock - 1;
            enqueue(ctx, 'production.buff', [grid, name, buff]);
        }
    }

    // Drops this module's needs and, when standing orders are on, puts one
    // need per configured queue building that has a producer. The need is
    // clamped to what the type's queue can hold (one book for the
    // Bookbinder), so it never asks for more than can ever be queued.
    function refreshNeeds(s, names) {
        var demand = S.core.production.demand;
        demand.dropOwner(OWNER);
        if (!s.standing) return;
        var cfgs = s.buildings;
        var keys = sortedKeys(cfgs);
        for (var i = 0; i < keys.length; i++) {
            var name = keys[i];
            var cfg = cfgs[name];
            if (!cfg || typeof cfg.item !== 'string' || !cfg.item) continue;
            if (!(typeof cfg.amount === 'number' && cfg.amount > 0)) continue;
            if (!has(names, name) || !highest(name)) continue;
            var type = names[name];
            var keep = S.core.production.keepMax(type);
            var items = Math.floor(typeof keep === 'number' ? Math.min(cfg.amount, keep) : cfg.amount);
            if (!(items > 0)) continue;
            demand.put(OWNER, name, {
                label:    'Standing order: ' + S.core.locale.bui(name),
                type:     type,
                item:     cfg.item,
                items:    items,
                basis:    S.DemandBasis.Queue,
                priority: S.ProductionPriority.Standing
            });
        }
    }

    // An order hold is a planner hold, so a held name reads Held and is
    // neither priced nor counted against maxOrders. The planner's hook is
    // keyed by item, so two names standing on the same item are both held
    // while one of them is: an unseen order of that item may still land,
    // and holding both is the safe side.
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
            stackOf:   function (n) { return stackFor(n.key, n.type); },
            isHeld:    function (kind, it) {
                return S.core.production.demand.isHeld(kind, it, OWNER) ||
                    (has(heldItems, it) ? { owner: OWNER, label: UNSEEN_HOLD } : null);
            }
        };
    }

    // Why a planner row is held, worded to follow "held by ", or null. The
    // one hold wording for the Skip notes and the demand view.
    function holdLabel(row) {
        if (!row || row.status !== S.DemandStatus.Held) return null;
        var pr = S.core.production.profile(row.type);
        var h = S.core.production.demand.isHeld(pr ? pr.kind : null, row.item, row.owner);
        if (h && h.label) return h.label;
        if (row.owner === OWNER && orderHeld(row.key)) return UNSEEN_HOLD;
        return null;
    }

    // A Skip is noted once when a standing row becomes held, not on every
    // pass it stays held.
    function noteHeld(rows) {
        var now = {};
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (r.owner !== OWNER || r.status !== S.DemandStatus.Held) continue;
            now[r.key] = true;
            if (lastHeld[r.key]) continue;
            var label = holdLabel(r);
            var text = 'held' + (label ? ' by ' + label : '');
            note({ kind: S.ProductionNote.Skip, name: r.key, item: r.item,
                   status: null, detail: text, text: text });
        }
        lastHeld = now;
    }

    function tryStanding(s, ctx, names) {
        refreshNeeds(s, names);
        if (!s.standing) {
            lastPass = { at: Date.now(), rows: [] };
            lastHeld = {};
            return;
        }
        var r = S.core.production.plan(S.core.production.demand.list(), planOpts(s));
        lastPass = { at: Date.now(), rows: r.rows };
        noteHeld(r.rows);
        for (var i = 0; i < r.orders.length; i++) {
            var o = r.orders[i];
            if (orderBreaker.admit(1) === 0) return;         // open and no probe due
            ctx.orders++;
            enqueue(ctx, 'production.order', [o.type, o.item, o.runs, stackFor(o.key, o.type), o.key]);
        }
    }

    // The three phases share one read pass, so queueNames(), the phases and
    // the producer lookups read the queue types, each type's entries and the
    // building name index once per plan instead of once per caller. The pass
    // is safe because nothing in it sends: enqueue only adds to the kernel
    // queue, whose actions run later, outside this pass, and read fresh.
    function planPass(s) {
        var ctx = { assigned: {}, queued: 0, orders: 0, buffs: 0, buffStock: {},
                    delay: typeof s.actionDelay === 'number' ? s.actionDelay : 1500 };
        var names = {};
        try { names = queueNames(); }
        catch (e) { S.kernel.warn('production', 'queueNames threw:', e); }

        try { tryComplete(s, ctx); }
        catch (e1) { S.kernel.error('production', 'complete phase threw:', e1); }
        try { tryBuffs(s, ctx, names); }
        catch (e2) { S.kernel.error('production', 'buff phase threw:', e2); }
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

    // The standing pass without enqueuing anything, for the demand view.
    // With standing orders on it refreshes this module's needs first, the
    // same way a plan pass does. It only reads, so it runs in one read pass.
    function assess() {
        var s = readSettings();
        return S.kernel.hostRead.pass(function () {
            if (s.enabled) refreshNeeds(s, queueNames());
            return S.core.production.plan(S.core.production.demand.list(), planOpts(s));
        });
    }

    function orderAction(params) {
        var type  = params[0];
        var item  = params[1];
        var runs  = params[2];
        var stack = params[3];
        var name  = params[4];

        if (!switchOn('standing')) {
            S.kernel.debug('production', 'standing orders are off — skipping order of', item);
            return;
        }
        // Re-check: the producer may have changed since plan() queued.
        var b = highest(name);
        if (!b) {
            S.kernel.log('production', 'no', name, 'left — skipping order of', item);
            return;
        }
        var def = S.core.production.orderIn(type, item, runs, { stack: stack, grid: S.core.buildings.grid(b) });
        // Keep the baseline the attempt reads, so the note can say what changed.
        var base;
        var baseline = def.baseline;
        if (typeof baseline === 'function') {
            def.baseline = function () { base = baseline.apply(def, arguments); return base; };
        }

        function onDone(r) {
            var R = S.ActionResult;
            var what = '';
            if (r.status === R.Verified) {
                orderBreaker.verify(name);
                delete holds[name];
                placed[type + '|' + item] = true;
                try { what = def.describe ? def.describe(base) : ''; } catch (e) { what = ''; }
            } else if (r.status === R.Failed && r.unseen) {
                holds[name] = clock() + ORDER_HOLD_MS;
                orderBreaker.miss();
                S.kernel.warn('production', r.label, 'was not seen in the queue — holding', name);
            } else if (r.status === R.Failed) {
                holds[name] = clock() + ORDER_HOLD_MS;
            } else if (r.status === R.Refused) {
                S.kernel.debug('production', r.label, 'refused:', r.reason);
            } else {
                return;
            }
            noteResult(S.ProductionNote.Order, name, item, r, 'Order verified' + (what ? ': ' + what : ''), what);
        }

        if (!S.core.actions.attempt(def, onDone)) {
            S.kernel.error('production', 'could not start', def.label);
        }
    }

    function buffAction(params) {
        var grid = params[0];
        var name = params[1];
        var buff = params[2];

        if (!switchOn('buffs')) {
            S.kernel.debug('production', 'buffs are off — skipping buff of', name);
            return;
        }
        // The producer may have changed (a building upgraded past it) or
        // taken a buff since plan() queued.
        var b = highest(name);
        if (!b || S.core.buildings.grid(b) !== grid) {
            S.kernel.debug('production', 'producer of', name, 'changed — skipping buff on grid', grid);
            return;
        }
        var block = S.core.buildings.buffBlock(b);
        if (block !== null) {
            S.kernel.debug('production', name, 'grid', grid, 'cannot take', buff, 'now:', block);
            return;
        }
        buffEngine.apply(grid, name, buff, false, function (r) {
            noteResult(S.ProductionNote.Buff, name, buff, r, 'buffed with ' + buff, '');
        });
    }

    // Completes the head entry of a type's queue. The switches do not gate
    // it, because the window's Complete button is a manual action. A
    // failure holds the queue, since what the message does is not confirmed
    // live. Returns whether the attempt started.
    function completeNow(type, item) {
        var name = 'queue ' + type;
        var def = S.core.production.complete(type);
        var ok = S.core.actions.attempt(def, function (r) {
            if (r && r.status === S.ActionResult.Failed) completeHolds[type] = clock() + COMPLETE_HOLD_MS;
            noteResult(S.ProductionNote.Complete, name, item || '', r, 'completed', '');
        });
        if (!ok) {
            S.kernel.error('production', 'could not start', def.label);
            noteResult(S.ProductionNote.Complete, name, item || '', null, 'completed', '');
        }
        return !!ok;
    }

    function completeAction(params) {
        if (!switchOn('bookComplete')) {
            S.kernel.debug('production', 'book completion is off — skipping completion of queue', params[0]);
            return;
        }
        completeNow(params[0], '');
    }

    function boot() {
        if (!S.kernel.settings.read('production')) {
            S.kernel.settings.write('production', S.modules.production.defaultSettings);
        }
        S.kernel.queue.action('production.order', orderAction);
        S.kernel.queue.action('production.buff', buffAction);
        S.kernel.queue.action('production.complete', completeAction);
    }

    // The one off path, called after a dashboard Save and after every
    // submenu flip. The module off stops its own queued work and withdraws
    // its needs at once, instead of waiting for them to expire; standing
    // orders off withdraws the needs. Other sub-switches need no cancel,
    // because each queued action re-checks its switch when it runs.
    function applySettings() {
        var s = readSettings();
        var demand = S.core.production.demand;
        if (!s.enabled) {
            if (S.kernel.queue && S.kernel.queue.cancelByModule) S.kernel.queue.cancelByModule(OWNER);
            if (demand) demand.dropOwner(OWNER);
            lastHeld = {};
            return;
        }
        if (!s.standing) {
            if (demand) demand.dropOwner(OWNER);
            lastHeld = {};
        }
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
    P.recent        = function () { return recent; };
    P.note          = note;
    P.resultText    = resultText;
    P.noteResult    = noteResult;
    P.completeNow   = completeNow;
    P.defaultStack  = defaultStack;
    P.holdLabel     = holdLabel;
    P.isPlaced      = function (type, item) { return placed[type + '|' + item] === true; };
    P.ownedByMining = ownedByMining;
    P.highest       = highest;
    P.queueNames    = queueNames;
    P.stackFor      = stackFor;
    P.lastPass      = function () { return lastPass; };
    P.assess        = assess;

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
