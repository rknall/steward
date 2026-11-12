/*
 * Buffing: the shared building-buff engine.
 *
 * A building buff is sent through S.core.actions with the def from
 * S.core.buffs.building(), so every apply is verified on the building
 * itself. An apply the client accepts but never shows still reports a
 * send, so the engine judges each outcome:
 *
 *   verified  clears the grid's hold and closes the breaker;
 *   unseen    holds the grid and counts a miss on the breaker, because
 *             the buff may have landed unseen and a second one would be
 *             wasted;
 *   failed    holds the grid, but does not count a miss;
 *   refused   logs at debug only (the def's own checks said no).
 *
 * create() returns an independent engine per owner: mines and masons
 * (mining) own one, timed production buildings (production) another, so
 * a run of unseen applies pauses only the owner that sent them. Each
 * engine keeps one S.core.breaker instance and a map grid -> hold until,
 * both memory only, so a script reload resets them.
 *
 * Bundle slot: core, loads after breaker.js and before buffs.js. The top
 * level only assigns S.core.buffing; every other core (breaker, buffs,
 * buildings, actions) is used at call time.
 */

(function (S) {

    // A grid whose apply was not seen waits 30 min, so a buff that landed
    // unseen is not paid for twice.
    var HOLD_MS = 1800000;

    // opts: { category, label, missText, pausedText, resumeText, holdMs? }.
    // The texts go to the breaker's open/closed log lines.
    function create(opts) {
        var o = opts || {};
        var category = o.category || 'buffing';
        var holdMs   = o.holdMs > 0 ? o.holdMs : HOLD_MS;
        var holds    = {};             // grid -> hold until, on the breaker clock

        var breaker = S.core.breaker.create({
            category:   category,
            label:      o.label,
            missText:   o.missText,
            pausedText: o.pausedText,
            resumeText: o.resumeText
        });

        // The live map, so callers and tests see holds as they change.
        function getHolds() {
            return holds;
        }

        // S.BuffVerdict.Ok when the building may be buffed now, S.BuffVerdict.Skip to try the next
        // one, S.BuffVerdict.Stop when the breaker is open and no probe is due, so the
        // caller ends the whole pass. The cheap per-building checks run
        // before admit(), because admit() spends the probe.
        function eligible(b, assigned) {
            var grid = S.core.buildings.grid(b);
            if (grid === null || typeof grid === 'undefined') return S.BuffVerdict.Skip;
            if (assigned && assigned[grid]) return S.BuffVerdict.Skip;          // another phase claimed it
            if (holds[grid] > breaker.clock()) return S.BuffVerdict.Skip;       // last apply was not seen
            if (S.core.buildings.buffBlock(b) !== null) return S.BuffVerdict.Skip;
            if (breaker.admit(1) === 0) return S.BuffVerdict.Stop;              // open and no probe due
            return S.BuffVerdict.Ok;
        }

        // Sends one verified apply. onResult(r) gets the action result after
        // the engine has judged it. False when the attempt could not start.
        function apply(grid, bName, buffName, workyard, onResult) {
            function onDone(r) {
                var R = S.ActionResult;
                if (r.status === R.Verified && r.sends > 0) {
                    delete holds[grid];
                    breaker.verify(bName + ' grid ' + grid);
                    S.kernel.log(category, 'buffed', bName, 'on grid', grid, 'with', buffName);
                } else if (r.status === R.Failed && r.unseen) {
                    holds[grid] = breaker.clock() + holdMs;
                    breaker.miss();
                    S.kernel.warn(category, buffName, 'on', bName, 'grid', grid,
                                  'was not seen to apply — holding the grid');
                } else if (r.status === R.Failed) {
                    // The send itself failed: hold the grid, but only an
                    // unseen apply counts towards the breaker.
                    holds[grid] = breaker.clock() + holdMs;
                    S.kernel.warn(category, buffName, 'on', bName, 'grid', grid,
                                  'failed:', r.reason, '— holding the grid');
                } else if (r.status === R.Refused) {
                    S.kernel.debug(category, buffName, 'on', bName, 'grid', grid,
                                   'refused:', r.reason);
                }
                if (typeof onResult === 'function') onResult(r);
            }

            if (!S.core.actions.attempt(
                    S.core.buffs.building(buffName, grid, bName, workyard), onDone)) {
                S.kernel.error(category, 'could not start buff', buffName, 'on', bName,
                               'grid', grid);
                return false;
            }
            return true;
        }

        return {
            HOLD_MS:  holdMs,
            breaker:  breaker,
            holds:    getHolds,
            eligible: eligible,
            apply:    apply
        };
    }

    S.core.buffing = {
        HOLD_MS: HOLD_MS,
        create:  create
    };

}(Steward));
