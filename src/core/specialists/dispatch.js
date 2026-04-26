/*
 * Specialist dispatch internals.
 *
 * Low-level packet wrappers for sending and recalling specialists. Lives
 * under core/ but is kept thin — composed dispatch ("send geologist to find X")
 * is a module concern, not core's. core/specialists.js calls into this for
 * the actual on-the-wire send.
 */

(function (S) {

    if (!S.core.specialists) S.core.specialists = {};

    // Looks up a specialist by name in the home player's specialist roster.
    // Returns the specialist's underlying ID the server expects.
    function specialistId(spec) {
        if (!spec) return null;
        try {
            if (typeof spec.GetID === 'function') return spec.GetID();
            if (typeof spec.getID === 'function') return spec.getID();
            if (typeof spec.GetUniqueID === 'function') return spec.GetUniqueID();
        } catch (e) { /* fall through */ }
        return null;
    }

    function buildSendData(taskType, params) {
        // The server-side send specialist packet historically takes the
        // task type as p1 and a serialized parameter blob as p2. Modules
        // that need richer payloads can pass `params` as a string or a
        // pre-built dVO object via core/packets.responder.
        return {
            taskType: taskType,
            params:   params || null
        };
    }

    function send(spec, taskType, params, responder) {
        var id = specialistId(spec);
        if (id === null) {
            S.kernel.warn('specialists', 'send: cannot resolve specialist id');
            return false;
        }
        // Action ID for "dispatch specialist" (mirrors aUtils.game.sendSpecialistPacket).
        // The exact action number is documented in the host client; if it
        // changes, this is the single place to update.
        var ACTION_DISPATCH_SPECIALIST = 51;     // TODO P2-spike: confirm in live client
        var data = buildSendData(taskType, params);
        // Some client builds ignore the responder for action packets and
        // surface results via mClientMessages instead. The responder is held
        // by the caller for that path; we keep the parameter in the signature
        // so call sites remain stable when the live-client behaviour is
        // confirmed during the P2 spike.
        if (responder && typeof responder.onResponse !== 'function') {
            S.kernel.warn('specialists', 'send: responder lacks onResponse — wrap with core.packets.responder()');
        }
        return S.core.packets.sendAction(ACTION_DISPATCH_SPECIALIST, id, taskType || 0, 0, data);
    }

    function recall(spec, responder) {
        var id = specialistId(spec);
        if (id === null) return false;
        // Responder is part of the published signature; once the live client
        // confirms whether recall surfaces a result via responder or via
        // mClientMessages, this guard is replaced with a real attachment.
        if (responder && typeof responder.onResponse !== 'function') {
            S.kernel.warn('specialists', 'recall: responder lacks onResponse — wrap with core.packets.responder()');
        }
        var ACTION_RECALL_SPECIALIST = 52;       // TODO P2-spike: confirm action id
        return S.core.packets.sendAction(ACTION_RECALL_SPECIALIST, id, 0, 0, null);
    }

    S.core.specialists.dispatch = {
        send:         send,
        recall:       recall,
        specialistId: specialistId
    };

}(Steward));
