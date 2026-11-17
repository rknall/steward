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
 *
 *            Each build and upgrade of a grid goes out once, through
 *            S.core.construction and S.core.actions with no retry, and
 *            counts only once it is seen on the grid. A grid whose send
 *            was not seen stays held for 30 min in
 *            steward/mining/holds.json; the hold is written before the
 *            send, so a script reload keeps it. 5 unseen sends in a row
 *            open the build breaker (memory only), which pauses build and
 *            upgrade except one probe every 5 min. See builds.js.
 *            Build and upgrade wait, without spending a slot or the
 *            breaker probe, while the zone view, build queue, building
 *            list, deposit list or a mine's level, upgrade state or
 *            permission cannot be read.
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

    function mergeSettings() {
        var stored = S.kernel.settings.read('mining') || {};
        var defaults = S.modules.mining.defaultSettings || {};
        var merged = {};
        var key;
        var field;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        // Deposit rows merge per field: a stored row missing fields (an
        // older build, a hand-edited file) still reads whole, the gaps
        // filled from its default row. Types without a default row stay
        // as stored.
        var depMerged = {};
        var defaultDeps = defaults.deposits || {};
        var storedDeps  = stored.deposits  || {};
        for (key in defaultDeps) {
            var row = {};
            var defRow = defaultDeps[key] || {};
            var storedRow = storedDeps[key];
            for (field in defRow) row[field] = defRow[field];
            if (storedRow !== null && typeof storedRow === 'object') {
                for (field in storedRow) row[field] = storedRow[field];
            }
            depMerged[key] = row;
        }
        for (key in storedDeps) {
            if (!Object.prototype.hasOwnProperty.call(defaultDeps, key)) {
                depMerged[key] = storedDeps[key];
            }
        }
        merged.deposits = depMerged;
        return merged;
    }

    // Every reader, this file included, goes through the export, so the
    // dashboard, diagnostics and the tests all see one merge.
    function readSettings() {
        return S.modules.mining.readSettings();
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
        var cap = S.core.construction.capacity();
        var slotsRemaining = 0;
        var licensesRemaining = 0;
        if (S.kernel.read.isOk(cap)) {
            slotsRemaining    = cap.value.slotsTotal - cap.value.slotsUsed;
            licensesRemaining = cap.value.licMax - cap.value.licUsed;
        }
        return {
            slotsRemaining:    slotsRemaining,
            licensesRemaining: licensesRemaining,
            capacity:           cap,    // build queue Result, waited on by buildReady
            ready:              null,   // buildReady answer, worked out once per pass
            depos:              {},     // deposit type -> on-map list, null while unreadable
            queued:             0,
            assigned:           {},
            buffs:              0,      // buff applies queued this pass
            buffStock:          {},     // buff name -> stock left this pass
            buffsCurrent:       buffSettingsCurrent(),
            buildStop:          false,  // build breaker open, no probe left this pass
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

    // True only on a good read. A read that may still settle wakes mining
    // after the retry delay, and one that stays bad warns once per window
    // instead of on every pass.
    function awaited(key, r, what) {
        var w = S.kernel.read.wait('mining', key, r);
        if (w === 'go') return true;
        if (w === 'expired') {
            S.kernel.warn('mining', what + ' still not readable:', r && r.why);
        }
        return false;
    }

    // The proof that a null byGrid means an empty grid: the zone view reads
    // home, and the building list was read completely and holds anything
    // (the rule S.core.buildings.readable() applies, turned into a Result so
    // it can be waited on). It also needs the build queue read. Worked out
    // once per pass, before any slot, licence or breaker probe is spent.
    function buildReady(ctx) {
        if (ctx.ready !== null) return ctx.ready;
        ctx.ready = false;
        var view = S.core.zone.view();
        if (!awaited('zone', view, 'zone view')) return false;
        if (view.value.home !== true) return false;                         // a real answer: away from home
        if (!awaited('capacity', ctx.capacity, 'build queue')) return false;
        var lr = S.core.buildings.listRead();
        if (S.kernel.read.isOk(lr) && !lr.value.length) {
            lr = S.kernel.read.unreadable('building list empty', lr.zoneId);
        }
        if (!awaited('buildings', lr, 'building list')) return false;
        ctx.ready = true;
        return true;
    }

    // Read once per type per pass, a failed read included, so build and
    // upgrade do not count two tries of the same wait in one pass.
    function depositsOf(info, ctx) {
        if (Object.prototype.hasOwnProperty.call(ctx.depos, info.name)) {
            return ctx.depos[info.name];
        }
        var r = S.core.deposits.byTypeRead(info.name);
        var list = awaited('deposits.' + info.name, r, info.name + ' deposits') ? r.value : null;
        ctx.depos[info.name] = list;
        return list;
    }

    // Phase functions; tryRefill is still a stub. Tests inject stubs via
    // S.modules.mining._phases — see tests/modules/mining.test.js.
    function tryBuild(info, cfg, ctx) {
        if (!cfg.build) return;
        if (!info.mineId || !info.mineName) return;
        if (ctx.buildStop) return;
        if (!buildReady(ctx)) return;
        if (ctx.slotsRemaining <= 0 || ctx.licensesRemaining <= 0) return;
        var builds = S.modules.mining.builds;

        var onMapDepos = depositsOf(info, ctx);
        if (!onMapDepos) return;

        for (var i = 0; i < onMapDepos.length; i++) {
            var depo = onMapDepos[i];
            if (!depo) continue;

            var grid = S.core.deposits.grid(depo);
            if (!grid) continue;
            if (ctx.assigned[grid]) continue;

            // A building (any building, including a depleted shell) on
            // this grid means the deposit is already covered, and no
            // building means an empty grid, because buildReady proved the
            // building list readable on home. Depleted
            // shells resolve naturally on the next tick: a geo finds a
            // new deposit, the shell goes away, byGrid returns null,
            // and we queue the build then. Our own mine seen there clears
            // the grid's build hold.
            var key = builds.buildKey(grid);
            var bld = S.core.buildings.byGrid(grid);
            if (bld) {
                if (S.core.buildings.name(bld) === info.mineName) {
                    builds.seen(key, info.mineName + ' grid ' + grid);
                }
                continue;
            }
            // A build sent earlier may still land unseen.
            if (builds.held(key)) continue;

            if (!canAffordMine(info.mineName)) continue;
            if (!builds.admit()) {
                ctx.buildStop = true;
                return;
            }

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
        if (!info.mineName) return;
        var target = (typeof cfg.targetLevel === 'number') ? cfg.targetLevel : 0;
        if (target <= 0) return;
        if (ctx.buildStop) return;
        if (!buildReady(ctx)) return;
        if (ctx.slotsRemaining <= 0) return;
        var builds = S.modules.mining.builds;

        var onMapDepos = depositsOf(info, ctx);
        if (!onMapDepos) return;

        for (var i = 0; i < onMapDepos.length; i++) {
            var depo = onMapDepos[i];
            if (!depo) continue;
            var grid = S.core.deposits.grid(depo);
            if (!grid) continue;
            if (ctx.assigned[grid]) continue;            // tryBuild already claimed this grid

            var bld = S.core.buildings.byGrid(grid);
            if (!bld) continue;                                              // no mine to upgrade
            if (S.core.buildings.name(bld) !== info.mineName) continue;      // wrong building (depleted shell, etc.)

            // An unread level is never level 0: skip the grid, the next pass
            // reads it again.
            var lvl = S.core.buildings.levelOf(bld);
            if (lvl === null) {
                S.kernel.debug('mining', info.mineName, 'grid', grid, 'level unreadable — waiting');
                continue;
            }
            // The level read now proves any upgrade to it landed.
            builds.seen(builds.upgradeKey(grid, lvl),
                info.mineName + ' grid ' + grid + ' level ' + lvl);
            if (lvl >= target) continue;                                     // already at or above target

            var nextLevel = lvl + 1;
            var ukey = builds.upgradeKey(grid, nextLevel);
            var busy = S.core.buildings.upgrading(bld);
            if (builds.held(ukey)) {
                if (busy === true) builds.seen(ukey, info.mineName + ' grid ' + grid + ' level ' + nextLevel);
                continue;
            }
            if (busy === null) {
                S.kernel.debug('mining', info.mineName, 'grid', grid, 'upgrade state unreadable — waiting');
                continue;
            }
            // Already upgrading: a new attempt would only end satisfied
            // and hold a slot every pass.
            if (busy === true) continue;
            var allowed = S.core.buildings.isUpgradable(bld);
            if (allowed === null) {
                S.kernel.debug('mining', info.mineName, 'grid', grid, 'upgrade permission unreadable — waiting');
                continue;
            }
            if (allowed === false) continue;                                 // host says no
            if (!builds.admit()) {
                ctx.buildStop = true;
                return;
            }

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
        // Reads the build holds back (and logs them) before the first plan.
        S.modules.mining.builds.load();

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
            if (!S.modules.mining.builds.build(mineId, grid, depoName, mineName)) {
                S.kernel.error('mining', 'could not start build of', mineName, 'on grid', grid);
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
            // A level or permission that cannot be read falls through to the
            // upgrade def, whose precheck refuses it before anything is sent.
            var lvl = S.core.buildings.levelOf(bld);
            if (lvl !== null && lvl >= nextLvl) {
                S.kernel.log('mining', mineName, 'on grid', grid,
                             'already at level', lvl,
                             '— skipping upgrade');
                return;
            }
            if (S.core.buildings.isUpgradable(bld) === false) {
                S.kernel.log('mining', mineName, 'on grid', grid,
                             'no longer upgradable — skipping');
                return;
            }
            if (!S.modules.mining.builds.upgrade(grid, mineName, nextLvl)) {
                S.kernel.error('mining', 'could not start upgrade of', mineName, 'on grid', grid);
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

    // The one settings reader, shared with ui.js, diagnostics and the
    // tests; the other two are exposed for ui.js and the tests.
    S.modules.mining.readSettings = mergeSettings;
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
