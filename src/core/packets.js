/*
 * Server-message wrappers.
 *
 * Modules call sendAction / sendMessage instead of touching game.gi directly.
 * Failures are logged with category context and never propagate.
 *
 * The responder() helper builds a callback object the host server-message
 * machinery accepts. Modules pass it as the last arg of sendAction/sendMessage
 * to receive the response when one comes back.
 */

(function (S) {

    function gameInterface() {
        try {
            if (typeof game !== 'undefined' && game && game.gi) return game.gi;
        } catch (e) { /* fall through */ }
        return null;
    }

    function sendAction(actionId, p1, p2, p3, data) {
        var gi = gameInterface();
        if (!gi || typeof gi.SendServerAction !== 'function') {
            S.kernel.warn('packets', 'sendAction: game.gi.SendServerAction unavailable');
            return false;
        }
        try {
            gi.SendServerAction(actionId, p1 || 0, p2 || 0, p3 || 0, data || null);
            return true;
        } catch (e) {
            S.kernel.error('packets', 'sendAction', actionId, 'threw:', e);
            return false;
        }
    }

    function sendMessage(messageId, data, responder) {
        var gi = gameInterface();
        if (!gi || !gi.mClientMessages || typeof gi.mClientMessages.SendMessagetoServer !== 'function') {
            S.kernel.warn('packets', 'sendMessage: mClientMessages.SendMessagetoServer unavailable');
            return false;
        }
        try {
            var zoneId = gi.mCurrentViewedZoneID;
            gi.mClientMessages.SendMessagetoServer(messageId, zoneId, data || null, responder || null);
            return true;
        } catch (e) {
            S.kernel.error('packets', 'sendMessage', messageId, 'threw:', e);
            return false;
        }
    }

    function responder(spec) {
        // The host expects an object with .onResponse / .onError methods (or a
        // similar shape). Modules pass plain functions; we wrap them here so
        // the on-the-wire shape is consistent and exceptions in user code
        // don't leak into the message-dispatch loop.
        spec = spec || {};
        return {
            onResponse: function (response) {
                if (typeof spec.onResponse !== 'function') return;
                try { spec.onResponse(response); }
                catch (e) { S.kernel.error('packets', 'responder.onResponse threw:', e); }
            },
            onError: function (err) {
                if (typeof spec.onError !== 'function') return;
                try { spec.onError(err); }
                catch (e) { S.kernel.error('packets', 'responder.onError threw:', e); }
            }
        };
    }

    S.core.packets = {
        sendAction:  sendAction,
        sendMessage: sendMessage,
        responder:   responder
    };

}(Steward));
