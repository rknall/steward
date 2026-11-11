'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var hostStubs = require('../stubs/host');
var jq = require('../stubs/jq');

var assert = t.assert;

var DASH = 'StewardDashboard';

function setup() {
    var fs = airfs.make();
    fs.dirs['C:/client/steward'] = true;
    fs.dirs['C:/client/steward/logs'] = true;
    var H = harness.boot({ sections: ['kernel'], host: { air: fs.air } });
    var $ = jq.install(H);
    var rig = hostStubs.installModal(H, { host: true });
    H.Steward.kernel.ui.ensureStyle = function () {};
    return { H: H, $: $, rig: rig, ui: H.Steward.kernel.ui, S: H.Steward };
}

function errors(s) {
    return s.H.logs().filter(function (l) { return l.level === 'error'; })
        .map(function (l) { return l.args.join(' '); });
}

// A host modal that is created but not yet shown.
function made(s, id) {
    var m = new s.H.ctx.Modal(id, id, true);
    m.create();
    return m;
}

function clickClose(s) {
    s.rig.element(DASH).find('.steward-foot-right').trigger('click');
}

t.test('isModalShown follows the Bootstrap state through hide and removal', function () {
    var s = setup();
    assert.strictEqual(s.ui.isModalShown(null), false);
    assert.strictEqual(s.ui.isModalShown(new s.H.ctx.Modal('Never', 'x', true)), false);
    var m = made(s, 'Probe');
    assert.strictEqual(s.ui.isModalShown(m), false);
    s.ui.showModal(m);
    assert.strictEqual(s.ui.isModalShown(m), true);
    s.ui.hideModal(m);
    assert.strictEqual(s.ui.isModalShown(m), false);
    s.rig.flushFades();
    assert.strictEqual(s.ui.isModalShown(m), false);
    assert.strictEqual(s.rig.element('Probe'), null);
    var m2 = made(s, 'Probe2');
    s.ui.showModal(m2);
    delete s.H.ctx.$;
    assert.strictEqual(s.ui.isModalShown(m2), false);
});

t.test('hideModal hides a shown modal once and ignores a fading one', function () {
    var s = setup();
    var m = made(s, 'Probe');
    s.ui.showModal(m);
    assert.strictEqual(s.rig.swaps, 1);
    assert.strictEqual(s.ui.hideModal(m), true);
    assert.strictEqual(s.rig.swaps, 2);
    assert.strictEqual(s.ui.hideModal(m), false);
    assert.strictEqual(s.rig.swaps, 2);
    assert.strictEqual(s.rig.balanced(), true);
});

t.test('the rig reproduces the wedge: a raw hide before another show', function () {
    var s = setup();
    var a = made(s, 'A');
    var b = made(s, 'B');
    a.show();
    a.hide();
    b.show();
    assert.strictEqual(s.rig.balanced(), false);
});

t.test('Close twice during the fade stays balanced and the dashboard reopens', function () {
    var s = setup();
    s.ui.openDashboard();
    assert.strictEqual(s.rig.isShown(DASH), true);
    clickClose(s);
    clickClose(s);
    assert.strictEqual(s.rig.swaps, 2);
    assert.strictEqual(s.rig.balanced(), true);
    s.rig.flushFades();
    s.ui.openDashboard();
    assert.strictEqual(s.rig.balanced(), true);
    assert.strictEqual(s.rig.isShown(DASH), true);
    assert.deepStrictEqual(errors(s), []);
});

t.test('releaseDashboard resets the buffer without a hide', function () {
    var s = setup();
    s.H.settings.write('logging', { probe: 1 });
    s.ui.openDashboard();
    assert.strictEqual(s.ui.bufferedSettings('logging').probe, 1);
    var swaps = s.rig.swaps;
    s.ui.releaseDashboard();
    assert.strictEqual(s.ui.screen.modal(), null);
    s.H.settings.write('logging', { probe: 2 });
    assert.strictEqual(s.ui.bufferedSettings('logging').probe, 2);
    assert.strictEqual(s.rig.isShown(DASH), true);
    assert.strictEqual(s.rig.swaps, swaps);
});

t.test('showModal settles a fading dialog so the host does not hide it twice', function () {
    var s = setup();
    s.ui.openDashboard();
    clickClose(s);
    s.ui.openSettings();
    assert.strictEqual(s.rig.balanced(), true);
    assert.strictEqual(s.rig.isShown('StewardSettings'), true);
    assert.strictEqual(s.rig.element(DASH).is(':visible'), false);
    s.rig.flushFades();
    assert.strictEqual(s.rig.balanced(), true);
    assert.strictEqual(s.rig.element(DASH), null);
});

t.test('opening a second screen with no close leaves one shown and balanced', function () {
    var s = setup();
    s.ui.openDashboard();
    s.ui.openSettings();
    assert.strictEqual(s.rig.balanced(), true);
    assert.deepStrictEqual(s.rig.shownIds(), ['StewardSettings']);
    assert.deepStrictEqual(errors(s), []);
});

t.test('reopening the same id during its own fade shows nothing and stays balanced', function () {
    var s = setup();
    s.ui.openDashboard();
    clickClose(s);
    s.ui.openDashboard();
    assert.strictEqual(s.rig.balanced(), true);
    s.rig.flushFades();
    assert.strictEqual(s.rig.balanced(), true);
    s.ui.openDashboard();
    assert.strictEqual(s.rig.isShown(DASH), true);
    assert.strictEqual(s.rig.balanced(), true);
});

t.test('a window hidden with unsaved edits no longer blocks opening, even while fading', function () {
    var s = setup();
    s.ui.openSettings();
    s.ui.helpers.update('logger', { keepRotated: 2 });
    assert.strictEqual(s.ui.hasOpenEdits(), true);
    var modal = s.ui.screen.modal();
    s.ui.hideModal(modal);
    assert.strictEqual(s.ui.hasOpenEdits(), false);
    var alerts = [];
    s.H.ctx.alert = function (m) { alerts.push(m); };
    s.ui.openDashboard();
    assert.strictEqual(s.rig.isShown(DASH), true);
    assert.deepStrictEqual(alerts.filter(function (a) { return /Save or close/.test(a); }), []);
    s.rig.flushFades();
    assert.strictEqual(s.rig.balanced(), true);
});

t.test('the helpers no-op without $ or Modal', function () {
    var s = setup();
    var m = made(s, 'Probe');
    delete s.H.ctx.$;
    assert.strictEqual(s.ui.isModalShown(m), false);
    assert.strictEqual(s.ui.hideModal(m), false);
    s.ui.showModal(m);
    s.ui.releaseDashboard();
    delete s.H.ctx.Modal;
    s.ui.openDashboard();
    assert.strictEqual(s.ui.hideModal(null), false);
    assert.ok(errors(s).every(function (e) { return /Modal class unavailable/.test(e); }), errors(s).join('\n'));
});

// The ui lines of one level whose text matches re.
function lines(s, level, re) {
    return s.H.logs().filter(function (l) {
        return l.level === level && l.category === 'ui' && re.test(l.args.join(' '));
    }).map(function (l) { return l.args.join(' '); });
}

var SECOND_HIDE = /^second hide of /;

t.test('the dashboard logs window shown, and Close logs one window hidden', function () {
    var s = setup();
    s.ui.openDashboard();
    assert.deepStrictEqual(lines(s, 'log', /^window shown/), ['window shown: ' + DASH]);
    clickClose(s);
    clickClose(s);
    assert.deepStrictEqual(lines(s, 'log', /^window hidden/), ['window hidden: ' + DASH]);
    assert.deepStrictEqual(lines(s, 'warn', SECOND_HIDE), []);
});

t.test('the header X twice during the fade warns once for the second hide', function () {
    var s = setup();
    s.ui.openDashboard();
    s.rig.dismiss(DASH);
    s.rig.dismiss(DASH);
    assert.strictEqual(s.rig.balanced(), false);
    assert.deepStrictEqual(lines(s, 'log', /^window hidden/), ['window hidden: ' + DASH]);
    var warns = lines(s, 'warn', SECOND_HIDE);
    assert.strictEqual(warns.length, 1);
    assert.strictEqual(warns[0], 'second hide of ' + DASH + ' while it closes: the game may now '
        + 'cover steward windows; restart the client if the game stops reacting');
});

t.test('a second screen over the dashboard logs the host hide without a warning', function () {
    var s = setup();
    s.ui.openDashboard();
    s.ui.openSettings();
    assert.deepStrictEqual(lines(s, 'log', /^window hidden/), ['window hidden: ' + DASH]);
    assert.deepStrictEqual(lines(s, 'log', /^window shown/),
        ['window shown: ' + DASH, 'window shown: StewardSettings']);
    assert.deepStrictEqual(lines(s, 'warn', SECOND_HIDE), []);
});

t.test('reopening the same id during its own fade logs a show with no effect', function () {
    var s = setup();
    s.ui.openDashboard();
    clickClose(s);
    s.ui.openDashboard();
    assert.deepStrictEqual(lines(s, 'log', /^window show had no effect/),
        ['window show had no effect: ' + DASH + ' (still closing)']);
});

t.test('two shows of one persistent element bind one watcher', function () {
    var s = setup();
    var m = new s.H.ctx.Modal('Keep', 'Keep', false);
    m.create();
    s.ui.showModal(m);
    s.ui.hideModal(m);
    s.rig.flushFades();
    assert.ok(s.rig.element('Keep'));
    s.ui.showModal(m);
    assert.strictEqual(s.rig.isShown('Keep'), true);
    assert.strictEqual(lines(s, 'log', /^window hidden/).length, 1);
    s.ui.hideModal(m);
    assert.deepStrictEqual(lines(s, 'log', /^window hidden/),
        ['window hidden: Keep', 'window hidden: Keep']);
    assert.deepStrictEqual(lines(s, 'debug', /^hide skipped/), []);
    s.ui.hideModal(m);
    assert.deepStrictEqual(lines(s, 'debug', /^hide skipped/), ['hide skipped, not shown: Keep']);
});

t.test('showModal over a fading dialog writes the settled debug line', function () {
    var s = setup();
    s.ui.openDashboard();
    assert.deepStrictEqual(lines(s, 'debug', /^settled /), []);
    clickClose(s);
    s.ui.openSettings();
    assert.deepStrictEqual(lines(s, 'debug', /^settled /),
        ['settled 1 closing dialog(s) before showing StewardSettings']);
});

t.test('the screen build label is the kernel one', function () {
    var s = setup();
    assert.strictEqual(s.ui.screen.buildLabel(), s.S.kernel.buildLabel());
});
