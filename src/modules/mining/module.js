/*
 * Mining module.
 *
 * Manages the mine and mason lifecycle on the home zone, one phase per
 * step for every enabled deposit type, in this order:
 *
 *   build    places a mine on every deposit grid that has no building,
 *            subject to build-queue slots, building licenses and
 *            per-mine affordability.
 *   upgrade  raises mines below the configured target level.
 *   pause    stops producing mines whose deposit fell below the global
 *            pause threshold, verified through S.core.production.setActive
 *            so the pause counts only once the mine reads paused.
 *   buff     applies the configured production buff (deposits.<Type>.buff)
 *            to every mine or mason that is producing, unbuffed and not
 *            upgrading, through S.core.buffs and S.core.actions, so each
 *            apply is verified on the building itself.
 *   refill   still a stub.
 *
 * The buff phase owns its own engine from the shared S.core.buffing:
 * applies that are sent but never seen on their building open its
 * breaker, which pauses mine and mason buffing only (geologists and
 * explorers keep the specialist send guard, production buildings their
 * own engine). A building whose apply was not seen is also held for a
 * while, because the buff may have landed unseen and a second one would
 * be wasted. Breaker and holds are memory only, so a script reload
 * resets both.
 * Buff values stored before the buff phase existed are cleared once at
 * boot (the `buffVersion` marker), and the buff phase runs only once
 * that marker is stored.
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

    // Each buff apply holds the shared queue for up to its verify window,
    // and the busy contract re-plans only once the queue drains, so a
    // pass sends only a few and the next pass picks up the rest.
    var BUFFS_PER_PLAN = 2;

    var buffEngine = S.core.buffing.create({
        category:   'mining',
        label:      'buff breaker',
        missText:   'buff applies in a row were not seen on their building',
        pausedText: 'mine and mason buffing is paused',
        resumeText: 'buffing resumes'
    });

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

    // Reads the raw store, not readSettings(): the merge would fill in the
    // default marker and hide that the stored values predate the buff UI.
    function buffSettingsCurrent() {
        try {
            var raw = S.kernel.settings.read('mining');
            var defaults = S.modules.mining.defaultSettings || {};
            return !!(raw && typeof raw === 'object' &&
                      raw.buffVersion === defaults.buffVersion);
        } catch (e) {
            return false;
        }
    }

    // Before the buff phase, deposits.<Type>.buff was a placeholder that
    // nothing read, so stored values are stale names the user never picked
    // for buffing. Clear them once and store the marker; every other field
    // stays as stored. A failed write leaves the marker missing, which keeps
    // the buff phase off and retries the clear on the next boot.
    function migrateBuffSettings() {
        try {
            var raw = S.kernel.settings.read('mining');
            if (!raw || buffSettingsCurrent()) return;
            var next = {};
            var key;
            for (key in raw) next[key] = raw[key];
            var deps = {};
            var rawDeps = raw.deposits || {};
            var cleared = [];
            for (key in rawDeps) {
                var entry = rawDeps[key];
                if (entry && typeof entry === 'object' &&
                    typeof entry.buff === 'string' && entry.buff !== '') {
                    var copy = {};
                    for (var f in entry) copy[f] = entry[f];
                    copy.buff = '';
                    deps[key] = copy;
                    cleared.push(key + '=' + entry.buff);
                } else {
                    deps[key] = entry;
                }
            }
            next.deposits = deps;
            next.buffVersion = S.modules.mining.defaultSettings.buffVersion;
            var ok = S.kernel.settings.write('mining', next);
            if (ok && cleared.length) {
                S.kernel.log('mining', 'buff settings reset once: cleared',
                             cleared.join(', '), '— pick buffs in the Mining tab');
            } else if (ok) {
                S.kernel.log('mining', 'buff settings marked current, nothing to clear');
            } else {
                S.kernel.warn('mining', 'buff settings reset could not be written;' +
                              ' buffing stays off until it is');
            }
        } catch (e) {
            S.kernel.error('mining', 'buff settings reset threw:', e);
        }
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
            buffs:              0,      // buff applies queued this pass
            buffStock:          {},     // buff name -> stock left this pass
            buffsCurrent:       buffSettingsCurrent(),
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

    // Phase functions; tryRefill is still a stub. Tests inject stubs via
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
        // Pause-only. Steward only undoes what Steward did:
        //   cfg.pause=true  ⇒ pause producing mines whose deposit has
        //                     dropped below pauseThreshold (mine longevity).
        //   cfg.pause=false ⇒ inert. Manual user pauses stay intact.
        //
        // Auto-unpause is NOT a tryPause job. It belongs to tryRefill: when
        // a Steward-initiated refill brings a deposit's remaining back above
        // pauseThreshold, that phase queues the unpause as a side-step. This
        // ties auto-unpause to a causal Steward action (the refill we just
        // sent) rather than a periodic reconciler — the user can pause/unpause
        // by hand without Steward second-guessing them.
        //
        // Pause/resume is a state toggle, not construction — no slot gate.
        if (cfg.pause !== true) return;
        if (!info.mineName) return;

        var settings  = readSettings();
        var threshold = (typeof settings.pauseThreshold === 'number')
            ? settings.pauseThreshold : 50;

        // Walk deposits (not buildings) so we can read GetAmount() for the
        // threshold gate. Mines on depleted shells (no on-map deposit) are
        // intentionally skipped here.
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
            if (!isActive) continue;                       // already paused

            var remaining = (typeof depo.GetAmount === 'function')
                ? depo.GetAmount() : 0;
            if (remaining >= threshold) continue;          // still high-yield

            ctx.assigned[grid] = true;
            ctx.queued++;

            var delay = (ctx.queued === 1) ? 0 : ctx.actionDelay;
            S.kernel.queue.add('mining.setProduction',
                [grid, info.mineName, false],              // always pause direction
                delay);
        }
    }
    function gridOrder(a, b) {
        return (S.core.buildings.grid(a) || 0) - (S.core.buildings.grid(b) || 0);
    }

    // Mine OR mason: each deposit type names exactly one of the two.
    // Whether a building can take a buff (producing, unbuffed, not
    // upgrading) is S.core.buildings' call; this phase only adds the
    // per-pass limit, the grids other phases claimed, the holds and the
    // breaker.
    function tryBuff(info, cfg, ctx) {
        // Stale buff names from before the buff UI must never buff.
        if (ctx.buffsCurrent !== true) return;
        if (typeof cfg.buff !== 'string' || !cfg.buff) return;
        var bName = info.mineName || info.masonName;
        if (!bName) return;
        if (ctx.buffs >= BUFFS_PER_PLAN) return;
        if (S.core.zone.isHome() !== true) return;
        if (!S.core.buffs.buildingBuffMatch(cfg.buff, bName, true)) {
            S.kernel.debug('mining', 'buff', cfg.buff, 'does not target', bName,
                           '— skipping buff');
            return;
        }
        // Stock is read once per buff per pass and counted down locally,
        // because the applies queued so far have not left the stock yet.
        var stock = Object.prototype.hasOwnProperty.call(ctx.buffStock, cfg.buff)
            ? ctx.buffStock[cfg.buff]
            : S.core.buffs.stock(cfg.buff, '');
        if (!(stock > 0)) return;

        var list;
        try { list = S.core.buildings.byName(bName).slice(); }
        catch (e) {
            S.kernel.warn('mining', 'byName threw for', bName, ':', e);
            return;
        }
        list.sort(gridOrder);

        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            // The grids build/upgrade/pause claimed are skipped as well.
            var verdict = buffEngine.eligible(b, ctx.assigned);
            if (verdict === S.BuffVerdict.Stop) {                            // open and no probe due
                ctx.buffs = BUFFS_PER_PLAN;
                return;
            }
            if (verdict !== S.BuffVerdict.Ok) continue;
            var grid = S.core.buildings.grid(b);

            ctx.assigned[grid] = true;
            ctx.queued++;
            ctx.buffs++;
            stock--;
            ctx.buffStock[cfg.buff] = stock;

            var delay = (ctx.queued === 1) ? 0 : ctx.actionDelay;
            S.kernel.queue.add('mining.buffBuilding',
                [grid, bName, cfg.buff, info.name],
                delay);

            if (ctx.buffs >= BUFFS_PER_PLAN || stock <= 0) return;
        }
    }
    function tryRefill()  { /* v2 — all types; takes (info, cfg, ctx) like the others */ }

    function phase(name, info, cfg, ctx) {
        var override = S.modules.mining._phases && S.modules.mining._phases[name];
        if (typeof override === 'function') return override(info, cfg, ctx);
        if (name === 'tryBuild')   return tryBuild(info, cfg, ctx);
        if (name === 'tryUpgrade') return tryUpgrade(info, cfg, ctx);
        if (name === 'tryPause')   return tryPause(info, cfg, ctx);
        if (name === 'tryBuff')    return tryBuff(info, cfg, ctx);
        if (name === 'tryRefill')  return tryRefill(info, cfg, ctx);
    }

    function planPass(s) {
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
            //   tryBuild → tryUpgrade → tryPause → tryBuff → tryRefill
            // Buff runs after build and upgrade so the grids they claimed
            // are skipped. Pause runs before buff so a mine about to be
            // paused claims its grid and is not buffed in the same pass;
            // the next pass sees it stopped, which the buff eligibility
            // check rejects.
            if (info.mineName) {
                phase('tryBuild',   info, cfg, ctx);
                phase('tryUpgrade', info, cfg, ctx);
                phase('tryPause',   info, cfg, ctx);
            }
            phase('tryBuff', info, cfg, ctx);            // mine OR mason
            phase('tryRefill', info, cfg, ctx);
        }
        if (ctx.queued > 0) {
            S.kernel.log('mining', 'queued', ctx.queued, 'action(s)');
        }
    }

    // The phases share one read pass, so the star menu, the target table and
    // the building name index are read once per plan. The queued actions run
    // later from the kernel queue, outside the pass, and read live.
    function plan() {
        var s = readSettings();
        if (!s || !s.enabled) return;
        S.kernel.hostRead.pass(function () { planPass(s); });
    }

    function boot() {
        if (!S.kernel.settings.read('mining')) {
            S.kernel.settings.write('mining', S.modules.mining.defaultSettings);
        }
        migrateBuffSettings();

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
            function onDone(r) {
                var R = S.ActionResult;
                if (r.status === R.Verified) {
                    S.kernel.log('mining', active ? 'resumed' : 'paused',
                                 mineName, 'on grid', grid);
                } else if (r.status === R.Failed) {
                    S.kernel.warn('mining', 'could not', active ? 'resume' : 'pause',
                                  mineName, 'on grid', grid, ':', r.reason);
                } else if (r.status === R.Refused) {
                    S.kernel.debug('mining', active ? 'resume' : 'pause', mineName,
                                   'on grid', grid, 'refused:', r.reason);
                }
            }

            if (!S.core.actions.attempt(
                    S.core.production.setActive(grid, mineName, active), onDone)) {
                S.kernel.error('mining', 'could not start setProduction for', mineName,
                               'on grid', grid);
            }
        });

        S.kernel.queue.action('mining.buffBuilding', function (params) {
            var grid     = params[0];
            var bName    = params[1];
            var buffName = params[2];

            // Re-check: state may have drifted since plan() queued. The
            // action def checks eligibility again right before it sends.
            var bld = S.core.buildings.byGrid(grid);
            if (!bld || S.core.buildings.name(bld) !== bName) {
                S.kernel.log('mining', 'grid', grid, 'no longer hosts', bName,
                             '— skipping buff');
                return;
            }

            // The engine judges the outcome: holds, breaker and log lines.
            buffEngine.apply(grid, bName, buffName, true);
        });
    }

    // Exposed for ui.js and the tests.
    S.modules.mining.readSettings = readSettings;
    S.modules.mining.buffBreaker  = buffEngine.breaker;
    S.modules.mining.buffHolds    = buffEngine.holds;

    S.kernel.register({
        id:       'mining',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        ui: {
            tab: 'mining',
            section: {
                id:    'mining',
                title: 'Mining',
                icon:  '⚒',
                side: function ($side, h) {
                    if (S.modules.mining.side) return S.modules.mining.side($side, h);
                },
                render: function ($main, h) {
                    if (S.modules.mining.render) return S.modules.mining.render($main, h);
                },
                summary: function (h) {
                    return S.modules.mining.summary ? S.modules.mining.summary(h) : '';
                },
                tiles: function (h) {
                    return S.modules.mining.tiles ? S.modules.mining.tiles(h) : [];
                }
            }
        }
    });

}(Steward));
