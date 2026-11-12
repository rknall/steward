/*
 * Deposit search and listing.
 *
 * The only source is mStreetDataMap.getDeposits_vectorByType(name), read
 * once per deposit type. The street-data deposit container (a
 * NotifyingIndexedContainer in the AIR client) neither indexes nor
 * enumerates, so walking it always yields nothing; there is deliberately no
 * container fallback, because an empty fallback reads as "no deposits".
 *
 * The AIR bridge sometimes throws a transient "[undefined] is not a
 * function" from inside getDeposits_vectorByType. byType retries the call
 * once, synchronously (no Promise or deferral in AIR), and logs a recovery.
 *
 * Contract: byType, list and byGrid return what the host reports, or THROW
 * when the host read failed or cannot be done (no zone, no street-data map,
 * method missing, or two failed calls). They never return [] to mean
 * "unknown", so callers can tell an unknown count from zero. Callers own
 * the warning: byType itself does not warn, so one failure is one line.
 */

(function (S) {

    function currentZone(zoneOverride) {
        if (zoneOverride) return zoneOverride;
        return S.core.zone.current();
    }

    // A falsy vector means the host answered and reported nothing, so it is
    // an empty result, not a failure.
    function readTypeVector(sdm, typeName) {
        var v = sdm.getDeposits_vectorByType(typeName);
        var out = [];
        if (!v) return out;
        var len = (typeof v.length === 'number') ? v.length : 0;
        for (var i = 0; i < len; i++) {
            if (v[i]) out.push(v[i]);
        }
        return out;
    }

    function name(d) {
        if (!d) return '';
        try { return typeof d.GetName_string === 'function' ? d.GetName_string() : ''; }
        catch (e) { return ''; }
    }

    function grid(d) {
        if (!d) return null;
        try { return typeof d.GetGrid === 'function' ? d.GetGrid() : null; }
        catch (e) { return null; }
    }

    function amount(d) {
        if (!d) return 0;
        try { return typeof d.GetAmount === 'function' ? d.GetAmount() : 0; }
        catch (e) { return 0; }
    }

    function byType(typeName, opts) {
        opts = opts || {};
        var zone = currentZone(opts.zone);
        var sdm = zone ? zone.mStreetDataMap : null;
        if (!sdm || typeof sdm.getDeposits_vectorByType !== 'function') {
            throw new Error('deposits.byType: host deposit lookup unavailable');
        }
        var firstErr;
        try {
            return readTypeVector(sdm, typeName);
        } catch (e1) {
            firstErr = e1;
        }
        var result;
        try {
            result = readTypeVector(sdm, typeName);
        } catch (e2) {
            throw new Error('deposits.byType failed twice for ' + typeName + ': ' +
                (e2 && e2.message ? e2.message : e2));
        }
        S.kernel.log('deposits', 'byType recovered on retry for', typeName, ':', firstErr);
        return result;
    }

    // Built from byType over the deposit-type enum, so a failed read of any
    // type propagates instead of shrinking the list.
    function list(opts) {
        opts = opts || {};
        var rows = S.core.deposits.types();
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            out = out.concat(byType(rows[i].name, opts));
        }
        return out;
    }

    function byGrid(targetGrid, opts) {
        var src = list(opts);
        for (var i = 0; i < src.length; i++) {
            if (grid(src[i]) === targetGrid) return src[i];
        }
        return null;
    }

    function depleted(opts) {
        opts = opts || {};
        // Depleted deposits surface as buildings whose name starts with "Depleted".
        if (!S.core.buildings) return [];
        return S.core.buildings.byPredicate(function (b) {
            var bn = S.core.buildings.name(b);
            return typeof bn === 'string' && bn.indexOf('Depleted') === 0;
        }, opts);
    }

    // True for a "Depleted*" building whose name carries a managed deposit
    // type name (for example DepletedIronOre). Anything else is never one.
    function isManagedDepleted(b) {
        if (!S.core.buildings) return false;
        var bn = S.core.buildings.name(b);
        if (typeof bn !== 'string' || bn.indexOf('Depleted') !== 0) return false;
        var rows = S.core.deposits.types();
        for (var i = 0; i < rows.length; i++) {
            if (bn.indexOf(rows[i].name) > 0) return true;
        }
        return false;
    }

    function depletedManaged(opts) {
        var all = depleted(opts);
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (isManagedDepleted(all[i])) out.push(all[i]);
        }
        return out;
    }

    // Sends the destruct command for one depleted deposit on the home zone.
    // The building is re-read from the zone by grid first and must still be a
    // managed depleted deposit, so a stale reference never destroys something
    // else. Returns true when the command was sent, false when it was refused;
    // a host throw propagates. Whether the building went away is for the
    // caller to verify on a later read.
    function removeDepleted(b, opts) {
        opts = opts || {};
        if (!S.core.zone.isHome()) return false;
        var zone = currentZone(opts.zone);
        if (!zone || typeof zone.GetBuildingFromGridPosition !== 'function' ||
            typeof zone.SendDestructBuildingCommand !== 'function') return false;
        var g = S.core.buildings.grid(b);
        if (g === null || typeof g === 'undefined') return false;
        var live = zone.GetBuildingFromGridPosition(g);
        if (!live || !isManagedDepleted(live)) return false;
        zone.SendDestructBuildingCommand(live, 'minimalInfoPanel');
        return true;
    }

    // Property-by-property assignment so helpers attached by sibling
    // files in core/deposits/ (which load before this file by filename
    // sort) survive — same pattern specialists.js uses.
    if (!S.core.deposits) S.core.deposits = {};
    S.core.deposits.list     = list;
    S.core.deposits.byType   = byType;
    S.core.deposits.byGrid   = byGrid;
    S.core.deposits.depleted = depleted;
    S.core.deposits.isManagedDepleted = isManagedDepleted;
    S.core.deposits.depletedManaged   = depletedManaged;
    S.core.deposits.removeDepleted    = removeDepleted;
    S.core.deposits.name     = name;
    S.core.deposits.grid     = grid;
    S.core.deposits.amount   = amount;

}(Steward));
