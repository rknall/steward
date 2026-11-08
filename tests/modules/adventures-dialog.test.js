'use strict';

// The template window is driven through the element tree the jq fake builds:
// the Modal stand-in hands out real Body and Footer elements, so a case
// clicks the same buttons a user would.

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var jq = require('../stubs/jq');
var hostStubs = require('../stubs/host');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup() {
    var afs = airfs.make();
    var alerts = [];
    var H = harness.boot({ host: {
        air: afs.air,
        showGameAlert: function (m) { alerts.push(m); }
    } });
    var $ = jq.install(H);
    var rig = hostStubs.installModal(H);
    return {
        H: H, $: $, rig: rig, fs: afs, alerts: alerts,
        S: H.Steward,
        dialog: H.Steward.modules.adventures.dialog,
        tpl: H.Steward.modules.adventures.templates
    };
}

function body(s) { return s.rig.made[s.rig.made.length - 1].modal.Body(); }
function footer(s) { return s.rig.made[s.rig.made.length - 1].modal.Footer(); }

// The first button under `$root` whose text equals `label`, clicked.
function click($root, $, label) {
    var hit = null;
    $root.find('button').each(function () {
        if (!hit && $(this).text() === label) hit = $(this);
    });
    assert.ok(hit, 'button "' + label + '" exists');
    hit.trigger('click');
}

function openEdit(s) {
    s.dialog.open();
    s.rig.visible = true;
    click(body(s), s.$, 'New template');
}

function typeLabel(s, text) {
    var $in = body(s).find('input').eq(0);
    $in.val(text).trigger('input');
}

t.test('dialog.js loads without the edit-guard API on the kernel UI', function () {
    var H = harness.boot();
    delete H.Steward.kernel.ui.addEditGuard;
    delete H.Steward.modules.adventures.dialog;
    var src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'adventures', 'dialog.js'), 'utf8');
    vm.runInContext(src, H.ctx);
    assert.strictEqual(typeof H.Steward.modules.adventures.dialog.open, 'function');
});

t.test('dialog.js registers its edit guard with the kernel UI', function () {
    var H = harness.boot();
    var ids = [];
    H.Steward.kernel.ui.addEditGuard = function (id) { ids.push(id); };
    var src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'adventures', 'dialog.js'), 'utf8');
    vm.runInContext(src, H.ctx);
    assert.deepStrictEqual(plain(ids), ['adventures']);
});

t.test('open shows the list view in the Steward adventures window', function () {
    var s = setup();
    s.dialog.open();
    assert.strictEqual(s.rig.made.length, 1);
    assert.strictEqual(s.rig.made[0].id, 'StewardAdventures');
    assert.strictEqual(body(s).find('.steward-card-h').eq(0).text().indexOf('Run templates') > -1, true);
    assert.strictEqual(body(s).find('button').length > 0, true);
});

t.test('open is refused while another window has open edits', function () {
    var s = setup();
    s.S.kernel.ui.hasOpenEdits = function () { return true; };
    s.dialog.open();
    assert.strictEqual(s.rig.made.length, 0);
    assert.strictEqual(s.alerts.length, 1);
    assert.ok(/Save or close/.test(s.alerts[0]));
});

t.test('Back to list with a changed draft says the changes were discarded', function () {
    var s = setup();
    openEdit(s);
    typeLabel(s, 'Changed');
    click(footer(s), s.$, 'Back to list');
    assert.deepStrictEqual(s.alerts, ['Steward: Template changes discarded']);
    assert.strictEqual(s.dialog.hasEdits(), false);
});

t.test('Back to list without changes says nothing', function () {
    var s = setup();
    openEdit(s);
    click(footer(s), s.$, 'Back to list');
    assert.deepStrictEqual(s.alerts, []);
});

t.test('hasEdits needs a changed draft in a visible window', function () {
    var s = setup();
    openEdit(s);
    assert.strictEqual(s.dialog.hasEdits(), false);
    typeLabel(s, 'Changed');
    assert.strictEqual(s.dialog.hasEdits(), true);
    s.rig.visible = false;
    assert.strictEqual(s.dialog.hasEdits(), false);
});

t.test('needs names what the draft still lacks, including a taken label', function () {
    var s = setup();
    var draft = s.tpl.normalize({});
    assert.deepStrictEqual(plain(s.dialog.needs(draft, [])),
        ['a label', 'an adventure', 'a loadout', 'at least one wave']);

    draft = s.tpl.normalize({ label: 'Knights', adventure: 'BlackKnights', loadout: 'l.json',
        waves: ['a.json', ''] });
    assert.deepStrictEqual(plain(s.dialog.needs(draft, [])), ['a file for every wave']);

    draft.waves = ['a.json'];
    assert.deepStrictEqual(plain(s.dialog.needs(draft, [])), []);
    var taken = [{ id: 't1', label: ' KNIGHTS ' }];
    assert.deepStrictEqual(plain(s.dialog.needs(draft, taken)), ['a label no other template uses']);
    draft.id = 't1';
    assert.deepStrictEqual(plain(s.dialog.needs(draft, taken)), []);
});
