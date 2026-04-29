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

    // freshUniqueId(b) — return a NEWLY-CONSTRUCTED dUniqueID VO for the buff,
    // not the host-managed one returned by b.GetUniqueId(). The host's
    // SendServerAction(61, ...) silently rejects stale/cached uid references
    // — see tso_client/.../6-buffs.js:sendBuffPacket for the reference
    // implementation. Pulls the two integer parts (uniqueID1, uniqueID2) off
    // the original VO, then calls game.def("Communication.VO::dUniqueID").
    // Create(part1, part2) to produce a fresh VO. Returns null on miss.
    function freshUniqueId(b) {
        var raw = uniqueId(b);
        if (!raw) return null;
        var part1 = raw.uniqueID1;
        var part2 = raw.uniqueID2;
        if (typeof part1 === 'undefined' || typeof part2 === 'undefined') return null;
        try {
            if (typeof game === 'undefined' || !game || typeof game.def !== 'function') return null;
            var ctor = game.def('Communication.VO::dUniqueID');
            if (!ctor || typeof ctor.Create !== 'function') return null;
            return ctor.Create(part1, part2);
        } catch (e) {
            S.kernel.warn('buffs', 'freshUniqueId Create threw:', e);
            return null;
        }
    }

    function definition(b) {
        if (!b) return null;
        try { return (typeof b.GetBuffDefinition === 'function') ? b.GetBuffDefinition() : null; }
        catch (e) { return null; }
    }

    // resourceName(b) — outer GetResourceName_string(). For FillDeposit and
    // other category-style consumables the GetType() name is shared across
    // every entry ('FillDeposit' for Titanium, Meat, Fish, …); the resource
    // string is the only field that distinguishes them. Returns '' on miss.
    function resourceName(b) {
        if (!b) return '';
        try { return (typeof b.GetResourceName_string === 'function') ? (b.GetResourceName_string() || '') : ''; }
        catch (e) { return ''; }
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

    // ----- localization helpers ------------------------------------------

    // Detects the host's "missing translation" sentinel — strings like
    // "[undefined text]" or "[missing-key]" the host returns instead of
    // null/undefined. Trim surrounding whitespace and check first/last
    // chars rather than a strict regex — the host has been observed to
    // return the sentinel with trailing whitespace, which `^...$` misses.
    function isPlaceholder(s) {
        if (typeof s !== 'string') return false;
        var trimmed = s.replace(/^\s+|\s+$/g, '');
        if (trimmed.length < 2) return false;
        return trimmed.charAt(0) === '[' &&
               trimmed.charAt(trimmed.length - 1) === ']';
    }

    // displayName(b) — localized resource name from loca.GetText('RES', name).
    // Falls back to the internal GetType() name if loca is unavailable,
    // returns falsy, or returns a bracketed placeholder.
    function displayName(b) {
        var internal = name(b);
        if (!internal) return '';
        try {
            if (typeof loca !== 'undefined' && loca && typeof loca.GetText === 'function') {
                var t = loca.GetText('RES', internal);
                if (t && !isPlaceholder(t)) return t;
            }
        } catch (e) { /* fall through */ }
        return internal;
    }

    // description(b) — localized description, truncated at the host's
    // 'Target' suffix (mirrors autoTSO/user_auto.js:4583). The DES text
    // continues past 'Target' with internal detail that's not useful in a
    // user-facing picker. Returns '' if no description is available or the
    // host returns a placeholder.
    function description(b) {
        var internal = name(b);
        if (!internal) return '';
        try {
            if (typeof loca !== 'undefined' && loca && typeof loca.GetText === 'function') {
                var raw = loca.GetText('DES', internal);
                if (raw && !isPlaceholder(raw)) return String(raw).split('Target')[0];
            }
        } catch (e) { /* fall through */ }
        return '';
    }

    // ----- targeting helpers ---------------------------------------------

    function isWorkyardBuilding(b) {
        if (!b) return false;
        try { return typeof b.isWorkyard === 'function' && !!b.isWorkyard(); }
        catch (e) { return false; }
    }

    // Returns the buff's target group string, or '' if none / unreadable.
    function targetGroup(b) {
        var def = definition(b);
        if (!def || typeof def.GetTargetGroup_string !== 'function') return '';
        try { return def.GetTargetGroup_string() || ''; }
        catch (e) { return ''; }
    }

    // True when the host's BuffSystem says `target` belongs to `groupName`.
    // Defensive: `game.def('BuffSystem.cBuffDefinition')` may not exist in
    // some host builds or under tests.
    function targetGroupContains(groupName, target) {
        if (!groupName || !target) return false;
        try {
            if (typeof game === 'undefined' || !game || typeof game.def !== 'function') return false;
            var bs = game.def('BuffSystem.cBuffDefinition');
            if (!bs || !bs.targetGroups || typeof bs.targetGroups.groupContains !== 'function') return false;
            return !!bs.targetGroups.groupContains(groupName, target);
        } catch (e) { return false; }
    }

    // matches(buff, target, isWorkyard) — three-path filter mirroring
    // autoTSO/aBuffs.getBuffsForBuilding (user_auto.js:4567):
    //   1. direct target name match
    //   2. workyard catch-all: target is a workyard AND buff lists 'Workyard'
    //   3. host-defined target group match
    function matches(b, target, isWorkyard) {
        if (!b || !target) return false;
        var t = targets(b);
        for (var i = 0; i < t.length; i++) {
            if (t[i] === target) return true;
        }
        if (isWorkyard) {
            for (var j = 0; j < t.length; j++) {
                if (t[j] === 'Workyard') return true;
            }
        }
        var grp = targetGroup(b);
        if (grp && targetGroupContains(grp, target)) return true;
        return false;
    }

    // ----- public API ----------------------------------------------------

    // available() — every buff in inventory (includes non-building buffs).
    function available() {
        var src = ensureSnapshot();
        var out = [];
        for (var i = 0; i < src.length; i++) out.push(src[i]);
        return out;
    }

    // forBuilding(target, opts) — buffs that apply to a building of the
    // given name. opts.isWorkyard=true expands the match to include
    // generic Workyard-targeting buffs (productivity boosts, etc.). Only
    // building-buffs (BuffType===0) with amount>0 are returned. Host buff
    // objects come back untouched.
    function forBuilding(target, opts) {
        if (!target) return [];
        opts = opts || {};
        var isWorkyard = !!opts.isWorkyard;
        var src = ensureSnapshot();
        var out = [];
        for (var i = 0; i < src.length; i++) {
            var b = src[i];
            if (!b) continue;
            if (!isBuildingBuff(b)) continue;
            if (amount(b) <= 0) continue;
            if (matches(b, target, isWorkyard)) out.push(b);
        }
        return out;
    }

    // True when the buff is deposit-targeted (TSO TargetType === 1, per
    // autoTSO/user_auto.js:4617). Refill items live here. Building buffs
    // are TargetType === 0 and surface via `forBuilding`.
    function isDepositBuff(b) {
        var def = definition(b);
        if (!def || typeof def.GetTargetType !== 'function') return false;
        try { return def.GetTargetType() === 1; }
        catch (e) { return false; }
    }

    // forDeposit(depositName) — refill items applicable to a deposit of
    // the given name. Filter recipe:
    //   - definition's TargetType === 1 (deposit-targeted)
    //   - amount > 0
    //   - GetResourceName_string() === depositName (exact match)
    //
    // The live host's FillDeposit entries share GetType='FillDeposit' across
    // every resource and leave GetTargetDescription_string empty — only
    // GetResourceName_string identifies which deposit the buff applies to.
    // Strict equality intentionally: a tolerant fallback would risk picking
    // a Meat refill for a TitaniumOre request.
    function forDeposit(depositName) {
        if (!depositName) return [];
        var src = ensureSnapshot();
        var out = [];
        for (var i = 0; i < src.length; i++) {
            var b = src[i];
            if (!b) continue;
            if (!isDepositBuff(b)) continue;
            if (amount(b) <= 0) continue;
            if (resourceName(b) === depositName) out.push(b);
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
            // Paused (or otherwise non-actively-producing) buildings don't
            // benefit from buffs — the buff timer would tick down on a stalled
            // production. autoTSO uses the same intent at user_auto.js:5279.
            if (typeof building.IsProductionActive === 'function' &&
                !building.IsProductionActive()) return false;
        } catch (e) { return false; }

        var b = byName(buffName);
        if (!b || amount(b) <= 0) return false;

        var bn = (typeof building.GetBuildingName_string === 'function')
            ? building.GetBuildingName_string() : '';
        if (!bn) return false;
        return matches(b, bn, isWorkyardBuilding(building));
    }

    if (!S.core) S.core = {};
    S.core.buffs = {
        // listing
        available:   available,
        forBuilding: forBuilding,
        forDeposit:  forDeposit,
        byName:      byName,
        invalidate:  invalidate,

        // accessors
        name:          name,
        displayName:   displayName,
        description:   description,
        amount:        amount,
        uniqueId:      uniqueId,
        freshUniqueId: freshUniqueId,
        resourceName:  resourceName,
        targets:       targets,
        targetGroup:   targetGroup,

        // matchers / gate
        matches:     matches,
        canApply:    canApply
    };

}(Steward));
