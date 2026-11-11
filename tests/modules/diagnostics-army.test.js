'use strict';

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');

var SAMPLE_MS = 5000;

// Capturing timers: every setTimeout is kept with its callback and delay so
// a case can fire the sampler's ticks by hand.
function makeTimers() {
    var list = [];
    var nextId = 1;
    return {
        list: list,
        setTimeout: function (fn, ms) {
            var e = { fn: fn, ms: ms, id: nextId++, cleared: false };
            list.push(e);
            return e.id;
        },
        clearTimeout: function (id) {
            for (var i = 0; i < list.length; i++) if (list[i].id === id) list[i].cleared = true;
        }
    };
}

// Sampler timers armed after index `from` (the lifecycle's deferred boot
// also goes through setTimeout and is ignored).
function samplerTimers(timers, from) {
    var out = [];
    for (var i = from; i < timers.list.length; i++) {
        if (timers.list[i].ms === SAMPLE_MS) out.push(timers.list[i]);
    }
    return out;
}

function pending(timers, from) {
    var out = [];
    var all = samplerTimers(timers, from);
    for (var i = 0; i < all.length; i++) {
        if (!all[i].cleared && !all[i].fired) out.push(all[i]);
    }
    return out;
}

function fire(entry) {
    entry.fired = true;
    entry.fn();
}

function setup() {
    var timers = makeTimers();
    var H = harness.boot({ timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } });
    return { H: H, timers: timers, army: H.Steward.modules.diagnostics.army };
}

function count(logs, category, re) {
    var n = 0;
    for (var i = 0; i < logs.length; i++) {
        if (logs[i].category !== category) continue;
        if (!re || re.test(String(logs[i].args[0]))) n++;
    }
    return n;
}

t.test('toggleSampler starts the sampler with one pending timer', function () {
    var s = setup();
    var from = s.timers.list.length;
    t.assert.strictEqual(s.army.toggleSampler(), true);
    t.assert.strictEqual(s.army.samplerRunning(), true);
    t.assert.strictEqual(pending(s.timers, from).length, 1);
    t.assert.strictEqual(s.H.queued().length, 0);
});

t.test('sampler stops itself after 36 samples', function () {
    var s = setup();
    var from = s.timers.list.length;
    s.army.toggleSampler();
    for (var i = 0; i < 36; i++) {
        var p = pending(s.timers, from);
        t.assert.strictEqual(p.length, 1, 'one timer pending before sample ' + (i + 1));
        fire(p[0]);
    }
    t.assert.strictEqual(s.army.samplerRunning(), false);
    t.assert.strictEqual(pending(s.timers, from).length, 0);
    t.assert.strictEqual(samplerTimers(s.timers, from).length, 36);
    t.assert.strictEqual(count(s.H.logs(), 'diag:sample', /^--- generals sample /), 36);
    t.assert.strictEqual(s.H.queued().length, 0);
});

t.test('toggle while running stops it and a stale callback does nothing', function () {
    var s = setup();
    var from = s.timers.list.length;
    s.army.toggleSampler();
    var p = pending(s.timers, from);
    t.assert.strictEqual(p.length, 1);
    t.assert.strictEqual(s.army.toggleSampler(), false);
    t.assert.strictEqual(s.army.samplerRunning(), false);
    t.assert.strictEqual(p[0].cleared, true);

    s.H.clearLogs();
    p[0].fn();
    t.assert.strictEqual(count(s.H.logs(), 'diag:sample'), 0);
    t.assert.strictEqual(samplerTimers(s.timers, from).length, 1);
    t.assert.strictEqual(s.H.queued().length, 0);
});

t.test('a pending tick after a script reload stops without dumping or re-arming', function () {
    var s = setup();
    var from = s.timers.list.length;
    s.army.toggleSampler();
    var p = pending(s.timers, from);
    t.assert.strictEqual(p.length, 1);

    var H2 = harness.reload(s.H);
    var afterReload = s.timers.list.length;
    s.H.clearLogs();
    H2.clearLogs();

    fire(p[0]);

    var all = s.H.logs().concat(H2.logs());
    t.assert.strictEqual(count(all, 'diag:sample'), 0);
    t.assert.strictEqual(count(all, 'diag', /^sampler stopped: script reloaded$/), 1);
    t.assert.strictEqual(samplerTimers(s.timers, afterReload).length, 0);
    t.assert.strictEqual(H2.Steward.modules.diagnostics.army.samplerRunning(), false);
    t.assert.strictEqual(s.H.queued().length, 0);
    t.assert.strictEqual(H2.queued().length, 0);
});

t.test('dumps do not throw on the bare host stubs', function () {
    var s = setup();
    s.army.dumpGenerals();
    s.army.dumpGenerals('diag:sample', 'sample 1/36');
    s.army.dumpArmy();
    s.army.dumpQuests();
    s.army.dumpAdventures();
    s.army.dumpDefinitions();
    s.army.dumpBuildings();
    t.assert.strictEqual(s.H.queued().length, 0);
    t.assert.ok(count(s.H.logs(), 'diag:army') > 0);
});

// Stubs the host class lookup so the core manager helper finds `mgr`
// (or nothing when `mgr` is null).
function withManager(s, mgr) {
    var prev = s.H.host.game.def;
    s.H.host.game.def = function (name) {
        if (name === 'com.bluebyte.tso.adventure.logic::AdventureManager') {
            return mgr ? { getInstance: function () { return mgr; } } : null;
        }
        return prev(name);
    };
}

t.test('dumpAdventures lists the manager\'s adventures through core', function () {
    var s = setup();
    var advs = [
        { zoneID: 1, adventureName: 'AdvA', ownerPlayerID: 7, mine: true },
        { zoneID: 2, adventureName: 'AdvB', ownerPlayerID: 8, mine: false }
    ];
    withManager(s, {
        getAdventures: function () { return advs; },
        isMyAdventure: function (adv) { return adv.mine; }
    });
    s.H.clearLogs();
    s.army.dumpAdventures();
    t.assert.strictEqual(count(s.H.logs(), 'diag:adv', /^adventures: 2$/), 1);
    t.assert.strictEqual(count(s.H.logs(), 'diag:adv', /isMyAdventure=true/), 1);
    t.assert.strictEqual(s.H.queued().length, 0);
});

t.test('dumpAdventures logs an error when the manager is missing', function () {
    var s = setup();
    withManager(s, null);
    s.H.clearLogs();
    s.army.dumpAdventures();
    var errors = s.H.logs().filter(function (l) {
        return l.level === 'error' && l.category === 'diag:adv' &&
               /adventure manager unavailable/.test(String(l.args[0]));
    });
    t.assert.strictEqual(errors.length, 1);
    t.assert.strictEqual(s.H.queued().length, 0);
});

t.test('inspect.TASK_GETTERS holds the seven task getters', function () {
    var H = harness.boot();
    // Copied into this realm: the list was built inside the vm context.
    var list = Array.prototype.slice.call(H.Steward.modules.diagnostics.inspect.TASK_GETTERS);
    t.assert.deepStrictEqual(list, [
        'GetType', 'GetOriginalType', 'GetSubType', 'GetState',
        'IsRunning', 'GetRemainingTime', 'GetNewGarrisonGridIdx'
    ]);
});

function withQuests(s, quests, total) {
    s.H.host.game.quests = {
        GetQuestPool: function () {
            return {
                GetQuest_vector: function () { return quests; },
                IsAnyQuestsActive: function () { return true; }
            };
        },
        GetTotalValuesForQuestTrigger: total
    };
}

function lines(s, category, level) {
    return s.H.logs().filter(function (l) {
        return l.category === category && (!level || l.level === level);
    }).map(function (l) { return String(l.args[0]); });
}

function matching(arr, re) {
    return arr.filter(function (x) { return re.test(x); });
}

t.test('dumpQuests logs each trigger with its status and counter', function () {
    var s = setup();
    var quest = {
        isFinished: function () { return false; },
        getQuestName_string: function () { return 'Barrels'; },
        GetQuestDefinition: function () {
            return {
                specialType_string: '',
                questTriggers_vector: [
                    { triggerIdx: 1, type: 1, condition: 9, name_string: 'B', amount: 3 },
                    { triggerIdx: 0, type: 1, condition: 9, name_string: 'A', amount: 5 }
                ],
                endConditions_vector: [
                    { triggerIdx: 0, action_string: 'x', item_string: '', name_string: 'A' }
                ]
            };
        },
        mQuestMode: 2,
        mQuestTriggersFinished_vector: [
            { status: 1, deltaStart: 0 },
            { status: 0, deltaStart: 2 }
        ]
    };
    withQuests(s, [{}, quest], function (player, q, idx) {
        if (idx === 1) throw new Error('no read');
        return 4;
    });
    s.H.clearLogs();
    s.army.dumpQuests();
    var out = lines(s, 'diag:quest');
    t.assert.strictEqual(matching(out, /not a quest/).length, 1);
    t.assert.strictEqual(matching(out, /triggers: 2/).length, 1);
    t.assert.strictEqual(matching(out, /trigger pos=0 idx=1 .*status=0 .*total=\[threw\]/).length, 1);
    t.assert.strictEqual(matching(out, /trigger pos=1 idx=0 .*status=1 .*total=4/).length, 1);
    t.assert.strictEqual(matching(out, /endConditions: 1/).length, 1);
    t.assert.strictEqual(matching(out, /end pos=0 idx=0 action=x/).length, 1);
    t.assert.strictEqual(matching(out, /anyQuestsActive=true/).length, 1);
    t.assert.strictEqual(matching(out, /def=getter/).length, 1);
    t.assert.strictEqual(matching(out, /mQuestMode=2/).length, 1);
    t.assert.strictEqual(lines(s, 'diag:quest', 'error').length, 0);
    t.assert.strictEqual(s.H.queued().length, 0);
});

t.test('dumpQuests logs an empty mQuestMode when the host field is absent', function () {
    var s = setup();
    var quest = {
        isFinished: function () { return false; },
        mQuestDefinition: { questTriggers_vector: [] },
        mQuestTriggersFinished_vector: []
    };
    withQuests(s, [quest], function () { return 0; });
    s.H.clearLogs();
    s.army.dumpQuests();
    var out = lines(s, 'diag:quest');
    t.assert.strictEqual(matching(out, /mQuestMode=/).length, 1);
    t.assert.strictEqual(matching(out, /mQuestMode=2/).length, 0);
    t.assert.strictEqual(lines(s, 'diag:quest', 'error').length, 0);
});

t.test('dumpQuests falls back to mQuestDefinition', function () {
    var s = setup();
    var quest = {
        isFinished: function () { return false; },
        mQuestDefinition: {
            questTriggers_vector: [{ triggerIdx: 0, type: 1, condition: 9, name_string: 'A', amount: 1 }]
        },
        mQuestTriggersFinished_vector: [{ status: 0, deltaStart: 0 }]
    };
    withQuests(s, [quest], function () { return 0; });
    s.H.clearLogs();
    s.army.dumpQuests();
    var out = lines(s, 'diag:quest');
    t.assert.strictEqual(matching(out, /def=field/).length, 1);
    t.assert.strictEqual(matching(out, /trigger pos=0/).length, 1);
});

t.test('dumpQuests logs target, type, min, status and total on end conditions', function () {
    var s = setup();
    var quest = {
        isFinished: function () { return false; },
        getQuestName_string: function () { return 'Hut'; },
        GetQuestDefinition: function () {
            return {
                specialType_string: '',
                questTriggers_vector: [
                    { triggerIdx: 0, type: 1, condition: 9, name_string: 'A', amount: 1, target_string: 'Hut' }
                ],
                endConditions_vector: [
                    { triggerIdx: 0, action_string: 'buffappliedonadventure', item_string: 'Bridge',
                      type: 1, min: 2, target_string: 'Broadsheet', amount: 3 },
                    { triggerIdx: 5, action_string: 'onmap', item_string: '', amount: 1 }
                ]
            };
        },
        mQuestMode: 3,
        mQuestTriggersFinished_vector: [{ status: 1, deltaStart: 0 }]
    };
    withQuests(s, [quest], function () { return 7; });
    s.H.clearLogs();
    s.army.dumpQuests();
    var out = lines(s, 'diag:quest');
    t.assert.strictEqual(matching(out, /trigger pos=0 idx=0 .* target=Hut .*status=1 deltaStart=0 total=7$/).length, 1);
    t.assert.strictEqual(matching(out,
        /end pos=0 idx=0 action=buffappliedonadventure item=Bridge .* type=1 min=2 target=Broadsheet status=1 total=7$/).length, 1);
    t.assert.strictEqual(matching(out,
        /end pos=1 idx=5 action=onmap .* status=\? total=7$/).length, 1);
    t.assert.strictEqual(lines(s, 'diag:quest', 'error').length, 0);
    t.assert.strictEqual(s.H.queued().length, 0);
});

function bldgSetup() {
    var fs = airfs.make();
    var H = harness.boot({ host: { air: fs.air } });
    return { fs: fs, H: H, army: H.Steward.modules.diagnostics.army };
}

function dumpFiles(fs) {
    return Object.keys(fs.disk).filter(function (k) {
        return /\/steward\/dumps\/buildings-[A-Za-z0-9_-]+-\d+\.json$/.test(k);
    });
}

t.test('dumpBuildings writes sorted records to steward/dumps', function () {
    var s = bldgSetup();
    s.H.installZone(s.H.zone.zone()
        .building(s.H.zone.building({ name: 'B', grid: 5 }))
        .building(s.H.zone.building({ name: 'A', grid: 9 }))
        .building(s.H.zone.building({ name: 'A', grid: 2, selectable: true, leaderCamp: true, ui: 'enemy', hasArmy: true })));
    s.H.clearLogs();
    s.army.dumpBuildings();
    var files = dumpFiles(s.fs);
    t.assert.strictEqual(files.length, 1);
    var doc = JSON.parse(s.fs.disk[files[0]]);
    t.assert.strictEqual(doc.count, 3);
    t.assert.deepStrictEqual(doc.buildings.map(function (r) { return r.name + '/' + r.grid; }),
        ['A/2', 'A/9', 'B/5']);
    var first = doc.buildings[0];
    t.assert.strictEqual(first.selectable, true);
    t.assert.strictEqual(first.leaderCamp, true);
    t.assert.strictEqual(first.attackable, false);
    t.assert.strictEqual(first.ui, 'enemy');
    t.assert.strictEqual(first.hasArmy, true);
    t.assert.strictEqual(doc.buildings[1].selectable, null);
    t.assert.strictEqual(matching(lines(s, 'diag:bldg'), /buildings: 3 written to /).length, 1);
    t.assert.strictEqual(s.H.queued().length, 0);
});

t.test('dumpBuildings re-reads the zone after a change', function () {
    var s = bldgSetup();
    var z = s.H.zone.zone().building(s.H.zone.building({ name: 'A', grid: 1 }));
    s.H.installZone(z);
    s.army.dumpBuildings();
    t.assert.ok(dumpFiles(s.fs).length >= 1);
    z.building(s.H.zone.building({ name: 'A', grid: 2 }));
    s.army.dumpBuildings();
    // Two dumps in one millisecond share a file name; either way the newest
    // content must show the added building.
    var counts = dumpFiles(s.fs).map(function (k) { return JSON.parse(s.fs.disk[k]).count; });
    t.assert.ok(counts.indexOf(2) >= 0);
});

t.test('dumpBuildings logs the records when no folder is writable', function () {
    var s = setup();
    s.H.installZone(s.H.zone.zone()
        .building(s.H.zone.building({ name: 'A', grid: 1 }))
        .building(s.H.zone.building({ name: 'B', grid: 2 })));
    s.H.Steward.kernel.files.stewardDir = function () { return null; };
    s.H.clearLogs();
    s.army.dumpBuildings();
    t.assert.strictEqual(matching(lines(s, 'diag:bldg'), /^  \{/).length, 2);
    t.assert.strictEqual(lines(s, 'diag:bldg', 'warn').length, 1);
    t.assert.strictEqual(s.H.queued().length, 0);
});

t.test('dumpBuildings survives a throwing building', function () {
    var s = setup();
    var bad = s.H.zone.building({ name: 'X', grid: 3 });
    s.H.installZone(s.H.zone.zone().building(s.H.zone.building({ name: 'A', grid: 1 })).building(bad));
    // Break the building only after the stub zone has indexed it by name.
    bad.GetGOContainer = function () { throw new Error('boom'); };
    bad.GetBuildingName_string = function () { throw new Error('boom'); };
    s.H.clearLogs();
    s.army.dumpBuildings();
    var out = lines(s, 'diag:bldg');
    t.assert.strictEqual(matching(out, /logging 2 records|buildings: 2 written/).length, 1);
    t.assert.strictEqual(s.H.queued().length, 0);
});

// ---- sampler countdown and plan ------------------------------------------------

t.test('samplerLeftMs is null while idle and counts down one step per tick', function () {
    var s = setup();
    var from = s.timers.list.length;
    var plan = s.army.samplerPlan();
    t.assert.strictEqual(s.army.samplerLeftMs(), null);
    s.army.toggleSampler();
    t.assert.strictEqual(s.army.samplerLeftMs(), plan.totalMs);
    fire(pending(s.timers, from)[0]);
    t.assert.strictEqual(s.army.samplerLeftMs(), plan.totalMs - plan.everyMs);
    fire(pending(s.timers, from)[0]);
    t.assert.strictEqual(s.army.samplerLeftMs(), plan.totalMs - 2 * plan.everyMs);
    s.army.toggleSampler();
    t.assert.strictEqual(s.army.samplerLeftMs(), null);
});

t.test('onSamplerTick is called after every sample, including the last', function () {
    var s = setup();
    var from = s.timers.list.length;
    var ticks = 0;
    s.H.Steward.modules.diagnostics.onSamplerTick = function () { ticks++; };
    s.army.toggleSampler();
    fire(pending(s.timers, from)[0]);
    t.assert.strictEqual(ticks, 1);
    fire(pending(s.timers, from)[0]);
    t.assert.strictEqual(ticks, 2);
    while (s.army.samplerRunning()) fire(pending(s.timers, from)[0]);
    t.assert.strictEqual(ticks, s.army.samplerPlan().count);
});

t.test('a throwing onSamplerTick hook does not stop the sampler', function () {
    var s = setup();
    var from = s.timers.list.length;
    s.H.Steward.modules.diagnostics.onSamplerTick = function () { throw new Error('boom'); };
    s.army.toggleSampler();
    fire(pending(s.timers, from)[0]);
    t.assert.strictEqual(s.army.samplerRunning(), true);
    t.assert.strictEqual(pending(s.timers, from).length, 1);
});

t.test('samplerPlan totalMs is everyMs times count', function () {
    var plan = setup().army.samplerPlan();
    t.assert.strictEqual(plan.totalMs, plan.everyMs * plan.count);
    t.assert.strictEqual(plan.everyMs, SAMPLE_MS);
});

// The tool row labelled "Sample generals".
function sampleRow($, d, H) {
    var $main = $('<div>');
    d.renderSection($main, H.Steward.kernel.ui.helpers);
    var $found = null;
    $main.find('.steward-tool').each(function () {
        var $r = $(this);
        if ($r.text().indexOf('Sample generals') > -1) $found = $r;
    });
    return $found;
}

t.test('the Sample generals help is built from the plan, not retyped', function () {
    var s = setup();
    var $ = require('../stubs/jq').install(s.H);
    var $row = sampleRow($, s.H.Steward.modules.diagnostics, s.H);
    t.assert.ok($row, 'sampler row rendered');
    var plan = s.army.samplerPlan();
    t.assert.strictEqual($row.find('small').text(),
        'every ' + (plan.everyMs / 1000) + ' s for ' + (plan.totalMs / 60000) + ' min');
});

t.test('the sampler button label follows the countdown', function () {
    var s = setup();
    var $ = require('../stubs/jq').install(s.H);
    var $btn = sampleRow($, s.H.Steward.modules.diagnostics, s.H).find('button');
    t.assert.strictEqual($btn.text(), 'Start');
    $btn.trigger('click');
    t.assert.strictEqual($btn.text(), 'Stop (3:00 left)');
});

t.test('dumpDefinitions logs campaigns and each template\'s folder', function () {
    var A = require('../stubs/army');
    var fs = airfs.make();
    var H = harness.boot({ host: { air: fs.air } });
    A.install(H, { adventureDefs: [
        A.adventureDef({ name: 'AdvM', type: 'Mission' }),
        A.adventureDef({ name: 'AdvC', type: 'Mission', campaign: 'ArabianNights' })
    ] });
    H.Steward.modules.adventures.templates.save({
        label: 'Alpha', adventure: 'AdvM', loadout: 'C:/b/l.json', waves: ['C:/b/w1.json'], speedBuff: 'SpeedBuffDefault'
    }, 1000);
    var saved = Object.keys(fs.disk).filter(function (k) { return /t1000\.json$/.test(k); })[0];
    t.assert.ok(saved, 'saved template file found');
    fs.disk[saved.replace(/t1000\.json$/, 'zz_bad.json')] = '{ not json';
    H.clearLogs();
    H.Steward.modules.diagnostics.army.dumpDefinitions();
    var lines = H.logs().map(function (l) { return String(l.args[0]); });
    t.assert.ok(lines.some(function (l) { return /^ {2}campaigns: ArabianNights=1 \(/.test(l); }), lines.join('\n'));
    t.assert.ok(lines.some(function (l) { return /^ {2}template "Alpha" AdvM type=Mission .*folder=Missions$/.test(l); }), lines.join('\n'));
    t.assert.ok(!lines.some(function (l) { return /"undefined"|template .*undefined/.test(l); }), lines.join('\n'));
});
