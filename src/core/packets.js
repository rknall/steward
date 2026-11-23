/*
 * Server-message wrappers.
 *
 * Modules call sendAction / sendMessage instead of touching game.gi directly.
 * Failures are logged with category context and never propagate.
 *
 * The responder() helper builds a callback object the host server-message
 * machinery accepts. Modules pass it as the last arg of sendAction/sendMessage
 * to receive the response when one comes back. That shape is unverified.
 *
 * hostResponder / trackedResponder build the responder through the host's own
 * game.createResponder, the shape verified live by quests. Prefer them, with
 * sendState / answered to tell whether the latest send was answered. sendTo is
 * sendMessage for an explicit zone.
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

    // Issues the host call with the zone it is given. No zone check here, so
    // sendMessage keeps passing the viewed zone through exactly as before.
    function send(who, messageId, zoneId, data, responder) {
        var gi = gameInterface();
        if (!gi || !gi.mClientMessages || typeof gi.mClientMessages.SendMessagetoServer !== 'function') {
            S.kernel.warn('packets', who + ': mClientMessages.SendMessagetoServer unavailable');
            return false;
        }
        try {
            gi.mClientMessages.SendMessagetoServer(messageId, zoneId, data || null, responder || null);
            return true;
        } catch (e) {
            S.kernel.error('packets', who, messageId, 'threw:', e);
            return false;
        }
    }

    function sendMessage(messageId, data, responder) {
        var gi = gameInterface();
        return send('sendMessage', messageId, gi ? gi.mCurrentViewedZoneID : undefined, data, responder);
    }

    // Like sendMessage but for an explicit zone, since some messages address a
    // zone other than the viewed one. A non-numeric zone is refused before the
    // host is called.
    function sendTo(messageId, zoneId, data, responder) {
        if (!S.kernel.is.finite(zoneId)) {
            S.kernel.warn('packets', 'sendTo: zone id is not a finite number:', zoneId);
            return false;
        }
        return send('sendTo', messageId, zoneId, data, responder);
    }

    // The host responder for a send, or null when the host has none. Called as
    // a method on game because createResponder reads its own this.
    function hostResponder(category, onResult, onFault) {
        try {
            if (typeof game === 'undefined' || !game || typeof game.createResponder !== 'function') return null;
            return game.createResponder(onResult, onFault) || null;
        } catch (e) {
            S.kernel.warn(category, 'createResponder threw:', e);
            return null;
        }
    }

    // Send state of one caller: whether it has sent at all, and a per-send
    // token. trackedResponder numbers each send, and a result callback records
    // its own number only while that send is still the latest one, so a late
    // answer to an earlier send never verifies a later one.
    function sendState() {
        return { sent: false, seq: 0, ack: 0 };
    }

    // A host responder that records the server's answer in ss. onData, when a
    // function, gets the result arguments of the latest send only. Both
    // callbacks run inside the host's dispatch loop, so nothing may escape
    // them. Null when the host has no responder; the caller then verifies by
    // absence only.
    function trackedResponder(ss, category, label, onData) {
        ss.sent = true;
        ss.seq++;
        var seq = ss.seq;
        var r = hostResponder(category,
            function () {
                try {
                    var current = seq === ss.seq;
                    if (current) ss.ack = seq;
                    S.kernel.debug(category, label + ': server result for send ' + seq +
                        (current ? '' : ' (stale, ignored)'));
                    if (current && typeof onData === 'function') onData(arguments[0], arguments[1]);
                } catch (e) {
                    S.kernel.error(category, label + ': result callback threw:', e);
                }
            },
            function (f) {
                try {
                    S.kernel.warn(category, label + ': server fault for send ' + seq, f);
                } catch (e) {
                    S.kernel.error(category, label + ': fault callback threw:', e);
                }
            }
        );
        if (!r) S.kernel.debug(category, label + ': no host responder, verifying by absence only');
        return r;
    }

    // True when the server answered the latest send.
    function answered(ss) {
        return ss.seq > 0 && ss.ack === ss.seq;
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
        sendTo:      sendTo,
        responder:   responder,
        hostResponder:    hostResponder,
        sendState:        sendState,
        trackedResponder: trackedResponder,
        answered:         answered
    };

}(Steward));
