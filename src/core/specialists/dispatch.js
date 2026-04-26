/*
 * Specialist dispatch internals.
 *
 * Action IDs and packet shape are confirmed from existing implementations:
 *   - host:    tso_client/client/files/content/scripts/4-specialists.js:417
 *   - autoTSO: autoTSO/user_auto.js:1818-1827
 *
 * Dispatch a specialist:
 *
 *   var t = game.def('Communication.VO::dStartSpecialistTaskVO', true);
 *   t.subTaskID  = subTaskId;
 *   t.paramString = '';
 *   t.uniqueID   = spec.GetUniqueID();         // dUniqueID — NOT a string
 *   game.gi.SendServerAction(95, taskId, 0, 0, t);
 *
 *   - taskId   = which "task type" (0 = explorer search; 0 = geologist search;
 *                non-zero = adventure search etc.). The numeric int the host
 *                stores in mainSettings.explDefTask / geoDefTask.
 *   - subTaskId = the variant within taskId (0 short, 1 medium, … for explorers;
 *                 deposit type index for geologists).
 *
 * Recall a specialist:
 *
 *   spec.GetTask().Retreat();
 *
 *   This is a host-side state-machine call, NOT a server action. Confirmed
 *   by tso_client/client/files/content/scripts/8-shortcuts.js:290.
 *
 * Lives under core/ and is kept thin — composed dispatch ("send geologist
 * to find iron" etc.) is a module concern.
 */

(function (S) {

    if (!S.core.specialists) S.core.specialists = {};

    var ACTION_DISPATCH_SPECIALIST = 95;

    function uniqueId(spec) {
        if (!spec) return null;
        try {
            // Specialists expose GetUniqueID() returning a dUniqueID — the
            // server-action packet expects this object, not a string.
            if (typeof spec.GetUniqueID === 'function') return spec.GetUniqueID();
        } catch (e) { /* fall through */ }
        return null;
    }

    function buildTaskVO(subTaskId) {
        try {
            if (typeof game === 'undefined' || !game.def) return null;
            var t = game.def('Communication.VO::dStartSpecialistTaskVO', true);
            if (!t) return null;
            t.subTaskID  = (typeof subTaskId === 'number') ? subTaskId : 0;
            t.paramString = '';
            return t;
        } catch (e) {
            S.kernel.warn('specialists', 'buildTaskVO threw:', e);
            return null;
        }
    }

    function send(spec, taskId, subTaskId, responder) {
        var uid = uniqueId(spec);
        if (uid === null) {
            S.kernel.warn('specialists', 'send: cannot resolve specialist GetUniqueID');
            return false;
        }
        var taskVO = buildTaskVO(subTaskId);
        if (taskVO === null) {
            S.kernel.warn('specialists', 'send: cannot construct dStartSpecialistTaskVO');
            return false;
        }
        try {
            taskVO.uniqueID = uid;
        } catch (e) {
            S.kernel.warn('specialists', 'send: failed to attach uniqueID:', e);
            return false;
        }
        // The send is a SendServerAction; responses surface via the host's
        // mClientMessages router, not directly. The responder argument is
        // accepted for API symmetry; modules attach observers separately.
        if (responder && typeof responder.onResponse !== 'function') {
            S.kernel.warn('specialists', 'send: responder lacks onResponse — wrap with core.packets.responder()');
        }
        return S.core.packets.sendAction(ACTION_DISPATCH_SPECIALIST, taskId || 0, 0, 0, taskVO);
    }

    function recall(spec, responder) {
        if (!spec) return false;
        try {
            var task = (typeof spec.GetTask === 'function') ? spec.GetTask() : null;
            if (!task) {
                S.kernel.warn('specialists', 'recall: specialist has no current task');
                return false;
            }
            if (typeof task.Retreat !== 'function') {
                S.kernel.warn('specialists', 'recall: task has no Retreat method');
                return false;
            }
            task.Retreat();
            // Retreat is purely client-side state-machine; responder will
            // never fire from here. Logged for parity with send().
            if (responder && typeof responder.onResponse !== 'function') {
                S.kernel.warn('specialists', 'recall: responder lacks onResponse — wrap with core.packets.responder()');
            }
            return true;
        } catch (e) {
            S.kernel.error('specialists', 'recall threw:', e);
            return false;
        }
    }

    S.core.specialists.dispatch = {
        send:     send,
        recall:   recall,
        uniqueId: uniqueId
    };

}(Steward));
