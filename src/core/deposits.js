/*
 * Deposit search and listing.
 *
 * Returns raw deposit-VO objects from the zone's mDepositContainer (or
 * getDeposits_vectorByType when filtering by name).
 */

(function (S) {

    function currentZone(zoneOverride) {
        if (zoneOverride) return zoneOverride;
        return S.core.zone.current();
    }

    function readDepositsFromZone(zone) {
        var out = [];
        if (!zone) return out;
        try {
            var sdm = zone.mStreetDataMap;
            if (!sdm) return out;
            var src = sdm.mDepositContainer;
            if (!src) return out;
            var len = (typeof src.length === 'number') ? src.length : 0;
            for (var i = 0; i < len; i++) {
                if (src[i]) out.push(src[i]);
            }
        } catch (e) {
            S.kernel.warn('deposits', 'readDepositsFromZone threw:', e);
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

    function list(opts) {
        opts = opts || {};
        return readDepositsFromZone(currentZone(opts.zone));
    }

    function byType(typeName, opts) {
        opts = opts || {};
        var zone = currentZone(opts.zone);
        if (!zone) return [];
        try {
            var sdm = zone.mStreetDataMap;
            if (sdm && typeof sdm.getDeposits_vectorByType === 'function') {
                var v = sdm.getDeposits_vectorByType(typeName);
                if (!v) return [];
                var out = [];
                var len = (typeof v.length === 'number') ? v.length : 0;
                for (var i = 0; i < len; i++) {
                    if (v[i]) out.push(v[i]);
                }
                return out;
            }
        } catch (e) {
            S.kernel.warn('deposits', 'byType threw for', typeName, ':', e);
        }
        // Fallback — manual filter.
        var all = readDepositsFromZone(zone);
        var filtered = [];
        for (var j = 0; j < all.length; j++) {
            if (name(all[j]) === typeName) filtered.push(all[j]);
        }
        return filtered;
    }

    function byGrid(targetGrid, opts) {
        opts = opts || {};
        var src = readDepositsFromZone(currentZone(opts.zone));
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

    // Property-by-property assignment so helpers attached by sibling
    // files in core/deposits/ (which load before this file by filename
    // sort) survive — same pattern specialists.js uses.
    if (!S.core.deposits) S.core.deposits = {};
    S.core.deposits.list     = list;
    S.core.deposits.byType   = byType;
    S.core.deposits.byGrid   = byGrid;
    S.core.deposits.depleted = depleted;
    S.core.deposits.name     = name;
    S.core.deposits.grid     = grid;
    S.core.deposits.amount   = amount;

}(Steward));
