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
 *   - the build queue: game.gi.mCurrentPlayer.mBuildQueue.GetTotalAvailableSlots()
 *     and .GetQueue_vector().length, and the licences GetMaxBuildingCount()
 *     and mCurrentBuildingsCountAll on the same player
 * The upgrade state, level and permission of a building are read through
 * S.core.buildings (upgrading, levelOf, isUpgradable).
 *
 * Failure contract: only positive reads count. A missing or unreadable
 * building never verifies a send and never clears the way for one: placing
 * needs a grid that reads empty while the building list is readable, and
 * upgrading needs a building whose level, upgrade state and permission all
 * read. Every home check reads S.core.zone.view(), so a loading or unreadable
 * zone never counts as home. A refusal that only means "a read failed" is a
 * registered read refusal, so a caller can tell "try again" from a decision.
 * Both defs default to no retry, since a resend of an unseen build or upgrade
 * can go out twice.
 *
 * Bundle slot: core, loads after buildings.js and core/buildings/ and before
 * deposits.js (core files load in name order). Other cores are used at call
 * time only. The capacity source registers at load and uses S.core.zone at
 * call time only, since zone.js loads later.
 */

(function (S) {

    var R = S.kernel.read;

    var ACTION_SET_BUILDING = 50;
    // The server normally answers a build or upgrade in 4 to 10 s; a slow
    // server takes 20 s or more.
    var TIMEOUT_MS = 30000;

    // Precheck refusals that only mean a read failed and nothing went out, so
    // callers can treat them as "try again", not as a decision.
    // An unreadable list looks empty everywhere, so no grid counts as empty.
    var BUILDINGS_UNREADABLE = R.readRefusal('buildings unreadable');
    // Whether the building is upgrading could not be read.
    var UPGRADE_STATE_UNREADABLE = R.readRefusal('upgrade state unreadable');
    // GetUpgradeLevel could not be read; a guessed level 0 would aim too low.
    var LEVEL_UNREADABLE = R.readRefusal('upgrade level unreadable');
    // IsUpgradeAllowed could not be read on the building.
    var PERMISSION_UNREADABLE = R.readRefusal('upgrade permission unreadable');

    function homeView() {
        return S.core.zone.view();
    }

    function onHome(v) {
        return R.isOk(v) && v.value.home === true;
    }

    // Why a send may not go out because of the zone, or null when the viewed
    // zone reads as home. Not home is a real answer; an unread zone is not.
    function homeRefusal() {
        var v = homeView();
        if (!R.isOk(v)) return S.core.zone.UNREADABLE;
        if (v.value.home !== true) return 'not on the home island';
        return null;
    }

    function onHomeWith(grid, buildingName) {
        return onHome(homeView()) &&
            S.core.buildings.name(S.core.buildings.byGrid(grid)) === buildingName;
    }

    function homeObservable() {
        return onHome(homeView());
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
                var home = homeRefusal();
                if (home) return home;
                S.core.buildings.invalidate();
                if (S.core.buildings.byGrid(grid)) return 'grid occupied';
                // An empty grid only counts as empty when the list itself
                // was read; an unreadable list looks empty everywhere.
                if (S.core.buildings.readable() !== true) return BUILDINGS_UNREADABLE;
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
        // reached before the level changes. An unread level never counts.
        function reached(b) {
            if (!b || S.core.buildings.name(b) !== buildingName) return false;
            var lvl = S.core.buildings.levelOf(b);
            if (lvl !== null && lvl >= nextLevel) return true;
            return S.core.buildings.upgrading(b) === true;
        }
        return {
            label:     'upgrade ' + buildingName + ' ' + grid + ' to ' + nextLevel,
            category:  'construction',
            timeoutMs: TIMEOUT_MS,
            retries:   0,
            satisfied: function () {
                return onHome(homeView()) && reached(S.core.buildings.byGrid(grid));
            },
            precheck: function () {
                var home = homeRefusal();
                if (home) return home;
                S.core.buildings.invalidate();
                var b = S.core.buildings.byGrid(grid);
                if (S.core.buildings.name(b) !== buildingName) return 'building changed';
                if (S.core.buildings.levelOf(b) === null) return LEVEL_UNREADABLE;
                var busy = S.core.buildings.upgrading(b);
                if (busy === null) return UPGRADE_STATE_UNREADABLE;
                if (busy === true) return 'already upgrading';
                var allowed = S.core.buildings.isUpgradable(b);
                if (allowed === null) return PERMISSION_UNREADABLE;
                if (allowed === false) return 'upgrade not allowed';
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
                return onHome(homeView()) && reached(S.core.buildings.byGrid(grid));
            },
            observable: homeObservable
        };
    }

    function isCount(v) {
        return typeof v === 'number' && isFinite(v);
    }

    // A read that throws is left to the read engine, which reports it as
    // unreadable and does not memoize it, so the next read in the pass retries.
    function readCapacity(arg, ctx) {
        var gi = (typeof game !== 'undefined' && game) ? game.gi : null;
        if (!gi) return R.notReady('no game.gi', ctx.zoneId);
        var p = gi.mCurrentPlayer;
        if (!p) return R.notReady('no player', ctx.zoneId);
        var q = p.mBuildQueue;
        if (!q || typeof q.GetTotalAvailableSlots !== 'function' ||
            typeof q.GetQueue_vector !== 'function' ||
            typeof p.GetMaxBuildingCount !== 'function') {
            return R.unreadable('build queue unreadable', ctx.zoneId);
        }
        var vec = q.GetQueue_vector();
        var c = {
            slotsTotal: q.GetTotalAvailableSlots(),
            slotsUsed:  vec ? vec.length : null,
            licMax:     p.GetMaxBuildingCount(),
            licUsed:    p.mCurrentBuildingsCountAll
        };
        if (!isCount(c.slotsTotal) || !isCount(c.slotsUsed) ||
            !isCount(c.licMax) || !isCount(c.licUsed)) {
            return R.unreadable('build queue or licence count not a number', ctx.zoneId);
        }
        return R.ok(c, ctx.zoneId);
    }

    R.source('construction.capacity', { scope: 'zone', read: readCapacity });

    // Build-queue slots and building licences of the viewed player, as a
    // Result { slotsTotal, slotsUsed, licMax, licUsed }. This is the one owner
    // of those host members; nothing else reads them directly.
    function capacity(opts) {
        return R.get('construction.capacity', undefined, opts);
    }

    S.core.construction = {
        ACTION_SET_BUILDING: ACTION_SET_BUILDING,
        TIMEOUT_MS:          TIMEOUT_MS,
        place:               place,
        upgrade:             upgrade,
        capacity:            capacity
    };

}(Steward));
