/*
 * Zone helpers.
 *
 * Thin wrappers around game.gi for current-zone identity and navigation.
 * Modules consult these instead of reaching into game.gi directly so the
 * abstraction can absorb client API changes in one place.
 *
 * view() is the readiness-aware read of the viewed zone: a Result that says
 * whether the zone is loading (notReady), cannot be read (unreadable) or is
 * known (ok, { id, home, adventure }). current/id/isHome/isAdventure keep their
 * plain contracts, where a failed read looks like "not home"; a caller that
 * must not act on such a guess reads view() instead.
 */

(function (S) {

    var R = S.kernel.read;

    // A precheck refusal that only means the zone could not be read and nothing
    // went out, so callers can treat it as "try again", not as a decision.
    var UNREADABLE = R.readRefusal('zone unreadable');

    function gi() {
        try {
            if (typeof game !== 'undefined' && game && game.gi) return game.gi;
        } catch (e) { /* fall through */ }
        return null;
    }

    function current() {
        var g = gi();
        if (!g) return null;
        try { return g.mCurrentPlayerZone || null; }
        catch (e) {
            S.kernel.warn('zone', 'current() threw:', e);
            return null;
        }
    }

    function id() {
        var g = gi();
        if (!g) return null;
        try { return g.mCurrentViewedZoneID; }
        catch (e) { return null; }
    }

    function isHome() {
        var g = gi();
        if (!g) return false;
        try {
            if (typeof g.isOnHomzone === 'function') return !!g.isOnHomzone();
        } catch (e) { /* swallow */ }
        return false;
    }

    function isAdventure() {
        try {
            var p = gi() ? gi().mCurrentPlayer : null;
            if (p && typeof p.mIsAdventureZone !== 'undefined') return !!p.mIsAdventureZone;
        } catch (e) { /* swallow */ }
        try {
            var z = current();
            if (z && z.mAdventureName && z.mAdventureName !== 'Home') return true;
        } catch (e2) { /* swallow */ }
        return false;
    }

    // A read that throws is left to the read engine, which reports it as
    // unreadable and does not memoize it, so the next read in the pass retries.
    function readView() {
        var g = gi();
        if (!g) return R.notReady('no game.gi');
        // The player zone is null while the client loads a zone; the other
        // members may still describe the previous one.
        if (!g.mCurrentPlayerZone) return R.notReady('zone loading');
        var zid = g.mCurrentViewedZoneID;
        if (typeof zid !== 'number') return R.unreadable('viewed zone id is not a number');
        if (typeof g.isOnHomzone !== 'function') return R.unreadable('isOnHomzone missing');
        var home = !!g.isOnHomzone();
        return R.ok({ id: zid, home: home, adventure: isAdventure() }, zid);
    }

    R.source('zone.view', { read: readView, scope: 'pass' });

    function view(opts) {
        return R.get('zone.view', undefined, opts);
    }

    // Precheck of a def that only acts on the home island: the zone's own
    // read refusal while the zone view is not ok (loading or unreadable), so a
    // failed read is retried rather than taken for "not home"; the plain
    // refusal when the zone is known and is not home; null when home.
    function homeRefusal() {
        var v = S.core.zone.view();
        if (!R.isOk(v)) return UNREADABLE;
        if (!v.value || v.value.home !== true) return 'not on the home island';
        return null;
    }

    function homePlayer() {
        var g = gi();
        if (!g) return null;
        try { return g.mHomePlayer || null; } catch (e) { return null; }
    }

    // Id of the player whose army and specialists are "own" in the current zone.
    // Falls back to the home player when the zone call is unavailable.
    function playerId() {
        try {
            if (typeof game !== 'undefined' && game && game.player &&
                typeof game.player.GetPlayerId === 'function') {
                return game.player.GetPlayerId();
            }
        } catch (e) { /* fall through to the home player */ }
        try {
            var hp = homePlayer();
            if (hp && typeof hp.GetPlayerId === 'function') return hp.GetPlayerId();
        } catch (e2) { /* swallow */ }
        return null;
    }

    // Zone id of the player's home island, or null when neither player object
    // answers. The viewed player is the fallback because it is the home player
    // while the home island is shown.
    function homeId() {
        try {
            if (typeof game !== 'undefined' && game && game.player &&
                typeof game.player.GetHomeZoneId === 'function') {
                var a = game.player.GetHomeZoneId();
                if (typeof a === 'number') return a;
            }
        } catch (e) { /* fall through to the viewed player */ }
        try {
            var p = gi() ? gi().mCurrentPlayer : null;
            if (p && typeof p.GetHomeZoneId === 'function') {
                var b = p.GetHomeZoneId();
                if (typeof b === 'number') return b;
            }
        } catch (e2) { /* swallow */ }
        return null;
    }

    function adventureName() {
        if (!isAdventure()) return null;
        try {
            var z = current();
            if (z && z.mAdventureName) return z.mAdventureName;
        } catch (e) { /* swallow */ }
        return null;
    }

    function viewedPlayer() {
        var g = gi();
        if (!g) return null;
        try { return g.mCurrentPlayer || null; } catch (e) { return null; }
    }

    function visit(zoneId) {
        var g = gi();
        if (!g || typeof g.visitZone !== 'function') {
            S.kernel.warn('zone', 'visit: game.gi.visitZone unavailable');
            return false;
        }
        try { g.visitZone(zoneId); return true; }
        catch (e) { S.kernel.error('zone', 'visit', zoneId, 'threw:', e); return false; }
    }

    function scrollTo(grid) {
        try {
            if (typeof game !== 'undefined' && game && game.zone && typeof game.zone.ScrollToGrid === 'function') {
                game.zone.ScrollToGrid(grid);
                return true;
            }
        } catch (e) {
            S.kernel.error('zone', 'scrollTo', grid, 'threw:', e);
        }
        return false;
    }

    // Grids of the landing fields: where the client lets a general be placed on
    // an adventure map. An unreadable vector, or a zone view that is not ok,
    // yields an empty list, so a caller finds no grid: while the zone loads or
    // cannot be read, the street data may still belong to the previous zone.
    function landingGrids() {
        var out = [];
        if (!R.isOk(view())) return out;
        try {
            if (typeof game === 'undefined' || !game || !game.zone) return out;
            var sdm = game.zone.mStreetDataMap;
            var vec = sdm ? sdm.mLandingFields_vector : null;
            if (!vec || typeof vec.length !== 'number') return out;
            for (var i = 0; i < vec.length; i++) {
                var f = vec[i];
                if (!f || typeof f.GetGrid !== 'function') continue;
                var g = f.GetGrid();
                if (typeof g === 'number' && g > 0 && out.indexOf(g) < 0) out.push(g);
            }
        } catch (e) {
            S.kernel.warn('zone', 'landingGrids threw:', e);
            return [];
        }
        return out;
    }

    S.core.zone = {
        current:      current,
        id:           id,
        isHome:       isHome,
        isAdventure:  isAdventure,
        homePlayer:   homePlayer,
        playerId:     playerId,
        homeId:       homeId,
        adventureName: adventureName,
        viewedPlayer: viewedPlayer,
        visit:        visit,
        scrollTo:     scrollTo,
        landingGrids: landingGrids,
        view:         view,
        homeRefusal:  homeRefusal,
        UNREADABLE:   UNREADABLE
    };

}(Steward));
