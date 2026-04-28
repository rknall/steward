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

    function canAffordMine(mineName) {
        if (!mineName) return false;
        try {
            var res = game.zone.GetResources(game.player);
            return !!(res && typeof res.CanPlayerAffordBuilding === 'function' &&
                      res.CanPlayerAffordBuilding(mineName));
        } catch (e) {
            S.kernel.warn('mining', 'canAffordMine threw for', mineName, ':', e);
            return false;
        }
    }

    // Phase functions. tryBuild is live in v1; the rest are v2 stubs
    // (filled once core/buffs lands). Tests inject stubs via
    // S.modules.mining._phases — see tests/modules/mining.test.js.
    function tryBuild(info, cfg, ctx) {
        if (!cfg.build) return;
        if (ctx.slotsRemaining <= 0 || ctx.licensesRemaining <= 0) return;
        if (!info.mineId || !info.mineName) return;

        var onMapDepos;
        try { onMapDepos = S.core.deposits.byType(info.name); }
        catch (e) {
            S.kernel.warn('mining', 'byType threw for', info.name, ':', e);
            return;
        }

        for (var i = 0; i < onMapDepos.length; i++) {
            var depo = onMapDepos[i];
            if (!depo) continue;

            var grid = S.core.deposits.grid(depo);
            if (!grid) continue;
            if (ctx.assigned[grid]) continue;

            // A building (any building, including a depleted shell) on
            // this grid means the deposit is already covered. Depleted
            // shells resolve naturally on the next tick: a geo finds a
            // new deposit, the shell goes away, byGrid returns null,
            // and we queue the build then.
            if (S.core.buildings.byGrid(grid)) continue;

            if (!canAffordMine(info.mineName)) continue;

            ctx.assigned[grid] = true;
            ctx.slotsRemaining--;
            ctx.licensesRemaining--;
            ctx.queued++;

            var delay = (ctx.queued === 1) ? 0 : ctx.actionDelay;
            S.kernel.queue.add('mining.buildMine',
                [info.mineId, grid, info.name, info.mineName],
                delay);

            if (ctx.slotsRemaining <= 0 || ctx.licensesRemaining <= 0) return;
        }
    }
    function tryUpgrade(info, cfg, ctx) {
        if (!cfg.upgrade) return;
        if (ctx.slotsRemaining <= 0) return;
        if (!info.mineName) return;
        var target = (typeof cfg.targetLevel === 'number') ? cfg.targetLevel : 0;
        if (target <= 0) return;

        var onMapDepos;
        try { onMapDepos = S.core.deposits.byType(info.name); }
        catch (e) {
            S.kernel.warn('mining', 'byType threw for', info.name, ':', e);
            return;
        }

        for (var i = 0; i < onMapDepos.length; i++) {
            var depo = onMapDepos[i];
            if (!depo) continue;
            var grid = S.core.deposits.grid(depo);
            if (!grid) continue;
            if (ctx.assigned[grid]) continue;            // tryBuild already claimed this grid

            var bld = S.core.buildings.byGrid(grid);
            if (!bld) continue;                                              // no mine to upgrade
            if (S.core.buildings.name(bld) !== info.mineName) continue;      // wrong building (depleted shell, etc.)
            if (S.core.buildings.level(bld) >= target) continue;             // already at or above target
            if (typeof bld.IsUpgradeAllowed === 'function' &&
                !bld.IsUpgradeAllowed(true)) continue;                       // host says no

            var nextLevel = S.core.buildings.level(bld) + 1;

            ctx.assigned[grid] = true;
            ctx.slotsRemaining--;
            ctx.queued++;

            var delay = (ctx.queued === 1) ? 0 : ctx.actionDelay;
            S.kernel.queue.add('mining.upgradeMine',
                [grid, info.mineName, nextLevel],
                delay);

            if (ctx.slotsRemaining <= 0) return;
        }
    }
    function tryPause(info, cfg, ctx) {
        // Asymmetric reconciliation:
        //   cfg.pause=true  ⇒ pause producing mines whose deposit has dropped
        //                     below pauseThreshold (preserve mine longevity).
        //   cfg.pause=false ⇒ resume any paused mine (unconditional).
        // Pause/resume is a state toggle, not a construction — no slot gate.
        if (typeof cfg.pause !== 'boolean') return;
        if (!info.mineName) return;

        var settings  = readSettings();
        var threshold = (typeof settings.pauseThreshold === 'number')
            ? settings.pauseThreshold : 50;
        var wantsActive = !cfg.pause;

        // Walk deposits (not buildings) so we can read GetAmount() for the
        // threshold gate. Mines on depleted shells (no on-map deposit) are
        // intentionally skipped — we don't auto-resume a depleted shell.
        var depos;
        try { depos = S.core.deposits.byType(info.name); }
        catch (e) {
            S.kernel.warn('mining', 'byType threw for', info.name, ':', e);
            return;
        }
        if (!depos || !depos.length) return;

        for (var i = 0; i < depos.length; i++) {
            var depo = depos[i];
            if (!depo) continue;
            var grid = S.core.deposits.grid(depo);
            if (!grid) continue;
            if (ctx.assigned[grid]) continue;

            var bld = S.core.buildings.byGrid(grid);
            if (!bld) continue;
            if (S.core.buildings.name(bld) !== info.mineName) continue;

            var isActive = (typeof bld.IsProductionActive === 'function')
                ? !!bld.IsProductionActive() : true;
            if (isActive === wantsActive) continue;        // already in desired state

            // Pause direction is gated on remaining amount; resume direction is not.
            if (!wantsActive) {
                var remaining = (typeof depo.GetAmount === 'function')
                    ? depo.GetAmount() : 0;
                if (remaining >= threshold) continue;       // still high-yield — leave it
            }

            ctx.assigned[grid] = true;
            ctx.queued++;

            var delay = (ctx.queued === 1) ? 0 : ctx.actionDelay;
            S.kernel.queue.add('mining.setProduction',
                [grid, info.mineName, wantsActive],
                delay);
        }
    }
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

            // Phase order per deposit:
            //   tryBuild → tryUpgrade → tryBuff → tryPause → tryRefill
            // Buff comes after upgrade so its effect compounds with the
            // newer level. Pause runs last among mine-only phases so the
            // earlier active-state phases get their chance first.
            if (info.mineName) {
                phase('tryBuild',   info, cfg, ctx);
                phase('tryUpgrade', info, cfg, ctx);
            }
            phase('tryBuff', info, cfg, ctx);            // mine OR mason
            if (info.mineName) {
                phase('tryPause', info, cfg, ctx);
            }
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

        S.kernel.queue.action('mining.buildMine', function (params) {
            var mineId   = params[0];
            var grid     = params[1];
            var depoName = params[2];
            var mineName = params[3];

            // Re-check: state may have drifted since plan() queued.
            if (S.core.buildings.byGrid(grid)) {
                S.kernel.log('mining', 'grid', grid, 'now occupied — skipping', mineName);
                return;
            }
            if (!canAffordMine(mineName)) {
                S.kernel.log('mining', 'no longer affordable — skipping', mineName);
                return;
            }
            try {
                game.gi.SendServerAction(50, mineId, grid, 0, null);
                S.kernel.log('mining', 'placed', mineName, 'on grid', grid,
                             '(' + depoName + ')');
                S.core.buildings.invalidate();
            } catch (e) {
                S.kernel.error('mining', 'SendServerAction(50) threw for', mineName, ':', e);
            }
        });

        S.kernel.queue.action('mining.upgradeMine', function (params) {
            var grid     = params[0];
            var mineName = params[1];
            var nextLvl  = params[2];

            // Re-check: state may have drifted since plan() queued.
            var bld = S.core.buildings.byGrid(grid);
            if (!bld || S.core.buildings.name(bld) !== mineName) {
                S.kernel.log('mining', 'grid', grid, 'no longer hosts', mineName,
                             '— skipping upgrade');
                return;
            }
            if (S.core.buildings.level(bld) >= nextLvl) {
                S.kernel.log('mining', mineName, 'on grid', grid,
                             'already at level', S.core.buildings.level(bld),
                             '— skipping upgrade');
                return;
            }
            if (typeof bld.IsUpgradeAllowed === 'function' &&
                !bld.IsUpgradeAllowed(true)) {
                S.kernel.log('mining', mineName, 'on grid', grid,
                             'no longer upgradable — skipping');
                return;
            }
            try {
                game.zone.UpgradeBuildingOnGridPosition(grid);
                S.kernel.log('mining', 'upgrading', mineName, 'on grid', grid,
                             'to level', nextLvl);
                S.core.buildings.invalidate();
            } catch (e) {
                S.kernel.error('mining',
                               'UpgradeBuildingOnGridPosition threw for', mineName, ':', e);
            }
        });

        S.kernel.queue.action('mining.setProduction', function (params) {
            var grid     = params[0];
            var mineName = params[1];
            var active   = !!params[2];

            // Re-check: state may have drifted since plan() queued.
            var bld = S.core.buildings.byGrid(grid);
            if (!bld || S.core.buildings.name(bld) !== mineName) {
                S.kernel.log('mining', 'grid', grid, 'no longer hosts', mineName,
                             '— skipping setProduction');
                return;
            }
            var current = (typeof bld.IsProductionActive === 'function')
                ? !!bld.IsProductionActive() : true;
            if (current === active) {
                S.kernel.log('mining', mineName, 'on grid', grid, 'already',
                             active ? 'active' : 'paused', '— skipping');
                return;
            }
            try {
                // Action 107: SendServerAction(107, 1=resume / 0=pause, grid, 0, null).
                // Source: tso_client/.../scripts/7-building.js:125.
                game.gi.SendServerAction(107, active ? 1 : 0, grid, 0, null);
                S.kernel.log('mining', active ? 'resumed' : 'paused',
                             mineName, 'on grid', grid);
                // No buildings.invalidate(): pause/resume doesn't change snapshot composition.
            } catch (e) {
                S.kernel.error('mining', 'SendServerAction(107) threw for', mineName, ':', e);
            }
        });
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
