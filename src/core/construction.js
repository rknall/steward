/*
 * Verified building placement and upgrade for one grid.
 *
 * Builds the action defs that place a building on an empty grid or upgrade
 * the building on a grid by one level, so a caller can send each exactly
 * once and know whether the host took it. Run the defs with
 * S.core.actions.attempt. Which building goes where, and how often a caller
 * may try again, stays with the caller.
 *
 * Host facts, kept here only:
 *   - action 50 is SET_BUILDING_IN_GAME: SendServerAction(50, buildingId,
 *     grid, 0, null) places a building of that id on that grid
 *   - an upgrade is started with zone.UpgradeBuildingOnGridPosition(grid)
 *     (docs/TSO_API.md, "Zones and buildings")
 *   - a running upgrade reads back as IsUpgradeInProgress() on the building
 *
 * Failure contract: only positive reads count. A missing or unreadable
 * building never verifies a send and never clears the way for one: placing
 * needs a grid that reads empty while the building list is readable, and
 * upgrading needs a building that positively reads as not upgrading. Both
 * defs default to no retry, since a resend of an unseen build or upgrade
 * can go out twice.
 *
 * Bundle slot: core, loads after buildings.js and core/buildings/ and before
 * deposits.js (core files load in name order). Other cores are used at call
 * time only.
 */

(function (S) {

    var ACTION_SET_BUILDING = 50;
    // The server normally answers a build or upgrade in 4 to 10 s; a slow
    // server takes 20 s or more.
    var TIMEOUT_MS = 30000;

    // Whether the building is upgrading: true or false from
    // IsUpgradeInProgress(), null when that cannot be read. buildings.js owns
    // the host read; this only picks it out of the buff state.
    function upgrading(b) {
        var st = S.core.buildings.buffState(b);
        if (!st || !st.blockers) return null;
        for (var i = 0; i < st.blockers.length; i++) {
            var bl = st.blockers[i];
            if (bl && bl.method === 'IsUpgradeInProgress') {
                if (bl.present === false) return null;
                return (bl.value === true || bl.value === false) ? bl.value : null;
            }
        }
        return null;
    }

    function onHomeWith(grid, buildingName) {
        return S.core.zone.isHome() === true &&
            S.core.buildings.name(S.core.buildings.byGrid(grid)) === buildingName;
    }

    function homeObservable() {
        return S.core.zone.isHome() === true;
    }

    function place(buildingId, grid, buildingName) {
        return {
            label:     'build ' + buildingName + ' ' + grid,
            category:  'construction',
            timeoutMs: TIMEOUT_MS,
            retries:   0,
            satisfied: function () {
                return onHomeWith(grid, buildingName);
            },
            precheck: function () {
                if (typeof buildingId !== 'number' || !(buildingId > 0)) return 'unknown building id';
                if (S.core.zone.isHome() !== true) return 'not on the home island';
                S.core.buildings.invalidate();
                if (S.core.buildings.byGrid(grid)) return 'grid occupied';
                // An empty grid only counts as empty when the list itself
                // was read; an unreadable list looks empty everywhere.
                if (S.core.buildings.readable() !== true) return 'buildings unreadable';
                return null;
            },
            send: function () {
                var ok = S.core.packets.sendAction(ACTION_SET_BUILDING, buildingId, grid, 0, null);
                S.core.buildings.invalidate();
                return ok;
            },
            check: function () {
                return onHomeWith(grid, buildingName);
            },
            observable: homeObservable
        };
    }

    function upgrade(grid, buildingName, nextLevel) {
        // A running upgrade is the effect of the send, so it counts as
        // reached before the level changes.
        function reached(b) {
            return !!b && S.core.buildings.name(b) === buildingName &&
                (S.core.buildings.level(b) >= nextLevel || upgrading(b) === true);
        }
        return {
            label:     'upgrade ' + buildingName + ' ' + grid + ' to ' + nextLevel,
            category:  'construction',
            timeoutMs: TIMEOUT_MS,
            retries:   0,
            satisfied: function () {
                return S.core.zone.isHome() === true && reached(S.core.buildings.byGrid(grid));
            },
            precheck: function () {
                if (S.core.zone.isHome() !== true) return 'not on the home island';
                S.core.buildings.invalidate();
                var b = S.core.buildings.byGrid(grid);
                if (S.core.buildings.name(b) !== buildingName) return 'building changed';
                if (upgrading(b) !== false) return 'upgrade state unreadable';
                if (!S.core.buildings.isUpgradable(b)) return 'upgrade not allowed';
                return null;
            },
            send: function () {
                var z = (typeof game !== 'undefined' && game) ? game.zone : null;
                if (!z || typeof z.UpgradeBuildingOnGridPosition !== 'function') {
                    return S.core.actions.NOT_SENT;
                }
                try {
                    z.UpgradeBuildingOnGridPosition(grid);
                } catch (e) {
                    S.kernel.warn('construction', 'UpgradeBuildingOnGridPosition threw for',
                                  buildingName, 'on grid', grid, ':', e);
                    S.core.buildings.invalidate();
                    return false;
                }
                S.core.buildings.invalidate();
                return true;
            },
            check: function () {
                return S.core.zone.isHome() === true && reached(S.core.buildings.byGrid(grid));
            },
            observable: homeObservable
        };
    }

    S.core.construction = {
        ACTION_SET_BUILDING: ACTION_SET_BUILDING,
        TIMEOUT_MS:          TIMEOUT_MS,
        place:               place,
        upgrade:             upgrade,
        upgrading:           upgrading
    };

}(Steward));
