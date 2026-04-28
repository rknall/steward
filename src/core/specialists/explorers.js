/*
 * Explorer-specific helpers.
 *
 * Companion to `core/specialists.js` for behaviour that only applies to
 * the explorer family. Mirrors the layout of `core/specialists/geologists.js`.
 *
 * What lives here:
 *   - treasureTaskTable / applySkills / allSpecSkills — task durations +
 *     skill-aware items/hour scoring used by bestTaskForEvent
 *   - biasFromTrait + classifyEffect / classifyEntry / familyForEffect —
 *     trait-skill scoring documented in docs/traits/EXPLORER.md
 *   - familyFromBias / pickAdventureSubtask / bestTaskForEvent /
 *     activeEventContext / forceTreasureOnEventsEnabled / userDefaultTask
 *   - pickTask — the explorer-routing entry point (precedence chain
 *     described inline)
 *   - taskFamilyOf(taskEnum) — explorer enum → 'treasure' | 'adventure'
 *
 * What stays in `core/specialists.js`:
 *   - generic listing / classification / status (explorers() listing
 *     sugar, isExplorer(), isExploring(), currentTask())
 *   - EXPLORER_TASK_PACKET + RAW_TO_EXPLORER_TASK + rawToExplorerTask —
 *     dispatch-level enum↔packet mappings consumed by the unified send().
 *     rawToExplorerTask is also exposed on the public namespace so
 *     this file can call it.
 */

(function (S) {

    if (!S.core.specialists) S.core.specialists = {};

    var LOOT_MODIFIERS = {
        changeloottablerolls: true,
        changelootcount:      true,
        changelootchance:     true
    };

    // Token for Lovely-trait private variants (`FindTreasure_Lovely_Short`,
    // `FindTreasure_Lovely_Prolonged_Easter`, …). The runtime gate is the
    // event suffix when one is present, otherwise the trait owner. See
    // docs/traits/EXPLORER.md "Trait-private drop tables".
    var LOVELY_TOKEN = '_Lovely';

    var EVENT_TREASURE_BOOST = 1000;  // > any plausible adventure score (~4)

    // Build the live treasure-task table. taskId=1 family. Skips
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
                var enumVal = S.core.specialists.rawToExplorerTask(1, t.subTaskID);
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
    // docs/traits/EXPLORER.md and exercised by docs/analysis/parse-specialists-dump.js.
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
    // list (resolved open question 5 in docs/traits/EXPLORER.md).
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
    // objects. Wired off `explorers.forceTreasureOnEvents`.
    // ---------------------------------------------------------------

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
        // it via the explorers.forceTreasureOnEvents setting.
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

    // Read the explorers.forceTreasureOnEvents setting. When
    // true (the default), an active treasure event tells biasFromTrait
    // to bump the treasure score by EVENT_TREASURE_BOOST so adventure-
    // biased explorers (Royal, Love Struck, Keener, Nora) join the
    // treasure dispatch instead of staying on adventures.
    function forceTreasureOnEventsEnabled() {
        try {
            var s = S.kernel.settings.read('explorers') || {};
            // Default ON when the setting hasn't been written yet.
            return s.forceTreasureOnEvents !== false;
        } catch (e) { return true; }
    }

    // Read the explorers.defaultTask setting — the user's
    // chosen fallback for vanilla explorers and inactive-trait cases
    // (off-event Fluffy Butte). Returns the ExplorerTask enum value or
    // null if unset.
    function userDefaultTask() {
        try {
            var s = S.kernel.settings.read('explorers') || {};
            if (typeof s.defaultTask === 'string' && s.defaultTask) {
                return s.defaultTask;
            }
        } catch (e) { /* fall through */ }
        return null;
    }

    // Pick the best subtask within the adventure family. VeryLong is
    // the longest available variant — "rule of thumb: longer is better"
    // off-event (every adventure trait we've audited boosts every
    // FindAdventureZone* variant equally). Per-explorer refinements
    // (e.g. Nora's `+1` on Long/VeryLong specifically) plug in here
    // when worth the complexity.
    function pickAdventureSubtask(/* explorer */) {
        return S.ExplorerTask.AdventureZoneVeryLong;
    }

    // Map an ExplorerTask enum value to its family ('treasure' /
    // 'adventure'). The enum value strings encode the family directly
    // ('TaskExplorerAdvZone…' = adventure), so this is a pure string
    // check — no dependency on the EXPLORER_TASK_PACKET table.
    function taskFamilyOf(taskEnum) {
        if (typeof taskEnum !== 'string') return null;
        if (taskEnum.indexOf('AdvZone') !== -1) return 'adventure';
        if (taskEnum.indexOf('TaskExplorer') === 0) return 'treasure';
        return null;
    }

    function pickTask(explorer) {
        // Precedence — algorithm wins over host global default for any
        // trait-bearing explorer. Host global only applies to vanilla
        // explorers (no per-type trait, biasFromTrait returns null).
        //
        //   1. mainSettings.explDefTaskByType[<name>] — per-type host
        //      override (user explicitly chose, always respected).
        //   2. Trait-aware family selection via biasFromTrait:
        //        - adventure family → AdventureZoneVeryLong (longest)
        //        - treasure family + treasure-event live → bestTaskForEvent
        //          (skill-aware items/hour optimisation)
        //        - treasure family off-event → Erudite/BeanACollada
        //          when learned, else Prolonged (longest treasure)
        //   3. Vanilla / null-family fallback chain:
        //        - mainSettings.explDefTask — host's global default
        //        - ExplorerTask.Prolonged — longest-available baseline
        //
        // Cooldown ("_Shop only, no _Content") is treated as no event
        // by activeEventContext — anyTreasureEvent stays false, the
        // forceTreasureOnEvents boost stays at 0, and bestTaskForEvent
        // never runs. Adventure-biased traits stay on adventures.
        var c = S.core.specialists;
        var baseline = S.ExplorerTask.Prolonged;
        if (!explorer) return baseline;

        // 1. Per-spec host override (host stores treasure-only — taskId=1).
        if (S.kernel.host) {
            var fromHostByName = c.rawToExplorerTask(1, S.kernel.host.explDefTaskByName(c.name(explorer)));
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
            return pickAdventureSubtask(explorer);
        }

        if (family === 'treasure') {
            // On-event: skill-aware items/hour optimisation picks
            // Short/Medium most of the time (event treasure values
            // don't scale linearly with duration).
            if (ctx.anyTreasureEvent) {
                try {
                    var bestForEvent = bestTaskForEvent(explorer, ctx.treasureEventCode);
                    if (bestForEvent) return bestForEvent;
                } catch (e) {
                    S.kernel.warn('specialists', 'pickTask event eval threw:', e);
                }
            }
            // Off-event: skill-locked variants are strict upgrades for
            // explorers who learned them (Erudite gates 1,4; BeanACollada
            // gates 1,5 — see ExplorerTask.TravellingErudite / BeanACollada).
            try {
                if (c.hasSkill(explorer, S.ExplorerSkill.TravellingErudite)) {
                    return S.ExplorerTask.TravellingErudite;
                }
                if (c.hasSkill(explorer, S.ExplorerSkill.BeanACollada)) {
                    return S.ExplorerTask.BeanACollada;
                }
            } catch (e) { /* ignore */ }
            // Treasure-family fallback when no event is live. Honour
            // the user's configured default task if they've chosen one
            // (explorers.defaultTask), otherwise return the
            // longest treasure variant per the "rule of thumb: longer
            // is better off-event" decision in docs/traits/EXPLORER.md. The
            // host global default is intentionally NOT consulted here —
            // autoTSO-installed hosts ship `mainSettings.explDefTask = Short`
            // by default and that conflicts with the algorithm.
            var userTreasure = userDefaultTask();
            if (userTreasure && taskFamilyOf(userTreasure) === 'treasure') {
                return userTreasure;
            }
            return S.ExplorerTask.Prolonged;
        }

        // 3. Vanilla / null-family fallback. No trait → no algorithmic
        //    preference; honour the user's default first, then host
        //    global, then the longest-available baseline.
        var userDefault = userDefaultTask();
        if (userDefault) return userDefault;
        if (S.kernel.host) {
            var fromHostGlobal = c.rawToExplorerTask(1, S.kernel.host.explDefTaskGlobal());
            if (fromHostGlobal) return fromHostGlobal;
        }
        return baseline;
    }

    S.core.specialists.pickTask         = pickTask;
    S.core.specialists.biasFromTrait    = biasFromTrait;
    S.core.specialists.familyFromBias   = familyFromBias;
    S.core.specialists.bestTaskForEvent = bestTaskForEvent;
    S.core.specialists.taskFamilyOf     = taskFamilyOf;

}(Steward));
