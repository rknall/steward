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
 */

(function (S) {

    var state = {
        running:        false,
        tickIntervalMs: S.kernel.TIMEOUTS.TICK_INTERVAL_MS,
        tickCount:      0,
        timer:          null,
        cursors:        {}      // { priority: number }
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

    // Per-tick cache invalidation. The snapshot caches in core/{buildings,
    // buffs, resources} are designed to be "valid for the duration of one
    // tick" — multiple plan() calls within the same tick share the same
    // snapshot, then the next tick gets a fresh read. Without explicit
    // invalidation here, read-only modules (mining's tryUpgrade, tryPause)
    // would let a snapshot survive across thousands of ticks, holding
    // stale host-VO references that the AIR GC can't reclaim. Long-session
    // memory pressure builds and the host eventually crashes.
    //
    // Each invalidate() is just `snapshot = null`; the next read repopulates
    // from the live host. Defensively wrapped — a missing core subsystem or
    // a thrown invalidate must not abort the tick.
    function invalidateCaches() {
        try { if (S.core.buildings && S.core.buildings.invalidate) S.core.buildings.invalidate(); }
        catch (e) { S.kernel.warn('scheduler', 'buildings.invalidate threw:', e); }
        try { if (S.core.buffs     && S.core.buffs.invalidate)     S.core.buffs.invalidate(); }
        catch (e) { S.kernel.warn('scheduler', 'buffs.invalidate threw:', e); }
        try { if (S.core.resources && S.core.resources.invalidate) S.core.resources.invalidate(); }
        catch (e) { S.kernel.warn('scheduler', 'resources.invalidate threw:', e); }
    }

    function tick() {
        if (!state.running) return;
        state.tickCount++;
        invalidateCaches();
        var ctx = buildContext();
        S.kernel.debug('scheduler', 'tick', state.tickCount, 'modules:', S.kernel.registry.count());

        for (var i = 0; i < S.kernel.PRIORITY_ORDER.length; i++) {
            walkTier(S.kernel.PRIORITY_ORDER[i], ctx);
        }

        try {
            if (S.kernel.queue && typeof S.kernel.queue.drain === 'function') {
                S.kernel.queue.drain();
            }
        } catch (e) {
            S.kernel.error('scheduler', 'queue.drain threw:', e);
        }

        scheduleNext();
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

    function configure(cfg) {
        if (!cfg) return;
        if (typeof cfg.tickInterval === 'number' && cfg.tickInterval > 0) {
            state.tickIntervalMs = cfg.tickInterval;
        }
    }

    function start() {
        if (state.running) return;
        state.running = true;
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
        S.kernel.log('scheduler', 'stopped');
    }

    S.kernel.scheduler = {
        start:     start,
        stop:      stop,
        tick:      tick,           // manual trigger (mostly for diagnostics)
        configure: configure,
        state:     state
    };

}(Steward));
