/*
 * Rebuild module.
 *
 * Scans the home zone's building container for exhausted wells and fields
 * (shells named MineDepletedDepositWater / MineDepletedDepositCorn that the
 * map reports through IsADepletedDeposit) and rebuilds each with the
 * configured well or field type, using command SET_BUILDING_IN_GAME (50).
 *
 * One rebuild is queued per free build-queue slot; the queued action checks
 * the grid and the queue again before it sends anything.
 */

(function (S) {

    if (!S.modules.rebuild) S.modules.rebuild = {};

    var CMD_SET_BUILDING_IN_GAME = 50;

    function readSettings() {
        var stored = S.kernel.settings.read('rebuild') || {};
        var defaults = S.modules.rebuild.defaultSettings;
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        return merged;
    }

    function find(list, name) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].name === name) return list[i];
        }
        return null;
    }

    // The building to place on a depleted shell of the given name, or null
    // when the name is not an exhausted well or field.
    function target(depletedName, s) {
        var m = S.modules.rebuild;
        if (depletedName === m.depletedWell)  return find(m.wells,  s.wellType)  || m.wells[0];
        if (depletedName === m.depletedField) return find(m.fields, s.fieldType) || m.fields[0];
        return null;
    }

    function isDepleted(b) {
        var name = S.core.buildings.name(b);
        if (target(name, readSettings()) === null) return false;
        try {
            var sdm = game.gi.mCurrentPlayerZone.mStreetDataMap;
            if (sdm && typeof sdm.IsADepletedDeposit === 'function') {
                return !!sdm.IsADepletedDeposit(b);
            }
        } catch (e) {
            S.kernel.warn('rebuild', 'IsADepletedDeposit threw:', e);
            return false;
        }
        return true;
    }

    function freeSlots() {
        try {
            var bq = game.gi.mCurrentPlayer.mBuildQueue;
            var free = bq.GetTotalAvailableSlots() - bq.GetQueue_vector().length;
            return free > 0 ? free : 0;
        } catch (e) {
            S.kernel.warn('rebuild', 'freeSlots threw:', e);
            return 0;
        }
    }

    function buildingNumber(entry) {
        try {
            var nr = global.buildingGroup.GetNrFromName(entry.name);
            if (nr > 0) return nr;
        } catch (e) { /* fall back to the known id */ }
        return entry.id;
    }

    function isReady(ctx) {
        var s = readSettings();
        return !!(s.enabled && ctx.zone && ctx.zone.isHome);
    }

    function plan() {
        var s = readSettings();
        S.core.buildings.invalidate();
        var found = S.core.buildings.byPredicate(isDepleted);
        if (!found.length) return;

        var free = freeSlots();
        if (free <= 0) return;
        found.sort(function (a, b) {
            return S.core.buildings.grid(a) - S.core.buildings.grid(b);
        });

        var queued = 0;
        for (var i = 0; i < found.length && queued < free; i++) {
            var grid = S.core.buildings.grid(found[i]);
            var entry = target(S.core.buildings.name(found[i]), s);
            var delay = (queued === 0) ? 0 : s.actionDelay;
            S.kernel.queue.add('rebuild.place', [grid, entry.name], delay);
            queued++;
        }
        if (queued > 0) S.kernel.log('rebuild', 'queued', queued, 'rebuild(s)');
    }

    function place(params) {
        var grid = params[0];
        var name = params[1];
        var m = S.modules.rebuild;
        var entry = find(m.wells, name) || find(m.fields, name);
        if (!entry) return;

        // Re-check: state may have drifted since plan() queued.
        var live = S.core.buildings.byGrid(grid);
        if (!live || !isDepleted(live)) {
            S.kernel.log('rebuild', 'grid', grid, 'no longer depleted — skipping');
            return;
        }
        if (freeSlots() <= 0) {
            S.kernel.log('rebuild', 'build queue full — skipping grid', grid);
            return;
        }
        try {
            var gi = game.gi;
            gi.SendServerAction(CMD_SET_BUILDING_IN_GAME, buildingNumber(entry), grid, 0, null);
            // Pre-place locally like the client does, or the server's answer
            // is dropped and the queue only shows the order after a reload.
            var sdm = gi.mCurrentPlayerZone.mStreetDataMap;
            if (sdm && typeof sdm.SetPrePlaceBuildingGridPos === 'function') {
                sdm.SetPrePlaceBuildingGridPos(gi.mCurrentPlayer, entry.name, grid, 0);
            }
            S.kernel.log('rebuild', 'rebuilding', entry.name, 'on grid', grid);
            S.core.buildings.invalidate();
        } catch (e) {
            S.kernel.error('rebuild', 'rebuild of', entry.name, 'on grid', grid, 'threw:', e);
        }
    }

    function boot() {
        if (!S.kernel.settings.read('rebuild')) {
            S.kernel.settings.write('rebuild', S.modules.rebuild.defaultSettings);
        }
        S.kernel.queue.action('rebuild.place', place);
    }

    S.kernel.register({
        id:       'rebuild',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan
    });

}(Steward));
