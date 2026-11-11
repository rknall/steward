/*
 * Scheduler.
 *
 * Cooperative round-robin within priority tiers. On every tick:
 *   - build context (zone, time, session flags)
 *   - for each tier (Critical → Normal → Idle), advance the per-tier cursor
 *     and call isReady → plan on each module starting from cursor offset
 *   - drain the queue (FIFO with per-task delay)
 *
 * isReady/plan throws are caught and logged — never propagate to the kernel
 * tick. A misbehaving module does not stop the system.
 *
 * Between ticks a module may ask for one extra plan() with wake(id, delayMs). A
 * wake runs on its own timer and touches no cursor, no tickCount, no tick timer
 * and no other module, so the others keep their tick. It obeys the same busy
 * contract as a tick and ends with a drain, whose pending gap it cannot shorten.
 * A module keeps a chain going by asking again from plan(); the next tick picks
 * up a chain that ended. stop() clears pending wakes, so none survives a kernel
 * Pause or a reload.
 *
 * The tick always reschedules, even when its body throws: each tier is walked
 * in its own try, and the next tick is armed from a finally. The tick writes a
 * heartbeat at most every HEARTBEAT_MS and a gap WARN when the timer was held
 * (e.g. by a locked or disconnected session). A missing heartbeat in the log
 * therefore means the timer itself stopped.
 */

(function (S) {

    var state = {
        running:         false,
        tickIntervalMs:  S.kernel.TIMEOUTS.TICK_INTERVAL_MS,
        tickCount:       0,
        timer:           null,
        cursors:         {},     // { priority: number }
        wakes:           {},     // { moduleId: { timer, due } }
        lastTickAt:      null,   // start of the last tick, for the gap check
        lastHeartbeatAt: null    // last heartbeat line
    };

    function buildContext() {
        var ctx = {
            now:     Date.now(),
            tick:    state.tickCount,
            zone:    { id: null, isHome: false, isAdventure: false, isFriend: false },
            session: {}
        };
        try {
            if (S.core.zone && typeof S.core.zone.id === 'function') {
                ctx.zone.id = S.core.zone.id();
                ctx.zone.isHome = S.core.zone.isHome();
                ctx.zone.isAdventure = typeof S.core.zone.isAdventure === 'function'
                    ? S.core.zone.isAdventure() : false;
            }
        } catch (e) {
            S.kernel.warn('scheduler', 'buildContext: zone read failed:', e);
        }
        return ctx;
    }

    function safeIsReady(mod, ctx) {
        try {
            return mod.isReady(ctx) === true;
        } catch (e) {
            S.kernel.warn('scheduler', mod.id, 'isReady threw:', e, '— treated as false');
            return false;
        }
    }

    function safePlan(mod, ctx) {
        // Set the kernel-internal "current module" pointer so queue.add can
        // tag enqueued actions with this module's id. This is single-threaded
        // JS — no concurrency to worry about.
        S.kernel._currentModule = mod.id;
        try {
            mod.plan(ctx);
        } catch (e) {
            S.kernel.error('scheduler', mod.id, 'plan threw:', e);
        }
        S.kernel._currentModule = null;
    }

    function walkTier(priority, ctx) {
        var inTier = S.kernel.registry.byTier(priority);
        if (inTier.length === 0) return;
        var cursor = state.cursors[priority] || 0;
        if (cursor >= inTier.length) cursor = 0;
        for (var offset = 0; offset < inTier.length; offset++) {
            var idx = (cursor + offset) % inTier.length;
            var mod = inTier[idx];
            // Module busy contract: skip plan() while the module has pending
            // or in-flight queue work. Prevents accumulation when drainage is
            // slower than tick rate (e.g. user has a host modal open).
            // See docs/SCHEDULER.md "Module busy contract".
            if (S.kernel.queue.isModuleBusy(mod.id)) continue;
            if (safeIsReady(mod, ctx)) safePlan(mod, ctx);
        }
        state.cursors[priority] = (cursor + 1) % inTier.length;
    }

    function drainQueue() {
        try {
            if (S.kernel.queue && typeof S.kernel.queue.drain === 'function') {
                S.kernel.queue.drain();
            }
        } catch (e) {
            S.kernel.error('scheduler', 'queue.drain threw:', e);
        }
    }

    function seconds(ms) { return Math.round(ms / 1000); }

    // A tick body throw would repeat on every tick, so it writes one line per
    // LOG_REPEAT_MS with a count of the lines held back. The limiter never
    // throws, so logging cannot stop the tick.
    var tickThrewNote = S.kernel.log.limited(function () { return S.kernel.TIMEOUTS.LOG_REPEAT_MS; });

    function noteTickThrew(err) {
        tickThrewNote('error', 'scheduler', 'tick threw', err);
    }

    // A tick far later than its interval means the host held the timer. The
    // stamp is set on every tick; start() clears it, so a resume after a pause
    // reports no gap. A wake never touches it.
    function noteGap(now) {
        var last = state.lastTickAt;
        state.lastTickAt = now;
        try {
            if (last !== null && now - last > S.kernel.LIMITS.TICK_GAP_FACTOR * state.tickIntervalMs) {
                S.kernel.warn('scheduler', 'tick gap ' + seconds(now - last) + ' s (interval ' +
                    seconds(state.tickIntervalMs) + ' s): the timer was held, e.g. by a locked or ' +
                    'disconnected session');
            }
        } catch (e) { /* logging never stops the tick */ }
    }

    // Each queue read is checked, since an older queue may be loaded during a
    // reload; a missing read prints '?'.
    function heartbeatLine() {
        var Q = S.kernel.queue || {};
        var depth = typeof Q.depth === 'function' ? Q.depth() : '?';
        var draining = typeof Q.isDraining === 'function'
            ? (Q.isDraining() ? 'draining' : 'idle') : '?';
        var deferring = '?';
        if (typeof Q.deferral === 'function') {
            var d = Q.deferral();
            if (d === null) {
                deferring = 'no';
            } else {
                deferring = seconds(d.ms) + ' s by ' + (typeof Q.dialogList === 'function'
                    ? Q.dialogList(d.ids) : String(d.ids));
            }
        }
        var busy = '?';
        if (typeof Q.isModuleBusy === 'function') {
            var mods = S.kernel.registry.list();
            var ids = [];
            for (var i = 0; i < mods.length; i++) {
                if (Q.isModuleBusy(mods[i].id)) ids.push(mods[i].id);
            }
            busy = ids.length > 0 ? ids.join(', ') : 'none';
        }
        return 'heartbeat: tick ' + state.tickCount + ', queue ' + depth + ' (' + draining +
            '), deferring ' + deferring + ', busy ' + busy;
    }

    // A manual tick without start() has no stamp yet; it sets one and writes
    // nothing, so the first line comes one full interval later.
    function noteHeartbeat(now) {
        try {
            if (state.lastHeartbeatAt === null) {
                state.lastHeartbeatAt = now;
                return;
            }
            if (now - state.lastHeartbeatAt < S.kernel.TIMEOUTS.HEARTBEAT_MS) return;
            state.lastHeartbeatAt = now;
            S.kernel.log('scheduler', heartbeatLine());
        } catch (e) { /* logging never stops the tick */ }
    }

    function tickBody() {
        var now = Date.now();
        noteGap(now);
        state.tickCount++;
        var ctx = buildContext();
        S.kernel.debug('scheduler', 'tick', state.tickCount, 'modules:', S.kernel.registry.count());

        // One throwing tier still lets the later tiers and the drain run.
        for (var i = 0; i < S.kernel.PRIORITY_ORDER.length; i++) {
            try {
                walkTier(S.kernel.PRIORITY_ORDER[i], ctx);
            } catch (e) {
                noteTickThrew(e);
            }
        }

        drainQueue();

        noteHeartbeat(now);
    }

    // The finally keeps the timer chain alive whatever the body does: a tick
    // that stops rescheduling would stop steward for the life of the instance.
    function tick() {
        if (!state.running) return;
        try {
            tickBody();
        } catch (e) {
            noteTickThrew(e);
        } finally {
            scheduleNext();
        }
    }

    function scheduleNext() {
        if (!state.running) return;
        if (state.timer !== null) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        state.timer = setTimeout(function () {
            state.timer = null;
            tick();
        }, state.tickIntervalMs);
    }

    function clearWakes() {
        for (var id in state.wakes) {
            if (state.wakes.hasOwnProperty(id)) clearTimeout(state.wakes[id].timer);
        }
        state.wakes = {};
    }

    // One extra plan() of this module after delayMs, between ticks. One wake per
    // module; the earliest due time wins, so a Resume or a moved step is not held
    // back by a slower wake already pending. Touches no cursor, no tickCount, no
    // other module, so the others keep their tick.
    function wake(id, delayMs) {
        if (!state.running || !S.kernel.registry.get(id)) return false;
        var ms = Math.max(typeof delayMs === 'number' ? delayMs : 0, S.kernel.TIMEOUTS.WAKE_MIN_MS);
        var due = Date.now() + ms;
        if (state.wakes.hasOwnProperty(id)) {
            if (state.wakes[id].due <= due) return false;
            clearTimeout(state.wakes[id].timer);
        }
        state.wakes[id] = {
            due:   due,
            timer: setTimeout(function () {
                delete state.wakes[id];
                runWake(id);
            }, ms)
        };
        return true;
    }

    function runWake(id) {
        if (!state.running) return;
        var mod = S.kernel.registry.get(id);
        if (!mod) return;
        // The busy contract of walkTier. Waits for the queue without a game read.
        if (S.kernel.queue.isModuleBusy(id)) {
            wake(id, S.kernel.TIMEOUTS.WAKE_BUSY_RECHECK_MS);
            return;
        }
        var ctx = buildContext();
        if (safeIsReady(mod, ctx)) safePlan(mod, ctx);
        // A pending gap keeps the queue draining, so this cannot shorten it.
        drainQueue();
    }

    function configure(cfg) {
        if (!cfg) return;
        if (typeof cfg.tickInterval === 'number' && cfg.tickInterval > 0) {
            state.tickIntervalMs = cfg.tickInterval;
        }
    }

    function start() {
        if (state.running) return;
        state.running = true;
        // A resume after a pause is no gap, and needs no immediate heartbeat.
        state.lastTickAt = null;
        state.lastHeartbeatAt = Date.now();
        S.kernel.log('scheduler', 'started, tickInterval=' + state.tickIntervalMs + 'ms');
        // Defer the first tick to next loop turn so callers can finish setting up.
        state.timer = setTimeout(tick, 0);
    }

    function stop() {
        state.running = false;
        if (state.timer !== null) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        clearWakes();
        S.kernel.log('scheduler', 'stopped');
    }

    S.kernel.scheduler = {
        start:     start,
        stop:      stop,
        tick:      tick,           // manual trigger (mostly for diagnostics)
        wake:      wake,           // one extra plan() of one module, between ticks
        configure: configure,
        state:     state
    };

}(Steward));
