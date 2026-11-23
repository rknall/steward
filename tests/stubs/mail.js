/*
 * Host fakes and drivers for the core mail tests.
 *
 * install(H) runs on a booted harness after AC.wire(H) and returns a
 * controller. It puts the harness on the home island (zone 77, player 555),
 * gives the host game.createResponder ({ onResult, onFault }), a mail window
 * with a settable visible flag, the mail defs core/mail.js asks for (the
 * dismiss VO, ArrayCollection, MailUtils.CanCollectMail, the connection
 * manager's passive GetHeaders result) and one clock through S.kernel.now.
 *
 *   var AC = require('../stubs/actions');
 *   var MS = require('../stubs/mail');
 *   var sent = AC.wire(H);
 *   var M = MS.install(H);
 *   M.prime([M.mail(1, 6)]);                 // one header snapshot
 *   var r = M.run(M.api.dismiss([1]), { inbox: function () { return []; } });
 *
 * drive() plays every queued entry the way the kernel queue would: the
 * actions attempts and the mail read requests, moving the clock by each
 * entry's delay. opts.inbox(), when given, answers every header request
 * the moment it is sent; opts.onStep(n) runs after each entry.
 */

'use strict';

var MSG_HEADERS = 1175;
var MSG_BODY = 1177;

// A fake mx.collections::ArrayCollection over a copy of items.
function coll(items) {
    var c = { items: (items || []).slice() };
    c.addItem = function (x) { c.items.push(x); c.length = c.items.length; };
    c.toArray = function () { return c.items.slice(); };
    c.length = c.items.length;
    return c;
}

// A raw host header. extra overrides or adds members.
function mail(id, type, extra) {
    var m = {
        id:             id,
        type:           type,
        senderId:       900 + id,
        senderName:     'Sender ' + id,
        timestamp:      1700000000000 + id,
        subject_string: 'Subject ' + id
    };
    if (extra) {
        for (var k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k)) m[k] = extra[k];
        }
    }
    return m;
}

function install(H, opts) {
    opts = opts || {};
    var S = H.Steward;
    var game = H.host.game;
    var gi = game.gi;
    var previousDef = game.def;

    var M = {
        S:              S,
        api:            S.core.mail,
        t:              typeof opts.now === 'number' ? opts.now : 1000000,
        home:           true,
        playerId:       555,
        zoneId:         77,
        notCollectable: {},
        missing:        {},
        passive:        null,
        messages:       [],
        coll:           coll,
        mail:           mail
    };

    S.kernel.now = function () { return M.t; };
    M.advance = function (ms) { M.t += ms; };

    gi.mCurrentPlayerZone = { fake: 'home zone' };
    gi.mCurrentViewedZoneID = M.zoneId;
    gi.isOnHomzone = function () { return M.home; };
    game.player.GetPlayerId = function () { return M.playerId; };

    game.createResponder = function (onResult, onFault) {
        return { onResult: onResult, onFault: onFault };
    };

    // Every message as AC.wire records it, plus the clock at the send.
    var record = gi.mClientMessages.SendMessagetoServer;
    gi.mClientMessages.SendMessagetoServer = function (id, zone, data, responder) {
        record(id, zone, data, responder);
        M.messages.push({ id: id, zone: zone, data: data, responder: responder, at: M.t });
    };

    M.window = { visible: false };
    M.setWindow = function (w) {
        M.window = w;
        H.host.globalFlash.gui.mMailWindow = w;
    };
    M.setWindow(M.window);

    var mailUtils = {
        CanCollectMail: function (raw) { return !M.notCollectable[raw.id]; }
    };
    var connection = {
        GetInstance: function () {
            return { mMailService: { operations: { GetHeaders: { lastResult: M.passive } } } };
        }
    };

    game.def = function (name) {
        if (Object.prototype.hasOwnProperty.call(M.missing, name)) return null;
        if (name === 'Communication.VO.Mail::dDismissMailsRequestVO') return { voName: 'dDismissMailsRequestVO' };
        if (name === 'mx.collections::ArrayCollection') return coll([]);
        if (name === 'com.bluebyte.tso.util::MailUtils') return mailUtils;
        if (name === 'ServerState::cConnectionManager') return connection;
        return previousDef.apply(this, arguments);
    };

    // A new passive GetHeaders result holding list (a new object each call,
    // the way the host replaces it per answer).
    M.setPassive = function (list) {
        M.passive = { data: { data: { headers_collection: coll(list) } } };
        return M.passive;
    };

    M.sentOf = function (id) {
        return M.messages.filter(function (m) { return m.id === id; });
    };
    M.last = function (id) {
        var l = M.sentOf(id);
        return l.length ? l[l.length - 1] : null;
    };

    M.answerHeaders = function (list, msg) {
        msg = msg || M.last(MSG_HEADERS);
        msg.responder.onResult({ type: 'result' }, { data: { headers_collection: coll(list) } });
    };
    M.answerBody = function (data, msg) {
        msg = msg || M.last(MSG_BODY);
        msg.responder.onResult({ type: 'result' }, { data: data });
    };
    M.fault = function (msg) {
        msg = msg || M.messages[M.messages.length - 1];
        msg.responder.onFault({ faultString: 'fake fault' });
    };
    M.ack = function (msg) {
        msg.responder.onResult({ type: 'result' }, {});
    };

    // Plays queued entries until none are left or opts.max were played.
    M.drive = function (dopts) {
        dopts = dopts || {};
        var max = typeof dopts.max === 'number' ? dopts.max : 400;
        var steps = 0;
        while (steps < max) {
            var all = H.queued();
            H.clearQueued();
            if (all.length === 0) break;
            for (var i = 0; i < all.length; i++) {
                var e = all[i];
                if (steps >= max) {
                    // Keep what was not played, in order, for the next call.
                    for (var k = i; k < all.length; k++) {
                        S.kernel.queue.add(all[k].name, all[k].params, all[k].delay === null ? undefined : all[k].delay);
                    }
                    break;
                }
                if (typeof e.delay === 'number') M.t += e.delay;
                var before = M.messages.length;
                if (e.name === 'core.attempt') S.core.actions.step(e.params);
                else if (e.name === M.api.STEP_HEADERS) M.api.stepHeaders(e.params);
                else if (e.name === M.api.STEP_BODY) M.api.stepBody(e.params);
                else throw new Error('mail stub: unexpected queue entry ' + e.name);
                steps++;
                if (typeof dopts.inbox === 'function') {
                    for (var j = before; j < M.messages.length; j++) {
                        if (M.messages[j].id === MSG_HEADERS) M.answerHeaders(dopts.inbox(), M.messages[j]);
                    }
                }
                if (typeof dopts.onStep === 'function') dopts.onStep(steps);
            }
        }
        return steps;
    };

    // Asks for the headers, plays the request and answers it with list.
    M.prime = function (list) {
        var status = M.api.refresh({ force: true });
        if (status !== M.api.REFRESH.Queued) throw new Error('mail stub: prime got ' + status);
        M.drive({ inbox: function () { return list; } });
    };

    // Runs def through actions.attempt and drives it to the end.
    M.run = function (def, dopts) {
        var result = null;
        S.core.actions.attempt(def, function (r) { result = r; });
        M.drive(dopts);
        return result;
    };

    return M;
}

module.exports = {
    install:     install,
    coll:        coll,
    mail:        mail,
    MSG_HEADERS: MSG_HEADERS,
    MSG_BODY:    MSG_BODY
};
