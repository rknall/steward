'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var hostStubs = require('../stubs/host');
var jq = require('../stubs/jq');

var assert = t.assert;

function setup() {
    var fs = airfs.make();
    fs.dirs['C:/client/steward'] = true;
    fs.dirs['C:/client/steward/logs'] = true;
    var H = harness.boot({ sections: ['kernel'], host: { air: fs.air } });
    var $ = jq.install(H);
    var rig = hostStubs.installModal(H);
    return { H: H, $: $, rig: rig, ui: H.Steward.kernel.ui, S: H.Steward };
}

// Registers a module on a tab. `section` adds to the minimal valid one;
// `enabled` (true or false) stores an enabled flag so the module gets a
// switch and an On/Off state.
function mod(s, id, tab, section, enabled) {
    var sec = { id: id, title: id, heading: id, render: function () {} };
    for (var k in section) sec[k] = section[k];
    s.S.kernel.register({
        id: id, priority: 'PriorityNormal',
        isReady: function () { return true; }, plan: function () {},
        ui: { tab: tab, section: sec }
    });
    if (typeof enabled === 'boolean') s.H.settings.write(id, { enabled: enabled });
}

// The newest modal: each open makes a new one.
function body(s) { return s.rig.made[s.rig.made.length - 1].modal.Body(); }

function open(s, tab) {
    s.ui.openDashboard(tab);
    return body(s);
}

function tabIds($body) {
    var out = [];
    $body.find('.steward-tab').each(function (i, node) { out.push(node.attrs['data-tab']); });
    return out;
}

function tileTitles(s, $body) {
    var out = [];
    $body.find('.steward-tile-h').each(function (i, node) { out.push(s.$(node).text()); });
    return out;
}

function tile(s, $body, title) {
    var found = null;
    $body.find('.steward-tile').each(function (i, node) {
        if (s.$(node).find('.steward-tile-h').text() === title) found = s.$(node);
    });
    assert.ok(found, 'no tile ' + title);
    return found;
}

function errors(s) {
    return s.H.logs().filter(function (l) { return l.level === 'error'; })
        .map(function (l) { return l.args.join(' '); });
}

function one() { return [{ lines: ['x'] }]; }

// ---- Tab bar ----------------------------------------------------------------

t.test('the tab bar hides tabs without modules and keeps Overview', function () {
    var s = setup();
    assert.deepStrictEqual(tabIds(open(s)), ['overview']);
    s.ui.closeDashboard(false);

    mod(s, 'events', 'events', {});
    mod(s, 'miner', 'mining', {});
    mod(s, 'tools', 'misc', {});
    // Order follows TAB_ORDER, not registration; misc never gets a tab.
    assert.deepStrictEqual(tabIds(open(s)), ['overview', 'mining', 'events']);
    assert.strictEqual(s.ui.screen.state().tab, 'overview');
});

t.test('opening on a tab that is not shown falls back to Overview', function () {
    var s = setup();
    mod(s, 'miner', 'mining', {});
    open(s, 'geologists');
    assert.strictEqual(s.ui.screen.state().tab, 'overview');
});

// ---- Overview tiles ---------------------------------------------------------

t.test('tiles follow the tab order with misc modules just before Events', function () {
    var s = setup();
    mod(s, 'ev', 'events', { tiles: one });
    mod(s, 'tl', 'misc', { tiles: one });
    mod(s, 'mn', 'mining', { tiles: one });
    mod(s, 'ex', 'specialists', { tiles: one });
    mod(s, 'cl', 'buildings', { tiles: one });
    mod(s, 'gl', 'geologists', { tiles: one });
    mod(s, 'plain', 'mining', {});
    assert.deepStrictEqual(tileTitles(s, open(s)), ['ex', 'gl', 'mn', 'cl', 'tl', 'ev']);
});

t.test('a tile badge defaults to On, Off or Paused from the flag and the pause', function () {
    var s = setup();
    mod(s, 'on', 'specialists', { tiles: one }, true);
    mod(s, 'off', 'geologists', { tiles: one }, false);
    mod(s, 'flagless', 'mining', { tiles: one });
    var $body = open(s);
    assert.strictEqual(tile(s, $body, 'on').find('.steward-badge').text(), 'On');
    assert.strictEqual(tile(s, $body, 'off').find('.steward-badge').text(), 'Off');
    assert.strictEqual(tile(s, $body, 'flagless').find('.steward-badge').length, 0);

    s.ui.pause();
    s.ui.closeDashboard(false);
    $body = open(s);
    assert.strictEqual(tile(s, $body, 'on').find('.steward-badge').text(), 'Paused');
    assert.strictEqual(tile(s, $body, 'off').find('.steward-badge').text(), 'Paused');
});

t.test('an explicit tile badge wins over the default', function () {
    var s = setup();
    mod(s, 'ex', 'specialists', {
        tiles: function () { return [{ badge: { kind: 'warn', text: 'Busy' } }]; }
    }, true);
    var $badge = tile(s, open(s), 'ex').find('.steward-badge');
    assert.strictEqual($badge.text(), 'Busy');
    assert.ok($badge.hasClass('steward-b-warn'));
});

t.test('a tile switch is buffered until Save', function () {
    var s = setup();
    mod(s, 'ex', 'specialists', { tiles: one }, false);
    var $body = open(s);
    var $sw = tile(s, $body, 'ex').find('input');
    $sw.prop('checked', true);
    $sw.trigger('change');
    assert.strictEqual(s.H.settings.read('ex').enabled, false);
    assert.strictEqual(s.ui.bufferedSettings('ex').enabled, true);
    assert.strictEqual(s.ui.canSave(), true);
    s.ui.closeDashboard(true);
    assert.strictEqual(s.H.settings.read('ex').enabled, true);
});

t.test('the Automation switch pauses at once and buffers nothing', function () {
    var s = setup();
    var $body = open(s);
    var $sw = $body.find('.steward-stat').first().find('input');
    assert.strictEqual(s.ui.isPaused(), false);
    $sw.prop('checked', false);
    $sw.trigger('change');
    assert.strictEqual(s.ui.isPaused(), true);
    assert.strictEqual(s.ui.screen.changes().count, 0);
    assert.strictEqual(s.ui.canSave(), false);

    // The Overview is drawn again, so the switch is a new element.
    $sw = body(s).find('.steward-stat').first().find('input');
    $sw.prop('checked', true);
    $sw.trigger('change');
    assert.strictEqual(s.ui.isPaused(), false);
});

t.test('a tiles function that throws is skipped and logged', function () {
    var s = setup();
    mod(s, 'bad', 'specialists', { tiles: function () { throw new Error('nope'); } });
    mod(s, 'good', 'geologists', { tiles: one });
    s.H.clearLogs();
    assert.deepStrictEqual(tileTitles(s, open(s)), ['good']);
    assert.ok(errors(s).some(function (e) { return /tiles threw for bad/.test(e); }), errors(s).join('\n'));
});

// ---- Compact layout ---------------------------------------------------------

function sideMod(s) {
    mod(s, 'ex', 'specialists', {
        summary: function () { return 'two busy'; },
        side:    function ($el) { $el.append(s.$('<div>', { 'class': 'probe-side' })); },
        render:  function ($el) { $el.append(s.$('<div>', { 'class': 'probe-main' })); }
    }, true);
}

t.test('a full-size window shows the side column and no strip', function () {
    var s = setup();
    sideMod(s);
    var $body = open(s, 'specialists');
    assert.strictEqual($body.find('.steward-strip').length, 0);
    assert.strictEqual($body.find('.probe-side').length, 1);
    assert.strictEqual($body.find('.probe-main').length, 1);
});

t.test('a short window folds the side column into a strip until Show settings', function () {
    var s = setup();
    sideMod(s);
    jq.setWindowHeight(640);
    var $body = open(s, 'specialists');
    assert.strictEqual($body.find('.steward-strip').length, 1);
    assert.strictEqual($body.find('.steward-strip-sum').text(), 'two busy');
    assert.strictEqual($body.find('.probe-side').length, 0);
    assert.strictEqual($body.find('.probe-main').length, 1);
    assert.strictEqual($body.find('.steward-strip-link').text(), 'Show settings');

    $body.find('.steward-strip-link').trigger('click');
    assert.strictEqual($body.find('.probe-side').length, 1);
    assert.strictEqual($body.find('.steward-strip-link').text(), 'Hide settings');
});

t.test('a render that throws shows an empty state and logs the module', function () {
    var s = setup();
    mod(s, 'ex', 'specialists', { render: function () { throw new Error('boom'); } });
    s.H.clearLogs();
    var $body = open(s, 'specialists');
    assert.strictEqual($body.find('.steward-empty-title').text(), 'Render failed');
    assert.ok(errors(s).some(function (e) { return /render threw for ex/.test(e); }));
});

// ---- Tab change marks -------------------------------------------------------

function chgMark($body, tab) {
    return $body.find('.steward-tab[data-tab="' + tab + '"]').find('.steward-tab-chg');
}

t.test('a tab shows its change mark after a change and drops it after a revert', function () {
    var s = setup();
    mod(s, 'ex', 'specialists', { tiles: one }, false);
    var $body = open(s);
    var $mark = chgMark($body, 'specialists');
    assert.strictEqual($mark.length, 1);
    assert.strictEqual($mark.css('display'), 'none');

    var $sw = tile(s, $body, 'ex').find('input');
    $sw.prop('checked', true);
    $sw.trigger('change');
    assert.strictEqual(s.ui.screen.changes().byNs.ex, 1);
    assert.strictEqual(chgMark(body(s), 'specialists').css('display'), '');

    // Switching back to the stored value is no change at all.
    $sw = tile(s, body(s), 'ex').find('input');
    $sw.prop('checked', false);
    $sw.trigger('change');
    assert.strictEqual(s.ui.screen.changes().count, 0);
    assert.strictEqual(chgMark(body(s), 'specialists').css('display'), 'none');
});

// ---- Fill sizing ------------------------------------------------------------

t.test('sizeFills on a panel whose elements lack offset does not throw', function () {
    var s = setup();
    var views = s.ui.views.dashboard;
    var $panel = s.$('<div>');
    $panel.append(s.$('<div>', { 'class': 'steward-fill' }));
    $panel.offset = undefined;
    views.sizeFills($panel);
    assert.strictEqual(views.sizeFills(null), undefined);

    var bare = { length: 1, css: function () { return ''; } };
    views.sizeFills(bare);
});

// Puts each modal's Body inside a `.modal` element, as the host's Modal does,
// so the view can find the element Bootstrap fires shown.bs.modal on. The
// wrapper starts hidden, like a modal rendered before Modal.show(), unless
// `visible` is true.
function wrapBodies(s, visible) {
    var proto = s.H.ctx.Modal.prototype;
    var plain = proto.Body;
    proto.Body = function () {
        var $b = plain.call(this);
        if ($b.length && !$b[0].parent) {
            var $m = s.$('<div>', { 'class': 'modal' });
            $m[0].visible = visible === true;
            $m.append($b);
        }
        return $b;
    };
}

t.test('fills are sized on the modal shown event, not at render', function () {
    var s = setup();
    wrapBodies(s);
    mod(s, 'ex', 'specialists', {
        render: function ($el) { $el.append(s.$('<div>', { 'class': 'steward-fill' })); }
    });
    var $body = open(s, 'specialists');
    var $modal = $body.closest('.modal');
    var $fill = $body.find('.steward-fill');
    assert.strictEqual($modal.length, 1);
    assert.strictEqual($fill.length, 1);
    // Measured while hidden every offset reads zero, so the fill only gets
    // the minimum.
    assert.strictEqual($fill.css('height'), '80px');

    // Laid out once visible: the panel spans 100..700, the fill starts at 200.
    var $panel = $body.find('.steward-panel');
    $panel[0].top = 100;
    $panel[0].h = 600;
    $fill[0].top = 200;
    assert.strictEqual($fill.css('height'), '80px');
    $modal.trigger('shown.bs.modal');
    assert.strictEqual($fill.css('height'), '498px');

    // The handler runs once: a later shown event leaves the size alone.
    $fill[0].top = 300;
    $modal.trigger('shown.bs.modal');
    assert.strictEqual($fill.css('height'), '498px');
});

t.test('an already visible modal binds no shown handler', function () {
    function shownCount(visible) {
        var s = setup();
        wrapBodies(s, visible);
        mod(s, 'ex', 'specialists', {
            render: function ($el) { $el.append(s.$('<div>', { 'class': 'steward-fill' })); }
        });
        var $modal = open(s, 'specialists').closest('.modal');
        return ($modal[0].handlers.shown || []).length;
    }
    assert.strictEqual(shownCount(false), 1);
    assert.strictEqual(shownCount(true), 0);
});
