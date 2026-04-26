/*
 * Specialist library.
 *
 * Steward classifies generals vs carriers itself — the host engine collapses
 * them to raw type 0 and a Carrier "looks like" a General until you check
 * whether it can attack. The classify() implementation is provisional:
 * capability-flag first, capacity-threshold (>330) fallback. P2 SPIKE: this
 * needs validation against the live client; document the chosen mechanism in
 * docs/CORE_USAGE.md once confirmed.
 *
 * Modules consult these helpers and never compare against bare strings —
 * always use Steward.SpecialistType.* / Steward.SpecialistStatus.* enums.
 */

(function (S) {

    // --- Enums populated here so they're available the moment this file runs.
    S.SpecialistType.General   = 'SpecialistGeneral';
    S.SpecialistType.Carrier   = 'SpecialistCarrier';
    S.SpecialistType.Explorer  = 'SpecialistExplorer';
    S.SpecialistType.Geologist = 'SpecialistGeologist';

    S.SpecialistStatus.Idle        = 'StatusIdle';
    S.SpecialistStatus.Working     = 'StatusWorking';
    S.SpecialistStatus.Traveling   = 'StatusTraveling';
    S.SpecialistStatus.Returning   = 'StatusReturning';
    S.SpecialistStatus.Unavailable = 'StatusUnavailable';

    S.SkillModifier.SearchTime = 'ModifierSearchTime';
    S.SkillModifier.LootRolls  = 'ModifierLootRolls';
    S.SkillModifier.LootAmount = 'ModifierLootAmount';
    S.SkillModifier.Other      = 'ModifierOther';

    S.ExplorerTask.Short              = 'TaskExplorerShort';        // raw subTaskID 0
    S.ExplorerTask.Medium             = 'TaskExplorerMedium';       // raw 1
    S.ExplorerTask.Long               = 'TaskExplorerLong';         // raw 2
    S.ExplorerTask.EvenLonger         = 'TaskExplorerEvenLonger';   // raw 3
    S.ExplorerTask.AdventureShort     = 'TaskExplorerAdvShort';     // raw 4
    S.ExplorerTask.AdventureLong      = 'TaskExplorerAdvLong';      // raw 5
    S.ExplorerTask.Prolonged          = 'TaskExplorerProlonged';    // raw 6

    S.GeologistTask.Search = 'TaskGeologistSearch';                 // raw 0

    // Map enum → raw integer the server expects.
    var EXPLORER_TASK_RAW = {};
    EXPLORER_TASK_RAW[S.ExplorerTask.Short]          = 0;
    EXPLORER_TASK_RAW[S.ExplorerTask.Medium]         = 1;
    EXPLORER_TASK_RAW[S.ExplorerTask.Long]           = 2;
    EXPLORER_TASK_RAW[S.ExplorerTask.EvenLonger]     = 3;
    EXPLORER_TASK_RAW[S.ExplorerTask.AdventureShort] = 4;
    EXPLORER_TASK_RAW[S.ExplorerTask.AdventureLong]  = 5;
    EXPLORER_TASK_RAW[S.ExplorerTask.Prolonged]      = 6;

    var GEOLOGIST_TASK_RAW = {};
    GEOLOGIST_TASK_RAW[S.GeologistTask.Search] = 0;

    // Raw host SPECIALIST_TYPE constants — used only for first-pass dispatch.
    var RAW_GENERAL_OR_CARRIER = 0;
    var RAW_EXPLORER           = 1;
    var RAW_GEOLOGIST          = 2;
    var GENERAL_CAPACITY_CAP   = 330;     // >330 implies Carrier (P2-spike)

    function rawType(spec) {
        if (!spec) return null;
        try {
            if (typeof spec.GetType === 'function') return spec.GetType();
        } catch (e) { /* fall through */ }
        return null;
    }

    function troopCapacity(spec) {
        if (!spec) return 0;
        try {
            if (typeof spec.GetMaxTroops === 'function')   return spec.GetMaxTroops();
            if (typeof spec.getMaxTroops === 'function')   return spec.getMaxTroops();
            if (typeof spec.GetTroopLimit === 'function')  return spec.GetTroopLimit();
        } catch (e) { /* fall through */ }
        return 0;
    }

    function canAttack(spec) {
        if (!spec) return false;
        // Try a capability flag first; the field name is uncertain (P2-spike).
        try {
            if (typeof spec.canAttack === 'boolean')     return spec.canAttack;
            if (typeof spec.mCanAttack === 'boolean')    return spec.mCanAttack;
            if (typeof spec.GetCanAttack === 'function') return !!spec.GetCanAttack();
        } catch (e) { /* fall through */ }
        // Capacity-threshold fallback: a general is capped at 330 troops, a
        // carrier exceeds that. If we can read capacity, use it; otherwise
        // assume "yes, attacker" as the conservative default.
        var cap = troopCapacity(spec);
        if (cap > 0) return cap <= GENERAL_CAPACITY_CAP;
        return true;
    }

    function classify(spec) {
        var rt = rawType(spec);
        if (rt === RAW_EXPLORER)  return S.SpecialistType.Explorer;
        if (rt === RAW_GEOLOGIST) return S.SpecialistType.Geologist;
        if (rt === RAW_GENERAL_OR_CARRIER) {
            return canAttack(spec) ? S.SpecialistType.General : S.SpecialistType.Carrier;
        }
        return null;
    }

    function isGeneral(spec)   { return classify(spec) === S.SpecialistType.General; }
    function isCarrier(spec)   { return classify(spec) === S.SpecialistType.Carrier; }
    function isExplorer(spec)  { return classify(spec) === S.SpecialistType.Explorer; }
    function isGeologist(spec) { return classify(spec) === S.SpecialistType.Geologist; }

    function specName(spec) {
        if (!spec) return '';
        try {
            if (typeof spec.getName === 'function') return spec.getName(false) || '';
            if (typeof spec.GetName === 'function') return spec.GetName() || '';
        } catch (e) { return ''; }
        return '';
    }

    function specTask(spec) {
        if (!spec) return null;
        try { return typeof spec.GetTask === 'function' ? spec.GetTask() : null; }
        catch (e) { return null; }
    }

    function hasTask(spec) {
        var t = specTask(spec);
        if (!t) return false;
        try {
            // Most task objects expose a sub-type / type accessor; presence
            // implies the specialist is busy.
            if (typeof t.GetSubType === 'function')  { t.GetSubType(); return true; }
            if (typeof t.GetType    === 'function')  { t.GetType();    return true; }
        } catch (e) { /* fall through */ }
        return !!t;
    }

    function status(spec) {
        if (!spec) return S.SpecialistStatus.Unavailable;
        if (!hasTask(spec)) return S.SpecialistStatus.Idle;
        // We don't yet have a clean way to distinguish Working vs Traveling
        // vs Returning from the host — collapse all "busy" states to Working
        // until the spike confirms the right field. (P2-spike.)
        return S.SpecialistStatus.Working;
    }

    function isAttacking(spec)   { return isGeneral(spec)   && status(spec) === S.SpecialistStatus.Working; }
    function isHauling(spec)     { return isCarrier(spec)   && status(spec) === S.SpecialistStatus.Working; }
    function isExploring(spec)   { return isExplorer(spec)  && status(spec) === S.SpecialistStatus.Working; }
    function isProspecting(spec) { return isGeologist(spec) && status(spec) === S.SpecialistStatus.Working; }

    function readVector(zone) {
        var out = [];
        if (!zone) return out;
        try {
            if (typeof zone.GetSpecialists_vector === 'function') {
                var v = zone.GetSpecialists_vector();
                if (v) {
                    var len = (typeof v.length === 'number') ? v.length : 0;
                    for (var i = 0; i < len; i++) if (v[i]) out.push(v[i]);
                }
            }
        } catch (e) {
            S.kernel.warn('specialists', 'readVector threw:', e);
        }
        return out;
    }

    function all(opts) {
        opts = opts || {};
        var zone = opts.zone || S.core.zone.current();
        return readVector(zone);
    }

    function byType(type, opts) {
        var src = all(opts);
        var out = [];
        for (var i = 0; i < src.length; i++) {
            if (classify(src[i]) === type) out.push(src[i]);
        }
        return out;
    }

    function byName(targetName, opts) {
        var src = all(opts);
        for (var i = 0; i < src.length; i++) {
            if (specName(src[i]) === targetName) return src[i];
        }
        return null;
    }

    function generals(opts)   { return byType(S.SpecialistType.General,   opts); }
    function carriers(opts)   { return byType(S.SpecialistType.Carrier,   opts); }
    function explorers(opts)  { return byType(S.SpecialistType.Explorer,  opts); }
    function geologists(opts) { return byType(S.SpecialistType.Geologist, opts); }

    function available(type, opts) {
        var src = byType(type, opts);
        var out = [];
        for (var i = 0; i < src.length; i++) {
            if (status(src[i]) === S.SpecialistStatus.Idle) out.push(src[i]);
        }
        return out;
    }

    function busy(type, opts) {
        var src = byType(type, opts);
        var out = [];
        for (var i = 0; i < src.length; i++) {
            if (status(src[i]) !== S.SpecialistStatus.Idle) out.push(src[i]);
        }
        return out;
    }

    function hasArmy(spec) {
        if (!spec) return false;
        try {
            if (typeof spec.GetArmy === 'function') {
                var a = spec.GetArmy();
                return !!(a && typeof a.HasUnits === 'function' && a.HasUnits());
            }
        } catch (e) { /* fall through */ }
        return false;
    }

    function hasExpertTroops(spec) {
        if (!hasArmy(spec)) return false;
        try {
            var a = spec.GetArmy();
            if (!a || typeof a.GetUnits_vector !== 'function') return false;
            var units = a.GetUnits_vector();
            var len = (typeof units.length === 'number') ? units.length : 0;
            for (var i = 0; i < len; i++) {
                var u = units[i];
                if (u && typeof u.GetIsElite === 'function' && u.GetIsElite()) return true;
            }
        } catch (e) { /* fall through */ }
        return false;
    }

    // --- Skills (normalized) ---

    function modifierEnum(rawString) {
        if (!rawString || typeof rawString !== 'string') return S.SkillModifier.Other;
        var s = rawString.toLowerCase();
        if (s === 'searchtime')           return S.SkillModifier.SearchTime;
        if (s === 'changeloottablerolls') return S.SkillModifier.LootRolls;
        if (s === 'lootamount')           return S.SkillModifier.LootAmount;
        return S.SkillModifier.Other;
    }

    function skills(spec) {
        var out = [];
        if (!spec) return out;
        try {
            var v = (typeof spec.GetSkills_vector === 'function') ? spec.GetSkills_vector()
                  : spec.mSkills_vector || null;
            if (!v) return out;
            var len = (typeof v.length === 'number') ? v.length : 0;
            for (var i = 0; i < len; i++) {
                var sk = v[i];
                if (!sk) continue;
                var def = (typeof sk.GetDefinition === 'function') ? sk.GetDefinition() : sk;
                if (!def) continue;
                out.push({
                    modifier:   modifierEnum(def.modifier_string || ''),
                    raw:        def.modifier_string || '',
                    multiplier: typeof def.multiplier === 'number' ? def.multiplier : 1,
                    adder:      typeof def.adder === 'number' ? def.adder : 0,
                    value:      typeof def.value === 'number' ? def.value : 0
                });
            }
        } catch (e) {
            S.kernel.warn('specialists', 'skills() threw:', e);
        }
        return out;
    }

    // --- Recommendations ---

    function pickTask(explorer) {
        // Default policy: pick the explorer task that maximizes items/hour.
        // When no event data is available, fall back to ExplorerTask.Short
        // (highest items/hour in the no-event baseline per autoTSO analysis).
        // Note: explorer-specific skills are honored once the P2 spike lands;
        // signature accepts the explorer now so call sites are stable.
        var defaultTask = S.ExplorerTask.Short;
        if (!explorer) return defaultTask;
        try {
            var active = S.core.events.active();
            if (!active.length) return defaultTask;
            // Prefer the first treasure-category active event.
            var eventCode = null;
            for (var i = 0; i < active.length; i++) {
                if (active[i].category === 'treasure') { eventCode = active[i].code; break; }
            }
            if (!eventCode) return defaultTask;
            var values = S.core.events.treasureValues(eventCode);
            if (!values || !values.length) return defaultTask;
            // values[k] = expected items per task k. Pick max(values[k] / duration[k]).
            // Without live duration data we approximate with autoTSO's defaults
            // (Short=1.2, Medium=2.4, Long=4.8, EvenLonger=9.6, Prolonged=14.4 hours).
            var defaultHours = [1.2, 2.4, 4.8, 9.6, 14.4];
            var bestIdx = 0;
            var bestRate = -1;
            for (var k = 0; k < values.length && k < defaultHours.length; k++) {
                var rate = values[k] / defaultHours[k];
                if (rate > bestRate) { bestRate = rate; bestIdx = k; }
            }
            var taskByIdx = [
                S.ExplorerTask.Short,
                S.ExplorerTask.Medium,
                S.ExplorerTask.Long,
                S.ExplorerTask.EvenLonger,
                S.ExplorerTask.Prolonged
            ];
            return taskByIdx[bestIdx] || defaultTask;
        } catch (e) {
            S.kernel.warn('specialists', 'pickTask threw:', e);
            return defaultTask;
        }
    }

    function pickDeposits(geologist) {
        // Returns an ordered list of deposit type names the geologist should
        // prioritize. With no event data, returns []; modules should fall
        // back to their own configured defaults. Per-geologist skills feed
        // into ranking once the P2 spike lands.
        var out = [];
        if (!geologist) return out;
        try {
            var active = S.core.events.active();
            for (var i = 0; i < active.length; i++) {
                var ev = active[i];
                var data = S.core.events.data && S.core.events.data.events[ev.code];
                if (!data || !data.depositModifier) continue;
                var keys = Object.keys(data.depositModifier);
                for (var k = 0; k < keys.length; k++) out.push(keys[k]);
            }
        } catch (e) {
            S.kernel.warn('specialists', 'pickDeposits threw:', e);
        }
        return out;
    }

    // --- Dispatch (low-level passthrough to dispatch.js) ---

    function send(spec, taskType, params, responder) {
        var raw = taskType;
        if (typeof EXPLORER_TASK_RAW[taskType] !== 'undefined') raw = EXPLORER_TASK_RAW[taskType];
        else if (typeof GEOLOGIST_TASK_RAW[taskType] !== 'undefined') raw = GEOLOGIST_TASK_RAW[taskType];
        return S.core.specialists.dispatch.send(spec, raw, params, responder);
    }

    function recall(spec, responder) {
        return S.core.specialists.dispatch.recall(spec, responder);
    }

    // --- Public surface ---

    S.core.specialists.all              = all;
    S.core.specialists.byType           = byType;
    S.core.specialists.byName           = byName;
    S.core.specialists.generals         = generals;
    S.core.specialists.carriers         = carriers;
    S.core.specialists.explorers        = explorers;
    S.core.specialists.geologists       = geologists;

    S.core.specialists.classify         = classify;
    S.core.specialists.canAttack        = canAttack;
    S.core.specialists.troopCapacity    = troopCapacity;
    S.core.specialists.isGeneral        = isGeneral;
    S.core.specialists.isCarrier        = isCarrier;
    S.core.specialists.isExplorer       = isExplorer;
    S.core.specialists.isGeologist      = isGeologist;
    S.core.specialists.hasArmy          = hasArmy;
    S.core.specialists.hasExpertTroops  = hasExpertTroops;

    S.core.specialists.status           = status;
    S.core.specialists.isAttacking      = isAttacking;
    S.core.specialists.isHauling        = isHauling;
    S.core.specialists.isExploring      = isExploring;
    S.core.specialists.isProspecting    = isProspecting;
    S.core.specialists.available        = available;
    S.core.specialists.busy             = busy;

    S.core.specialists.skills           = skills;
    S.core.specialists.pickTask         = pickTask;
    S.core.specialists.pickDeposits     = pickDeposits;

    S.core.specialists.send             = send;
    S.core.specialists.recall           = recall;

    S.core.specialists.name             = specName;

}(Steward));
