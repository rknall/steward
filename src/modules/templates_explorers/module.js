/*
 * Templates_explorers module.
 *
 * Periodically dispatches idle explorers to the task chosen by the
 * precedence chain documented in docs/CORE_USAGE.md (Rule 5):
 *
 *   1. settings.overrides[<name>]                  — Steward's per-explorer
 *                                                     override (most specific)
 *   2. mainSettings.explDefTaskByType[<GetType>]   — host's per-type override
 *      (consulted inside core.specialists.pickTask)
 *   3. event-aware optimisation                     — pickTask
 *   4. mainSettings.explDefTask                     — host's global default
 *      (also inside pickTask)
 *   5. Steward.ExplorerTask.Short                   — hardcoded baseline
 *
 * Honours the kernel's busy contract: once plan() has enqueued one
 * dispatch per available explorer, the module is "busy" until those
 * dispatches drain. No second plan() call piles work on top.
 *
 * P7d v0.4.0 scope: dispatch idle explorers only. Explorers already
 * working are left alone. Cancellation and re-routing are deferred
 * until the user has a real workflow that needs them.
 */

(function (S) {

    function readSettings() {
        return (S.modules.templates_explorers && S.modules.templates_explorers.readSettings)
            ? S.modules.templates_explorers.readSettings()
            : S.modules.templates_explorers.defaultSettings;
    }

    function stripHtml(name) {
        if (S.modules.templates_explorers && S.modules.templates_explorers.stripHtml) {
            return S.modules.templates_explorers.stripHtml(name);
        }
        return (typeof name === 'string') ? name.replace(/<[^>]+>/g, '') : '';
    }

    // Translate an ExplorerTask enum value into the (taskId, subTaskId)
    // pair the dispatch packet expects. autoTSO and host both treat
    // explorer treasure searches with taskId=0 (the host's
    // mainSettings.explDefTask is in the SAME numeric space as ExplorerTask
    // subTaskIDs, since the dispatch packet's taskId is always 0 for
    // treasure searches and the variant goes into subTaskID).
    var ENUM_TO_SUBTASK = {};
    ENUM_TO_SUBTASK[S.ExplorerTask.Short]          = 0;
    ENUM_TO_SUBTASK[S.ExplorerTask.Medium]         = 1;
    ENUM_TO_SUBTASK[S.ExplorerTask.Long]           = 2;
    ENUM_TO_SUBTASK[S.ExplorerTask.EvenLonger]     = 3;
    ENUM_TO_SUBTASK[S.ExplorerTask.AdventureShort] = 4;
    ENUM_TO_SUBTASK[S.ExplorerTask.AdventureLong]  = 5;
    ENUM_TO_SUBTASK[S.ExplorerTask.Prolonged]      = 6;

    function pickForExplorer(explorer) {
        var s = readSettings();
        var c = S.core.specialists;

        // 1. Per-name override (Steward's settings).
        if (s.overrides) {
            var rawName = c.name(explorer);
            var key = stripHtml(rawName);
            if (key && s.overrides[key]) {
                var enumVal = s.overrides[key];
                if (typeof ENUM_TO_SUBTASK[enumVal] !== 'undefined') {
                    return enumVal;
                }
                S.kernel.warn('templates_explorers',
                    'override for', key, 'is not a recognised ExplorerTask value:', enumVal);
            }
        }

        // 2-5. Host per-type, event-aware, host global, baseline — all in pickTask.
        try {
            return c.pickTask(explorer) || S.ExplorerTask.Short;
        } catch (e) {
            S.kernel.warn('templates_explorers', 'pickTask threw:', e);
            return S.ExplorerTask.Short;
        }
    }

    function isReady(ctx) {
        var s = readSettings();
        if (!s || !s.enabled) return false;
        if (!ctx.zone || !ctx.zone.isHome) return false;
        return true;
    }

    function uniqueKey(spec) {
        try {
            if (typeof spec.GetUniqueID === 'function') {
                var uid = spec.GetUniqueID();
                if (uid && typeof uid.toKeyString === 'function') return uid.toKeyString();
            }
        } catch (e) { /* fall through */ }
        return null;
    }

    function plan() {
        var c = S.core.specialists;
        var idleExplorers;
        try { idleExplorers = c.available(S.SpecialistType.Explorer); }
        catch (e) {
            S.kernel.error('templates_explorers', 'available() threw:', e);
            return;
        }

        if (idleExplorers.length === 0) return;

        var s = readSettings();
        var delay = (typeof s.dispatchDelay === 'number') ? s.dispatchDelay : 1500;
        var dispatched = 0;

        for (var i = 0; i < idleExplorers.length; i++) {
            var spec = idleExplorers[i];
            var task = pickForExplorer(spec);
            if (!task) continue;

            // Capture uniqueID (a stable per-instance key) so the queue
            // action re-finds the SAME explorer at fire time. Two explorers
            // can share a display name (e.g. multiple "Bewitching Explorer"
            // instances of GetType=51) — name-based lookup picks one and
            // sends to it repeatedly while ignoring the rest.
            var uidKey = uniqueKey(spec);
            if (!uidKey) {
                S.kernel.warn('templates_explorers', 'no uniqueID for', stripHtml(c.name(spec)),
                              '— skipping');
                continue;
            }
            var name = stripHtml(c.name(spec)) || '?';
            S.kernel.queue.add('templates_explorers.dispatch',
                [uidKey, name, task],
                i === 0 ? 0 : delay);
            dispatched++;
        }

        if (dispatched > 0) {
            S.kernel.log('templates_explorers', 'queued dispatch for', dispatched, 'idle explorer(s)');
        }
    }

    function boot() {
        // Seed defaults on first run.
        if (!S.kernel.settings.read('templates_explorers')) {
            S.kernel.settings.write('templates_explorers',
                S.modules.templates_explorers.defaultSettings);
        }

        // Register the dispatch action.
        S.kernel.queue.action('templates_explorers.dispatch', function (params) {
            var uidKey = params[0];
            var displayName = params[1] || '?';
            var taskEnum = params[2];
            var c = S.core.specialists;

            // Re-find the explorer by uniqueID (display names can repeat
            // across instances; uniqueID is stable per-instance).
            var spec = null;
            try {
                var explorers = c.explorers();
                for (var i = 0; i < explorers.length; i++) {
                    if (uniqueKey(explorers[i]) === uidKey) {
                        spec = explorers[i];
                        break;
                    }
                }
            } catch (e) {
                S.kernel.error('templates_explorers', 'lookup for', displayName, 'threw:', e);
                return;
            }

            if (!spec) {
                S.kernel.warn('templates_explorers', 'could not re-find', displayName,
                              '(uid', uidKey, ') — skipping');
                return;
            }
            if (c.status(spec) !== S.SpecialistStatus.Idle) {
                S.kernel.log('templates_explorers', displayName, 'no longer idle — skipping');
                return;
            }

            try {
                var ok = c.send(spec, taskEnum);
                if (ok) {
                    S.kernel.log('templates_explorers', 'sent', displayName, '→', taskEnum);
                } else {
                    S.kernel.warn('templates_explorers', 'send returned false for', displayName);
                }
            } catch (e) {
                S.kernel.error('templates_explorers', 'send threw for', displayName, ':', e);
            }
        });

        // Render the menu.
        if (S.modules.templates_explorers.renderMenu) {
            S.modules.templates_explorers.renderMenu();
        }
    }

    S.kernel.register({
        id:       'templates_explorers',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan
    });

}(Steward));
