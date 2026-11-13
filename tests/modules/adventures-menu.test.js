'use strict';

// The ~Steward~ > Adventures submenu: category folders, greyed rows at no
// maps, and the placeholder rows shown until the game's adventure list is
// readable. Rows are walked through their label/enabled functions, one pass
// object per menu read like the kernel does.

var fsys = require('fs');
var path = require('path');
var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var A = require('../stubs/army');

var assert = t.assert;

var SCEN_DIR = 'C:/client/steward/adventures/scenarios';
var ROOT = path.join(__dirname, '..', '..');
var FIXED = 9; // command rows and their separator before the template part

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function def(name, type, campaign, requiresEvent) {
    return A.adventureDef({ name: name, type: type, campaign: campaign, requiresEvent: requiresEvent });
}

// o.defs: adventure definitions (omit for "not readable yet"), o.maps: map
// name -> amount, o.scenarios: id -> file text (the built-in scenarios).
function setup(o) {
    o = o || {};
    var timers = [];
    var fs = airfs.make();
    var H = harness.boot({
        host: { air: fs.air },
        timers: { setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; } }
    });
    var S = H.Steward;
    S.modules.adventures.builtinScenarios = o.scenarios || {};
    var s = { H: H, S: S, fs: fs, timers: timers, maps: o.maps || {}, reads: 0, rebuilds: 0 };
    A.install(H, { buffs: [], adventureDefs: o.defs });
    s.counts = function () { s.reads++; return plain(s.maps); };
    S.core.buffs.mapCounts = s.counts;
    S.kernel.ui = S.kernel.ui || {};
    S.kernel.ui.refreshModuleMenu = function () { s.rebuilds++; return true; };
    s.menu = S.modules.adventures.menu;
    s.tpl = S.modules.adventures.templates;
    H.clearQueued();
    return s;
}

// Makes the host adventure list readable after the menu was built.
function makeReadable(s, defs) {
    A.install(s.H, { buffs: [], adventureDefs: defs });
    s.S.core.buffs.mapCounts = s.counts;
}

function save(s, label, adventure) {
    s.tpl.save({
        label: label, adventure: adventure, loadout: 'C:/b/l.json',
        waves: ['C:/b/w1.json'], speedBuff: 'SpeedBuffDefault'
    }, 1000);
}

function labelOf(item, pass) {
    if (item.separator) return '---';
    return typeof item.label === 'function' ? item.label(pass) : item.label;
}

function enabledOf(item, pass) {
    return typeof item.enabled === 'function' ? item.enabled(pass) : item.enabled !== false;
}

// Items -> nested labels; a folder is { 'Name': [children] }.
function labels(items, pass) {
    pass = pass || {};
    var out = [];
    for (var i = 0; i < items.length; i++) {
        if (items[i].items) {
            var folder = {};
            folder[labelOf(items[i], pass)] = labels(items[i].items, pass);
            out.push(folder);
        } else {
            out.push(labelOf(items[i], pass));
        }
    }
    return out;
}

function tail(s) { return plain(labels(s.menu.items()).slice(FIXED)); }

function builtin(id) { return fsys.readFileSync(path.join(ROOT, 'scenarios', id + '.json'), 'utf8'); }

function twinsAdventure() { return JSON.parse(builtin('twins')).adventure; }

// ---- before load ---------------------------------------------------------------

t.test('before load the menu shows greyed loading rows for templates and scenarios', function () {
    var s = setup({ scenarios: { twins: builtin('twins') } });
    save(s, 'Alpha', 'AdvA');
    var items = s.menu.items();
    assert.deepStrictEqual(plain(labels(items).slice(FIXED)), ['Templates (loading…)', '---', 'Scenarios (loading…)']);
    assert.strictEqual(enabledOf(items[FIXED], {}), false);
    assert.strictEqual(enabledOf(items[FIXED + 2], {}), false);
});

t.test('before load with no templates the menu still says No templates yet', function () {
    var s = setup();
    assert.deepStrictEqual(tail(s), ['No templates yet']);
    makeReadable(s, [def('AdvA', 'Mission')]);
    assert.strictEqual(s.menu.sync(), false);
});

// ---- after load ----------------------------------------------------------------

t.test('after load templates sit in type folders with campaign sub-folders above loose entries', function () {
    var s = setup({ defs: [
        def('AdvB', 'Mission'), def('AdvA', 'Mission'), def('AdvC', 'Mission', 'ArabianNights'),
        def('AdvM', 'MiniMission'), def('AdvV', 'Venture')
    ] });
    save(s, 'Zeta', 'AdvB');
    save(s, 'Alpha', 'AdvA');
    save(s, 'Campy', 'AdvC');
    save(s, 'Mini', 'AdvM');
    save(s, 'Vent', 'AdvV');
    save(s, 'Lost', 'NotInDefinitions');
    var camp = s.S.core.adventures.campaignLabel('ArabianNights');
    var top = tail(s);
    var names = top.map(function (e) { return Object.keys(e)[0]; });
    assert.deepStrictEqual(names, ['Missions', 'Mini-missions', 'Ventures', 'Other']);
    var sub = {};
    sub[camp] = ['Campy ×0'];
    assert.deepStrictEqual(top[0].Missions, [sub, 'Alpha ×0', 'Zeta ×0']);
    assert.deepStrictEqual(top[3].Other, ['Lost ×0']);
});

t.test('after load scenarios sit in one Scenarios folder with campaign sub-folders and broken files last', function () {
    var rec = JSON.parse(builtin('twins'));
    var s = setup({ scenarios: { twins: builtin('twins') }, defs: [def(rec.adventure, 'Mission', 'ArabianNights')] });
    s.fs.disk[SCEN_DIR + '/zz_bad.json'] = '{ not json';
    var camp = s.S.core.adventures.campaignLabel('ArabianNights');
    var top = tail(s);
    assert.strictEqual(top[0], 'No templates yet');
    assert.strictEqual(top[1], '---');
    var sub = {};
    sub[camp] = ['Twins ×0'];
    assert.deepStrictEqual(top[2].Scenarios, [sub, 'zz_bad: broken scenario file']);
});

t.test('every built-in scenario is listed under its real name', function () {
    var files = fsys.readdirSync(path.join(ROOT, 'scenarios')).filter(function (f) { return /\.json$/.test(f); });
    var text = {};
    var defs = [];
    var expected = [];
    files.forEach(function (f) {
        var id = f.replace(/\.json$/, '');
        text[id] = builtin(id);
        var rec = JSON.parse(text[id]);
        defs.push(def(rec.adventure, 'Mission'));
        expected.push(rec.label + ' ×0');
    });
    var s = setup({ scenarios: text, defs: defs });
    var folder = tail(s)[2].Scenarios;
    assert.strictEqual(folder.length, 11);
    assert.deepStrictEqual(folder.slice().sort(), expected.sort());
    assert.ok(folder.indexOf('A New Experience ×0') !== -1);
    assert.ok(folder.indexOf('Where Do Easter Eggs Come From? ×0') !== -1);
});

// ---- maps ----------------------------------------------------------------------

t.test('a row at ×0 is greyed and at ×1 is enabled', function () {
    var adv = twinsAdventure();
    var s = setup({ scenarios: { twins: builtin('twins') }, maps: { AdvA: 0 },
        defs: [def('AdvA', 'Mission'), def(adv, 'Mission')] });
    save(s, 'Alpha', 'AdvA');
    var items = s.menu.items();
    var tplRow = items[FIXED].items[0];
    var scnRow = items[FIXED + 2].items[0];
    assert.strictEqual(labelOf(tplRow, {}), 'Alpha ×0');
    assert.strictEqual(enabledOf(tplRow, {}), false);
    assert.strictEqual(enabledOf(scnRow, {}), false);
    s.maps.AdvA = 1;
    s.maps[adv] = 1;
    assert.strictEqual(enabledOf(tplRow, {}), true);
    assert.strictEqual(enabledOf(scnRow, {}), true);
    assert.strictEqual(labelOf(tplRow, {}), 'Alpha ×1');
});

t.test('an unreadable pass keeps the last readable enabled state and a never-read row is greyed', function () {
    var s = setup({ maps: { AdvA: 2 }, defs: [def('AdvA', 'Mission')] });
    save(s, 'Alpha', 'AdvA');
    var row = s.menu.items()[FIXED].items[0];
    var unreadable = function () { return null; };
    assert.strictEqual(enabledOf(row, {}), true);
    s.S.core.buffs.mapCounts = unreadable;
    assert.strictEqual(enabledOf(row, {}), true);
    assert.strictEqual(labelOf(row, {}), 'Alpha ×?');
    s.maps.AdvA = 0;
    s.S.core.buffs.mapCounts = s.counts;
    assert.strictEqual(enabledOf(row, {}), false);
    s.S.core.buffs.mapCounts = unreadable;
    assert.strictEqual(enabledOf(row, {}), false);
    var fresh = s.menu.items()[FIXED].items[0];
    assert.strictEqual(enabledOf(fresh, {}), false);
    assert.strictEqual(labelOf(fresh, {}), 'Alpha ×?');
});

t.test('label and enabled share one star-menu read per pass', function () {
    var adv = twinsAdventure();
    var s = setup({ scenarios: { twins: builtin('twins') }, maps: { AdvA: 1 },
        defs: [def('AdvA', 'Mission'), def(adv, 'Mission')] });
    save(s, 'Alpha', 'AdvA');
    save(s, 'Beta', 'AdvA');
    var items = s.menu.items();
    s.reads = 0;
    var pass = {};
    var rows = [items[FIXED].items[0], items[FIXED].items[1], items[FIXED + 2].items[0]];
    for (var i = 0; i < rows.length; i++) {
        labelOf(rows[i], pass);
        enabledOf(rows[i], pass);
    }
    assert.strictEqual(s.reads, 1);
});

// ---- the one automatic rebuild ---------------------------------------------------

t.test('the loading row asks for exactly one rebuild once definitions become readable', function () {
    var s = setup();
    save(s, 'Alpha', 'AdvA');
    var row = s.menu.items()[FIXED];
    var base = s.timers.length;
    for (var i = 0; i < 5; i++) assert.strictEqual(labelOf(row, {}), 'Templates (loading…)');
    assert.strictEqual(s.timers.length, base);
    makeReadable(s, [def('AdvA', 'Mission')]);
    labelOf(row, {});
    assert.strictEqual(s.timers.length, base + 1);
    assert.strictEqual(s.timers[base].ms, 0);
    labelOf(row, {});
    labelOf(row, {});
    assert.strictEqual(s.timers.length, base + 1);
    assert.strictEqual(s.rebuilds, 0);
    s.timers[base].fn();
    assert.strictEqual(s.rebuilds, 1);
    s.menu.items();
    assert.strictEqual(s.menu.sync(), false);
    labelOf(row, {});
    assert.strictEqual(s.timers.length, base + 1);
    assert.strictEqual(s.rebuilds, 1);
});

t.test('two loading rows probe the definitions once per pass', function () {
    var s = setup({ scenarios: { twins: builtin('twins') } });
    save(s, 'Alpha', 'AdvA');
    var items = s.menu.items();
    var probes = 0;
    var adv = s.S.core.adventures;
    var orig = adv.definitions;
    adv.definitions = function () { probes++; return orig.apply(adv, arguments); };
    var pass = {};
    labelOf(items[FIXED], pass);
    labelOf(items[FIXED + 2], pass);
    assert.strictEqual(probes, 1);
    labelOf(items[FIXED], {});
    assert.strictEqual(probes, 2);
});

t.test('a build with readable definitions shows folders at once and needs no automatic rebuild', function () {
    var s = setup({ defs: [def('AdvA', 'Mission')] });
    save(s, 'Alpha', 'AdvA');
    var base = s.timers.length;
    var items = s.menu.items();
    assert.deepStrictEqual(plain(labels(items).slice(FIXED)), [{ Missions: ['Alpha ×0'] }]);
    for (var i = 0; i < 3; i++) labels(items);
    assert.strictEqual(s.timers.length, base);
    assert.strictEqual(s.menu.sync(), false);
    assert.strictEqual(s.rebuilds, 0);
});

t.test('sync after load rebuilds once on a user action and then not again', function () {
    var s = setup({ defs: [def('AdvA', 'Mission'), def('AdvB', 'Mission')] });
    save(s, 'Alpha', 'AdvA');
    s.menu.items();
    assert.strictEqual(s.menu.sync(), false);
    save(s, 'Beta', 'AdvB');
    assert.strictEqual(s.menu.sync(), true);
    assert.strictEqual(s.rebuilds, 1);
    s.menu.items();
    assert.strictEqual(s.menu.sync(), false);
    assert.strictEqual(s.rebuilds, 1);
});

// ---- Queues folder ----------------------------------------------------------

// Saves a queue of template entries [id, count] under `label`; returns its id.
function saveQueue(s, label, entries, extra) {
    var rec = s.S.modules.adventures.queues.normalize({
        label: label,
        entries: entries.map(function (e) { return { kind: 'template', id: e, count: 1 }; }),
        noMap: extra && extra.noMap
    });
    var r = s.S.modules.adventures.queues.save(rec, 5000);
    assert.ok(r.ok, JSON.stringify(r));
    return r.id;
}

function saveTpl(s, label, adventure) {
    return s.tpl.save({
        label: label, adventure: adventure, loadout: 'C:/b/l.json',
        waves: ['C:/b/w1.json'], speedBuff: 'SpeedBuffDefault'
    }, 1000).id;
}

function queuesFolder(items) {
    for (var i = 0; i < items.length; i++) if (items[i].label === 'Queues') return { at: i, item: items[i] };
    return null;
}

t.test('no Queues folder without a queue', function () {
    var s = setup({ defs: [def('AdvA', 'Mission')] });
    save(s, 'Alpha', 'AdvA');
    assert.strictEqual(queuesFolder(s.menu.items()), null);
});

t.test('the Skip entry command sits after End repetition', function () {
    var s = setup({ defs: [def('AdvA', 'Mission')] });
    var names = s.menu.COMMANDS.map(function (c) { return c.name; });
    assert.deepStrictEqual(plain(names), ['pause', 'resume', 'endRepetition', 'skipEntry', 'stop']);
    assert.strictEqual(plain(labels(s.menu.items()))[6], 'Skip entry');
});

t.test('the Queues folder follows Scenarios and its row shows entries and maps', function () {
    var s = setup({
        scenarios: { twins: builtin('twins') }, maps: { AdvA: 2, AdvB: 0 },
        defs: [def('AdvA', 'Mission'), def('AdvB', 'Mission')]
    });
    var a = saveTpl(s, 'Alpha', 'AdvA');
    var b = saveTpl(s, 'Beta', 'AdvB');
    saveQueue(s, 'Long', [a, b]);
    saveQueue(s, 'Dry', [b, a]);
    var items = s.menu.items();
    var q = queuesFolder(items);
    assert.ok(q, 'folder');
    assert.strictEqual(items[q.at - 1].label !== undefined && labelOf(items[q.at - 1]), 'Scenarios');
    assert.deepStrictEqual(plain(labels(q.item.items)), ['Dry (2 entries) ×0', 'Long (2 entries) ×2']);
    assert.deepStrictEqual(plain(q.item.items.map(function (it) { return enabledOf(it, {}); })), [false, true]);
});

t.test('a queue with no-map skip shows the maps of the first entry that has one', function () {
    var s = setup({ maps: { AdvA: 3, AdvB: 0 }, defs: [def('AdvA', 'Mission'), def('AdvB', 'Mission')] });
    var a = saveTpl(s, 'Alpha', 'AdvA');
    var b = saveTpl(s, 'Beta', 'AdvB');
    saveQueue(s, 'Skipper', [b, a], { noMap: 'skip' });
    var q = queuesFolder(s.menu.items());
    assert.deepStrictEqual(plain(labels(q.item.items)), ['Skipper (2 entries) ×3']);
    assert.strictEqual(enabledOf(q.item.items[0], {}), true);
});

t.test('a queue row starts the queue and a broken file is a disabled row last', function () {
    var s = setup({ maps: { AdvA: 1 }, defs: [def('AdvA', 'Mission')] });
    var a = saveTpl(s, 'Alpha', 'AdvA');
    var id = saveQueue(s, 'Solo', [a]);
    var qs = s.S.modules.adventures.queues;
    s.S.kernel.files.writeText(qs.pathOf('aaa-bad'), '{ nope');
    var q = queuesFolder(s.menu.items());
    assert.deepStrictEqual(plain(labels(q.item.items)), ['Solo (1 entry) ×1', 'aaa-bad.json (unreadable)']);
    assert.strictEqual(enabledOf(q.item.items[1], {}), false);
    var called = [];
    s.S.modules.adventures.run.startQueue = function (x) { called.push(x); };
    q.item.items[0].onSelect();
    assert.deepStrictEqual(called, [id]);
});

t.test('queues show one greyed loading row until the definitions are readable', function () {
    var s = setup({});
    save(s, 'Alpha', 'AdvA');
    var a = s.tpl.list()[0].id;
    saveQueue(s, 'Solo', [a]);
    var items = s.menu.items();
    var q = queuesFolder(items);
    assert.strictEqual(q, null);
    var last = items[items.length - 1];
    assert.strictEqual(labelOf(last, {}), 'Queues (loading…)');
    assert.strictEqual(enabledOf(last, {}), false);
});

t.test('saving or removing a queue changes the signature, a status read does not rebuild', function () {
    var s = setup({ maps: { AdvA: 1 }, defs: [def('AdvA', 'Mission')] });
    var a = saveTpl(s, 'Alpha', 'AdvA');
    s.menu.items();
    assert.strictEqual(s.menu.sync(), false);
    var id = saveQueue(s, 'Solo', [a]);
    assert.strictEqual(s.menu.sync(), true);
    var items = s.menu.items();
    for (var i = 0; i < 3; i++) labels(items);
    assert.strictEqual(s.menu.sync(), false);
    assert.strictEqual(s.rebuilds, 1);
    s.S.modules.adventures.queues.remove(id);
    assert.strictEqual(s.menu.sync(), true);
});
