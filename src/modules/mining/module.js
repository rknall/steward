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

    // Refill feature gate. The deposit-refill SendServerAction(61, ...)
    // path is silently rejected by the host; even SendMessagetoServer with
    // a dServerAction VO reaches the server but fails server-side
    // validation. See docs/superpowers/mining/refill-investigation.md for
    // the full investigation chronology. Until a workable wire format is
    // found (likely needs cracked-client / decompile work), we keep the
    // code intact but gate the user-visible feature off:
    //   - tryRefill phase short-circuits at entry
    //   - readSettings sanitizes any persisted cfg.refill=true to false
    //   - ui.js hides the Refill column when this is false
    //   - tryPause's "skip when refill available" branch is therefore
    //     never reached (refillAvailable always false)
    //
    // Stored on the module namespace (not as a closure var) so tests can
    // flip the gate via `H.Steward.modules.mining._REFILL_ENABLED = true`
    // without rebuilding. Production toggle: edit this line and rebuild.
    S.modules.mining._REFILL_ENABLED = false;

    // Diagnostic logging for refill paths. Independent of _REFILL_ENABLED
    // so a re-investigation can run with diagnostics off, or a partial
    // probe (cursor / host-VO / buffApplied observer) can run without
    // queueing any refill actions.
    S.modules.mining._REFILL_DEBUG = false;

    function refillEnabled() { return !!S.modules.mining._REFILL_ENABLED; }
    function refillDebug()   { return !!S.modules.mining._REFILL_DEBUG;   }

    // Module-private state. Survives across ticks but resets on reboot.
    // tryPause records grids it queued a pause for; tryRefill's queue
    // action consults this map to auto-unpause ONLY mines paused by
    // Steward — manual user pauses are left alone. No settings persistence
    // (cheap to lose; an across-reboot Steward-paused mine just stays
    // paused until the user touches it).
    var stewardPausedGrids = {};
    S.modules.mining._stewardPausedGrids = stewardPausedGrids;

    // The +N units a single FillDeposit_* item adds to a deposit. TSO's
    // refill items add 100 — used as a predictor in the queue action to
    // decide whether refill brings us back above threshold (fresh
    // deposit.amount() reads stale right after SendServerAction since the
    // host updates asynchronously).
    var ASSUMED_REFILL_AMOUNT = 100;

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
        // Sanitize refill flags. The feature is gated off (see REFILL_ENABLED
        // at top of file) — any persisted cfg.refill=true must not reach the
        // planner or be exposed to the UI as enabled state. We rewrite at
        // read time so partial migrations / stale settings can't accidentally
        // turn it back on.
        if (!refillEnabled()) {
            for (key in depMerged) {
                if (depMerged[key] && depMerged[key].refill === true) {
                    // Clone to avoid mutating shared default objects.
                    var copy = {};
                    for (var k2 in depMerged[key]) copy[k2] = depMerged[key][k2];
                    copy.refill = false;
                    depMerged[key] = copy;
                }
            }
        }
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
        // Pause-only. Steward only undoes what Steward did:
        //   cfg.pause=true  ⇒ pause producing mines whose deposit has
        //                     dropped below pauseThreshold (mine longevity).
        //   cfg.pause=false ⇒ inert. Manual user pauses stay intact.
        //
        // Refill coordination: if cfg.refill names a buff that's currently
        // available in inventory, we skip pausing — the refill will keep
        // the deposit producing and avoids a flicker (pause → refill →
        // unpause in the same drain).
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

        // Will we be refilling this type? If so, skip pause. cfg.refill is
        // a yes/no toggle — the planner auto-picks the specific refill
        // item via core/buffs.forDeposit (deposit-targeted buffs in
        // inventory). If anything matches, refill will fire.
        var refillAvailable = false;
        if (cfg.refill === true && S.core.buffs && S.core.buffs.forDeposit) {
            try {
                var matches = S.core.buffs.forDeposit(info.name) || [];
                refillAvailable = matches.length > 0;
            } catch (e) { refillAvailable = false; }
        }

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

            // Funnel through the core accessor — has try/catch + typeof guard,
            // resilient to stale host VOs whose typeof still reports 'function'
            // but whose call throws (Flash/AIR GC behaviour).
            var remaining = S.core.deposits.amount(depo);
            if (remaining >= threshold) continue;          // still high-yield
            if (refillAvailable) continue;                 // refill will handle this

            // Record so tryRefill's queue action can later auto-unpause us
            // (and only us) when a future refill restores the deposit.
            stewardPausedGrids[grid] = true;

            ctx.assigned[grid] = true;
            ctx.queued++;

            var delay = (ctx.queued === 1) ? 0 : ctx.actionDelay;
            S.kernel.queue.add('mining.setProduction',
                [grid, info.mineName, false],              // always pause direction
                delay);
        }
    }

    function tryBuff(info, cfg, ctx) {
        // Apply the user-selected buff (cfg.buff) to every eligible
        // building of this deposit type. Mine-bearing types target the
        // mine; mason-only types target the mason building. Eligibility
        // (no active buff, not mid-construction/upgrade/destruction, buff
        // in inventory, target match) is delegated to S.core.buffs.canApply.
        if (!cfg.buff || typeof cfg.buff !== 'string') return;

        var targetName = info.mineName || info.masonName;
        if (!targetName) return;

        var blds;
        try { blds = S.core.buildings.byName(targetName); }
        catch (e) {
            S.kernel.warn('mining', 'byName threw for', targetName, ':', e);
            return;
        }
        if (!blds || !blds.length) return;

        for (var i = 0; i < blds.length; i++) {
            var bld = blds[i];
            if (!bld) continue;
            var grid = S.core.buildings.grid(bld);
            if (!grid) continue;
            if (ctx.assigned[grid]) continue;

            if (!S.core.buffs.canApply(bld, cfg.buff)) continue;

            ctx.assigned[grid] = true;
            ctx.queued++;

            var delay = (ctx.queued === 1) ? 0 : ctx.actionDelay;
            S.kernel.queue.add('mining.applyBuff',
                [grid, targetName, cfg.buff],
                delay);
        }
    }

    function tryRefill(info, cfg, ctx) {
        // Feature gate. See REFILL_ENABLED at top of file. The phase body
        // below is preserved for future re-investigation but never runs
        // while the gate is off — readSettings also forces cfg.refill to
        // false in that mode, so this check is belt-and-suspenders.
        if (!refillEnabled()) return;

        // Refill triggers when a deposit drops below pauseThreshold,
        // regardless of cfg.pause. cfg.refill is a boolean toggle —
        // we auto-detect the deposit-specific refill via core/buffs.forDeposit
        // (TargetType=1 buffs whose target description matches info.name).
        // We deliberately avoid the generic deposit refiller; only items
        // specific to this deposit type are picked.
        if (cfg.refill !== true) return;
        if (!S.core.buffs || !S.core.buffs.forDeposit) return;

        var matches = [];
        try { matches = S.core.buffs.forDeposit(info.name) || []; }
        catch (e) {
            S.kernel.warn('mining', 'forDeposit threw for', info.name, ':', e);
            return;
        }
        if (!matches.length) {
            if (refillDebug()) {
                S.kernel.log('mining', '[diag] tryRefill:', info.name,
                             '— no matching refill in inventory (forDeposit=[])');
            }
            return;
        }
        if (refillDebug()) {
            S.kernel.log('mining', '[diag] tryRefill:', info.name,
                         '— matched refill, resourceName=',
                         S.core.buffs.resourceName(matches[0]),
                         'amount=', S.core.buffs.amount(matches[0]));
        }

        // Pick the first match. If multiple specific refills exist for the
        // same deposit, the user can pick a more curated list later via the
        // UI; for now any match is "good enough".
        var refillBuff = matches[0];
        if (!refillBuff) return;
        var stockLeft = S.core.buffs.amount(refillBuff);
        if (stockLeft <= 0) {
            if (refillDebug()) {
                S.kernel.log('mining', '[diag] tryRefill:', info.name,
                             '— stock<=0, skipping');
            }
            return;
        }

        var settings  = readSettings();
        var threshold = (typeof settings.pauseThreshold === 'number')
            ? settings.pauseThreshold : 50;

        var depos;
        try { depos = S.core.deposits.byType(info.name); }
        catch (e) {
            S.kernel.warn('mining', 'byType threw for', info.name, ':', e);
            return;
        }
        if (!depos || !depos.length) return;

        var depositsBelowThreshold = 0;
        for (var i = 0; i < depos.length; i++) {
            var depo = depos[i];
            if (!depo) continue;
            var grid = S.core.deposits.grid(depo);
            if (!grid) continue;
            if (ctx.assigned[grid]) continue;

            var remaining = S.core.deposits.amount(depo);
            if (remaining >= threshold) continue;
            depositsBelowThreshold++;

            // Don't queue more refills than we have items in stock —
            // multiple deposits below threshold could each reserve one.
            if (stockLeft <= 0) return;
            stockLeft--;

            ctx.assigned[grid] = true;
            ctx.queued++;

            var delay = (ctx.queued === 1) ? 0 : ctx.actionDelay;
            if (refillDebug()) {
                S.kernel.log('mining', '[diag] tryRefill: queueing refill for',
                             info.name, 'grid', grid, 'remaining', remaining);
            }
            // info.mineName may be null for mason types — pass it through
            // so the queue action can decide whether to attempt unpause.
            // The action re-resolves the matching refill buff via forDeposit
            // at send-time — we deliberately don't pass a buff name through
            // because every FillDeposit shares GetType='FillDeposit' on the
            // live host; the deposit name is the unambiguous handle.
            S.kernel.queue.add('mining.refillDeposit',
                [grid, info.name, info.mineName, threshold, remaining],
                delay);
        }
        if (depositsBelowThreshold === 0 && refillDebug()) {
            S.kernel.log('mining', '[diag] tryRefill:', info.name,
                         '— no deposits below threshold (have refill, all full)');
        }
    }

    function phase(name, info, cfg, ctx) {
        // Per-phase try/catch: a broken phase logs and the planner moves on
        // to the next one. Without this, a single host hiccup (stale VO,
        // missing method) would skip every later phase for every later
        // deposit type on this tick.
        try {
            var override = S.modules.mining._phases && S.modules.mining._phases[name];
            if (typeof override === 'function') return override(info, cfg, ctx);
            if (name === 'tryBuild')   return tryBuild(info, cfg, ctx);
            if (name === 'tryUpgrade') return tryUpgrade(info, cfg, ctx);
            if (name === 'tryPause')   return tryPause(info, cfg, ctx);
            if (name === 'tryBuff')    return tryBuff(info, cfg, ctx);
            if (name === 'tryRefill')  return tryRefill(info, cfg, ctx);
        } catch (e) {
            S.kernel.warn('mining', name, 'threw for', info && info.name, ':', e);
        }
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

    // [diag-host] Install a buffApplied observer on game.gi.channels.BUFF.
    // Fires on EVERY buff that the host's buff system processes — both
    // manual refills (UI click) and programmatic ones (SendServerAction
    // that the host accepts). Lets us decide whether our refill calls
    // reach the buff system at all, and observe the live target/buff
    // shape on a known-working manual refill.
    //
    // Reference: tso_client/.../6-buffs.js:1,74,187 (the Buffs feature).
    function installBuffAppliedObserver() {
        try {
            if (typeof game === 'undefined' || !game || !game.gi ||
                !game.gi.channels || !game.gi.channels.BUFF ||
                typeof game.getTracker !== 'function') {
                S.kernel.log('mining',
                             '[diag] buffApplied observer skipped — channels.BUFF unavailable');
                return;
            }
            var tracker = game.getTracker('stewardBuffDiag', function (event) {
                try {
                    var d = (event && event.data) || {};
                    var buffType = '';
                    var buffDefName = '';
                    var buffResource = '';
                    if (d.buff) {
                        try { if (typeof d.buff.GetType === 'function') buffType = d.buff.GetType(); } catch (e1) {}
                        try { if (typeof d.buff.GetResourceName_string === 'function') buffResource = d.buff.GetResourceName_string() || ''; } catch (e2) {}
                        try {
                            if (typeof d.buff.GetBuffDefinition === 'function') {
                                var def = d.buff.GetBuffDefinition();
                                if (def && typeof def.GetName_string === 'function') buffDefName = def.GetName_string();
                            }
                        } catch (e3) {}
                    }
                    var tGrid = '?', tBuildingName = '', tDepositName = '';
                    if (d.target) {
                        try { if (typeof d.target.GetGrid === 'function') tGrid = d.target.GetGrid(); } catch (e4) {}
                        try { if (typeof d.target.GetBuildingName_string === 'function') tBuildingName = d.target.GetBuildingName_string() || ''; } catch (e5) {}
                        try { if (typeof d.target.GetName_string === 'function') tDepositName = d.target.GetName_string() || ''; } catch (e6) {}
                    }
                    S.kernel.log('buff',
                                 '[diag] buffApplied:',
                                 'type=', buffType,
                                 'def=', buffDefName,
                                 'resource=', buffResource,
                                 'target_grid=', tGrid,
                                 'building=', tBuildingName,
                                 'deposit=', tDepositName,
                                 'ownerID=', d.buffOwnerID);
                } catch (logErr) {
                    S.kernel.warn('buff', '[diag] tracker callback threw:', logErr);
                }
            });
            game.gi.channels.BUFF.addPropertyObserver('buffApplied', tracker);
            S.kernel.log('mining', '[diag] buffApplied observer installed on channels.BUFF');
        } catch (e) {
            var msg = (e && (e.message || e.toString())) || 'unknown';
            S.kernel.warn('mining',
                          '[diag] buffApplied observer install failed:', msg);
        }
    }

    // [diag-host] Probe game.gi.mCurrentCursor for slots that might
    // hold a "selected buff" the host reads before processing
    // SendServerAction(61). for-in is empty on AIR Flash bridges so we
    // probe by name. mCurrentSpecialist is our positive control — its
    // presence proves the probe works.
    // [diag-host] describeType in chunks. Some host VO types have several
    // KB of metadata; logging lines are size-limited so we split at line
    // boundaries and emit each as a separate log event.
    function logDescribeType(label, obj) {
        try {
            var rt = (typeof window !== 'undefined') ? window.runtime : null;
            var fu = rt && rt.flash && rt.flash.utils;
            if (!fu || typeof fu.describeType !== 'function' || !obj) {
                S.kernel.log('mining', '[diag] describeType', label,
                             '— unavailable (obj=null or flash.utils missing)');
                return;
            }
            var raw;
            try { raw = String(fu.describeType(obj)); }
            catch (e1) { raw = '(toString threw)'; }
            S.kernel.log('mining', '[diag] describeType', label, 'length=', raw.length);
            // Split into ~600-char chunks aligned to whitespace.
            var i = 0;
            while (i < raw.length) {
                var end = Math.min(i + 600, raw.length);
                S.kernel.log('mining', '[diag] dt', label, raw.substring(i, end));
                i = end;
            }
        } catch (e) {
            var msg = (e && (e.message || e.toString())) || 'unknown';
            S.kernel.warn('mining', '[diag] describeType', label, 'threw:', msg);
        }
    }

    // [diag-host] One-time describeType dump for the host VOs whose
    // method/property surface we still don't fully know. Each gets logged
    // in chunks. Searchable in the resulting log via [diag] dt <label>.
    function probeHostVOs() {
        try {
            // mCurrentPlayer — for any "applyBuffToDeposit"-style methods.
            if (game && game.gi && game.gi.mCurrentPlayer) {
                logDescribeType('mCurrentPlayer', game.gi.mCurrentPlayer);
            }
            // First available buff — for cBuff methods (Apply, etc.).
            try {
                if (game && game.gi && game.gi.mCurrentPlayer &&
                    typeof game.gi.mCurrentPlayer.getAvailableBuffs_vector === 'function') {
                    var buffs = game.gi.mCurrentPlayer.getAvailableBuffs_vector();
                    if (buffs && buffs.length) logDescribeType('cBuff', buffs[0]);
                }
            } catch (e2) { S.kernel.warn('mining', '[diag] buff probe threw:', (e2 && (e2.message || e2.toString())) || 'unknown'); }
            // First deposit in current zone — for cDeposit methods.
            try {
                var zone = game && game.gi && game.gi.mCurrentPlayerZone;
                var sdm = zone && zone.mStreetDataMap;
                var deps = sdm && sdm.mDepositContainer;
                if (deps && deps.length) logDescribeType('cDeposit', deps[0]);
            } catch (e3) { S.kernel.warn('mining', '[diag] deposit probe threw:', (e3 && (e3.message || e3.toString())) || 'unknown'); }
        } catch (e) {
            var msg = (e && (e.message || e.toString())) || 'unknown';
            S.kernel.warn('mining', '[diag] probeHostVOs failed:', msg);
        }
    }

    function probeCursorShape() {
        try {
            if (typeof game === 'undefined' || !game || !game.gi) return;

            var candidates = [
                'mCurrentSpecialist',     // positive control (5-battle.js:174)
                'mCurrentBuff',           // analogue for buffs
                'mSelectedBuff',
                'mCurrentItem',
                'mActiveBuff',
                'mPendingBuff',
                'mSelectedItem',
                'mCurrentBuilding',
                'mCurrentDeposit',
                'mCurrentTarget',
                'mSelected',
                'GetGridPosition'         // known method (5-army.js:146)
            ];

            var subjects = [
                ['game.gi.mCurrentCursor', game.gi.mCurrentCursor],
                ['game.gi.mMouseCursor',   game.gi.mMouseCursor]
            ];

            for (var s = 0; s < subjects.length; s++) {
                var label = subjects[s][0];
                var obj = subjects[s][1];
                if (!obj) {
                    S.kernel.log('mining', '[diag] cursor probe', label, '— null/undefined');
                    continue;
                }
                var found = [];
                for (var i = 0; i < candidates.length; i++) {
                    var nm = candidates[i];
                    var v;
                    try { v = obj[nm]; }
                    catch (rerr) { v = '<threw>'; }
                    if (typeof v !== 'undefined') {
                        var t = typeof v;
                        // Don't try to stringify the value — bridged
                        // objects can be huge and may throw on toString.
                        // Just record name + type.
                        found.push(nm + ':' + t);
                    }
                }
                S.kernel.log('mining', '[diag] cursor probe', label, '—',
                             found.length ? found.join(', ') : 'no candidate slots present');
            }

            // Try flash.utils.describeType on mCurrentCursor for full
            // class metadata. window.runtime.flash exposes the AIR Flash
            // namespace per autoTSO patterns (line 1791, 326).
            try {
                var rt = (typeof window !== 'undefined') ? window.runtime : null;
                var fu = rt && rt.flash && rt.flash.utils;
                if (fu && typeof fu.describeType === 'function' && game.gi.mCurrentCursor) {
                    var desc = fu.describeType(game.gi.mCurrentCursor);
                    var descStr = '';
                    try { descStr = String(desc); } catch (estr) { descStr = '(toString threw)'; }
                    S.kernel.log('mining', '[diag] describeType(mCurrentCursor) length=',
                                 descStr.length, 'first 800 chars:',
                                 descStr.substring(0, 800));
                } else {
                    S.kernel.log('mining', '[diag] describeType unavailable',
                                 '— window.runtime.flash.utils not reachable');
                }
            } catch (derr) {
                var dmsg = (derr && (derr.message || derr.toString())) || 'unknown';
                S.kernel.warn('mining', '[diag] describeType threw:', dmsg);
            }
        } catch (e) {
            var msg = (e && (e.message || e.toString())) || 'unknown';
            S.kernel.warn('mining', '[diag] cursor probe failed:', msg);
        }
    }

    function boot() {
        if (!S.kernel.settings.read('mining')) {
            S.kernel.settings.write('mining', S.modules.mining.defaultSettings);
        }

        // Diagnostic probes for the deposit-refill investigation. Gated
        // behind REFILL_DEBUG so the noise doesn't fire on every boot —
        // these dump cursor shape, host-VO describeType, and a buffApplied
        // observer that captures every host buff event. Set REFILL_DEBUG=true
        // at the top of the file when re-investigating.
        if (refillDebug()) {
            installBuffAppliedObserver();
            probeCursorShape();
            probeHostVOs();
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

        S.kernel.queue.action('mining.refillDeposit', function (params) {
            var grid             = params[0];
            var depoName         = params[1];
            var mineName         = params[2];
            var threshold        = params[3];
            var preRefillAmount  = params[4];

            if (refillDebug()) {
                S.kernel.log('mining', '[diag] refillDeposit: entered for',
                             depoName, 'grid', grid);
            }

            // Re-verify the grid still hosts the right deposit type. We
            // search via byType (getDeposits_vectorByType) rather than
            // byGrid (mDepositContainer) because the live host excludes
            // deposits sitting under a mine building from mDepositContainer
            // — they only surface through getDeposits_vectorByType. The
            // planner used byType to find this grid in the first place, so
            // mirroring that lookup here keeps the two paths consistent.
            var depo = null;
            try {
                var typeList = S.core.deposits.byType(depoName) || [];
                for (var ti = 0; ti < typeList.length; ti++) {
                    if (S.core.deposits.grid(typeList[ti]) === grid) {
                        depo = typeList[ti];
                        break;
                    }
                }
            } catch (e) {
                S.kernel.warn('mining',
                              'refillDeposit: byType threw for', depoName, ':', e);
                return;
            }
            if (!depo) {
                if (refillDebug()) {
                    S.kernel.log('mining',
                                 '[diag] refillDeposit: deposit no longer at grid',
                                 grid, 'for type', depoName);
                }
                return;
            }

            // Re-resolve the refill buff against current inventory. Force a
            // fresh inventory read first — the planner's snapshot may hold
            // stale buff VO references that the host has recycled.
            S.core.buffs.invalidate();
            var matches = S.core.buffs.forDeposit(depoName) || [];
            var b = matches[0];
            if (!b) {
                if (refillDebug()) {
                    S.kernel.log('mining', '[diag] refillDeposit: forDeposit',
                                 depoName, 'returned [] at action time');
                }
                return;
            }
            var stock = S.core.buffs.amount(b);
            if (stock <= 0) {
                if (refillDebug()) {
                    S.kernel.log('mining', '[diag] refillDeposit: stock<=0 for', depoName);
                }
                return;
            }
            // Use the live VO's GetUniqueId() directly. We tried
            // Create-reconstructed dUniqueIDs and the host silently
            // rejected them; passing the live VO matches the working
            // path for building buffs (autoTSO/user_auto.js:4661).
            var uid = S.core.buffs.uniqueId(b);
            if (!uid) {
                if (refillDebug()) {
                    S.kernel.log('mining', '[diag] refillDeposit: uniqueId',
                                 'returned null for', depoName,
                                 '— buff has no GetUniqueId');
                }
                return;
            }
            var uidParts = '(' + uid.uniqueID1 + ',' + uid.uniqueID2 + ')';

            // Set cursor preconditions. cCursor.mCurrentBuff exists per
            // boot probe; setting it before the action mirrors the
            // specialist pattern (5-battle.js:174). On its own this is
            // not sufficient — the deposit-refill server validation still
            // rejects — but we keep the writes here as a hypothesis
            // baseline for re-investigation.
            var bld = null;
            try { bld = S.core.buildings.byGrid(grid); } catch (e) { bld = null; }
            var cursorBuffSet = false;
            try {
                if (game.gi.mCurrentCursor) {
                    game.gi.mCurrentCursor.mCurrentBuff = b;
                    if (bld) game.gi.mCurrentCursor.mCurrentBuilding = bld;
                    cursorBuffSet = (game.gi.mCurrentCursor.mCurrentBuff === b);
                }
            } catch (cursorErr) {
                S.kernel.warn('mining',
                              'refillDeposit: cursor assignment threw:',
                              (cursorErr && (cursorErr.message || cursorErr.toString())) || 'unknown');
            }
            if (refillDebug()) {
                S.kernel.log('mining', '[diag] refillDeposit: cursor write took=',
                             cursorBuffSet, '. mCurrentBuilding=',
                             bld ? S.core.buildings.name(bld) : 'null');
            }

            // SendMessagetoServer(61, zoneID, dServerAction, responder).
            // This reaches the server (responder fires) but server-side
            // validation rejects with empty data. See refill investigation
            // doc for details. Code retained for future re-investigation.
            var dispatched = false;
            try {
                if (typeof game.def === 'function' &&
                    game.gi.mClientMessages &&
                    typeof game.gi.mClientMessages.SendMessagetoServer === 'function') {
                    var dSA = game.def('Communication.VO::dServerAction', true);
                    if (dSA) {
                        dSA.type    = 0;
                        dSA.grid    = grid;
                        dSA.endGrid = 0;
                        dSA.data    = uid;
                        var responder = null;
                        if (refillDebug() && typeof game.createResponder === 'function') {
                            responder = game.createResponder(function (ev, dat) {
                                S.kernel.log('mining',
                                             '[diag] refillDeposit: responder fired for',
                                             depoName, '— event=', ev && (ev.type || ''),
                                             ', data=', dat);
                            });
                        }
                        if (refillDebug()) {
                            S.kernel.log('mining',
                                         '[diag] refillDeposit: SendMessagetoServer(61,',
                                         'zoneID,', 'dSA{type=0,grid=' + grid + ',endGrid=0,data=uid' + uidParts + '},',
                                         responder ? 'responder' : 'null', ')');
                        }
                        game.gi.mClientMessages.SendMessagetoServer(
                            61, game.gi.mCurrentViewedZoneID, dSA, responder
                        );
                        dispatched = true;
                    } else if (refillDebug()) {
                        S.kernel.warn('mining',
                                      '[diag] refillDeposit: game.def(dServerAction) returned null');
                    }
                } else if (refillDebug()) {
                    S.kernel.warn('mining',
                                  '[diag] refillDeposit: SendMessagetoServer unavailable');
                }
            } catch (sendErr) {
                S.kernel.error('mining',
                               'refillDeposit SendMessagetoServer threw for',
                               depoName, ':',
                               (sendErr && (sendErr.message || sendErr.toString())) || 'unknown');
            }
            if (dispatched) {
                S.kernel.log('mining', 'refilled', depoName, 'on grid', grid);
                S.core.buffs.invalidate();
            } else {
                return;
            }

            // [diag-host] Re-read inventory immediately after the call.
            // If host accepted: stock_after === stock_before - 1 (host
            // consumed one). If stock unchanged, the call was silently
            // rejected — likely the wrong action code or wrong arg shape
            // for TargetType=1 (deposit) buffs. Note that the host may
            // process the action async, so a same-tick read can still be
            // stale; the next tick's planner gives the authoritative count.
            if (refillDebug()) {
                try {
                    var afterMatches = S.core.buffs.forDeposit(depoName) || [];
                    var afterStock = afterMatches.length ?
                        S.core.buffs.amount(afterMatches[0]) : 0;
                    S.kernel.log('mining', '[diag] refillDeposit: post-call stock=',
                                 afterStock, '(was', stock, ', delta',
                                 (afterStock - stock) + ').',
                                 afterStock === stock ?
                                     'host appears to have rejected the call' :
                                     'host accepted (stock changed)');
                } catch (err2) {
                    S.kernel.warn('mining',
                                  '[diag] refillDeposit: post-call read threw:', err2);
                }
            }

            // Auto-unpause: only if Steward paused this grid AND the mine
            // is currently paused AND the (estimated) post-refill amount
            // clears the threshold. Estimate is `preRefill + 100` because
            // depo.GetAmount() reads stale immediately after the async
            // server action lands; the host updates on a later host tick.
            if (!stewardPausedGrids[grid] || !mineName) return;
            var bld = S.core.buildings.byGrid(grid);
            if (!bld || S.core.buildings.name(bld) !== mineName) {
                delete stewardPausedGrids[grid];
                return;
            }
            var isActive = (typeof bld.IsProductionActive === 'function')
                ? !!bld.IsProductionActive() : true;
            if (isActive) {
                delete stewardPausedGrids[grid];
                return;
            }
            var expected = (typeof preRefillAmount === 'number' ? preRefillAmount : 0)
                + ASSUMED_REFILL_AMOUNT;
            if (expected < threshold) return;            // still low — leave paused

            delete stewardPausedGrids[grid];
            S.kernel.queue.add('mining.setProduction', [grid, mineName, true], 0);
        });

        S.kernel.queue.action('mining.applyBuff', function (params) {
            var grid     = params[0];
            var bldName  = params[1];
            var buffName = params[2];

            // Re-check: state may have drifted since plan() queued.
            var bld = S.core.buildings.byGrid(grid);
            if (!bld || S.core.buildings.name(bld) !== bldName) {
                S.kernel.log('mining', 'grid', grid, 'no longer hosts', bldName,
                             '— skipping buff');
                return;
            }
            // Buff-availability checks are silent on miss: state drift between
            // plan() and the queued send is expected (inventory consumed by
            // the same tick, building got buffed elsewhere, etc.) and not
            // worth log noise. Failures of the actual SendServerAction below
            // still surface as errors.
            if (!S.core.buffs.canApply(bld, buffName)) return;
            var b = S.core.buffs.byName(buffName);
            var uid = S.core.buffs.uniqueId(b);
            if (!uid) return;
            try {
                // Action 61: SendServerAction(61, 0, grid, 0, uniqueId, null).
                // Source: autoTSO/user_auto.js:4661.
                game.gi.SendServerAction(61, 0, grid, 0, uid, null);
                S.kernel.log('mining', 'buffed', bldName, 'on grid', grid,
                             'with', buffName);
                S.core.buffs.invalidate();          // we just consumed one buff
            } catch (e) {
                S.kernel.error('mining', 'SendServerAction(61) threw for', buffName, ':', e);
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
