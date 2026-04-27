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
    S.SpecialistType.General        = 'SpecialistGeneral';
    S.SpecialistType.Carrier        = 'SpecialistCarrier';
    S.SpecialistType.Admiral        = 'SpecialistAdmiral';
    S.SpecialistType.AdmiralCarrier = 'SpecialistAdmiralCarrier';
    S.SpecialistType.Explorer       = 'SpecialistExplorer';
    S.SpecialistType.Geologist      = 'SpecialistGeologist';

    S.SpecialistStatus.Idle        = 'StatusIdle';
    S.SpecialistStatus.Working     = 'StatusWorking';
    S.SpecialistStatus.Traveling   = 'StatusTraveling';
    S.SpecialistStatus.Returning   = 'StatusReturning';
    S.SpecialistStatus.Unavailable = 'StatusUnavailable';

    S.SkillModifier.SearchTime = 'ModifierSearchTime';
    S.SkillModifier.LootRolls  = 'ModifierLootRolls';
    S.SkillModifier.LootAmount = 'ModifierLootAmount';
    S.SkillModifier.Other      = 'ModifierOther';

    // Explorer tasks come in two families. Treasure searches (taskId=1)
    // include five "standard" durations + two skill-locked variants. Adventure
    // zone searches (taskId=2) are a separate family for finding adventure
    // zones (the activity that DROPS adventures, not adventure-zone-internal
    // explorer tasks). Source: tso_client/.../4-specialists.js:21-33.
    //
    // The previous shape merged 1,4 / 1,5 with the adventure family, which
    // was wrong: 1,4 (FindTreasureTravellingErudite) and 1,5
    // (FindTreasureBeanACollada) are skill-locked TREASURE searches.
    S.ExplorerTask.Short                 = 'TaskExplorerShort';                // 1,0
    S.ExplorerTask.Medium                = 'TaskExplorerMedium';               // 1,1
    S.ExplorerTask.Long                  = 'TaskExplorerLong';                 // 1,2
    S.ExplorerTask.EvenLonger            = 'TaskExplorerEvenLonger';           // 1,3
    S.ExplorerTask.TravellingErudite     = 'TaskExplorerTravellingErudite';    // 1,4 — skill 39
    S.ExplorerTask.BeanACollada          = 'TaskExplorerBeanACollada';         // 1,5 — skill 40
    S.ExplorerTask.Prolonged             = 'TaskExplorerProlonged';            // 1,6
    S.ExplorerTask.AdventureZoneShort    = 'TaskExplorerAdvZoneShort';         // 2,0
    S.ExplorerTask.AdventureZoneMedium   = 'TaskExplorerAdvZoneMedium';        // 2,1
    S.ExplorerTask.AdventureZoneLong     = 'TaskExplorerAdvZoneLong';          // 2,2
    S.ExplorerTask.AdventureZoneVeryLong = 'TaskExplorerAdvZoneVeryLong';      // 2,3

    S.GeologistTask.Search = 'TaskGeologistSearch';                 // raw 0

    // Map enum → { taskId, subTaskId } for the dispatch packet.
    //
    // The host's SendServerAction(95, taskId, 0, 0, dStartSpecialistTaskVO)
    // expects taskId to identify the *task family* and the dVO's subTaskID
    // to pick the variant. Live-spike confirmed working explorer tasks return
    // GetTask().GetType()={1,2} and GetSubType()={0..6}.
    //
    //   - Explorer treasure searches:        taskId=1
    //   - Explorer adventure-zone searches:  taskId=2
    //   - Geologist deposit search:          taskId=0
    //
    // autoTSO/user_auto.js:743-750 confirms: sendExplorer passes taskId
    // (via finalTask[0]); sendGeologist passes taskId=0 (literal).
    var EXPLORER_TASK_PACKET = {};
    EXPLORER_TASK_PACKET[S.ExplorerTask.Short]                 = { taskId: 1, subTaskId: 0 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.Medium]                = { taskId: 1, subTaskId: 1 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.Long]                  = { taskId: 1, subTaskId: 2 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.EvenLonger]            = { taskId: 1, subTaskId: 3 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.TravellingErudite]     = { taskId: 1, subTaskId: 4 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.BeanACollada]          = { taskId: 1, subTaskId: 5 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.Prolonged]             = { taskId: 1, subTaskId: 6 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.AdventureZoneShort]    = { taskId: 2, subTaskId: 0 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.AdventureZoneMedium]   = { taskId: 2, subTaskId: 1 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.AdventureZoneLong]     = { taskId: 2, subTaskId: 2 };
    EXPLORER_TASK_PACKET[S.ExplorerTask.AdventureZoneVeryLong] = { taskId: 2, subTaskId: 3 };

    // Inverse: (taskId, subTaskId) → ExplorerTask enum. Used by currentTask
    // to decode a busy explorer's GetTask().GetType()/.GetSubType() pair, and
    // by callers that read host settings (treasure-only context — pass 1 as
    // taskId).
    var RAW_TO_EXPLORER_TASK = {
        1: {
            0: S.ExplorerTask.Short,
            1: S.ExplorerTask.Medium,
            2: S.ExplorerTask.Long,
            3: S.ExplorerTask.EvenLonger,
            4: S.ExplorerTask.TravellingErudite,
            5: S.ExplorerTask.BeanACollada,
            6: S.ExplorerTask.Prolonged
        },
        2: {
            0: S.ExplorerTask.AdventureZoneShort,
            1: S.ExplorerTask.AdventureZoneMedium,
            2: S.ExplorerTask.AdventureZoneLong,
            3: S.ExplorerTask.AdventureZoneVeryLong
        }
    };

    var GEOLOGIST_TASK_PACKET = {};
    // Geologists: taskId=0, subTaskId is the deposit-type index supplied
    // by the caller (since one geologist enum represents many deposits).
    GEOLOGIST_TASK_PACKET[S.GeologistTask.Search] = { taskId: 0, subTaskId: 0 };

    // Specialist type taxonomy.
    //
    // The host's GetType() returns many integers — beyond {0=General,
    // 1=Explorer, 2=Geologist} there are specials like Marshal (18),
    // Courageous Explorer (32), Admiral, etc. The instance method
    // GetBaseType() partially normalizes (Courageous Explorer → 1) but not
    // for all variants (Marshal → 18, NOT 0).
    //
    // Canonical normalization: ask the *type definition* for its base type:
    //   game.def('Specialists::cSpecialist').GetSpecialistDescriptionForType(typeNum).getBaseType()
    //
    // Confirmed mechanism via tso_client/.../4-specialists.js:73-77 and
    // 8-shortcuts.js:228 (`armySPECIALIST_TYPE.IsGeneral(item.GetType())`).
    //
    // Carrier detection: a Carrier is a General whose specialist description
    // returns isTransportGeneral() === true. Confirmed via
    // autoTSO/user_auto.js:6688 (`a.GetSpecialistDescription().isTransportGeneral()`).

    var BASE_GENERAL   = 0;
    var BASE_EXPLORER  = 1;
    var BASE_GEOLOGIST = 2;

    var armySpecTypeEnum = null;            // cached host enum (Enums::SPECIALIST_TYPE)
    var cSpecialistClass = null;            // cached host class (Specialists::cSpecialist)

    function getArmySpecTypeEnum() {
        if (armySpecTypeEnum !== null) return armySpecTypeEnum;
        try {
            if (typeof swmmo !== 'undefined' && swmmo && typeof swmmo.getDefinitionByName === 'function') {
                armySpecTypeEnum = swmmo.getDefinitionByName('Enums::SPECIALIST_TYPE') || false;
            } else if (typeof game !== 'undefined' && game && typeof game.def === 'function') {
                armySpecTypeEnum = game.def('Enums::SPECIALIST_TYPE') || false;
            } else {
                armySpecTypeEnum = false;
            }
        } catch (e) { armySpecTypeEnum = false; }
        return armySpecTypeEnum || null;
    }

    function getCSpecialist() {
        if (cSpecialistClass !== null) return cSpecialistClass;
        try {
            if (typeof game !== 'undefined' && game && typeof game.def === 'function') {
                cSpecialistClass = game.def('Specialists::cSpecialist') || false;
            } else {
                cSpecialistClass = false;
            }
        } catch (e) { cSpecialistClass = false; }
        return cSpecialistClass || null;
    }

    function rawType(spec) {
        if (!spec) return null;
        try {
            if (typeof spec.GetType === 'function') return spec.GetType();
        } catch (e) { /* fall through */ }
        return null;
    }

    function specDescription(spec) {
        if (!spec) return null;
        try {
            if (typeof spec.GetSpecialistDescription === 'function') {
                return spec.GetSpecialistDescription();
            }
        } catch (e) { /* fall through */ }
        // Fallback: look up via the static class given the type id.
        try {
            var cls = getCSpecialist();
            var rt = rawType(spec);
            if (cls && rt !== null && typeof cls.GetSpecialistDescriptionForType === 'function') {
                return cls.GetSpecialistDescriptionForType(rt);
            }
        } catch (e2) { /* fall through */ }
        return null;
    }

    function baseTypeOf(typeNum) {
        if (typeof typeNum !== 'number') return null;
        // Fast path: the standard three already match their base.
        if (typeNum === BASE_GENERAL)   return BASE_GENERAL;
        if (typeNum === BASE_EXPLORER)  return BASE_EXPLORER;
        if (typeNum === BASE_GEOLOGIST) return BASE_GEOLOGIST;
        // Static lookup for everything else.
        try {
            var cls = getCSpecialist();
            if (cls && typeof cls.GetSpecialistDescriptionForType === 'function') {
                var def = cls.GetSpecialistDescriptionForType(typeNum);
                if (def && typeof def.getBaseType === 'function') return def.getBaseType();
            }
        } catch (e) { /* fall through */ }
        return null;
    }

    function isCarrierByDescription(spec) {
        var desc = specDescription(spec);
        if (!desc) return false;
        try {
            if (typeof desc.isTransportGeneral === 'function') return !!desc.isTransportGeneral();
        } catch (e) { /* fall through */ }
        return false;
    }

    // The host exposes two related predicates we rely on:
    //   IsGeneral(rt)            — base General family (type 0 and friends)
    //   IsGeneralOrAdmiral(rt)   — also includes Admiral types (18, 19, …)
    //
    // The Admiral class is TSO's expedition-only combat class. Like
    // Generals, it splits into two flavours via isTransportGeneral():
    //   - attacker (e.g. Marshal,            type 18)
    //   - transport (e.g. Expedition Supplier, type 19)
    //
    // Helpers:
    //   isInGeneralFamily(spec)  → true for plain Generals (and Carriers built atop them)
    //   isInAdmiralFamily(spec)  → true for Admirals (and AdmiralCarriers built atop them)
    //   isFighterOrTransport(spec) → either family — useful as the umbrella check.

    function isInGeneralFamily(spec) {
        var rt = rawType(spec);
        if (rt === null) return false;
        var enum_ = getArmySpecTypeEnum();
        if (enum_ && typeof enum_.IsGeneral === 'function') {
            try { return !!enum_.IsGeneral(rt); }
            catch (e) { /* fall through to base-type heuristic */ }
        }
        return baseTypeOf(rt) === BASE_GENERAL;
    }

    function isInAdmiralFamily(spec) {
        var rt = rawType(spec);
        if (rt === null) return false;
        // Admiral = "GeneralOrAdmiral" minus "General". Best signal we have
        // without a dedicated IsAdmiral predicate (which the host doesn't
        // expose under that name).
        var enum_ = getArmySpecTypeEnum();
        if (enum_ && typeof enum_.IsGeneralOrAdmiral === 'function') {
            try { if (!enum_.IsGeneralOrAdmiral(rt)) return false; }
            catch (e) { return false; }
        } else {
            return false;
        }
        return !isInGeneralFamily(spec);
    }

    function isFighterOrTransport(spec) {
        return isInGeneralFamily(spec) || isInAdmiralFamily(spec);
    }

    function canAttack(spec) {
        // Generals and Admirals attack; their carrier-flavour cousins don't.
        if (!isFighterOrTransport(spec)) return false;
        return !isCarrierByDescription(spec);
    }

    function troopCapacity(spec) {
        // No reliable instance-level getter found in the spike. The
        // description's getMaxTroopCount or similar may exist; try a few.
        if (!spec) return 0;
        var desc = specDescription(spec);
        if (desc) {
            try {
                if (typeof desc.getMaxTroopCount === 'function') return desc.getMaxTroopCount();
                if (typeof desc.GetMaxTroopCount === 'function') return desc.GetMaxTroopCount();
                if (typeof desc.maxTroops_int    === 'number')   return desc.maxTroops_int;
            } catch (e) { /* fall through */ }
        }
        return 0;
    }

    function classify(spec) {
        var rt = rawType(spec);
        if (rt === null) return null;

        var base = baseTypeOf(rt);
        if (base === BASE_EXPLORER)  return S.SpecialistType.Explorer;
        if (base === BASE_GEOLOGIST) return S.SpecialistType.Geologist;

        // Two combat-class families, each with attacker / carrier flavour.
        var transport = isCarrierByDescription(spec);
        if (isInGeneralFamily(spec)) {
            return transport ? S.SpecialistType.Carrier : S.SpecialistType.General;
        }
        if (isInAdmiralFamily(spec)) {
            return transport ? S.SpecialistType.AdmiralCarrier : S.SpecialistType.Admiral;
        }
        return null;
    }

    function isGeneral(spec)        { return classify(spec) === S.SpecialistType.General; }
    function isCarrier(spec)        { return classify(spec) === S.SpecialistType.Carrier; }
    function isAdmiral(spec)        { return classify(spec) === S.SpecialistType.Admiral; }
    function isAdmiralCarrier(spec) { return classify(spec) === S.SpecialistType.AdmiralCarrier; }
    function isExplorer(spec)       { return classify(spec) === S.SpecialistType.Explorer; }
    function isGeologist(spec)      { return classify(spec) === S.SpecialistType.Geologist; }

    function specName(spec) {
        if (!spec) return '';
        // ArgumentError #1063 (wrong number of arguments) varies by
        // specialist subtype: some take getName(), others getName(false).
        // Try both, in order of "no args" first since that's the more common
        // shape per the live spike output.
        if (!spec) return '';
        try { if (typeof spec.getName === 'function') return spec.getName() || ''; } catch (e) { /* try next */ }
        try { if (typeof spec.getName === 'function') return spec.getName(false) || ''; } catch (e) { /* try next */ }
        try { if (typeof spec.GetName === 'function') return spec.GetName() || ''; } catch (e) { /* try next */ }
        try { if (typeof spec.GetName === 'function') return spec.GetName(false) || ''; } catch (e) { /* fall through */ }
        return '';
    }

    function specTask(spec) {
        if (!spec) return null;
        try { return typeof spec.GetTask === 'function' ? spec.GetTask() : null; }
        catch (e) { return null; }
    }

    function hasTask(spec) {
        // Confirmed via the spike: GetTask() returns null for idle specialists
        // and a Flash task object (which JSON-stringifies to "{}") for busy
        // ones. Truthiness check is sufficient.
        var t = specTask(spec);
        return !!t;
    }

    // IsInUse() is the cross-type "busy" flag. Generals expose
    // GetGeneralState() with -1 = idle-traveling/working, 0 = idle, plus
    // values for various activity sub-states. We use IsInUse first because
    // the spike showed it returns true for working explorers (where
    // GetGeneralState returns -1 even when idle).
    function isInUse(spec) {
        if (!spec) return false;
        try { if (typeof spec.IsInUse === 'function') return !!spec.IsInUse(); }
        catch (e) { /* fall through */ }
        return false;
    }

    function status(spec) {
        if (!spec) return S.SpecialistStatus.Unavailable;
        // Idle: no task AND not in use.
        if (!hasTask(spec) && !isInUse(spec)) return S.SpecialistStatus.Idle;
        // The spike showed Working specs all collapse to one bucket from
        // these getters — GetTask().GetType / GetSubType give activity
        // shape but not Working/Traveling/Returning distinctions reliably.
        // Refine when we have a returning specialist to inspect.
        return S.SpecialistStatus.Working;
    }

    // Map ExplorerTask enum → host loca key. Sourced from
    // tso_client/.../4-specialists.js:21-33. The host's loca lookup gives
    // the in-game label (e.g. "Treasure Search Short" vs the ambiguous bare
    // "Short") with translation. Two families:
    //   - FindTreasure* — the seven treasure-search variants
    //   - FindAdventureZone* — the four adventure-zone-search variants
    var TASK_LOCA_KEYS = {};
    TASK_LOCA_KEYS[S.ExplorerTask.Short]                 = 'FindTreasureShort';
    TASK_LOCA_KEYS[S.ExplorerTask.Medium]                = 'FindTreasureMedium';
    TASK_LOCA_KEYS[S.ExplorerTask.Long]                  = 'FindTreasureLong';
    TASK_LOCA_KEYS[S.ExplorerTask.EvenLonger]            = 'FindTreasureEvenLonger';
    TASK_LOCA_KEYS[S.ExplorerTask.Prolonged]             = 'FindTreasureLongest';
    TASK_LOCA_KEYS[S.ExplorerTask.TravellingErudite]     = 'FindTreasureTravellingErudite';
    TASK_LOCA_KEYS[S.ExplorerTask.BeanACollada]          = 'FindTreasureBeanACollada';
    TASK_LOCA_KEYS[S.ExplorerTask.AdventureZoneShort]    = 'FindAdventureZoneShort';
    TASK_LOCA_KEYS[S.ExplorerTask.AdventureZoneMedium]   = 'FindAdventureZoneMedium';
    TASK_LOCA_KEYS[S.ExplorerTask.AdventureZoneLong]     = 'FindAdventureZoneLong';
    TASK_LOCA_KEYS[S.ExplorerTask.AdventureZoneVeryLong] = 'FindAdventureZoneVeryLong';

    // Localised in-game label for an explorer task. Falls back gracefully
    // when loca isn't ready or the enum is unknown.
    function taskLabel(taskEnum) {
        if (!taskEnum) return '';
        var key = TASK_LOCA_KEYS[taskEnum];
        if (!key) return String(taskEnum);
        try {
            if (typeof loca !== 'undefined' && loca && typeof loca.GetText === 'function') {
                var t = loca.GetText('LAB', key);
                if (t) return t;
            }
        } catch (e) { /* fall through */ }
        return key;
    }

    // Decode the explorer's *current* task by reading both
    // GetTask().GetType() (task family) and GetSubType() (variant) and
    // mapping the pair back through RAW_TO_EXPLORER_TASK. Returns the
    // ExplorerTask enum or null when idle / on an unknown task.
    function currentTask(spec) {
        var task = specTask(spec);
        if (!task) return null;
        try {
            var type = (typeof task.GetType === 'function') ? task.GetType() : null;
            var sub  = (typeof task.GetSubType === 'function') ? task.GetSubType() : null;
            if (typeof type !== 'number' || typeof sub !== 'number') return null;
            return rawToExplorerTask(type, sub);
        } catch (e) { /* ignore */ }
        return null;
    }

    function isAttacking(spec)   {
        // Both Generals and Admirals attack. We collapse the two for this query
        // since modules generally don't care about the family — only the role.
        var c = classify(spec);
        if (c !== S.SpecialistType.General && c !== S.SpecialistType.Admiral) return false;
        return status(spec) === S.SpecialistStatus.Working;
    }
    function isHauling(spec)     {
        var c = classify(spec);
        if (c !== S.SpecialistType.Carrier && c !== S.SpecialistType.AdmiralCarrier) return false;
        return status(spec) === S.SpecialistStatus.Working;
    }
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

    function generals(opts)         { return byType(S.SpecialistType.General,        opts); }
    function carriers(opts)         { return byType(S.SpecialistType.Carrier,        opts); }
    function admirals(opts)         { return byType(S.SpecialistType.Admiral,        opts); }
    function admiralCarriers(opts)  { return byType(S.SpecialistType.AdmiralCarrier, opts); }
    function explorers(opts)        { return byType(S.SpecialistType.Explorer,       opts); }
    function geologists(opts)       { return byType(S.SpecialistType.Geologist,      opts); }

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

    // (taskId, subTaskId) → ExplorerTask enum. Both args required: pass 1
    // when reading a treasure-only host setting (host's `explDefTask` /
    // `explDefTaskByType` store just the subTaskID, family is implicit).
    function rawToExplorerTask(taskId, subTaskId) {
        if (typeof taskId !== 'number' || typeof subTaskId !== 'number') return null;
        var byTask = RAW_TO_EXPLORER_TASK[taskId];
        if (!byTask) return null;
        return byTask[subTaskId] || null;
    }

    // True when `taskEnum` is a recognised ExplorerTask (treasure OR
    // adventure-zone). Used by the modules that accept user-configured
    // task overrides — both families are valid choices since an explorer
    // might be configured for adventure-zone searches based on skills.
    function knownTask(taskEnum) {
        return !!EXPLORER_TASK_PACKET[taskEnum];
    }

    function pickTask(explorer) {
        // Precedence (see docs/CORE_USAGE.md "Rule 5"):
        //   1. mainSettings.explDefTaskByType[<name>] — per-spec host override
        //   2. event-aware optimization (treasure events)
        //   3. mainSettings.explDefTask                — host's global default
        //   4. ExplorerTask.Short                      — hard-coded baseline
        var defaultTask = S.ExplorerTask.Short;
        if (!explorer) return defaultTask;

        // 1. Per-spec host override (host stores treasure-only — taskId=1).
        if (S.kernel.host) {
            var fromHostByName = rawToExplorerTask(1, S.kernel.host.explDefTaskByName(specName(explorer)));
            if (fromHostByName) return fromHostByName;
        }

        // 2. Event-aware optimization.
        try {
            var active = S.core.events.active();
            if (active.length) {
                var eventCode = null;
                for (var i = 0; i < active.length; i++) {
                    if (active[i].category === 'treasure' || (active[i].categories && active[i].categories.treasure)) {
                        eventCode = active[i].code; break;
                    }
                }
                if (eventCode) {
                    var values = S.core.events.treasureValues(eventCode);
                    if (values && values.length) {
                        // Apply level-dependent multiplier (Anniversary boost).
                        var levelMult = (typeof S.core.events.levelMultiplier === 'function')
                            ? S.core.events.levelMultiplier(eventCode) : 1;
                        // values[k] = expected items per task k. Pick max(values/hours).
                        // Approximate hours per task per autoTSO/docs/explorers.md.
                        // Skill-aware duration math is deferred — modules that
                        // need it should consult core.specialists.skills(spec)
                        // directly. The defaults below match the no-skill case.
                        var defaultHours = [1.2, 2.4, 4.8, 9.6, 14.4];
                        var bestIdx = 0;
                        var bestRate = -1;
                        for (var k = 0; k < values.length && k < defaultHours.length; k++) {
                            var rate = (values[k] * levelMult) / defaultHours[k];
                            if (rate > bestRate) { bestRate = rate; bestIdx = k; }
                        }
                        var taskByIdx = [
                            S.ExplorerTask.Short,
                            S.ExplorerTask.Medium,
                            S.ExplorerTask.Long,
                            S.ExplorerTask.EvenLonger,
                            S.ExplorerTask.Prolonged
                        ];
                        if (taskByIdx[bestIdx]) return taskByIdx[bestIdx];
                    }
                }
            }
        } catch (e) {
            S.kernel.warn('specialists', 'pickTask event eval threw:', e);
        }

        // 3. Host global default (treasure-only — taskId=1).
        if (S.kernel.host) {
            var fromHostGlobal = rawToExplorerTask(1, S.kernel.host.explDefTaskGlobal());
            if (fromHostGlobal) return fromHostGlobal;
        }

        // 4. Hard-coded baseline.
        return defaultTask;
    }

    function pickDeposits(geologist) {
        // Returns an ordered list of deposit type names the geologist should
        // prioritize. Precedence:
        //   1. mainSettings.geoDefTaskByType[<name>] — per-spec host override
        //   2. event-aware deposit modifiers
        //   3. mainSettings.geoDefTask              — host's global default
        //   4. []                                    — caller falls back to own config
        //
        // The host stores defaults as a single deposit-type index (not a list)
        // so when only the host default applies we return a one-element array.
        // Per-geologist skill weighting plugs in here once the P2 spike lands.
        var out = [];
        if (!geologist) return out;

        // 1. Per-spec host override (returns a single index → wrap as one-elem list).
        if (S.kernel.host) {
            var perName = S.kernel.host.geoDefTaskByName(specName(geologist));
            if (typeof perName === 'number') return ['' + perName];
        }

        // 2. Event-aware deposit modifiers.
        try {
            var active = S.core.events.active();
            for (var i = 0; i < active.length; i++) {
                var ev = active[i];
                var data = S.core.events.data && S.core.events.data.events[ev.code];
                if (!data || !data.depositModifier) continue;
                var keys = Object.keys(data.depositModifier);
                for (var k = 0; k < keys.length; k++) out.push(keys[k]);
            }
            if (out.length > 0) return out;
        } catch (e) {
            S.kernel.warn('specialists', 'pickDeposits event eval threw:', e);
        }

        // 3. Host global default.
        if (S.kernel.host) {
            var global = S.kernel.host.geoDefTaskGlobal();
            if (typeof global === 'number') return ['' + global];
        }

        return out;
    }

    // --- Dispatch (low-level passthrough to dispatch.js) ---
    //
    // Server packet: SendServerAction(95, taskId, 0, 0, dStartSpecialistTaskVO)
    //   - taskId    = "task category" int. For explorers and geologists the
    //                 host's user-config (mainSettings.explDefTask /
    //                 geoDefTask) stores this directly. 0 = treasure search
    //                 / deposit search; non-zero = adventure searches and
    //                 specials.
    //   - subTaskId = variant within the category. For explorers: short=0,
    //                 medium=1, long=2, evenLonger=3, prolonged=6. For
    //                 geologists: deposit-type index.
    //
    // Modules pass either Steward.{ExplorerTask,GeologistTask} enum values
    // (in which case we map to their raw subTaskId and assume taskId=0) or
    // explicit (taskId, subTaskId) integers.

    function send(spec, taskOrEnum, subTaskIdOpt, responder) {
        if (typeof taskOrEnum === 'string') {
            // Enum value — translate via the per-family packet map.
            var explPkt = EXPLORER_TASK_PACKET[taskOrEnum];
            if (explPkt) {
                return S.core.specialists.dispatch.send(spec, explPkt.taskId, explPkt.subTaskId, responder);
            }
            var geoPkt = GEOLOGIST_TASK_PACKET[taskOrEnum];
            if (geoPkt) {
                // For geologist enums, subTaskIdOpt overrides the default
                // subTaskId — that's how the caller specifies the deposit-
                // type index they want the geologist to search for.
                var subTaskId = (typeof subTaskIdOpt === 'number') ? subTaskIdOpt : geoPkt.subTaskId;
                return S.core.specialists.dispatch.send(spec, geoPkt.taskId, subTaskId, responder);
            }
            S.kernel.warn('specialists', 'send: unknown enum', taskOrEnum);
            return false;
        }
        if (typeof taskOrEnum === 'number') {
            // Caller passed taskId directly; subTaskId from the second arg.
            var sub = (typeof subTaskIdOpt === 'number') ? subTaskIdOpt : 0;
            return S.core.specialists.dispatch.send(spec, taskOrEnum, sub, responder);
        }
        S.kernel.warn('specialists', 'send: taskOrEnum must be Steward.{Explorer,Geologist}Task or a number');
        return false;
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
    S.core.specialists.admirals         = admirals;
    S.core.specialists.admiralCarriers  = admiralCarriers;
    S.core.specialists.explorers        = explorers;
    S.core.specialists.geologists       = geologists;

    S.core.specialists.classify         = classify;
    S.core.specialists.canAttack        = canAttack;
    S.core.specialists.troopCapacity    = troopCapacity;
    S.core.specialists.isGeneral        = isGeneral;
    S.core.specialists.isCarrier        = isCarrier;
    S.core.specialists.isAdmiral        = isAdmiral;
    S.core.specialists.isAdmiralCarrier = isAdmiralCarrier;
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
    S.core.specialists.currentTask      = currentTask;
    S.core.specialists.taskLabel        = taskLabel;
    S.core.specialists.knownTask        = knownTask;
    S.core.specialists.pickTask         = pickTask;
    S.core.specialists.pickDeposits     = pickDeposits;

    S.core.specialists.send             = send;
    S.core.specialists.recall           = recall;

    S.core.specialists.name             = specName;

}(Steward));
