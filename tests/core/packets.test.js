'use strict';

var t = require('../runner');
var harness = require('../harness');
var AC = require('../stubs/actions');

// opts.noResponder leaves the host without game.createResponder.
function boot(opts) {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    H.host.game.gi.mCurrentViewedZoneID = 5;
    if (!(opts && opts.noResponder)) {
        H.host.game.createResponder = function (onResult, onFault) {
            return { onResult: onResult, onFault: onFault };
        };
    }
    var sent = AC.wire(H);
    return { H: H, P: H.Steward.core.packets, sent: sent };
}

t.test('sendTo passes the given zone and payload', function () {
    var b = boot();
    var vo = { value: 1 };
    var resp = { tag: 'r' };
    t.assert.strictEqual(b.P.sendTo(1050, 77, vo, resp), true);
    t.assert.strictEqual(b.sent.messages.length, 1);
    t.assert.strictEqual(b.sent.messages[0].id, 1050);
    t.assert.strictEqual(b.sent.messages[0].zone, 77);
    t.assert.strictEqual(b.sent.messages[0].data, vo);
    t.assert.strictEqual(b.sent.messages[0].responder, resp);
});

t.test('sendTo refuses a non-number zone without a host call', function () {
    var b = boot();
    t.assert.strictEqual(b.P.sendTo(1, undefined, {}), false);
    t.assert.strictEqual(b.P.sendTo(1, '5', {}), false);
    t.assert.strictEqual(b.P.sendTo(1, NaN, {}), false);
    t.assert.strictEqual(b.P.sendTo(1, Infinity, {}), false);
    t.assert.strictEqual(b.sent.messages.length, 0);
});

t.test('sendTo returns false when the host call throws', function () {
    var b = boot();
    b.H.host.game.gi.mClientMessages.SendMessagetoServer = function () { throw new Error('boom'); };
    t.assert.strictEqual(b.P.sendTo(1, 5, {}), false);
});

t.test('sendMessage still uses the viewed zone', function () {
    var b = boot();
    t.assert.strictEqual(b.P.sendMessage(1175, { value: 5000 }), true);
    t.assert.strictEqual(b.sent.messages[0].zone, 5);
    t.assert.strictEqual(b.sent.messages[0].id, 1175);
    b.H.host.game.gi.mCurrentViewedZoneID = 9;
    b.P.sendMessage(1177, null);
    t.assert.strictEqual(b.sent.messages[1].zone, 9);
});

t.test('hostResponder is null without game.createResponder', function () {
    var b = boot({ noResponder: true });
    t.assert.strictEqual(b.P.hostResponder('x', function () {}, function () {}), null);
});

t.test('hostResponder returns the host responder', function () {
    var b = boot();
    var r = b.P.hostResponder('x', function () {}, function () {});
    t.assert.strictEqual(typeof r.onResult, 'function');
    t.assert.strictEqual(typeof r.onFault, 'function');
});

t.test('hostResponder is null when createResponder throws', function () {
    var b = boot();
    b.H.host.game.createResponder = function () { throw new Error('boom'); };
    t.assert.strictEqual(b.P.hostResponder('x', function () {}, function () {}), null);
});

t.test('sendState starts unsent and unanswered', function () {
    var b = boot();
    var ss = b.P.sendState();
    t.assert.strictEqual(ss.sent, false);
    t.assert.strictEqual(ss.seq, 0);
    t.assert.strictEqual(ss.ack, 0);
    t.assert.strictEqual(b.P.answered(ss), false);
});

t.test('trackedResponder bumps seq and acks only the latest send', function () {
    var b = boot();
    var ss = b.P.sendState();
    var r1 = b.P.trackedResponder(ss, 'x', 'first');
    t.assert.strictEqual(ss.sent, true);
    t.assert.strictEqual(ss.seq, 1);
    var r2 = b.P.trackedResponder(ss, 'x', 'second');
    t.assert.strictEqual(ss.seq, 2);

    r1.onResult({});
    t.assert.strictEqual(ss.ack, 0);
    t.assert.strictEqual(b.P.answered(ss), false);

    r2.onResult({});
    t.assert.strictEqual(ss.ack, 2);
    t.assert.strictEqual(b.P.answered(ss), true);

    b.P.trackedResponder(ss, 'x', 'third');
    t.assert.strictEqual(b.P.answered(ss), false);
});

t.test('trackedResponder passes the result arguments to onData for the latest send only', function () {
    var b = boot();
    var ss = b.P.sendState();
    var got = [];
    var r1 = b.P.trackedResponder(ss, 'x', 'first', function (e, d) { got.push(['1', e, d]); });
    var r2 = b.P.trackedResponder(ss, 'x', 'second', function (e, d) { got.push(['2', e, d]); });
    r1.onResult('e1', 'd1');
    t.assert.strictEqual(got.length, 0);
    r2.onResult('e2', 'd2');
    t.assert.strictEqual(got.length, 1);
    t.assert.strictEqual(got[0][0], '2');
    t.assert.strictEqual(got[0][1], 'e2');
    t.assert.strictEqual(got[0][2], 'd2');
});

t.test('trackedResponder does not let a throwing onData escape', function () {
    var b = boot();
    var ss = b.P.sendState();
    var r = b.P.trackedResponder(ss, 'x', 'send', function () { throw new Error('boom'); });
    r.onResult({}, {});
    t.assert.strictEqual(b.P.answered(ss), true);
});

t.test('trackedResponder fault does not ack or call onData', function () {
    var b = boot();
    var ss = b.P.sendState();
    var called = false;
    var r = b.P.trackedResponder(ss, 'x', 'send', function () { called = true; });
    r.onFault({ fault: true });
    t.assert.strictEqual(ss.ack, 0);
    t.assert.strictEqual(called, false);
    t.assert.strictEqual(b.P.answered(ss), false);
});

t.test('trackedResponder without a host responder still counts the send', function () {
    var b = boot({ noResponder: true });
    var ss = b.P.sendState();
    t.assert.strictEqual(b.P.trackedResponder(ss, 'x', 'send'), null);
    t.assert.strictEqual(ss.sent, true);
    t.assert.strictEqual(ss.seq, 1);
    t.assert.strictEqual(b.P.answered(ss), false);
});
