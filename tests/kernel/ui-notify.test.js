'use strict';

var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup(host) {
    var alerts = [];
    var h = host || { showGameAlert: function (msg) { alerts.push(msg); } };
    var H = harness.boot({ sections: ['kernel'], host: h });
    return { H: H, alerts: alerts, ui: H.Steward.kernel.ui };
}

t.test('notify: empty or non-string text shows nothing', function () {
    var s = setup();
    s.ui.notify('');
    s.ui.notify(null);
    s.ui.notify(undefined);
    s.ui.notify(42);
    assert.deepStrictEqual(plain(s.alerts), []);
});

t.test('notify: text shows with the Steward prefix', function () {
    var s = setup();
    s.ui.notify('x');
    assert.deepStrictEqual(plain(s.alerts), ['Steward: x']);
});

t.test('notify: a missing showGameAlert is a no-op', function () {
    var s = setup({});
    s.ui.notify('x');
});
