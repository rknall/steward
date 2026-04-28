/*
 * Building search, listing, and state predicates.
 *
 * Returns raw game objects — modules read fields via the helpers below or
 * via GetBuildingName_string() / GetGrid() directly.
 *
 * Cache: per scheduler tick, cleared at every tick start. Modules that mutate
 * the building set (place, destroy, upgrade) call invalidate() to force a
 * re-read in the same tick.
 */

(function (S) {

    var snapshot = null;     // cached array per tick

    function currentZone(zoneOverride) {
        if (zoneOverride) return zoneOverride;
        return S.core.zone.current();
    }

    function readAllFromZone(zone) {
        var out = [];
        if (!zone) return out;
        try {
            var sdm = zone.mStreetDataMap;
            if (!sdm) return out;

            var src = null;
            if (typeof sdm.GetBuildings_vector === 'function') {
                src = sdm.GetBuildings_vector();
            } else if (sdm.mBuildingContainer) {
                src = sdm.mBuildingContainer;
            }
            if (!src) return out;

            // Vectors usually expose a .length and numeric index; iterate defensively.
            var len = (typeof src.length === 'number') ? src.length : 0;
            for (var i = 0; i < len; i++) {
                var b = src[i];
                if (b) out.push(b);
            }
        } catch (e) {
            S.kernel.warn('buildings', 'readAllFromZone threw:', e);
        }
        return out;
    }

    function ensureSnapshot(zoneOverride) {
        if (zoneOverride) return readAllFromZone(zoneOverride);
        if (!snapshot) snapshot = readAllFromZone(currentZone());
        return snapshot;
    }

    function invalidate() { snapshot = null; }

    function name(b) {
        if (!b) return '';
        try { return b.GetBuildingName_string ? b.GetBuildingName_string() : ''; }
        catch (e) { return ''; }
    }

    function grid(b) {
        if (!b) return null;
        try { return b.GetGrid ? b.GetGrid() : null; }
        catch (e) { return null; }
    }

    function level(b) {
        if (!b) return 0;
        try { return b.GetUpgradeLevel ? b.GetUpgradeLevel() : 0; }
        catch (e) { return 0; }
    }

    function playerId(b) {
        if (!b) return null;
        try { return typeof b.getPlayerID === 'function' ? b.getPlayerID() : null; }
        catch (e) { return null; }
    }

    function goContainer(b) {
        if (!b) return null;
        try { return typeof b.GetGOContainer === 'function' ? b.GetGOContainer() : null; }
        catch (e) { return null; }
    }

    function isMine(b) { return playerId(b) === 0; }

    function isEnemy(b) {
        if (playerId(b) === -1) return true;
        var c = goContainer(b);
        return !!(c && c.ui === 'enemy');
    }

    function isAttackable(b) {
        var c = goContainer(b);
        return !!(c && c.mIsAttackable && !c.mIsLeaderCamp);
    }

    function hasArmy(b) {
        if (!b) return false;
        try {
            var a = typeof b.GetArmy === 'function' ? b.GetArmy() : null;
            return !!(a && typeof a.HasUnits === 'function' && a.HasUnits());
        } catch (e) { return false; }
    }

    function isUpgradable(b) {
        if (!b) return false;
        try { return typeof b.IsUpgradeAllowed === 'function' && !!b.IsUpgradeAllowed(true); }
        catch (e) { return false; }
    }

    function isCollectible(b) {
        if (!b) return false;
        try {
            if (typeof game === 'undefined' || !game.def) return false;
            var cm = game.def('Collections::CollectionsManager');
            if (!cm) return false;
            var inst = typeof cm.getInstance === 'function' ? cm.getInstance() : cm;
            if (inst && typeof inst.getBuildingIsCollectible === 'function') {
                return !!inst.getBuildingIsCollectible(name(b));
            }
        } catch (e) { /* swallow */ }
        return false;
    }

    function matchesType(b, type) {
        // type may be either an internal building name (Steward.Building.Foo
        // value) or an array of names.
        var n = name(b);
        if (!n) return false;
        if (type && typeof type === 'string') return n === type;
        if (type && type.length) {
            for (var i = 0; i < type.length; i++) {
                if (n === type[i]) return true;
            }
        }
        return false;
    }

    function list(opts) {
        opts = opts || {};
        var src = ensureSnapshot(opts.zone);
        if (!opts.type) return src.slice();
        var out = [];
        for (var i = 0; i < src.length; i++) {
            if (matchesType(src[i], opts.type)) out.push(src[i]);
        }
        return out;
    }

    function byName(targetName, opts) {
        opts = opts || {};
        // Fast path: ask the host's named lookup. Mirrors byGrid's fast
        // path. Some building categories (e.g. masons) appear in the
        // host's getBuildingsByName_vector but not in GetBuildings_vector,
        // so the snapshot fallback would miss them.
        if (!opts.zone) {
            try {
                var z = S.core.zone.current();
                if (z && z.mStreetDataMap &&
                    typeof z.mStreetDataMap.getBuildingsByName_vector === 'function') {
                    var v = z.mStreetDataMap.getBuildingsByName_vector(targetName);
                    if (v) {
                        var hits = [];
                        var len = (typeof v.length === 'number') ? v.length : 0;
                        for (var i = 0; i < len; i++) {
                            if (v[i]) hits.push(v[i]);
                        }
                        return hits;
                    }
                }
            } catch (e) { /* fall through to snapshot */ }
        }
        var src = ensureSnapshot(opts.zone);
        var out = [];
        for (var j = 0; j < src.length; j++) {
            if (name(src[j]) === targetName) out.push(src[j]);
        }
        return out;
    }

    function byGrid(targetGrid, opts) {
        opts = opts || {};
        if (!opts.zone) {
            // Fast path: ask the game directly when on the current zone.
            try {
                var g = typeof game !== 'undefined' ? game : null;
                if (g && g.zone && typeof g.zone.GetBuildingFromGridPosition === 'function') {
                    return g.zone.GetBuildingFromGridPosition(targetGrid) || null;
                }
            } catch (e) { /* fall through */ }
        }
        var src = ensureSnapshot(opts.zone);
        for (var i = 0; i < src.length; i++) {
            if (grid(src[i]) === targetGrid) return src[i];
        }
        return null;
    }

    function byPredicate(fn, opts) {
        opts = opts || {};
        var src = ensureSnapshot(opts.zone);
        var out = [];
        for (var i = 0; i < src.length; i++) {
            try { if (fn(src[i])) out.push(src[i]); }
            catch (e) { /* skip */ }
        }
        return out;
    }

    function listMines(opts) {
        return byPredicate(function (b) {
            var n = name(b);
            return typeof n === 'string' && n.indexOf('Mine') > -1;
        }, opts);
    }

    // Group every collectible building on the zone by display name and
    // count occurrences. Returns [{ name, count }] sorted by count desc
    // then by name. Used by the dashboard's Collect Pickups section, but
    // intentionally lives here so any module ("how much is on the ground
    // right now") can consume the same query without re-implementing the
    // walk + filter + group.
    function collectiblesByName(opts) {
        opts = opts || {};
        var src = ensureSnapshot(opts.zone);
        var groups = {};
        for (var i = 0; i < src.length; i++) {
            if (!isCollectible(src[i])) continue;
            var n = name(src[i]);
            if (!n) continue;
            groups[n] = (groups[n] || 0) + 1;
        }
        var out = [];
        var keys = Object.keys(groups);
        for (var k = 0; k < keys.length; k++) {
            out.push({ name: keys[k], count: groups[keys[k]] });
        }
        out.sort(function (a, b) {
            if (b.count !== a.count) return b.count - a.count;
            return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        });
        return out;
    }

    S.core.buildings = {
        // listing
        list:               list,
        byName:             byName,
        byGrid:             byGrid,
        byPredicate:        byPredicate,
        listMines:          listMines,
        collectiblesByName: collectiblesByName,
        invalidate:         invalidate,

        // accessors
        name:         name,
        grid:         grid,
        level:        level,
        playerId:     playerId,

        // state predicates
        isMine:       isMine,
        isEnemy:      isEnemy,
        isAttackable: isAttackable,
        hasArmy:      hasArmy,
        isUpgradable: isUpgradable,
        isCollectible:isCollectible
    };

}(Steward));
