'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var hostStubs = require('../stubs/host');
var jq = require('../stubs/jq');

var assert = t.assert;

var LOGDIR = 'C:/client/steward/logs';

// Objects built inside the vm context carry that realm's prototypes, so
// deepStrictEqual compares a plain copy.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup() {
    var fs = airfs.make();
    fs.dirs['C:/client/steward'] = true;
    fs.dirs[LOGDIR] = true;
    var alerts = [];
    var H = harness.boot({
        sections: ['kernel'],
        host: { air: fs.air, showGameAlert: function (msg) { alerts.push(msg); } }
    });
    return { fs: fs, H: H, alerts: alerts, ui: H.Steward.kernel.ui, S: H.Steward };
}

function seedRotated(s, count) {
    for (var n = 1; n <= count; n++) s.fs.disk[LOGDIR + '/console.log.' + n] = 'old ' + n;
}

function rotatedOnDisk(s) {
    return Object.keys(s.fs.disk).filter(function (p) {
        return /console\.log\.\d+$/.test(p);
    }).length;
}

// ---- Save and Close ---------------------------------------------------------

t.test('Save applies logger settings at once', function () {
    var s = setup();
    seedRotated(s, 4);
    s.ui.helpers.update('logger', { keepRotated: 1 });
    s.ui.closeDashboard(true);
    assert.strictEqual(s.H.settings.read('logger').keepRotated, 1);
    assert.strictEqual(rotatedOnDisk(s), 1);
    assert.ok(s.fs.disk[LOGDIR + '/console.log.1'] !== undefined);
    assert.strictEqual(s.S.kernel.log.effective().keepRotated, 1);
});

t.test('Save applies the tick interval', function () {
    var s = setup();
    s.ui.helpers.update('scheduler', { tickInterval: 20000 });
    s.ui.closeDashboard(true);
    assert.strictEqual(s.H.settings.read('scheduler').tickInterval, 20000);
    assert.strictEqual(s.S.kernel.scheduler.state.tickIntervalMs, 20000);
});

t.test('Close discards', function () {
    var s = setup();
    seedRotated(s, 4);
    var keepBefore = s.S.kernel.log.effective().keepRotated;
    var tickBefore = s.S.kernel.scheduler.state.tickIntervalMs;
    s.ui.helpers.update('logger', { keepRotated: 1 });
    s.ui.helpers.update('scheduler', { tickInterval: 20000 });
    s.ui.closeDashboard(false);
    assert.strictEqual(s.H.settings.read('logger'), null);
    assert.strictEqual(s.H.settings.read('scheduler'), null);
    assert.strictEqual(s.S.kernel.log.effective().keepRotated, keepBefore);
    assert.strictEqual(s.S.kernel.scheduler.state.tickIntervalMs, tickBefore);
    assert.strictEqual(rotatedOnDisk(s), 4);
});

t.test('h.update on a misc module id goes through the shared buffer and saves', function () {
    var s = setup();
    s.S.kernel.register({
        id: 'zeta', priority: 'PriorityNormal',
        isReady: function () { return true; }, plan: function () {},
        ui: { tab: 'misc', section: { id: 'zeta', title: 'Zeta', render: function () {} } }
    });
    s.H.settings.write('zeta', { keep: 'me' });
    s.ui.helpers.update('zeta', { probe: 1 });
    assert.strictEqual(s.ui.bufferedSettings('zeta').probe, 1);
    assert.strictEqual(s.H.settings.read('zeta').probe, undefined);
    s.ui.closeDashboard(true);
    assert.deepStrictEqual(plain(s.H.settings.read('zeta')), { keep: 'me', probe: 1 });
});

// ---- Typing enables Save ----------------------------------------------------

// Every $() in the host stub returns the shared $.fn, so patching its `on`
// records the handlers of whichever element h.input builds next.
function recordHandlers(s) {
    var handlers = {};
    s.H.ctx.$.fn.on = function (ev, fn) {
        (handlers[ev] = handlers[ev] || []).push(fn);
        return s.H.ctx.$.fn;
    };
    return handlers;
}

t.test('typing into a bound input enables Save before blur', function () {
    var s = setup();
    var handlers = recordHandlers(s);
    assert.strictEqual(s.ui.canSave(), false);
    s.ui.helpers.input({ onChange: function () {} });
    assert.strictEqual(handlers.input.length, 1);
    handlers.input[0]();
    assert.strictEqual(s.ui.canSave(), true);
    // Typing alone marks nothing dirty, so closing writes nothing.
    s.ui.closeDashboard(true);
    assert.strictEqual(s.alerts.length, 0);
    assert.strictEqual(s.H.settings.read('logger'), null);
    assert.strictEqual(s.ui.canSave(), false);
});

t.test('an unbound input adds no typing hook', function () {
    var s = setup();
    var handlers = recordHandlers(s);
    s.ui.helpers.input({});
    assert.strictEqual(handlers.input, undefined);
});

t.test('typing then the blur change saves on the first Save', function () {
    var s = setup();
    var handlers = recordHandlers(s);
    s.S.kernel.register({
        id: 'zeta', priority: 'PriorityNormal',
        isReady: function () { return true; }, plan: function () {},
        ui: { tab: 'misc', section: { id: 'zeta', title: 'Zeta', render: function () {} } }
    });
    s.ui.helpers.input({ onChange: function () { s.ui.helpers.update('zeta', { probe: 1 }); } });
    handlers.input[0]();
    assert.strictEqual(s.ui.canSave(), true);
    handlers.change[0]();
    s.ui.closeDashboard(true);
    assert.strictEqual(s.H.settings.read('zeta').probe, 1);
    assert.strictEqual(s.ui.canSave(), false);
});

t.test('a typing-only edit neither blocks opening nor survives it', function () {
    var s = setup();
    var handlers = recordHandlers(s);
    var rig = hostStubs.installModal(s.H);
    s.ui.openSettings();
    rig.visible = true;
    s.ui.helpers.input({ onChange: function () {} });
    handlers.input[0]();
    assert.strictEqual(s.ui.canSave(), true);

    s.ui.openDashboard();
    assert.strictEqual(rig.made.length, 2);
    assert.strictEqual(s.alerts.length, 0);
    assert.strictEqual(s.ui.canSave(), false);
});

// ---- Parsers ----------------------------------------------------------------

t.test('settingsParse sizeKB, whole and tickMs', function () {
    var K = harness.boot({ sections: ['kernel'] }).Steward.kernel;
    var p = K.ui.settingsParse;
    var min = K.TIMEOUTS.TICK_INTERVAL_MIN_MS;

    assert.strictEqual(p.sizeKB('2'), 2048);
    assert.strictEqual(p.sizeKB(' 1.5 '), 1536);
    assert.strictEqual(p.sizeKB('0'), 0);
    assert.strictEqual(p.sizeKB(''), null);
    assert.strictEqual(p.sizeKB('   '), null);
    assert.strictEqual(p.sizeKB('-1'), null);
    assert.strictEqual(p.sizeKB('abc'), null);

    assert.strictEqual(p.whole('3'), 3);
    assert.strictEqual(p.whole('2.7'), 2);
    assert.strictEqual(p.whole('0'), 0);
    assert.strictEqual(p.whole(''), null);
    assert.strictEqual(p.whole('-1'), null);
    assert.strictEqual(p.whole('many'), null);
    assert.strictEqual(p.keep, undefined);

    assert.strictEqual(p.tickMs('20'), 20000);
    assert.strictEqual(p.tickMs('12.5'), 12500);
    assert.strictEqual(p.tickMs('5'), min);
    assert.strictEqual(p.tickMs('0'), min);
    assert.strictEqual(p.tickMs(''), null);
    assert.strictEqual(p.tickMs('-3'), null);
    assert.strictEqual(p.tickMs('soon'), null);
});

// ---- Opening ----------------------------------------------------------------

t.test('openSettings opens the StewardSettings modal', function () {
    var s = setup();
    var rig = hostStubs.installModal(s.H);
    s.ui.openSettings();
    assert.strictEqual(rig.made.length, 1);
    assert.strictEqual(rig.made[0].id, 'StewardSettings');
    assert.strictEqual(rig.made[0].title, 'Steward settings');
    assert.strictEqual(rig.made[0].closable, true);
});

t.test('opening is refused while the open screen has unsaved edits', function () {
    var s = setup();
    var rig = hostStubs.installModal(s.H);
    s.ui.openSettings();
    rig.visible = true;
    s.ui.helpers.update('logger', { keepRotated: 2 });

    s.ui.openSettings();
    s.ui.openDashboard();
    assert.strictEqual(rig.made.length, 1);
    assert.strictEqual(s.alerts.length, 2);
    assert.ok(/Save or close/.test(s.alerts[0]));
    // The refused open must not have dropped the edit.
    assert.strictEqual(s.ui.bufferedSettings('logger').keepRotated, 2);
});

t.test('stale dirty state does not block opening', function () {
    var s = setup();
    var rig = hostStubs.installModal(s.H);
    s.ui.openSettings();
    rig.visible = false;
    s.ui.helpers.update('logger', { keepRotated: 2 });

    s.ui.openDashboard();
    assert.strictEqual(rig.made.length, 2);
    assert.strictEqual(rig.made[1].id, 'StewardDashboard');
    assert.strictEqual(rig.made[1].title, 'Steward');
    assert.strictEqual(s.alerts.length, 0);
    s.ui.openSettings();
    assert.strictEqual(rig.made.length, 3);
    assert.strictEqual(s.alerts.length, 0);
});

t.test('open failures name the screen', function () {
    var s = setup();
    function errorText() {
        return s.H.logs().filter(function (l) {
            return l.level === 'error';
        }).map(function (l) { return l.args.join(' '); }).join('\n');
    }

    s.H.clearLogs();
    s.ui.openDashboard();
    s.ui.openSettings();
    var text = errorText();
    assert.ok(/cannot open dashboard/.test(text), text);
    assert.ok(/cannot open settings/.test(text), text);

    hostStubs.installModal(s.H);
    s.H.ctx.Modal.prototype.create = function () { throw new Error('boom'); };
    s.H.clearLogs();
    s.ui.openDashboard();
    s.ui.openSettings();
    text = errorText();
    assert.ok(/openDashboard threw/.test(text), text);
    assert.ok(/openSettings threw/.test(text), text);
});

// ---- Tabs -------------------------------------------------------------------

t.test('TAB_ORDER has no tools or misc and every other id is overview or a known tab', function () {
    var s = setup();
    var ids = s.ui.TAB_ORDER.map(function (tab) { return tab.id; });
    assert.strictEqual(ids.indexOf('tools'), -1);
    assert.strictEqual(ids.indexOf('misc'), -1);
    for (var i = 0; i < ids.length; i++) {
        assert.ok(ids[i] === 'overview' || s.S.kernel.registry.TABS[ids[i]] === true, ids[i]);
    }
});

// ---- Screens built on the element-tree fake --------------------------------

function setupJq() {
    var s = setup();
    s.$ = jq.install(s.H);
    s.rig = hostStubs.installModal(s.H);
    return s;
}

function bodyOf(s, i) { return s.rig.made[i || 0].modal.Body(); }
function footerOf(s, i) { return s.rig.made[i || 0].modal.Footer(); }

function misc(s, id, heading, extra) {
    var section = { id: id, title: heading, heading: heading, render: function () {} };
    for (var k in extra) section[k] = extra[k];
    s.S.kernel.register({
        id: id, priority: 'PriorityNormal',
        isReady: function () { return true; }, plan: function () {},
        ui: { tab: 'misc', section: section }
    });
}

// The checkbox of the settings field with this label.
function fieldControl(s, label) {
    var found = null;
    bodyOf(s).find('.steward-field').each(function (i, node) {
        var $f = s.$(node);
        if ($f.find('.steward-field-name').text() === label) found = $f;
    });
    assert.ok(found, 'no field ' + label);
    return found.find('input');
}

function flip($input) {
    $input.prop('checked', !$input.prop('checked'));
    $input.trigger('change');
}

function alertsMatching(s, re) {
    return s.alerts.filter(function (a) { return re.test(a); });
}

t.test('the screens carry the user-facing titles', function () {
    var s = setupJq();
    s.ui.openDashboard();
    s.ui.closeDashboard(false);
    s.ui.openSettings();
    assert.strictEqual(s.rig.made[0].title, 'Steward');
    assert.strictEqual(s.rig.made[1].title, 'Steward settings');
});

t.test('Close with changes says so, and without changes says nothing', function () {
    var s = setupJq();
    s.ui.openSettings();
    s.ui.closeDashboard(false);
    assert.strictEqual(s.alerts.length, 0);

    s.ui.openSettings();
    s.ui.helpers.update('logger', { keepRotated: 1 });
    s.ui.closeDashboard(false);
    assert.strictEqual(alertsMatching(s, /Changes discarded/).length, 1);
    assert.strictEqual(s.H.settings.read('logger'), null);
});

t.test('the change count and names cover the logger and a misc module', function () {
    var s = setup();
    misc(s, 'zeta', 'Zeta', {});
    s.H.settings.write('zeta', { keep: 'me' });
    assert.strictEqual(s.ui.screen.changes().count, 0);

    s.ui.helpers.update('logger', { keepRotated: 1, debugEnabled: true });
    s.ui.helpers.update('zeta', { probe: 1 });
    var c = s.ui.screen.changes();
    assert.strictEqual(c.count, 3);
    assert.deepStrictEqual(plain(c.names), ['Logging', 'Zeta']);
    assert.strictEqual(c.byNs.logger, 2);
    assert.strictEqual(c.byNs.zeta, 1);
});

t.test('reverting an edit clears the count and Save', function () {
    var s = setup();
    s.H.settings.write('zeta', { keep: 'me' });
    s.ui.helpers.update('zeta', { probe: 1 });
    assert.strictEqual(s.ui.screen.changes().count, 1);
    assert.strictEqual(s.ui.canSave(), true);
    s.ui.helpers.update('zeta', function (v) { delete v.probe; });
    assert.strictEqual(s.ui.screen.changes().count, 0);
    assert.strictEqual(s.ui.canSave(), false);
});

t.test('a logger toggle flipped twice counts no change', function () {
    var s = setupJq();
    s.ui.openSettings();
    var $sw = fieldControl(s, 'Include debug lines');
    flip($sw);
    assert.strictEqual(s.ui.screen.changes().count, 1);
    assert.ok(/1 unsaved change/.test(footerOf(s).text()), footerOf(s).text());
    flip($sw);
    assert.strictEqual(s.ui.screen.changes().count, 0);
    assert.strictEqual(s.ui.canSave(), false);
});

t.test('Save writes only the namespaces that changed', function () {
    var s = setupJq();
    s.ui.openSettings();
    flip(fieldControl(s, 'Include debug lines'));
    footerOf(s).find('button').first().trigger('click');
    assert.notStrictEqual(s.H.settings.read('logger'), null);
    assert.strictEqual(s.H.settings.read('scheduler'), null);
    assert.strictEqual(alertsMatching(s, /Configuration saved/).length, 1);
});

t.test('the footer Save is updated in place, never rebuilt', function () {
    var s = setupJq();
    s.ui.openSettings();
    var before = footerOf(s).find('button')[0];
    assert.strictEqual(before.props.disabled, true);
    flip(fieldControl(s, 'Include debug lines'));
    var after = footerOf(s).find('button')[0];
    assert.strictEqual(after, before);
    assert.strictEqual(after.props.disabled, false);
    assert.ok(after.cls.indexOf('steward-primary') >= 0);
});

t.test('an open screen with edits blocks both screens, a throwing guard does not', function () {
    var s = setupJq();
    s.ui.openSettings();
    s.rig.visible = true;
    s.ui.helpers.update('logger', { keepRotated: 2 });
    s.ui.openDashboard();
    s.ui.openSettings('general');
    assert.strictEqual(s.rig.made.length, 1);
    assert.strictEqual(alertsMatching(s, /Save or close/).length, 2);

    s.ui.closeDashboard(false);
    s.ui.addEditGuard('win', function () { return true; });
    s.ui.openDashboard();
    assert.strictEqual(s.rig.made.length, 1);
    s.ui.addEditGuard('win', function () { throw new Error('broken window'); });
    s.H.clearLogs();
    s.ui.openDashboard();
    assert.strictEqual(s.rig.made.length, 2);
    assert.ok(s.H.logs().some(function (l) {
        return l.level === 'error' && /edit guard threw for win/.test(l.args.join(' '));
    }));
    s.ui.addEditGuard('win', null);
});

t.test('openSettings(group) selects the group, an unknown one falls back to General', function () {
    var s = setupJq();
    misc(s, 'adventures', 'Adventures', {});
    s.ui.openSettings('adventures');
    assert.strictEqual(s.ui.screen.state().group, 'adventures');
    assert.strictEqual(bodyOf(s).find('.steward-snav-item.active').children('span').first().text(), 'Adventures');
    s.ui.closeDashboard(false);

    s.ui.openSettings('nope');
    assert.strictEqual(s.ui.screen.state().group, 'general');
    assert.strictEqual(bodyOf(s, 1).find('.steward-snav-item.active').children('span').first().text(), 'General');
});

t.test('a runsNow group is listed apart and replaces the idle note', function () {
    var s = setupJq();
    misc(s, 'tools', 'Diagnostics tools', { runsNow: true });
    s.ui.openSettings();
    assert.strictEqual(bodyOf(s).find('.steward-snav-grp').text(), 'RUNS AT ONCE');
    assert.strictEqual(footerOf(s).find('.steward-foot-note').text(),
        'No changes. Settings apply when you press Save.');

    bodyOf(s).find('.steward-snav-item').last().trigger('click');
    assert.strictEqual(s.ui.screen.state().group, 'tools');
    assert.strictEqual(footerOf(s).find('.steward-foot-note').text(), 'Diagnostics tools don\'t use Save.');
    assert.strictEqual(bodyOf(s).find('.steward-main').hasClass('steward-narrow'), false);
});

t.test('the Logging and Scheduler cards are titled by the shell\'s names', function () {
    var s = setupJq();
    s.ui.openSettings();
    var titles = [];
    bodyOf(s).find('.steward-card-h span').each(function (i, node) {
        titles.push(s.$(node).text());
    });
    assert.ok(titles.indexOf(s.ui.screen.nsName('logger')) >= 0, titles.join('|'));
    assert.ok(titles.indexOf(s.ui.screen.nsName('scheduler')) >= 0, titles.join('|'));
});
