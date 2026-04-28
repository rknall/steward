/*
 * Buff inventory + per-target filtering.
 *
 * The host's buff system is a few layers deep: each buff in the player's
 * inventory carries a definition with a target description (a comma-separated
 * list of building names like "IronMine,GoldMine") and a buff type. We expose
 * a normalized read of "what buffs do I have, what can I apply to a given
 * building" so modules don't have to chase the host's pointer chains.
 *
 * Returns raw host buff objects from forBuilding/byName so callers can read
 * .GetUniqueId() for SendServerAction(61, ...). Defensive accessors on top
 * for name / amount / targets / definition so a stub or partial host object
 * doesn't blow up the caller.
 *
 * Cache: per-tick, like core/buildings. Inventory changes (apply, refund)
 * call invalidate() to force a fresh read.
 *
 * Spike reference: autoTSO/user_auto.js:4526-4682.
 */

(function (S) {

    var snapshot = null;     // cached array of host buff objects per tick

    function readInventory() {
        var out = [];
        try {
            var p = (typeof game !== 'undefined' && game && game.gi)
                ? game.gi.mCurrentPlayer : null;
            if (!p || typeof p.getAvailableBuffs_vector !== 'function') return out;
            var src = p.getAvailableBuffs_vector();
            var len = (src && typeof src.length === 'number') ? src.length : 0;
            for (var i = 0; i < len; i++) {
                if (src[i]) out.push(src[i]);
            }
        } catch (e) {
            S.kernel.warn('buffs', 'readInventory threw:', e);
        }
        return out;
    }

    function ensureSnapshot() {
        if (!snapshot) snapshot = readInventory();
        return snapshot;
    }

    function invalidate() { snapshot = null; }

    // ----- defensive accessors -------------------------------------------

    function name(b) {
        if (!b) return '';
        try { return (typeof b.GetType === 'function') ? b.GetType() : ''; }
        catch (e) { return ''; }
    }

    function amount(b) {
        if (!b) return 0;
        try { return (typeof b.amount === 'number') ? b.amount : 0; }
        catch (e) { return 0; }
    }

    function uniqueId(b) {
        if (!b) return null;
        try { return (typeof b.GetUniqueId === 'function') ? b.GetUniqueId() : null; }
        catch (e) { return null; }
    }

    function definition(b) {
        if (!b) return null;
        try { return (typeof b.GetBuffDefinition === 'function') ? b.GetBuffDefinition() : null; }
        catch (e) { return null; }
    }

    // Mine/mason buffs are GetBuffType() === 0. Other types (zone-wide,
    // adventure, combat) are filtered out since they don't apply to a
    // single building grid.
    function isBuildingBuff(b) {
        var def = definition(b);
        if (!def || typeof def.GetBuffType !== 'function') return false;
        try { return def.GetBuffType() === 0; }
        catch (e) { return false; }
    }

    // Returns the comma-split target list from the definition, or [] on error.
    function targets(b) {
        var def = definition(b);
        if (!def || typeof def.GetTargetDescription_string !== 'function') return [];
        try {
            var s = def.GetTargetDescription_string();
            if (!s) return [];
            var parts = s.split(',');
            // Trim whitespace defensively (some host strings have stray spaces).
            for (var i = 0; i < parts.length; i++) parts[i] = (parts[i] || '').replace(/^\s+|\s+$/g, '');
            return parts;
        } catch (e) { return []; }
    }

    // ----- public API ----------------------------------------------------

    // available() — every buff in inventory (includes non-building buffs).
    function available() {
        var src = ensureSnapshot();
        var out = [];
        for (var i = 0; i < src.length; i++) out.push(src[i]);
        return out;
    }

    // forBuilding(target) — buffs whose target list mentions the given
    // building name AND whose definition is a building-buff (BuffType === 0)
    // AND whose amount > 0. Returns the host buff objects untouched.
    function forBuilding(target) {
        if (!target) return [];
        var src = ensureSnapshot();
        var out = [];
        for (var i = 0; i < src.length; i++) {
            var b = src[i];
            if (!b) continue;
            if (!isBuildingBuff(b)) continue;
            if (amount(b) <= 0) continue;
            var t = targets(b);
            for (var j = 0; j < t.length; j++) {
                if (t[j] === target) { out.push(b); break; }
            }
        }
        return out;
    }

    // byName(name) — first inventory entry with the given GetType() name,
    // or null. Used by tryBuff to resolve the user-selected buff string.
    function byName(buffName) {
        if (!buffName) return null;
        var src = ensureSnapshot();
        for (var i = 0; i < src.length; i++) {
            if (name(src[i]) === buffName) return src[i];
        }
        return null;
    }

    // canApply(building, buffName) — pre-flight gate. True iff:
    //   - building exists, no active production buff
    //   - building isn't upgrading, constructing, or being destroyed
    //   - buff is in inventory with amount > 0
    //   - buff's target list mentions the building's name
    // Mirrors autoTSO/user_auto.js:5279-5281.
    function canApply(building, buffName) {
        if (!building || !buffName) return false;
        try {
            if (building.productionBuff) return false;          // truthy = active buff present
            if (typeof building.IsUpgradeInProgress === 'function' &&
                building.IsUpgradeInProgress()) return false;
            if (typeof building.IsInConstructionMode === 'function' &&
                building.IsInConstructionMode()) return false;
            if (typeof building.IsInDestruction === 'function' &&
                building.IsInDestruction()) return false;
        } catch (e) { return false; }

        var b = byName(buffName);
        if (!b || amount(b) <= 0) return false;

        var bn = (typeof building.GetBuildingName_string === 'function')
            ? building.GetBuildingName_string() : '';
        if (!bn) return false;
        var t = targets(b);
        for (var i = 0; i < t.length; i++) {
            if (t[i] === bn) return true;
        }
        return false;
    }

    if (!S.core) S.core = {};
    S.core.buffs = {
        // listing
        available:   available,
        forBuilding: forBuilding,
        byName:      byName,
        invalidate:  invalidate,

        // accessors
        name:        name,
        amount:      amount,
        uniqueId:    uniqueId,
        targets:     targets,

        // gate
        canApply:    canApply
    };

}(Steward));
