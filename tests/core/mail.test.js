'use strict';

var t = require('../runner');
var harness = require('../harness');
var AC = require('../stubs/actions');
var MS = require('../stubs/mail');

var assert = t.assert;

var HEADERS = 1175;
var BODY = 1177;
var DISMISS = 1201;
var TRADE_ACCEPT = 1050;
var TRADE_REJECT = 1053;
var TRADE_COLLECT = 1054;
var INVITE_ACCEPT = 93;

// A booted kernel + core with the mail host fakes on the home island.
function boot() {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var sent = AC.wire(H);
    var M = MS.install(H);
    return { H: H, S: H.Steward, api: H.Steward.core.mail, sent: sent, M: M };
}

function ids(list) {
    return list.map(function (h) { return h.id; }).join(',');
}

function logged(b, level, text) {
    return b.H.logs().some(function (l) {
        return l.level === level && l.args.join(' ').indexOf(text) >= 0;
    });
}

// Acks every message with this id once, right after it is sent.
function acker(b, id) {
    var done = [];
    return function () {
        var l = b.M.sentOf(id);
        for (var i = 0; i < l.length; i++) {
            if (done.indexOf(l[i]) < 0) {
                done.push(l[i]);
                b.M.ack(l[i]);
            }
        }
    };
}

function noLegacyHeaderCall(b) {
    assert.strictEqual(b.M.sentOf(1184).length, 0, 'message 1184 is never sent');
}

// --- 1. headers() -----------------------------------------------------------

t.test('headers is notReady before any answer, never an empty list', function () {
    var b = boot();
    var r = b.api.headers();
    assert.strictEqual(r.state, 'notReady');
    assert.strictEqual(r.why, 'no header answer yet');
    assert.strictEqual(r.value, null);
    assert.strictEqual(b.api.stamp(), null);
});

t.test('headers is ok and normalised after an answer, and returns a copy', function () {
    var b = boot();
    b.M.prime([
        b.M.mail(1, 6, { senderName: '<b>Bob</b> &amp; co' }),
        b.M.mail(2, 99)
    ]);
    var r = b.api.headers();
    assert.strictEqual(r.state, 'ok');
    assert.strictEqual(r.zoneId, 77);
    assert.deepEqual(JSON.parse(JSON.stringify(r.value[0])), {
        id: 1, type: 6, kind: b.S.MailKind.Loot, senderId: 901, senderName: 'Bob & co',
        timestamp: 1700000000001, subject: 'Subject 1'
    });
    assert.strictEqual(r.value[1].kind, b.S.MailKind.Unknown);
    r.value[0].id = 500;
    r.value.pop();
    var again = b.api.headers();
    assert.strictEqual(ids(again.value), '1,2');
    var st = b.api.stamp();
    assert.strictEqual(st.seq, 1);
    assert.strictEqual(st.requestedAt, b.M.last(HEADERS).at);
});

t.test('headers is partial when an entry has no id', function () {
    var b = boot();
    b.M.prime([b.M.mail(1, 6), { type: 6, subject_string: 'no id' }]);
    var r = b.api.headers();
    assert.strictEqual(r.state, 'partial');
    assert.strictEqual(r.lost, 1);
    assert.strictEqual(ids(r.value), '1');
});

t.test('headers is unreadable after a fault and never an empty list', function () {
    var b = boot();
    assert.strictEqual(b.api.refresh(), b.api.REFRESH.Queued);
    b.M.drive();
    b.M.fault(b.M.last(HEADERS));
    var r = b.api.headers();
    assert.strictEqual(r.state, 'unreadable');
    assert.strictEqual(r.why, 'server fault');
    assert.strictEqual(r.value, null);
});

t.test('headers is notReady stale past maxAgeMs, unreadable when the refetch failed', function () {
    var b = boot();
    b.M.prime([b.M.mail(1, 6)]);
    b.M.advance(5000);
    var r = b.api.headers(1000);
    assert.strictEqual(r.state, 'notReady');
    assert.strictEqual(r.why, 'stale');
    assert.strictEqual(r.value, null);
    assert.strictEqual(b.api.headers(10000).state, 'ok');
    assert.strictEqual(b.api.headers().state, 'ok');

    b.M.advance(b.api.MIN_REFRESH_GAP_MS);
    assert.strictEqual(b.api.refresh({ force: true }), b.api.REFRESH.Queued);
    b.M.drive();
    b.M.fault(b.M.last(HEADERS));
    r = b.api.headers(1000);
    assert.strictEqual(r.state, 'unreadable');
    assert.strictEqual(r.why, 'server fault');
});

// --- 2. refresh() -----------------------------------------------------------

t.test('refresh is single-flight: two calls in one tick send one 1175', function () {
    var b = boot();
    assert.strictEqual(b.api.refresh(), b.api.REFRESH.Queued);
    assert.strictEqual(b.api.refresh(), b.api.REFRESH.Pending);
    var q = b.H.queued();
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].name, 'core.mail.headers');
    b.M.drive();
    assert.strictEqual(b.api.refresh({ force: true }), b.api.REFRESH.Pending, 'in flight');
    var l = b.M.sentOf(HEADERS);
    assert.strictEqual(l.length, 1);
    assert.strictEqual(l[0].zone, 77);
    assert.strictEqual(l[0].data.voName, 'dIntegerVO');
    assert.strictEqual(l[0].data.value, b.api.HEADERS_PAGE);
    noLegacyHeaderCall(b);
});

t.test('refresh answers Fresh, Gap inside the floor and Held off home', function () {
    var b = boot();
    b.M.prime([b.M.mail(1, 6)]);
    var sentAt = b.M.last(HEADERS).at;
    assert.strictEqual(b.api.refresh({ maxAgeMs: 60000 }), b.api.REFRESH.Fresh);
    assert.strictEqual(b.api.refresh({ after: sentAt - 1 }), b.api.REFRESH.Fresh);
    assert.strictEqual(b.api.refresh({ after: sentAt }), b.api.REFRESH.Gap);
    assert.strictEqual(b.api.refresh({ force: true }), b.api.REFRESH.Gap);
    b.M.advance(b.api.MIN_REFRESH_GAP_MS - 1);
    assert.strictEqual(b.api.refresh({ force: true }), b.api.REFRESH.Gap);
    b.M.advance(1);
    b.M.home = false;
    assert.strictEqual(b.api.refresh({ force: true }), b.api.REFRESH.Held);
    assert.strictEqual(b.H.queued().length, 0);
    b.M.home = true;
    assert.strictEqual(b.api.refresh({ force: true }), b.api.REFRESH.Queued);
    b.M.drive();
    assert.strictEqual(b.M.sentOf(HEADERS).length, 2);
    noLegacyHeaderCall(b);
});

t.test('refresh drops a queued request the queue never ran, without a send', function () {
    var b = boot();
    assert.strictEqual(b.api.refresh(), b.api.REFRESH.Queued);
    b.H.clearQueued();
    assert.strictEqual(b.api.refresh(), b.api.REFRESH.Pending);
    b.M.advance(b.api.ANSWER_TIMEOUT_MS + 1);
    assert.strictEqual(b.api.refresh(), b.api.REFRESH.Queued, 'no gap: nothing went out');
    assert.strictEqual(b.M.sentOf(HEADERS).length, 0);
});

t.test('the header request goes nowhere when the zone left home before it ran', function () {
    var b = boot();
    assert.strictEqual(b.api.refresh(), b.api.REFRESH.Queued);
    b.M.home = false;
    b.M.drive();
    assert.strictEqual(b.M.sentOf(HEADERS).length, 0);
    b.M.home = true;
    assert.strictEqual(b.api.refresh(), b.api.REFRESH.Queued);
});

// --- 3. passive fallback ----------------------------------------------------

t.test('passive answer: adopted once it changed since the send and PASSIVE_AFTER_MS passed', function () {
    var b = boot();
    b.M.setPassive([b.M.mail(9, 6)]);
    b.api.refresh();
    b.M.drive();
    var sentAt = b.M.last(HEADERS).at;
    b.M.last(HEADERS).responder.onResult({ type: 'result' }, { data: {} });
    assert.strictEqual(b.api.headers().state, 'notReady', 'an answer without a collection is not adopted');
    b.M.setPassive([b.M.mail(1, 6), b.M.mail(2, 9)]);
    b.M.advance(b.api.PASSIVE_AFTER_MS - 1);
    assert.strictEqual(b.api.headers().state, 'notReady');
    b.M.advance(1);
    var r = b.api.headers();
    assert.strictEqual(r.state, 'ok');
    assert.strictEqual(ids(r.value), '1,2');
    assert.strictEqual(b.api.stamp().requestedAt, sentAt);
});

t.test('passive answer: the same object as before the send is not adopted; timeout is unreadable', function () {
    var b = boot();
    b.M.setPassive([b.M.mail(9, 6)]);
    b.api.refresh();
    b.M.drive();
    b.M.advance(b.api.PASSIVE_AFTER_MS + 1000);
    assert.strictEqual(b.api.headers().state, 'notReady');
    b.M.advance(b.api.ANSWER_TIMEOUT_MS);
    var r = b.api.headers();
    assert.strictEqual(r.state, 'unreadable');
    assert.strictEqual(r.why, 'no answer');
    assert.ok(logged(b, 'warn', 'no answer within'));
    assert.strictEqual(b.api.refresh({ force: true }), b.api.REFRESH.Queued, 'the expired request no longer blocks');
});

t.test('passive answer while the mail window is open is partial', function () {
    var b = boot();
    b.api.refresh();
    b.M.drive();
    b.M.setPassive([b.M.mail(1, 6)]);
    b.M.window.visible = true;
    b.M.advance(b.api.PASSIVE_AFTER_MS);
    var r = b.api.headers();
    assert.strictEqual(r.state, 'partial');
    assert.strictEqual(r.why, 'foreign answer');
    assert.strictEqual(ids(r.value), '1');
});

// --- 4. instance guard ------------------------------------------------------

t.test('a late answer to a replaced instance changes nothing and wakes no one', function () {
    var b = boot();
    var wakes = [];
    b.S.kernel.scheduler.wake = function (id) { wakes.push(id); return true; };
    b.S.kernel.registry.get = function (id) { return id === 'collect' ? { id: id } : null; };
    b.api.subscribe('collect', null);
    b.api.refresh();
    b.M.drive();
    b.S.core.mail = { replaced: true };
    b.M.answerHeaders([b.M.mail(1, 6)]);
    assert.strictEqual(b.api.stamp(), null);
    assert.strictEqual(wakes.length, 0);
    assert.ok(logged(b, 'debug', 'late answer ignored'));
    b.M.fault(b.M.last(HEADERS));
    b.S.core.mail = b.api;
    assert.strictEqual(b.api.headers().state, 'notReady', 'the late fault changed nothing either');
});

// --- 5. subscribe / news ----------------------------------------------------

t.test('subscribe wakes a registered owner once per new matching mail; news tells each id once', function () {
    var b = boot();
    var K = b.S.MailKind;
    var wakes = [];
    b.S.kernel.scheduler.wake = function (id, ms) { wakes.push(id + '@' + ms); return true; };
    b.S.kernel.registry.get = function (id) {
        return (id === 'collect' || id === 'trader') ? { id: id } : null;
    };
    var wakeText = 'collect@' + b.S.kernel.TIMEOUTS.READ_RETRY_MS;

    assert.strictEqual(b.api.subscribe('', null), false);
    assert.strictEqual(b.api.subscribe('collect', 5), false);
    assert.strictEqual(b.api.subscribe('collect', { kinds: [K.Loot] }), true);
    assert.strictEqual(b.api.subscribe('ghost', null), true);
    assert.strictEqual(b.api.news('collect').state, 'notReady', 'no snapshot yet');
    assert.strictEqual(b.api.news('nobody').state, 'unreadable');
    assert.strictEqual(b.api.news('nobody').why, 'not subscribed');
    assert.strictEqual(wakes.length, 0);

    b.M.prime([b.M.mail(1, 6), b.M.mail(2, 1)]);
    assert.deepEqual(wakes, [wakeText], 'an unregistered owner is not woken');
    assert.strictEqual(ids(b.api.news('collect').value), '1');
    assert.strictEqual(ids(b.api.news('collect').value), '');

    b.M.advance(b.api.MIN_REFRESH_GAP_MS);
    b.M.prime([b.M.mail(1, 6), b.M.mail(2, 1)]);
    assert.strictEqual(wakes.length, 1, 'the same ids are no news');
    assert.strictEqual(ids(b.api.news('collect').value), '');

    b.M.advance(b.api.MIN_REFRESH_GAP_MS);
    b.M.prime([b.M.mail(1, 6), b.M.mail(2, 1), b.M.mail(3, 25)]);
    assert.strictEqual(wakes.length, 2);
    assert.strictEqual(ids(b.api.news('collect').value), '3');

    b.api.subscribe('trader', function (h) { return h.kind === K.Trade; });
    assert.strictEqual(wakes[2], 'trader@' + b.S.kernel.TIMEOUTS.READ_RETRY_MS);
    assert.strictEqual(ids(b.api.news('trader').value), '2');

    b.api.subscribe('trader', function () { throw new Error('bad filter'); });
    assert.strictEqual(wakes.length, 3, 'a throwing filter matches nothing');
    assert.strictEqual(ids(b.api.news('trader').value), '');
    assert.ok(logged(b, 'warn', 'mail filter threw'));

    assert.strictEqual(b.api.match({ kinds: [K.Trade] }, { kind: K.Trade }), true);
    assert.strictEqual(b.api.match({ kinds: [K.Trade] }, { kind: K.Loot }), false);
    assert.strictEqual(b.api.match(null, { kind: K.Loot }), true);

    assert.strictEqual(b.api.unsubscribe('collect'), true);
    assert.strictEqual(b.api.unsubscribe('collect'), false);
    b.M.advance(b.api.MIN_REFRESH_GAP_MS);
    b.M.prime([b.M.mail(1, 6), b.M.mail(2, 1), b.M.mail(3, 25), b.M.mail(4, 6)]);
    assert.strictEqual(wakes.length, 3, 'an unsubscribed owner is not woken');
    assert.strictEqual(b.api.news('collect').why, 'not subscribed');
});

t.test('news is partial with the snapshot loss when the snapshot is partial', function () {
    var b = boot();
    b.api.subscribe('collect', null);
    b.M.prime([b.M.mail(1, 6), { type: 6 }]);
    var r = b.api.news('collect');
    assert.strictEqual(r.state, 'partial');
    assert.strictEqual(r.lost, 1);
    assert.strictEqual(ids(r.value), '1');
});

// --- 6. dismiss -------------------------------------------------------------

function dismissBoot() {
    var b = boot();
    b.M.prime([b.M.mail(1, 6), b.M.mail(2, 6), b.M.mail(3, 1)]);
    b.H.clearLogs();
    return b;
}

t.test('dismiss is held while the mail window is open or unreadable, and refused off home', function () {
    var b = dismissBoot();
    var A = b.S.ActionResult;

    b.M.window.visible = true;
    var r = b.M.run(b.api.dismiss([1]));
    assert.strictEqual(r.status, A.Refused);
    assert.strictEqual(r.reason, b.api.HELD);
    assert.strictEqual(b.api.isHold(r.reason), true);

    b.M.setWindow({ Show: function () {}, Hide: function () {} });
    r = b.M.run(b.api.dismiss([1]));
    assert.strictEqual(r.reason, b.api.WINDOW_UNREADABLE);
    assert.strictEqual(b.api.isHold(r.reason), true);

    b.M.setWindow({ visible: true, stage: null });
    assert.strictEqual(b.api.windowOpen().value, false, 'a window off the stage is not shown');
    b.M.setWindow({ visible: true, stage: {} });
    assert.strictEqual(b.api.windowOpen().value, true);
    b.M.setWindow({ IsOpen: function () { return true; } });
    assert.strictEqual(b.M.run(b.api.dismiss([1])).reason, b.api.HELD);
    b.M.setWindow(null);
    assert.strictEqual(b.api.windowOpen().value, false, 'a window never created is closed');

    b.M.setWindow({ visible: false });
    b.M.home = false;
    r = b.M.run(b.api.dismiss([1]));
    assert.strictEqual(r.reason, b.api.NOT_HOME);
    assert.strictEqual(b.api.isHold(r.reason), false);

    assert.strictEqual(b.M.sentOf(DISMISS).length, 0);
});

t.test('dismiss refuses wrong kinds, uncollectable, unknown and bad ids', function () {
    var b = dismissBoot();
    b.M.setWindow({ visible: false });
    function reason(def) { return b.M.run(def).reason; }

    assert.strictEqual(reason(b.api.dismiss([1, 3])), b.api.WRONG_KIND);
    b.M.notCollectable[2] = true;
    assert.strictEqual(reason(b.api.dismiss([2])), b.api.NOT_COLLECTABLE);
    delete b.M.notCollectable[2];
    assert.strictEqual(reason(b.api.dismiss([42])), b.api.NOT_FOUND);
    assert.strictEqual(reason(b.api.dismiss([])), b.api.BAD_IDS);
    assert.strictEqual(reason(b.api.dismiss([1, 'x'])), b.api.BAD_IDS);
    var many = [];
    for (var i = 0; i <= b.api.DISMISS_MAX; i++) many.push(i + 1);
    assert.strictEqual(reason(b.api.dismiss(many)), b.api.BAD_IDS);
    b.M.missing['com.bluebyte.tso.util::MailUtils'] = true;
    assert.strictEqual(reason(b.api.dismiss([1])), b.api.COLLECT_CHECK_MISSING);
    assert.strictEqual(b.M.sentOf(DISMISS).length, 0);
});

t.test('dismiss verifies once an ok snapshot requested after the send lacks the ids', function () {
    var b = dismissBoot();
    var r = b.M.run(b.api.dismiss([1, 2], { toStar: true }), {
        inbox: function () { return [b.M.mail(3, 1)]; }
    });
    assert.strictEqual(r.status, b.S.ActionResult.Verified);
    assert.strictEqual(r.sends, 1);
    var l = b.M.sentOf(DISMISS);
    assert.strictEqual(l.length, 1);
    assert.strictEqual(l[0].zone, 77);
    assert.strictEqual(l[0].data.voName, 'dDismissMailsRequestVO');
    assert.deepEqual(l[0].data.mailsIDs_collection.items, [1, 2]);
    assert.strictEqual(l[0].data.claim, false);
    assert.ok(b.M.last(HEADERS).at > l[0].at, 'a header request went out after the send');
    noLegacyHeaderCall(b);
});

t.test('dismiss: an ack alone, or a partial snapshot without the ids, does not verify', function () {
    var b = dismissBoot();
    var A = b.S.ActionResult;
    var r = b.M.run(b.api.dismiss([1]), {
        inbox: function () { return [b.M.mail(1, 6), b.M.mail(2, 6), b.M.mail(3, 1)]; },
        onStep: acker(b, DISMISS)
    });
    assert.strictEqual(r.status, A.Failed);
    assert.strictEqual(r.unseen, true);
    assert.strictEqual(r.sends, 2, 'the default retry sends once more');

    b = dismissBoot();
    r = b.M.run(b.api.dismiss([1]), {
        inbox: function () { return [b.M.mail(2, 6), { type: 6 }]; },
        onStep: acker(b, DISMISS)
    });
    assert.strictEqual(r.status, A.Failed);
    assert.strictEqual(b.api.headers().state, 'partial');
});

t.test('dismiss: a snapshot requested before the send does not verify', function () {
    var b = dismissBoot();
    var result = null;
    b.M.advance(b.api.MIN_REFRESH_GAP_MS);
    assert.strictEqual(b.api.refresh({ force: true }), b.api.REFRESH.Queued);
    b.M.drive({ max: 1 });
    var early = b.M.last(HEADERS);

    b.S.core.actions.attempt(b.api.dismiss([1]), function (x) { result = x; });
    b.M.drive({ max: 1 });
    var send = b.M.last(DISMISS);
    assert.ok(send && send.at > early.at);

    b.M.answerHeaders([b.M.mail(2, 6), b.M.mail(3, 1)], early);
    assert.strictEqual(b.api.headers().state, 'ok');
    b.M.drive({ max: 6 });
    assert.strictEqual(result, null, 'not verified by the earlier request');

    b.M.drive({ inbox: function () { return [b.M.mail(2, 6), b.M.mail(3, 1)]; } });
    assert.strictEqual(result.status, b.S.ActionResult.Verified);
    assert.ok(b.M.last(HEADERS).at > send.at);
});

function claimOf(opts, routeStorage) {
    var b = dismissBoot();
    if (routeStorage !== undefined) b.H.host.mainSettings.mailRouteStorage = routeStorage;
    var r = b.M.run(b.api.dismiss([1], opts), { inbox: function () { return []; } });
    assert.strictEqual(r.status, b.S.ActionResult.Verified);
    return b.M.last(DISMISS).data.claim;
}

t.test('dismiss claim follows toStar, else the host route setting', function () {
    assert.strictEqual(claimOf({ toStar: true }), false);
    assert.strictEqual(claimOf({ toStar: false }, false), true);
    assert.strictEqual(claimOf(undefined), true);
    assert.strictEqual(claimOf({}, true), true);
    assert.strictEqual(claimOf(undefined, false), false);
});

// --- 7. trade / completeTrade -----------------------------------------------

function tradeBoot() {
    var b = boot();
    b.M.prime([b.M.mail(2, 1), b.M.mail(3, 4), b.M.mail(4, 1), b.M.mail(5, 1), b.M.mail(6, 1)]);
    return b;
}

function inboxOf(b) {
    return function () { return [b.M.mail(2, 1), b.M.mail(3, 4), b.M.mail(4, 1), b.M.mail(5, 1), b.M.mail(6, 1)]; };
}

t.test('trade accept goes to the player zone, verifies by its ack and is never sent twice', function () {
    var b = tradeBoot();
    var A = b.S.ActionResult;
    var r = b.M.run(b.api.trade(2, true), { inbox: inboxOf(b), onStep: acker(b, TRADE_ACCEPT) });
    assert.strictEqual(r.status, A.Verified);
    var l = b.M.sentOf(TRADE_ACCEPT);
    assert.strictEqual(l.length, 1);
    assert.strictEqual(l[0].zone, 555);
    assert.strictEqual(l[0].data.value, 2);

    r = b.M.run(b.api.trade(2, false));
    assert.strictEqual(r.status, A.Refused);
    assert.strictEqual(r.reason, b.api.ALREADY_SENT);
    assert.strictEqual(b.M.sentOf(TRADE_REJECT).length, 0);

    r = b.M.run(b.api.trade(4, false), { inbox: inboxOf(b), onStep: acker(b, TRADE_REJECT) });
    assert.strictEqual(r.status, A.Verified);
    assert.strictEqual(b.M.last(TRADE_REJECT).zone, 555);
    assert.strictEqual(b.M.last(TRADE_REJECT).data.value, 4);
});

t.test('trade has no retry: an unseen failure sends once, and a new def refuses', function () {
    var b = tradeBoot();
    var A = b.S.ActionResult;
    var r = b.M.run(b.api.trade(5, true), { inbox: inboxOf(b) });
    assert.strictEqual(r.status, A.Failed);
    assert.strictEqual(r.unseen, true);
    assert.strictEqual(r.sends, 1);
    r = b.M.run(b.api.trade(5, true), { inbox: inboxOf(b) });
    assert.strictEqual(r.reason, b.api.ALREADY_SENT);
    assert.strictEqual(b.M.sentOf(TRADE_ACCEPT).length, 1);
});

t.test('an ack for another send does not verify a trade; completeTrade sends 1054', function () {
    var b = tradeBoot();
    var A = b.S.ActionResult;
    var rt = null;
    var rc = null;
    b.S.core.actions.attempt(b.api.trade(6, true), function (x) { rt = x; });
    b.S.core.actions.attempt(b.api.completeTrade(3), function (x) { rc = x; });
    b.M.drive({ inbox: inboxOf(b), onStep: acker(b, TRADE_COLLECT) });
    assert.strictEqual(rc.status, A.Verified);
    assert.strictEqual(rt.status, A.Failed);
    var c = b.M.last(TRADE_COLLECT);
    assert.strictEqual(c.zone, 555);
    assert.strictEqual(c.data.value, 3);

    assert.strictEqual(b.M.run(b.api.completeTrade(2)).reason, b.api.WRONG_KIND);
    assert.strictEqual(b.M.run(b.api.trade(3, true)).reason, b.api.WRONG_KIND);
    b.M.playerId = null;
    assert.strictEqual(b.M.run(b.api.trade(4, true)).reason, b.S.core.actions.NOT_SENT);
});

t.test('a late ack of a trade responder after a newer send is ignored', function () {
    var b = tradeBoot();
    var ss = b.S.core.packets.sendState();
    var first = b.S.core.packets.trackedResponder(ss, 'mail', 'x');
    b.S.core.packets.trackedResponder(ss, 'mail', 'x');
    first.onResult({}, {});
    assert.strictEqual(b.S.core.packets.answered(ss), false);
});

// --- 8. acceptInvite --------------------------------------------------------

t.test('acceptInvite needs the body, then sends 93 to the invite zone', function () {
    var b = boot();
    var A = b.S.ActionResult;
    b.M.prime([b.M.mail(7, 23)]);

    var r = b.M.run(b.api.acceptInvite(7));
    assert.strictEqual(r.status, A.Refused);
    assert.strictEqual(r.reason, b.api.BODY_UNREADABLE);
    assert.strictEqual(b.api.isHold(r.reason), true);

    assert.strictEqual(b.api.body(7).why, 'body not requested');
    assert.strictEqual(b.api.requestBody(7), b.api.REFRESH.Queued);
    assert.strictEqual(b.api.requestBody(7), b.api.REFRESH.Pending);
    assert.strictEqual(b.api.body(7).why, 'body requested');
    b.M.drive();
    var q = b.M.last(BODY);
    assert.strictEqual(q.zone, 77);
    assert.strictEqual(q.data.value, 7);
    b.M.answerBody({ body: 'join us', attachments: { zoneID: 999 }, senderId: 4, senderName: '<i>Ann</i>' });
    var body = b.api.body(7);
    assert.strictEqual(body.state, 'ok');
    assert.strictEqual(body.value.attachments.zoneID, 999);
    assert.strictEqual(body.value.senderName, 'Ann');
    assert.strictEqual(b.api.requestBody(7), b.api.REFRESH.Fresh);

    r = b.M.run(b.api.acceptInvite(7), {
        inbox: function () { return [b.M.mail(7, 23)]; },
        onStep: acker(b, INVITE_ACCEPT)
    });
    assert.strictEqual(r.status, A.Verified);
    var l = b.M.sentOf(INVITE_ACCEPT);
    assert.strictEqual(l.length, 1);
    assert.strictEqual(l[0].zone, 999);
    assert.strictEqual(l[0].data.value, 7);
});

t.test('a faulted body is unreadable and may be asked again after BODY_RETRY_MS', function () {
    var b = boot();
    b.M.prime([b.M.mail(8, 23)]);
    b.api.requestBody(8);
    b.M.drive();
    b.M.fault(b.M.last(BODY));
    var r = b.api.body(8);
    assert.strictEqual(r.state, 'unreadable');
    assert.strictEqual(r.why, 'server fault');
    assert.strictEqual(b.api.requestBody(8), b.api.REFRESH.Gap);
    b.M.advance(b.api.BODY_RETRY_MS);
    assert.strictEqual(b.api.requestBody(8), b.api.REFRESH.Queued);
});

// --- 9. window opens before a retry -----------------------------------------

t.test('a window opened between the send and the retry holds the retry; a new def goes out after closing', function () {
    var b = dismissBoot();
    var A = b.S.ActionResult;
    var r = b.M.run(b.api.dismiss([1]), {
        inbox: function () { return [b.M.mail(1, 6), b.M.mail(2, 6), b.M.mail(3, 1)]; },
        onStep: function () {
            if (b.M.sentOf(DISMISS).length === 1) b.M.window.visible = true;
        }
    });
    assert.strictEqual(r.status, A.Failed);
    assert.strictEqual(r.reason, 'retry refused: ' + b.api.HELD);
    assert.strictEqual(b.M.sentOf(DISMISS).length, 1, 'nothing more was sent');

    b.M.window.visible = false;
    r = b.M.run(b.api.dismiss([1]), { inbox: function () { return [b.M.mail(2, 6), b.M.mail(3, 1)]; } });
    assert.strictEqual(r.status, A.Verified);
    assert.strictEqual(b.M.sentOf(DISMISS).length, 2);
});

// --- 10. parseItems / kindOf ------------------------------------------------

t.test('parseItems reads two- and three-part items, malformed is null', function () {
    var b = boot();
    var P = b.api.parseItems;
    assert.deepEqual(JSON.parse(JSON.stringify(P('Wood,100|Stone, 5'))), [
        { name: 'Wood', amount: 100 }, { name: 'Stone', amount: 5 }
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(P('Buff,Fish Platter,3'))), [
        { type: 'Buff', name: 'Fish Platter', amount: 3 }
    ]);
    assert.strictEqual(P('Wood,lots'), null);
    assert.strictEqual(P('Wood,100|Stone'), null);
    assert.strictEqual(P('a,b,c,1'), null);
    assert.strictEqual(P('Wood,'), null);
    assert.strictEqual(P(''), null);
    assert.strictEqual(P(null), null);
});

t.test('kindOf maps known types, others are Unknown; typesOf is a copy', function () {
    var b = boot();
    var K = b.S.MailKind;
    assert.strictEqual(b.api.kindOf(6), K.Loot);
    assert.strictEqual(b.api.kindOf(32), K.Geologist);
    assert.strictEqual(b.api.kindOf(1), K.Trade);
    assert.strictEqual(b.api.kindOf(5), K.TradeResult);
    assert.strictEqual(b.api.kindOf(23), K.Invite);
    assert.strictEqual(b.api.kindOf(99), K.Unknown);
    assert.strictEqual(b.api.kindOf(null), K.Unknown);
    var l = b.api.typesOf(K.TradeResult);
    assert.strictEqual(l.join(','), '4,5');
    l.push(77);
    assert.strictEqual(b.api.typesOf(K.TradeResult).join(','), '4,5');
    assert.strictEqual(b.api.typesOf(K.Unknown).length, 0);
});

t.test('passive before any answer has no result; with an answer it exposes the collection', function () {
    var b = boot();
    var p = b.api.passive();
    assert.strictEqual(p.lastResult, null);
    assert.strictEqual(p.collection, null);
    assert.ok(p.operations && p.operations.GetHeaders);
    var lr = b.M.setPassive([b.M.mail(1, 6)]);
    p = b.api.passive();
    assert.strictEqual(p.lastResult, lr);
    assert.strictEqual(b.S.kernel.hostRead.list(p.collection).length, 1);
    b.M.passive = { data: { headers_collection: b.M.passive.data.data.headers_collection } };
    p = b.api.passive();
    assert.strictEqual(b.S.kernel.hostRead.list(p.collection).length, 1);
});

t.test('passive without the connection manager returns nulls and does not throw', function () {
    var b = boot();
    b.M.missing['ServerState::cConnectionManager'] = true;
    var p = b.api.passive();
    assert.strictEqual(p.operations, null);
    assert.strictEqual(p.lastResult, null);
    assert.strictEqual(p.collection, null);
});

t.test('collectCheckAvailable reflects the host collect check', function () {
    var b = boot();
    assert.strictEqual(b.api.collectCheckAvailable(), true);
    b.M.missing['com.bluebyte.tso.util::MailUtils'] = true;
    assert.strictEqual(b.api.collectCheckAvailable(), false);
    delete b.M.missing['com.bluebyte.tso.util::MailUtils'];
    var orig = b.H.host.game.def;
    b.H.host.game.def = function (name) {
        if (name === 'com.bluebyte.tso.util::MailUtils') return {};
        return orig(name);
    };
    assert.strictEqual(b.api.collectCheckAvailable(), false);
});
