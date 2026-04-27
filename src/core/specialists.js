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

    // Skill IDs the host uses for explorer task gating. Sourced from the
    // `req` arrays in tso_client/.../4-specialists.js:21-27 and the host's
    // skill check in createExplorerDropdown (line 311). Skill 39 unlocks
    // FindTreasureTravellingErudite (1,4); skill 40 unlocks
    // FindTreasureBeanACollada (1,5).
    if (!S.ExplorerSkill) S.ExplorerSkill = {};
    S.ExplorerSkill.TravellingErudite = 39;
    S.ExplorerSkill.BeanACollada      = 40;

    // Per-task capability descriptor — mirrors the host's `req` arrays so
    // the dashboard / pickTask filter mirrors what the host's dropdown
    // shows. [enum, needsErudite, needsBeanACollada, requiredPlayerLevel].
    // Source: tso_client/.../4-specialists.js:19-35.
    var TASK_REQUIREMENTS = [
        [S.ExplorerTask.Short,                 false, false,  8],
        [S.ExplorerTask.Medium,                false, false, 20],
        [S.ExplorerTask.Long,                  false, false, 32],
        [S.ExplorerTask.EvenLonger,            false, false, 40],
        [S.ExplorerTask.Prolonged,             false, false, 54],
        [S.ExplorerTask.TravellingErudite,     true,  false,  0],
        [S.ExplorerTask.BeanACollada,          false, true,   0],
        [S.ExplorerTask.AdventureZoneShort,    false, false, 26],
        [S.ExplorerTask.AdventureZoneMedium,   false, false, 36],
        [S.ExplorerTask.AdventureZoneLong,     false, false, 42],
        [S.ExplorerTask.AdventureZoneVeryLong, false, false, 56]
    ];

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

    // Read `spec.getSkillTree().getItems_vector()` into a {skillId: level}
    // map. Skill tree only — these are the "permanent" skills that gate
    // task availability (matches the host's own filter at
    // tso_client/.../4-specialists.js:188-191). Returns {} on any failure
    // (host APIs not ready, foreign spec type, etc.).
    function skillTreeMap(spec) {
        var out = {};
        if (!spec) return out;
        try {
            if (typeof spec.getSkillTree !== 'function') return out;
            var tree = spec.getSkillTree();
            if (!tree || typeof tree.getItems_vector !== 'function') return out;
            var v = tree.getItems_vector();
            var len = (typeof v.length === 'number') ? v.length : 0;
            for (var i = 0; i < len; i++) {
                var sk = v[i];
                if (!sk) continue;
                var id = (typeof sk.getId === 'function') ? sk.getId() : null;
                var lvl = (typeof sk.getLevel === 'function') ? sk.getLevel() : 0;
                if (typeof id === 'number') out[id] = lvl || 0;
            }
        } catch (e) { /* ignore */ }
        return out;
    }

    function hasSkill(spec, skillId) {
        var m = skillTreeMap(spec);
        return (m[skillId] || 0) > 0;
    }

    // Player level — used for the level-gated tasks. 0 fallback when the
    // host isn't ready.
    function playerLevel() {
        try {
            if (typeof game !== 'undefined' && game && game.player &&
                typeof game.player.GetPlayerLevel === 'function') {
                return game.player.GetPlayerLevel() || 0;
            }
        } catch (e) { /* ignore */ }
        return 0;
    }

    // List of ExplorerTask enums this explorer is eligible for, mirroring
    // the host's createExplorerDropdown filter exactly. A task qualifies if:
    //   - it requires Erudite and the explorer has Erudite, OR
    //   - it requires BeanACollada and the explorer has BeanACollada, OR
    //   - it has no skill requirement and the player's level meets the gate.
    function availableTasks(spec) {
        if (!spec) return [];
        var hasE = hasSkill(spec, S.ExplorerSkill.TravellingErudite);
        var hasB = hasSkill(spec, S.ExplorerSkill.BeanACollada);
        var lvl = playerLevel();
        var out = [];
        for (var i = 0; i < TASK_REQUIREMENTS.length; i++) {
            var r = TASK_REQUIREMENTS[i];
            var enumVal = r[0], needsE = r[1], needsB = r[2], reqLvl = r[3];
            if (needsE && hasE) { out.push(enumVal); continue; }
            if (needsB && hasB) { out.push(enumVal); continue; }
            if (!needsE && !needsB && lvl >= reqLvl) { out.push(enumVal); continue; }
        }
        return out;
    }

    // Walk the host's specialistTaskDefinitions_vector to find treasure
    // task data (duration + taskType_string for skill matching). Returns
    // an array of { enum, subTaskID, duration, taskType_string } in the
    // five-standard-treasure order. Skips the skill-locked variants
    // (4=Erudite, 5=BeanACollada) since the event-aware optimiser doesn't
    // include them in the comparison — autoTSO matches this exclusion at
    // user_auto.js:4439.
    function treasureTaskTable() {
        var out = [];
        try {
            if (typeof game === 'undefined' || !game || typeof game.def !== 'function') return out;
            var globalDef = game.def('global');
            if (!globalDef) return out;
            var family = globalDef.specialistTaskDefinitions_vector &&
                         globalDef.specialistTaskDefinitions_vector[1];
            if (!family) return out;
            var subs = family.subtasks_vector;
            if (!subs) return out;
            var len = (typeof subs.length === 'number') ? subs.length : 0;
            for (var i = 0; i < len; i++) {
                var t = subs[i];
                if (!t) continue;
                if (t.subTaskID === 4 || t.subTaskID === 5) continue;
                var enumVal = rawToExplorerTask(1, t.subTaskID);
                if (!enumVal) continue;
                out.push({
                    enumVal:          enumVal,
                    subTaskID:        t.subTaskID,
                    duration:         t.duration,
                    taskType_string:  t.taskType_string || ''
                });
            }
        } catch (e) {
            S.kernel.warn('specialists', 'treasureTaskTable threw:', e);
        }
        return out;
    }

    // Apply an explorer's skills to a task's (duration, lootMultiplier).
    // Mirrors autoTSO calculateDailyItems (user_auto.js:4441-4461). A skill
    // entry's level_vector[level-1] holds an array of skillDef effects;
    // each effect targets either ALL tasks (empty type_string) or a
    // specific 'FindTreasure<TaskType>' task. Modifiers we honour:
    //   - 'searchtime' → either replaces duration (value !== 0) or applies
    //     duration = duration * multiplier + adder
    //   - 'changeloottablerolls' → take MAX of multipliers
    function applySkills(task, allSkills) {
        var duration = task.duration;
        var lootMultiplier = 1;
        if (!allSkills) return { duration: duration, lootMultiplier: lootMultiplier };
        for (var i = 0; i < allSkills.length; i++) {
            var skill = allSkills[i];
            try {
                var lvl = (typeof skill.getLevel === 'function') ? skill.getLevel() - 1 : -1;
                if (lvl < 0) continue;
                var def = (typeof skill.getDefinition === 'function') ? skill.getDefinition() : null;
                if (!def || !def.level_vector || !def.level_vector[lvl]) continue;
                var effects = def.level_vector[lvl];
                var elen = (typeof effects.length === 'number') ? effects.length : 0;
                for (var e = 0; e < elen; e++) {
                    var eff = effects[e];
                    if (!eff) continue;
                    var typeStr = eff.type_string || '';
                    var matches = (typeStr.length === 0) ||
                                  (typeStr === ('FindTreasure' + task.taskType_string));
                    if (!matches) continue;
                    var modStr = (eff.modifier_string || '').toLowerCase();
                    if (modStr === 'searchtime') {
                        if (eff.value !== 0) duration = eff.value;
                        else                 duration = (duration * (eff.multiplier || 1)) + (eff.adder || 0);
                    } else if (modStr === 'changeloottablerolls') {
                        if ((eff.multiplier || 0) > lootMultiplier) lootMultiplier = eff.multiplier;
                    }
                }
            } catch (err) { /* skip this skill */ }
        }
        return { duration: duration, lootMultiplier: lootMultiplier };
    }

    // Concat skill tree + dynamic (equipment / buff) skills into one list,
    // matching autoTSO at user_auto.js:4443.
    function allSpecSkills(spec) {
        var out = [];
        if (!spec) return out;
        try {
            if (typeof spec.getSkillTree === 'function') {
                var tree = spec.getSkillTree();
                if (tree && typeof tree.getItems_vector === 'function') {
                    var v1 = tree.getItems_vector();
                    var l1 = (typeof v1.length === 'number') ? v1.length : 0;
                    for (var i = 0; i < l1; i++) if (v1[i]) out.push(v1[i]);
                }
            }
            var dyn = spec.skills;
            if (dyn && typeof dyn.getItems_vector === 'function') {
                var v2 = dyn.getItems_vector();
                var l2 = (typeof v2.length === 'number') ? v2.length : 0;
                for (var j = 0; j < l2; j++) if (v2[j]) out.push(v2[j]);
            }
        } catch (e) { /* ignore */ }
        return out;
    }

    // ---------------------------------------------------------------
    // biasFromTrait — score an explorer's trait-skill effects into
    // {treasure, adventure, deposit, other} buckets so callers can pick
    // the best dispatch family. Mirrors the algorithm documented in
    // docs/EXPLORER_TRAITS.md and exercised by docs/analysis/parse_explorers_dump.py.
    //
    // Per-effect rules:
    //   - Loot modifiers (changeloottablerolls / changelootcount /
    //     changelootchance): weight = max(adder, multiplier-1) * chance,
    //     positive only.
    //   - searchTime: weight = (1 - multiplier) * chance, signed.
    //     <1 multiplier = faster (bonus); >1 = slower (penalty).
    //     Captures Nora the Explorer's "treasure actively discouraged"
    //     signal (×1.5 searchTime on every treasure variant).
    //   - Other modifiers (modifierEffect, unlockTask, …): skipped.
    //
    // Family dispatch: type_string prefix → family. IntrepidLoot is
    // grouped with FindAdventureZone* per `wildDetermination`'s effect
    // list (resolved open question 5 in EXPLORER_TRAITS.md).
    //
    // Seasonal gating: an effect whose name_string lists ONLY event-
    // suffixed loot-table identifiers (no plain entry) only contributes
    // when one of its events is currently live. opts.activeEvents is
    // the Set of live event codes; pass null to treat every event as
    // live (used by the off-event vs on-event audit).
    //
    // opts.eventBoost: when > 0 AND any event is live, add this constant
    // to the treasure score. Implements the "no adventure during events"
    // rule purely additively — never mutates the host's trait/skill
    // objects. Wired off `templates_explorers.forceTreasureOnEvents`.
    // ---------------------------------------------------------------

    var LOOT_MODIFIERS = {
        changeloottablerolls: true,
        changelootcount:      true,
        changelootchance:     true
    };

    // Token for Lovely-trait private variants (`FindTreasure_Lovely_Short`,
    // `FindTreasure_Lovely_Prolonged_Easter`, …). The runtime gate is the
    // event suffix when one is present, otherwise the trait owner. See
    // EXPLORER_TRAITS.md "Trait-private drop tables".
    var LOVELY_TOKEN = '_Lovely';

    function familyForEffect(eff) {
        var typeStr = eff.type_string || '';
        var nameFirst = '';
        var ns = eff.name_string || '';
        if (ns) {
            var commaIdx = ns.indexOf(',');
            nameFirst = (commaIdx === -1 ? ns : ns.substring(0, commaIdx));
        }
        var tag = typeStr || nameFirst;
        if (tag.indexOf('FindTreasure') === 0)         return 'treasure';
        if (tag.indexOf('FindAdventureZone') === 0)    return 'adventure';
        if (tag.indexOf('FindAdventure_') === 0)       return 'adventure';
        if (tag.indexOf('IntrepidLoot') === 0)         return 'adventure';
        if (tag.indexOf('FindDeposit') === 0)          return 'deposit';
        return 'other';
    }

    // Classify one comma-separated name_string entry. Returns
    // 'plain' | 'lovely' | 'trait-private' | 'event:<code>' | 'other'.
    function classifyEntry(entry, typeTag) {
        if (!entry) return 'other';
        if (entry === typeTag) return 'plain';
        // Event suffix wins over the _Lovely token: a table like
        // 'FindTreasure_Lovely_Short_Easter' only exists when Easter is
        // live, so the runtime gate is the event. Vocabulary lives in
        // core/events.js (suffixToCode) so it stays in sync with the
        // event-data table.
        var eventCode = S.core.events.suffixToCode(entry);
        if (eventCode) return 'event:' + eventCode;
        if (entry.indexOf(LOVELY_TOKEN) > -1) return 'lovely';
        if (entry.indexOf('FindTreasure_') === 0)  return 'trait-private';
        if (entry.indexOf('FindAdventure_') === 0) return 'trait-private';
        if (entry === 'IntrepidLoot')              return 'trait-private';
        return 'other';
    }

    function classifyEffect(eff) {
        var typeTag = eff.type_string || '';
        var raw = eff.name_string || '';
        // Strip the host's truncation marker. We keep going on whatever
        // is visible; a hidden plain entry would only shift our
        // classification from event-gated to mixed (more permissive).
        if (raw.indexOf('…') > -1) raw = raw.split('…').join('');
        raw = raw.replace(/^\s+|\s+$/g, '').replace(/,$/, '');
        var entries = raw.length ? raw.split(',') : [];
        if (entries.length === 0) {
            return { mode: 'year-round', events: [] };
        }
        var hasPlain = false, hasLovely = false, hasPrivate = false;
        var events = {};
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i].replace(/^\s+|\s+$/g, '');
            if (!e) continue;
            var c = classifyEntry(e, typeTag);
            if      (c === 'plain')         hasPlain = true;
            else if (c === 'lovely')        hasLovely = true;
            else if (c === 'trait-private') hasPrivate = true;
            else if (c.indexOf('event:') === 0) events[c.substring(6)] = true;
        }
        var alwaysOn = hasPlain || hasLovely || hasPrivate;
        var eventList = [];
        for (var k in events) if (Object.prototype.hasOwnProperty.call(events, k)) eventList.push(k);
        var mode;
        if (alwaysOn && eventList.length) mode = 'mixed';
        else if (alwaysOn)                mode = 'year-round';
        else if (eventList.length)        mode = 'event-gated';
        else                              mode = 'unknown';
        return { mode: mode, events: eventList };
    }

    function biasFromTrait(spec, opts) {
        opts = opts || {};
        var activeEvents = opts.activeEvents;            // Set / object map / null
        var eventBoost   = opts.eventBoost || 0;
        var scores = { treasure: 0, adventure: 0, deposit: 0, other: 0 };
        if (!spec || !spec.skills || typeof spec.skills.getItems_vector !== 'function') {
            return scores;
        }
        // Walk the trait-skill collection (spec.skills); the universal
        // skill tree is excluded — biasFromTrait is about per-type traits,
        // not invested skill levels. Skip the universal premium buff.
        var traits = spec.skills.getItems_vector();
        var tlen = (typeof traits.length === 'number') ? traits.length : 0;
        for (var i = 0; i < tlen; i++) {
            var trait = traits[i];
            if (!trait) continue;
            var sid = -1;
            try { if (typeof trait.getId === 'function') sid = trait.getId(); }
            catch (e) { sid = -1; }
            if (sid === 301) continue;  // friendpremiumbuff1 — universal premium buff

            var lvl = -1;
            try { if (typeof trait.getLevel === 'function') lvl = trait.getLevel(); }
            catch (e) { lvl = -1; }
            if (lvl <= 0) continue;

            var def = null;
            try { if (typeof trait.getDefinition === 'function') def = trait.getDefinition(); }
            catch (e) { /* skip */ }
            if (!def || !def.level_vector || !def.level_vector[lvl - 1]) continue;
            var effects = def.level_vector[lvl - 1];
            var elen = (typeof effects.length === 'number') ? effects.length : 0;
            for (var e = 0; e < elen; e++) {
                var eff = effects[e];
                if (!eff) continue;
                var mod = (eff.modifier_string || '').toLowerCase();
                var chance = (typeof eff.chance === 'number' && eff.chance) ? eff.chance : 1;
                var weight = 0;
                if (LOOT_MODIFIERS[mod]) {
                    var loot = Math.max(eff.adder || 0, (eff.multiplier || 1) - 1) * chance;
                    if (loot <= 0) continue;
                    weight = loot;
                } else if (mod === 'searchtime') {
                    weight = (1 - (eff.multiplier || 1)) * chance;
                } else {
                    continue;
                }

                // Seasonal gating — event-gated effects only fire when
                // one of their events is in activeEvents. Pass
                // activeEvents=null (or 'ANY') to count every event as
                // live (audit / always-on score).
                var cls = classifyEffect(eff);
                if (cls.mode === 'event-gated' && activeEvents && activeEvents !== 'ANY') {
                    var matched = false;
                    for (var ec = 0; ec < cls.events.length; ec++) {
                        if (activeEvents[cls.events[ec]]) { matched = true; break; }
                    }
                    if (!matched) continue;
                }

                scores[familyForEffect(eff)] += weight;
            }
        }

        // "No adventure during events" boost — purely additive to OUR
        // scoring, no host mutation. Caller decides whether to enable
        // it via the templates_explorers.forceTreasureOnEvents setting.
        var hasEvent = (activeEvents === 'ANY') ||
                       (!!activeEvents && objectHasAnyKey(activeEvents));
        if (eventBoost > 0 && hasEvent) {
            scores.treasure += eventBoost;
        }

        return scores;
    }

    function objectHasAnyKey(obj) {
        if (!obj) return false;
        for (var k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) return true;
        }
        return false;
    }

    // Convenience: highest-scoring family from biasFromTrait, or null
    // when no family scores positive (caller should fall back to the
    // user default).
    function familyFromBias(spec, opts) {
        var s = biasFromTrait(spec, opts);
        var best = null, bestScore = 0;
        var keys = ['treasure', 'adventure', 'deposit', 'other'];
        for (var i = 0; i < keys.length; i++) {
            if (s[keys[i]] > bestScore) {
                best = keys[i];
                bestScore = s[keys[i]];
            }
        }
        return best;
    }

    // Best treasure-search variant for this explorer during a treasure-
    // event-active context. Computes items/hour using the live host task
    // durations + the explorer's skills + GetTimeBonus (general spec bonus).
    // Returns null when host data isn't reachable or the event has no
    // treasure value table.
    function bestTaskForEvent(spec, eventCode) {
        if (!spec || !eventCode) return null;
        var values = (S.core.events && S.core.events.treasureValues)
            ? S.core.events.treasureValues(eventCode) : [];
        if (!values || !values.length) return null;
        var levelMult = (S.core.events && typeof S.core.events.levelMultiplier === 'function')
            ? S.core.events.levelMultiplier(eventCode) : 1;

        var tasks = treasureTaskTable();
        if (!tasks.length) return null;

        var skillList = allSpecSkills(spec);
        var timeBonus = 1;
        try {
            var desc = (typeof spec.GetSpecialistDescription === 'function')
                ? spec.GetSpecialistDescription() : null;
            if (desc && typeof desc.GetTimeBonus === 'function') {
                var b = desc.GetTimeBonus();
                if (typeof b === 'number' && b > 0) timeBonus = b;
            }
        } catch (e) { /* ignore */ }

        var best = null;
        var bestRate = -1;
        for (var i = 0; i < tasks.length && i < values.length; i++) {
            var t = tasks[i];
            var applied = applySkills(t, skillList);
            var adjustedDuration = applied.duration / timeBonus;
            if (adjustedDuration <= 0) continue;
            var items = values[i] * applied.lootMultiplier * levelMult;
            var rate = items / adjustedDuration;
            if (rate > bestRate) { bestRate = rate; best = t.enumVal; }
        }
        return best;
    }

    // Build the "active treasure-event" context: { events: { code: true },
    // anyTreasureEvent: bool, treasureEventCode: <one code> }. Treasure
    // events are those in their `_Content` phase (items still dropping);
    // cooldown / shop-only events don't count.
    function activeEventContext() {
        var ctx = { events: {}, anyTreasureEvent: false, treasureEventCode: null };
        try {
            var active = S.core.events.active();
            for (var i = 0; i < active.length; i++) {
                var ev = active[i];
                var inTreasure = !!(ev.categories && ev.categories.treasure);
                if (!inTreasure) continue;
                ctx.events[ev.code] = true;
                if (!ctx.treasureEventCode) ctx.treasureEventCode = ev.code;
                ctx.anyTreasureEvent = true;
            }
        } catch (e) { /* swallow — context just stays empty */ }
        return ctx;
    }

    // Read the templates_explorers.forceTreasureOnEvents setting. When
    // true (the default), an active treasure event tells biasFromTrait
    // to bump the treasure score by EVENT_TREASURE_BOOST so adventure-
    // biased explorers (Royal, Love Struck, Keener, Nora) join the
    // treasure dispatch instead of staying on adventures.
    function forceTreasureOnEventsEnabled() {
        try {
            var s = S.kernel.settings.read('templates_explorers') || {};
            // Default ON when the setting hasn't been written yet.
            return s.forceTreasureOnEvents !== false;
        } catch (e) { return true; }
    }

    var EVENT_TREASURE_BOOST = 1000;  // > any plausible adventure score (~4)

    // Pick the best subtask within the adventure family. VeryLong is
    // the longest available variant — "rule of thumb: longer is better"
    // off-event (every adventure trait we've audited boosts every
    // FindAdventureZone* variant equally). Per-explorer refinements
    // (e.g. Nora's `+1` on Long/VeryLong specifically) plug in here
    // when worth the complexity.
    function pickAdventureSubtask(/* explorer */) {
        return S.ExplorerTask.AdventureZoneVeryLong;
    }

    function pickTask(explorer) {
        // Precedence (see docs/CORE_USAGE.md "Rule 5"):
        //   1. mainSettings.explDefTaskByType[<name>] — per-type host override.
        //   2. Trait-aware family selection via biasFromTrait, then:
        //        - treasure family + active treasure event → bestTaskForEvent
        //          (skill-aware items/hour optimisation)
        //        - treasure family off-event → skill-locked Erudite/BeanACollada
        //          if present, otherwise the longest available variant
        //          (host global default if set, else Prolonged baseline).
        //        - adventure family → longest available adventure variant.
        //   3. Host global default — treasure-only.
        //   4. ExplorerTask.Prolonged — longest-available baseline (per
        //      "prefer longer for off-event" rule of thumb in
        //      docs/EXPLORER_TRAITS.md).
        var baseline = S.ExplorerTask.Prolonged;
        if (!explorer) return baseline;

        // 1. Per-spec host override (host stores treasure-only — taskId=1).
        if (S.kernel.host) {
            var fromHostByName = rawToExplorerTask(1, S.kernel.host.explDefTaskByName(specName(explorer)));
            if (fromHostByName) return fromHostByName;
        }

        // 2. Trait-aware selection. Build the active-event context once
        //    so we can pass it both to biasFromTrait (for the boost) and
        //    to bestTaskForEvent (for the items/hour pick).
        var ctx = activeEventContext();
        var boost = (ctx.anyTreasureEvent && forceTreasureOnEventsEnabled())
            ? EVENT_TREASURE_BOOST : 0;
        var family = familyFromBias(explorer, {
            activeEvents: ctx.events,
            eventBoost:   boost
        });

        if (family === 'adventure') {
            // No event override is in play (otherwise the boost would
            // have flipped this to 'treasure'); pick the longest
            // adventure variant.
            return pickAdventureSubtask(explorer);
        }

        // Treasure family (or null fallthrough).
        if (ctx.anyTreasureEvent) {
            try {
                var bestForEvent = bestTaskForEvent(explorer, ctx.treasureEventCode);
                if (bestForEvent) return bestForEvent;
            } catch (e) {
                S.kernel.warn('specialists', 'pickTask event eval threw:', e);
            }
        }

        // Off-event treasure: skill-locked variants are strict upgrades
        // for explorers who qualify (Erudite gates 1,4 — beanACollada 1,5).
        try {
            if (hasSkill(explorer, S.ExplorerSkill.TravellingErudite)) {
                return S.ExplorerTask.TravellingErudite;
            }
            if (hasSkill(explorer, S.ExplorerSkill.BeanACollada)) {
                return S.ExplorerTask.BeanACollada;
            }
        } catch (e) { /* ignore */ }

        // 3. Host global default (treasure-only).
        if (S.kernel.host) {
            var fromHostGlobal = rawToExplorerTask(1, S.kernel.host.explDefTaskGlobal());
            if (fromHostGlobal) return fromHostGlobal;
        }

        // 4. Longest-available baseline.
        return baseline;
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
    S.core.specialists.skillTreeMap     = skillTreeMap;
    S.core.specialists.hasSkill         = hasSkill;
    S.core.specialists.currentTask      = currentTask;
    S.core.specialists.taskLabel        = taskLabel;
    S.core.specialists.knownTask        = knownTask;
    S.core.specialists.availableTasks   = availableTasks;
    S.core.specialists.bestTaskForEvent = bestTaskForEvent;
    S.core.specialists.pickTask         = pickTask;
    S.core.specialists.biasFromTrait    = biasFromTrait;
    S.core.specialists.familyFromBias   = familyFromBias;
    S.core.specialists.pickDeposits     = pickDeposits;

    S.core.specialists.send             = send;
    S.core.specialists.recall           = recall;

    S.core.specialists.name             = specName;

}(Steward));
