'use strict';

var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');

// The harness runs the bundle in its own vm realm; copy its arrays into
// this realm so deepStrictEqual compares values, not prototypes.
function plain(arr) { return JSON.parse(JSON.stringify(arr)); }

function ui() {
    return harness.boot({ sections: ['kernel'] }).Steward.kernel.ui;
}

t.test('scopeCss prefixes a rule with one id', function () {
    var css = ui().scopeCss(['.a{color:red;}'], ['X']);
    t.assert.strictEqual(css, '#X .a{color:red;}');
});

t.test('scopeCss emits every id for every selector', function () {
    var css = ui().scopeCss(['.a, .b{color:red;}', '.c{x:1;}'], ['X', 'Y']);
    t.assert.strictEqual(css,
        '#X .a,#X .b,#Y .a,#Y .b{color:red;}' +
        '#X .c,#Y .c{x:1;}');
});

t.test('scopeCss leaves commas inside the body intact', function () {
    var body = '{background:linear-gradient(180deg,#a 0%,#b 100%);}';
    var css = ui().scopeCss(['.btn' + body], ['X', 'Y']);
    t.assert.strictEqual(css, '#X .btn,#Y .btn' + body);
});

t.test('mergeScopes with no attribute starts with the dashboard', function () {
    var u = ui();
    t.assert.deepStrictEqual(plain(u.mergeScopes(null, 'StewardDashboard')), ['StewardDashboard']);
    t.assert.deepStrictEqual(plain(u.mergeScopes(null, 'StewardAdventures')),
        ['StewardDashboard', 'StewardAdventures']);
});

t.test('the dashboard modal id is exported and leads every merged scope list', function () {
    var u = ui();
    t.assert.strictEqual(u.DASHBOARD_MODAL_ID, 'StewardDashboard');
    t.assert.strictEqual(plain(u.mergeScopes('X', 'Y'))[0], u.DASHBOARD_MODAL_ID);
});

t.test('mergeScopes does not duplicate a recorded id', function () {
    var out = plain(ui().mergeScopes('StewardDashboard,StewardAdventures', 'StewardAdventures'));
    t.assert.deepStrictEqual(out, ['StewardDashboard', 'StewardAdventures']);
});

t.test('mergeScopes puts the dashboard first when the attribute lacks it', function () {
    var out = plain(ui().mergeScopes('StewardAdventures', 'StewardDashboard'));
    t.assert.deepStrictEqual(out, ['StewardDashboard', 'StewardAdventures']);
});

t.test('mergeScopes appends a new id after the recorded ones', function () {
    var out = plain(ui().mergeScopes('StewardDashboard,,StewardA', 'StewardB'));
    t.assert.deepStrictEqual(out, ['StewardDashboard', 'StewardA', 'StewardB']);
});

t.test('helpers.escape replaces the five HTML characters', function () {
    var esc = ui().helpers.escape;
    t.assert.strictEqual(esc('<a href="x">Tom & Jerry\'s</a>'),
        '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
    t.assert.strictEqual(esc(null), '');
    t.assert.strictEqual(esc(undefined), '');
    t.assert.strictEqual(esc(5), '5');
});

// ---- Rule set ---------------------------------------------------------------

var BANNED = [
    /display\s*:\s*flex/, /display\s*:\s*grid/, /linear-gradient/, /calc\(/,
    /position\s*:\s*sticky/, /:focus-visible/, /var\(--/,
    /[0-9.](vw|vh|rem)\b/
];

// The class contract every view emits. The two host classes the old markup
// used (.tblHeader, .container-fluid) are deliberately not emitted.
var CLASSES = [
    'modal-dialog', 'modal-content', 'modal-header', 'modal-body', 'modal-footer',
    'steward-head-extra', 'steward-head-sum', 'steward-foot-note', 'steward-foot-dirty',
    'steward-foot-need', 'steward-foot-right',
    'steward-tabs', 'steward-tab', 'active', 'steward-tab-dot', 'steward-live',
    'steward-tab-chg', 'steward-tab-cnt',
    'steward-panel', 'steward-set', 'steward-compact',
    'steward-cols', 'steward-side', 'steward-wide', 'steward-edit', 'steward-main',
    'steward-narrow', 'steward-stack', 'steward-snav', 'steward-snav-item',
    'steward-snav-grp', 'steward-snav-dot',
    'steward-card', 'steward-card-h', 'steward-card-meta', 'steward-icon',
    'steward-subhead', 'steward-subhead-meta',
    'steward-field', 'steward-field-lbl', 'steward-field-name', 'steward-field-help',
    'steward-field-ctl', 'steward-sub', 'steward-dis', 'steward-wrap',
    'switch', 'slider', 'steward-input', 'steward-dropdown', 'steward-dirty',
    'steward-invalid', 'steward-unit', 'steward-disabled',
    'btn', 'steward-btn', 'steward-btn-sm', 'steward-primary', 'steward-link',
    'steward-danger', 'steward-confirm', 'steward-now', 'steward-iconbtn',
    'steward-badge', 'steward-b-ok', 'steward-b-busy', 'steward-b-off',
    'steward-b-paused', 'steward-b-tag', 'steward-b-phase', 'steward-tbl',
    'steward-num', 'steward-c', 'steward-fill', 'steward-who', 'steward-under',
    'steward-chips', 'steward-chip', 'steward-stats', 'steward-stat',
    'steward-stat-w1', 'steward-stat-w2', 'steward-stat-w3', 'steward-stat-w4',
    'steward-stat-k', 'steward-stat-v', 'steward-grid', 'steward-cell',
    'steward-cell-2', 'steward-cell-3', 'steward-tile', 'steward-tile-h',
    'steward-tile-line', 'steward-tile-foot', 'steward-banner', 'steward-empty',
    'steward-empty-title', 'steward-strip', 'steward-strip-sum', 'steward-strip-link',
    'steward-tool',
    'steward-card-badge', 'steward-inline', 'steward-inline-item', 'steward-note',
    'steward-card-foot',
    'steward-crumb', 'steward-waves', 'steward-wave-n', 'steward-wave-f',
    'steward-handle', 'steward-moved', 'ui-sortable-placeholder',
    'steward-muted', 'steward-ok', 'steward-warn', 'steward-bad'
];

t.test('STYLE_RULES uses none of the techniques AIR cannot render', function () {
    var text = ui().STYLE_RULES.join('\n');
    BANNED.forEach(function (re) {
        t.assert.ok(!re.test(text), 'banned: ' + re);
    });
});

t.test('STYLE_RULES defines every class of the contract', function () {
    var text = ui().STYLE_RULES.join('\n');
    var missing = CLASSES.filter(function (c) {
        return text.indexOf('.' + c) < 0;
    });
    t.assert.deepStrictEqual(missing, []);
});

t.test('styleChecksum is a short token and the rules change with the layout', function () {
    var u = ui();
    t.assert.ok(/^[0-9a-z]+$/.test(u.styleChecksum));
    var other = u.buildRules(u.tokens, {
        modal: 1, panel: 1, settingsPanel: 1, side: 1, sideWide: 1, sideEdit: 1,
        snav: 1, narrow: 1, fieldCtl: 1, fieldCtlWide: 1, compactMaxHeight: 1,
        minPanel: 1, chrome: { dashboard: 1, settings: 1 }
    });
    t.assert.notStrictEqual(other.join(''), u.STYLE_RULES.join(''));
});

// Every token and every layout number replaced by a marker: whatever the
// rules still say that is not a marker was written into buildRules itself.
function sentinels(u) {
    var tokens = {};
    var layout = {};
    var n = 0;
    Object.keys(u.tokens).forEach(function (k) {
        n++;
        tokens[k] = typeof u.tokens[k] === 'number' ? 70000 + n * 3 : 'T_' + k + '_T';
    });
    Object.keys(u.layout).forEach(function (k) {
        n++;
        if (k === 'chrome') layout.chrome = { dashboard: 80001, settings: 80002 };
        else layout[k] = 80000 + n * 3;
    });
    return { tokens: tokens, layout: layout };
}

t.test('buildRules takes every colour from its tokens and every width from its layout', function () {
    var u = ui();
    var sent = sentinels(u);
    var text = u.buildRules(sent.tokens, sent.layout).join('\n');

    Object.keys(sent.tokens).forEach(function (k) {
        t.assert.ok(text.indexOf(String(sent.tokens[k])) >= 0, 'token not used: ' + k);
    });
    // Read by the shell when it sizes a short window, not by the CSS.
    var shellOnly = ['compactMaxHeight', 'minPanel', 'chrome'];
    Object.keys(sent.layout).forEach(function (k) {
        if (shellOnly.indexOf(k) >= 0) return;
        t.assert.ok(text.indexOf(String(sent.layout[k])) >= 0, 'layout not used: ' + k);
    });

    t.assert.ok(!/#[0-9a-f]{3,6}\b/i.test(text), 'a hex colour is written in buildRules');
    t.assert.ok(!/rgba?\(/.test(text), 'an rgb colour is written in buildRules');
    Object.keys(u.layout).forEach(function (k) {
        if (typeof u.layout[k] !== 'number') return;
        // Not preceded by a digit, or it would match the tail of a marker.
        t.assert.ok(!new RegExp('(^|[^0-9])' + u.layout[k] + 'px').test(text),
            'real layout value in rules: ' + k);
    });
    Object.keys(u.tokens).forEach(function (k) {
        if (typeof u.tokens[k] !== 'string') return;
        t.assert.ok(text.indexOf(u.tokens[k]) < 0, 'real colour in rules: ' + k);
    });
});

// ---- ensureStyle ------------------------------------------------------------

function styleRig() {
    var H = harness.boot({ sections: ['kernel'] });
    jq.install(H);
    return { H: H, ui: H.Steward.kernel.ui, doc: H.ctx.document };
}

t.test('ensureStyle creates the element with scopes and the rule checksum', function () {
    var r = styleRig();
    r.ui.ensureStyle('StewardSettings');
    var el = r.doc.getElementById('steward-dashboard-style');
    t.assert.ok(el);
    t.assert.strictEqual(el.getAttribute('data-scopes'), 'StewardDashboard,StewardSettings');
    t.assert.strictEqual(el.getAttribute('data-rules'), r.ui.styleChecksum);
});

t.test('ensureStyle rewrites the element when data-rules differs', function () {
    var r = styleRig();
    r.ui.ensureStyle('StewardSettings');
    var el = r.doc.getElementById('steward-dashboard-style');
    el.setAttribute('data-rules', 'stale');
    var before = el.children[0];
    r.ui.ensureStyle('StewardSettings');
    t.assert.strictEqual(el.getAttribute('data-rules'), r.ui.styleChecksum);
    t.assert.notStrictEqual(el.children[0], before);
});

t.test('ensureStyle leaves the element alone when scopes and checksum match', function () {
    var r = styleRig();
    r.ui.ensureStyle('StewardSettings');
    var el = r.doc.getElementById('steward-dashboard-style');
    var before = el.children[0];
    r.ui.ensureStyle('StewardSettings');
    t.assert.strictEqual(el.children[0], before);
    t.assert.strictEqual(el.children.length, 1);
});

t.test('ensureStyle adds a new scope to the recorded ones', function () {
    var r = styleRig();
    r.ui.ensureStyle('StewardSettings');
    r.ui.ensureStyle('StewardAdventures');
    var el = r.doc.getElementById('steward-dashboard-style');
    t.assert.strictEqual(el.getAttribute('data-scopes'),
        'StewardDashboard,StewardSettings,StewardAdventures');
});

t.test('the table rule sets color and font-size itself (quirks-mode hosts do not inherit them)', function () {
    var rule = ui().STYLE_RULES.filter(function (r) {
        return r.indexOf('.steward-tbl{') === 0;
    })[0];
    t.assert.ok(rule, 'no .steward-tbl rule');
    t.assert.ok(/(^|;)color:#/.test(rule), rule);
    t.assert.ok(/font-size:\d+px/.test(rule), rule);
    t.assert.ok(/font-weight:400/.test(rule), rule);
});

t.test('a muted span in a stat value is styled like the small text', function () {
    var rule = ui().STYLE_RULES.filter(function (r) {
        return r.indexOf('.steward-stat-v .steward-muted') >= 0;
    })[0];
    t.assert.ok(rule && rule.indexOf('.steward-stat-v small') >= 0, String(rule));
    t.assert.ok(/font-weight:400/.test(rule), rule);
});

t.test('the modal footer stretches the host frame image over its full width', function () {
    var rule = ui().STYLE_RULES.filter(function (r) {
        return r.indexOf('.modal-footer{') === 0;
    })[0];
    t.assert.ok(rule && /background-size:100% 100%,contain;/.test(rule), String(rule));
});
