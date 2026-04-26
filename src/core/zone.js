/*
 * Zone helpers.
 *
 * Thin wrappers around game.gi for current-zone identity and navigation.
 * Modules consult these instead of reaching into game.gi directly so the
 * abstraction can absorb client API changes in one place.
 */

(function (S) {

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

    function homePlayer() {
        var g = gi();
        if (!g) return null;
        try { return g.mHomePlayer || null; } catch (e) { return null; }
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

    S.core.zone = {
        current:      current,
        id:           id,
        isHome:       isHome,
        isAdventure:  isAdventure,
        homePlayer:   homePlayer,
        viewedPlayer: viewedPlayer,
        visit:        visit,
        scrollTo:     scrollTo
    };

}(Steward));
