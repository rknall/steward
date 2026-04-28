/*
 * Mining module.
 *
 * Manages the mine-building lifecycle on the home zone. v1 fills the
 * `tryBuild` phase only — places a mine on every deposit grid that
 * has no building, subject to build-queue slots, building licenses,
 * and per-mine affordability. The other phases (tryUpgrade, tryPause,
 * tryBuff, tryRefill) are stubs that return immediately; they land in
 * v2 once the core/buffs subsystem exists.
 *
 * The geologists module covers deposit-search dispatch. This module
 * runs independently on the same tick: geos find deposits → next tick,
 * mining sees them on map → queues build. No coupling beyond shared
 * S.core.deposits.types().
 *
 * Honours the kernel's busy contract: once plan() has enqueued one
 * action per available slot the module is "busy" until the queue
 * drains. No second plan() call piles work on top.
 */

(function (S) {

    if (!S.modules.mining) S.modules.mining = {};

    function readSettings() {
        var stored = S.kernel.settings.read('mining') || {};
        var defaults = S.modules.mining.defaultSettings || {};
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        // Deep-merge nested deposits map so partial user edits don't
        // wipe defaults for deposit types the user hasn't touched.
        var depMerged = {};
        var defaultDeps = defaults.deposits || {};
        var storedDeps  = stored.deposits  || {};
        for (key in defaultDeps) depMerged[key] = defaultDeps[key];
        for (key in storedDeps)  depMerged[key] = storedDeps[key];
        merged.deposits = depMerged;
        return merged;
    }

    function isReady(ctx) {
        var s = readSettings();
        if (!s || !s.enabled) return false;
        if (!ctx.zone || !ctx.zone.isHome) return false;
        return true;
    }

    function readPlanContext() {
        var s = readSettings();
        var slotsRemaining = 0;
        var licensesRemaining = 0;
        try {
            var p  = game.gi.mCurrentPlayer;
            var bq = p.mBuildQueue;
            slotsRemaining    = bq.GetTotalAvailableSlots() - bq.GetQueue_vector().length;
            licensesRemaining = p.GetMaxBuildingCount() - p.mCurrentBuildingsCountAll;
        } catch (e) {
            S.kernel.warn('mining', 'readPlanContext threw:', e);
        }
        return {
            slotsRemaining:    slotsRemaining,
            licensesRemaining: licensesRemaining,
            queued:             0,
            assigned:           {},
            actionDelay:       (typeof s.actionDelay === 'number') ? s.actionDelay : 1500
        };
    }

    // Phase functions. Production bodies are filled in later tasks
    // (tryBuild in Task 4, the rest in v2). Tests inject stubs via
    // S.modules.mining._phases — see tests/modules/mining.test.js.
    function tryBuild(info, cfg, ctx)   { /* filled in Task 4 */ }
    function tryUpgrade(info, cfg, ctx) { /* v2 */ }
    function tryPause(info, cfg, ctx)   { /* v2 */ }
    function tryBuff(info, cfg, ctx)    { /* v2 — mine OR mason */ }
    function tryRefill(info, cfg, ctx)  { /* v2 — all types */ }

    function phase(name, info, cfg, ctx) {
        var override = S.modules.mining._phases && S.modules.mining._phases[name];
        if (typeof override === 'function') return override(info, cfg, ctx);
        if (name === 'tryBuild')   return tryBuild(info, cfg, ctx);
        if (name === 'tryUpgrade') return tryUpgrade(info, cfg, ctx);
        if (name === 'tryPause')   return tryPause(info, cfg, ctx);
        if (name === 'tryBuff')    return tryBuff(info, cfg, ctx);
        if (name === 'tryRefill')  return tryRefill(info, cfg, ctx);
    }

    function plan() {
        var s = readSettings();
        if (!s || !s.enabled) return;
        if (!S.core.deposits || !S.core.deposits.types) {
            S.kernel.error('mining', 'core.deposits.types unavailable — bundle order issue?');
            return;
        }
        var ctx = readPlanContext();
        var types = S.core.deposits.types();
        var depCfg = (s && s.deposits) || {};
        for (var t = 0; t < types.length; t++) {
            var info = types[t];
            var cfg = depCfg[info.name];
            if (!cfg || !cfg.enabled) continue;

            if (info.mineName) {
                phase('tryBuild',   info, cfg, ctx);
                phase('tryUpgrade', info, cfg, ctx);
                phase('tryPause',   info, cfg, ctx);
            }
            phase('tryBuff',  info, cfg, ctx);
            phase('tryRefill', info, cfg, ctx);
        }
        if (ctx.queued > 0) {
            S.kernel.log('mining', 'queued', ctx.queued, 'action(s)');
        }
    }

    function boot() {
        if (!S.kernel.settings.read('mining')) {
            S.kernel.settings.write('mining', S.modules.mining.defaultSettings);
        }
        // Queue action 'mining.buildMine' is registered in Task 4.
    }

    // Exposed for ui.js (set in Task 5).
    S.modules.mining.readSettings = readSettings;

    S.kernel.register({
        id:       'mining',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        ui: {
            tab: 'geologists',
            section: {
                id:    'mining',
                title: 'Mining',
                render: function ($body, h) {
                    if (S.modules.mining.renderSection) {
                        return S.modules.mining.renderSection($body, h);
                    }
                },
                summary: function () {
                    return S.modules.mining.summary
                        ? S.modules.mining.summary()
                        : '';
                }
            }
        }
    });

}(Steward));
