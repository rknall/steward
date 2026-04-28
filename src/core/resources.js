/*
 * Player resource inventory.
 *
 * Wraps `game.getResources().GetPlayerResources_vector("")` and the
 * single-name lookup `GetPlayerResource(name)` from the AIR host. Lets
 * modules read item amounts (Leather, Banner, Cauldron, etc.) without
 * having to navigate the host's pointer chains.
 *
 * Localized display names go through `loca.GetText('RES', name)` — same
 * path core/buffs uses. Defensive accessors fall back gracefully when
 * the host or loca is unavailable.
 *
 * Cache: per-tick, like core/buildings and core/buffs. Inventory changes
 * (production, trade) call invalidate() to force a fresh read.
 *
 * Spike reference: autoTSO/user_auto.js:4733 (GetPlayerResources_vector)
 * and :5471 (GetPlayerResource access).
 */

(function (S) {

    var snapshot = null;     // cached array of host resource objects per tick

    function host() {
        try {
            if (typeof game === 'undefined' || !game) return null;
            if (typeof game.getResources !== 'function') return null;
            return game.getResources();
        } catch (e) { return null; }
    }

    function readInventory() {
        var out = [];
        try {
            var h = host();
            if (!h || typeof h.GetPlayerResources_vector !== 'function') return out;
            var src = h.GetPlayerResources_vector('');
            var len = (src && typeof src.length === 'number') ? src.length : 0;
            for (var i = 0; i < len; i++) {
                if (src[i]) out.push(src[i]);
            }
        } catch (e) {
            S.kernel.warn('resources', 'readInventory threw:', e);
        }
        return out;
    }

    function ensureSnapshot() {
        if (!snapshot) snapshot = readInventory();
        return snapshot;
    }

    function invalidate() { snapshot = null; }

    // ----- accessors -----------------------------------------------------

    function name(r) {
        if (!r) return '';
        try { return r.name_string || ''; }
        catch (e) { return ''; }
    }

    // Returns the amount currently held. Per-name lookup goes straight to
    // the host (cheaper for single reads, and shows entries with amount 0
    // that GetPlayerResources_vector may omit).
    function amount(nameOrObj) {
        if (!nameOrObj) return 0;
        if (typeof nameOrObj === 'object') {
            try { return (typeof nameOrObj.amount === 'number') ? nameOrObj.amount : 0; }
            catch (e) { return 0; }
        }
        var r = byName(nameOrObj);
        if (!r) return 0;
        try { return (typeof r.amount === 'number') ? r.amount : 0; }
        catch (e) { return 0; }
    }

    // displayName(name) — loca.GetText('RES', name). Falls back to the
    // internal key when loca is missing or returns falsy.
    function displayName(internal) {
        if (!internal) return '';
        try {
            if (typeof loca !== 'undefined' && loca && typeof loca.GetText === 'function') {
                var t = loca.GetText('RES', internal);
                if (t) return t;
            }
        } catch (e) { /* fall through */ }
        return internal;
    }

    // ----- public API ----------------------------------------------------

    // list() — every resource the host returns, raw host objects.
    function list() {
        var src = ensureSnapshot();
        var out = [];
        for (var i = 0; i < src.length; i++) out.push(src[i]);
        return out;
    }

    // byName(name) — single resource via the host's per-name lookup. Returns
    // null when the host has no record (e.g. event item the player has
    // never received).
    function byName(internal) {
        if (!internal) return null;
        var h = host();
        if (!h || typeof h.GetPlayerResource !== 'function') return null;
        try { return h.GetPlayerResource(internal) || null; }
        catch (e) { return null; }
    }

    if (!S.core) S.core = {};
    S.core.resources = {
        list:        list,
        byName:      byName,
        amount:      amount,
        displayName: displayName,
        name:        name,
        invalidate:  invalidate
    };

}(Steward));
