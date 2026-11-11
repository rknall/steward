/*
 * Verified production pause and resume for one building.
 *
 * Builds the action def that switches a building's production on or off, so
 * a caller can pause or resume a producer and know the host took it. Run the
 * def with S.core.actions.attempt. Which building to switch and when stays
 * with the caller.
 *
 * Host facts, kept here only:
 *   - action 107 is SendServerAction(107, 1 = resume / 0 = pause, grid, 0,
 *     null); it sets an absolute state rather than flipping the current one
 *     (tso_client scripts/7-building.js:125)
 *   - the state is read back with IsProductionActive() on the building
 *
 * Failure contract: an unreadable building or state is never taken for
 * "already in that state"; satisfied and check answer true only on a
 * positive read. isActive gives the same read to other callers: true or
 * false from IsProductionActive(), and null when it is missing, throws or
 * does not return a boolean.
 *
 * Bundle slot: core, under core/production/ before production.js (core files
 * load in name order). Other cores are used at call time only.
 */

(function (S) {

    if (!S.core.production) S.core.production = {};

    var ACTION_SET_PRODUCTION = 107;
    var TOGGLE_TIMEOUT_MS = 15000;

    // The building's reported production state, or null when it cannot be
    // read.
    function activeOf(b) {
        if (!b || typeof b.IsProductionActive !== 'function') return null;
        try {
            var v = b.IsProductionActive();
            return typeof v === 'boolean' ? v : null;
        } catch (e) {
            return null;
        }
    }

    // Retries stay at the default: action 107 sets an absolute state, so a
    // resend after an unseen first send changes nothing the first did not.
    function setActive(grid, buildingName, on) {
        var want = !!on;
        return {
            label:     (want ? 'resume ' : 'pause ') + buildingName + ' ' + grid,
            category:  'production',
            timeoutMs: TOGGLE_TIMEOUT_MS,
            satisfied: function () {
                return activeOf(S.core.buildings.byGrid(grid)) === want;
            },
            precheck: function () {
                if (S.core.zone.isHome() !== true) return 'not on the home island';
                S.core.buildings.invalidate();
                var b = S.core.buildings.byGrid(grid);
                if (S.core.buildings.name(b) !== buildingName) return 'building changed';
                if (typeof b.IsProductionActive !== 'function') return 'production state unreadable';
                return null;
            },
            send: function () {
                return S.core.packets.sendAction(ACTION_SET_PRODUCTION, want ? 1 : 0, grid, 0, null);
            },
            check: function () {
                return activeOf(S.core.buildings.byGrid(grid)) === want;
            }
        };
    }

    S.core.production.setActive = setActive;
    S.core.production.isActive = activeOf;

}(Steward));
