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
        try {
            mod.plan(ctx);
        } catch (e) {
            S.kernel.error('scheduler', mod.id, 'plan threw:', e);
        }
    }

    function walkTier(priority, ctx) {
        var inTier = S.kernel.registry.byTier(priority);
        if (inTier.length === 0) return;
        var cursor = state.cursors[priority] || 0;
        if (cursor >= inTier.length) cursor = 0;
        for (var offset = 0; offset < inTier.length; offset++) {
            var idx = (cursor + offset) % inTier.length;
            var mod = inTier[idx];
            if (safeIsReady(mod, ctx)) safePlan(mod, ctx);
        }
        state.cursors[priority] = (cursor + 1) % inTier.length;
    }

    function tick() {
        if (!state.running) return;
        state.tickCount++;
        var ctx = buildContext();
        S.kernel.log('scheduler', 'tick', state.tickCount, 'modules:', S.kernel.registry.count());

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
