'use strict';

// Collect clicks map pickups through S.core.pickups and S.core.actions.attempt,
// one target per plan(). Each test builds a viewed zone of fake map objects and
// plays the queued attempt entries with AC.drive, changing the zone between
// polls the way the host would after a click.
//
// queue.add is captured by the kernel stub, so the real queue never shows work
// in flight; queue.isModuleBusy is replaced by a switch instead.

var t = require('../runner');
var harness = require('../harness');
var AC = require('../stubs/actions');

var ZONE = 7;
var HOME = { zone: { isHome: true } };
var ADVENTURE = { zone: { isHome: false, isAdventure: true } };

function trig(name, idx) {
    return { triggerIdx: idx, type: 1, condition: 9, name_string: name };
}

// Quest that waits for the named objects to be clicked.
function quest(names) {
    return {
        isFinished:    function () { return false; },
        IsQuestActive: function () { return true; },
        GetQuestDefinition: function () {
            return { questTriggers_vector: names.map(function (n, i) { return trig(n, i); }) };
        },
        mQuestTriggersFinished_vector: names.map(function () { return { status: 0 }; })
    };
}

// opts.adventure, opts.objects (building opts), opts.quests (fake quests),
// opts.collectibles (names the host flags as collectible).
function boot(opts) {
    var H = harness.boot();
    var gi = H.host.game.gi;
    var z = H.zone.zone();
    var made = (opts.objects || []).map(function (o) { return H.zone.building(o); });
    made.forEach(function (b) { z.building(b); });
    gi.mCurrentPlayer = {};
    gi.mCurrentPlayerZone = z.zone;
    z.mountOnPlayer(gi.mCurrentPlayer);
    gi.mCurrentPlayer.mIsAdventureZone = opts.adventure === true;
    gi.mCurrentViewedZoneID = ZONE;
    var list = opts.quests || [];
    H.host.game.quests = {
        GetQuestPool: function () {
            return { GetQuest_vector: function () { return list; } };
        }
    };
    var flagged = opts.collectibles || [];
    H.Steward.core.buildings.isCollectible = function (b) {
        return flagged.indexOf(H.Steward.core.buildings.name(b)) > -1;
    };
    var sent = AC.wire(H);
    var selected = [];
    gi.SelectBuilding = function (b) { selected.push(b); };
    H.Steward.core.buildings.invalidate();

    var w = {
        H: H, S: H.Steward, mod: H.module('collect'), made: made, selected: selected,
        buildings: z.zone.mStreetDataMap.mBuildingContainer,
        busy: false, clock: 1000000, wakes: []
    };
    H.Steward.kernel.queue.isModuleBusy = function () { return w.busy; };
    H.Steward.kernel.scheduler.wake = function (id, ms) { w.wakes.push([id, ms]); return true; };
    H.Steward.modules.collect.now = function () { return w.clock; };
    return w;
}

function remove(w, building) {
    w.buildings.splice(w.buildings.indexOf(building), 1);
}

function egg(grid) {
    return { name: 'BuildingStripedEggs', grid: grid, playerId: 0 };
}

function crate(grid) {
    return { name: 'crate', grid: grid, selectable: true, attackable: true, playerId: ZONE };
}

function settings(w, extra) {
    var s = { enabled: true, namePatterns: ['StripedEggs'] };
    for (var k in (extra || {})) s[k] = extra[k];
    w.H.settings.write('collect', s);
}

function queuedAttempts(w) {
    return w.H.queued().filter(function (q) { return q.name === 'core.attempt'; });
}

// Plays the queued entries; the object is removed after the first poll when
// gone is given, as the host does after a successful click.
function settle(w, gone) {
    var removed = false;
    AC.drive(w.H, {
        onStep: function () {
            if (gone && !removed) {
                removed = true;
                remove(w, gone);
            }
        }
    });
}

// ---- home -----------------------------------------------------------------------

t.test('home clicks only a collectible that matches a pattern, verified once it is gone', function () {
    var w = boot({
        objects: [egg(1), { name: 'BuildingCharcoal', grid: 2, playerId: 0 }],
        collectibles: ['BuildingStripedEggs', 'BuildingCharcoal']
    });
    settings(w);

    w.mod.plan(HOME);
    t.assert.strictEqual(queuedAttempts(w).length, 1);

    settle(w, w.made[0]);
    t.assert.strictEqual(w.selected.length, 1);
    t.assert.strictEqual(w.selected[0], w.made[0]);
    t.assert.strictEqual(w.wakes.length, 1);
    t.assert.strictEqual(w.wakes[0][0], 'collect');

    // The charcoal pile is not a pattern match and is never clicked.
    w.H.clearQueued();
    w.mod.plan(HOME);
    t.assert.strictEqual(queuedAttempts(w).length, 0);
});

t.test('home plans one target per plan', function () {
    var w = boot({
        objects: [egg(1), egg(2)],
        collectibles: ['BuildingStripedEggs']
    });
    settings(w);
    w.mod.plan(HOME);
    t.assert.strictEqual(queuedAttempts(w).length, 1);
    settle(w, w.made[0]);
    t.assert.strictEqual(w.selected.length, 1);
    t.assert.strictEqual(w.selected[0], w.made[0]);
});

t.test('home plans nothing when no pattern matches', function () {
    var w = boot({ objects: [egg(7)], collectibles: ['BuildingStripedEggs'] });
    settings(w, { namePatterns: ['NonexistentResource'] });
    w.mod.plan(HOME);
    t.assert.strictEqual(w.H.queued().length, 0);
});

t.test('home ignores quest objects', function () {
    var w = boot({ quests: [quest(['crate'])], objects: [crate(5)] });
    settings(w);
    w.mod.plan(HOME);
    t.assert.strictEqual(w.H.queued().length, 0);
});

t.test('plan does nothing on an unreadable building list', function () {
    var w = boot({ objects: [] });
    settings(w);
    w.mod.plan(HOME);
    t.assert.strictEqual(w.H.queued().length, 0);
});

// ---- adventures -----------------------------------------------------------------

t.test('an adventure zone clicks a quest object, one per plan', function () {
    var w = boot({
        adventure: true,
        quests: [quest(['crate'])],
        objects: [crate(5), crate(6)]
    });
    settings(w, { adventureZones: true });

    t.assert.strictEqual(w.mod.isReady(ADVENTURE), true);
    w.mod.plan(ADVENTURE);
    t.assert.strictEqual(queuedAttempts(w).length, 1);

    // Selectable going false verifies the click.
    AC.drive(w.H, { onStep: function () { w.made[0].mIsSelectable = false; } });
    t.assert.strictEqual(w.selected.length, 1);
    t.assert.strictEqual(w.selected[0], w.made[0]);
});

// ---- scenario island ------------------------------------------------------------

// quest(names) in the given quest mode.
function modeQuest(names, mode) {
    var q = quest(names);
    q.mQuestMode = mode;
    return q;
}

// Puts a scenario run (or, with o.template, a template run) on the run
// state, with its island on o.zoneId (default the viewed zone).
function scenarioRun(w, o) {
    o = o || {};
    var r = {
        id: 'r1', status: o.status || w.S.RunStatus.Running,
        zoneId: o.zoneId === undefined ? ZONE : o.zoneId
    };
    if (!o.template) r.scenarioId = 'test_scenario';
    w.S.modules.adventures.state.current().run = r;
    return r;
}

// An adventure with a striped egg collectible, a crate of an unread quest and
// a barrel of a quest in mode 1.
function scenarioIsland() {
    var w = boot({
        adventure: true,
        quests: [modeQuest(['crate'], 2), modeQuest(['barrel'], 1)],
        objects: [egg(1), crate(5), { name: 'barrel', grid: 6, selectable: true, attackable: true, playerId: ZONE }],
        collectibles: ['BuildingStripedEggs']
    });
    settings(w, { adventureZones: true });
    return w;
}

t.test('a scenario island clicks no collectible and no object of a quest that is not running', function () {
    var w = scenarioIsland();
    scenarioRun(w);
    t.assert.strictEqual(w.S.modules.adventures.trips.scenarioViewed(), true);
    w.mod.plan(ADVENTURE);
    t.assert.strictEqual(queuedAttempts(w).length, 0);
});

// A quest whose end conditions count the named objects as destroyed.
function destroyQuest(names, mode) {
    var q = quest([]);
    q.GetQuestDefinition = function () {
        return {
            questTriggers_vector: [],
            endConditions_vector: names.map(function (n, i) {
                return { action_string: 'buildingdestroyed', item_string: n, triggerIdx: i };
            })
        };
    };
    q.mQuestMode = mode;
    return q;
}

// A flagged egg and a flagged bucket that a buildingdestroyed condition names.
function bucketIsland(mode) {
    var w = boot({
        adventure: true,
        quests: [destroyQuest(['BuildingBucket'], mode)],
        objects: [egg(1), { name: 'BuildingBucket', grid: 8, selectable: false, attackable: false, playerId: ZONE }],
        collectibles: ['BuildingStripedEggs', 'BuildingBucket']
    });
    settings(w, { adventureZones: true });
    return w;
}

t.test('a scenario island clicks a collectible a running quest counts and still no pattern collectible', function () {
    var w = bucketIsland(3);
    scenarioRun(w);
    w.mod.plan(ADVENTURE);
    t.assert.strictEqual(queuedAttempts(w).length, 1);
    AC.drive(w.H, { onStep: function () { remove(w, w.made[1]); } });
    t.assert.strictEqual(w.selected.length, 1);
    t.assert.strictEqual(w.selected[0], w.made[1]);
});

t.test('a scenario island does not click a named collectible of an unread quest', function () {
    var w = bucketIsland(2);
    scenarioRun(w);
    w.mod.plan(ADVENTURE);
    t.assert.strictEqual(queuedAttempts(w).length, 0);
});

t.test('a scenario island clicks a quest object once its quest is running (mode 3)', function () {
    var w = scenarioIsland();
    scenarioRun(w, { status: w.S.RunStatus.Paused });
    w.H.host.game.quests.GetQuestPool().GetQuest_vector()[0].mQuestMode = 3;
    w.mod.plan(ADVENTURE);
    t.assert.strictEqual(queuedAttempts(w).length, 1);
    AC.drive(w.H, { onStep: function () { w.made[1].mIsSelectable = false; } });
    t.assert.strictEqual(w.selected.length, 1);
    t.assert.strictEqual(w.selected[0], w.made[1]);
});

t.test('outside a scenario island collect behaves as before', function () {
    // A template run, a scenario run on another zone, a finished scenario
    // run and no run at all: the egg goes first as the first target.
    var cases = [{ template: true }, { zoneId: ZONE + 1 }, { status: 'done' }, null];
    for (var i = 0; i < cases.length; i++) {
        var w = scenarioIsland();
        if (cases[i]) {
            var o = cases[i];
            if (o.status === 'done') o.status = w.S.RunStatus.Done;
            scenarioRun(w, o);
        }
        t.assert.strictEqual(w.S.modules.adventures.trips.scenarioViewed(), false, 'case ' + i);
        w.mod.plan(ADVENTURE);
        t.assert.strictEqual(queuedAttempts(w).length, 1, 'case ' + i);
        AC.drive(w.H, { onStep: function () { remove(w, w.made[0]); } });
        t.assert.strictEqual(w.selected[0], w.made[0], 'case ' + i);
    }
});

t.test('an adventure with the setting off is not ready', function () {
    var w = boot({ adventure: true, quests: [quest(['crate'])], objects: [crate(5)] });
    settings(w, { adventureZones: false });
    t.assert.strictEqual(w.mod.isReady(ADVENTURE), false);
});

t.test('isReady is false while the adventures module has queue work in flight', function () {
    var w = boot({ adventure: true, quests: [quest(['crate'])], objects: [crate(5)] });
    settings(w, { adventureZones: true });
    w.busy = true;
    t.assert.strictEqual(w.mod.isReady(ADVENTURE), false);
    w.busy = false;
    t.assert.strictEqual(w.mod.isReady(ADVENTURE), true);
});

t.test('the adventures guard does not hold the home island', function () {
    var w = boot({ objects: [egg(1)], collectibles: ['BuildingStripedEggs'] });
    settings(w);
    w.busy = true;
    t.assert.strictEqual(w.mod.isReady(HOME), true);
});

t.test('isReady needs the module enabled and a known zone kind', function () {
    var w = boot({});
    settings(w, { enabled: false, adventureZones: true });
    t.assert.strictEqual(w.mod.isReady(HOME), false);
    t.assert.strictEqual(w.mod.isReady(ADVENTURE), false);

    settings(w, { adventureZones: true });
    t.assert.strictEqual(w.mod.isReady({ zone: { isHome: false, isAdventure: false } }), false);

    settings(w, { namePatterns: [] });
    t.assert.strictEqual(w.mod.isReady(HOME), false);
});

// ---- retry ----------------------------------------------------------------------

t.test('a failed click is not retried before CLICK_RETRY_MS and is retried after it', function () {
    var w = boot({ objects: [egg(1)], collectibles: ['BuildingStripedEggs'] });
    settings(w);
    var retryMs = w.S.modules.collect.CLICK_RETRY_MS;
    t.assert.strictEqual(typeof retryMs, 'number');

    w.mod.plan(HOME);
    t.assert.strictEqual(queuedAttempts(w).length, 1);
    // The building never leaves its grid, so the click fails.
    settle(w, null);
    t.assert.strictEqual(w.selected.length > 0, true);
    var clicks = w.selected.length;

    w.H.clearQueued();
    w.clock += retryMs - 1;
    w.mod.plan(HOME);
    t.assert.strictEqual(queuedAttempts(w).length, 0);

    w.clock += 1;
    w.mod.plan(HOME);
    t.assert.strictEqual(queuedAttempts(w).length, 1);
    settle(w, null);
    t.assert.strictEqual(w.selected.length > clicks, true);
});

t.test('a failed target does not hold back the next one', function () {
    var w = boot({ objects: [egg(1), egg(2)], collectibles: ['BuildingStripedEggs'] });
    settings(w);
    w.mod.plan(HOME);
    settle(w, null);
    t.assert.strictEqual(w.selected[0], w.made[0]);

    w.selected.length = 0;
    w.H.clearQueued();
    w.mod.plan(HOME);
    settle(w, w.made[1]);
    t.assert.strictEqual(w.selected[0], w.made[1]);
});

// ---- boot -----------------------------------------------------------------------

t.test('boot writes the defaults when nothing is stored', function () {
    var w = boot({});
    w.mod.boot();
    var s = w.H.settings.read('collect');
    t.assert.strictEqual(s.adventureZones, true);
    t.assert.strictEqual(s.enabled, w.S.modules.collect.defaultSettings.enabled);
});

t.test('boot seeds adventureZones into stored settings that lack it', function () {
    var w = boot({});
    w.H.settings.write('collect', { enabled: true, namePatterns: ['Eggs'] });
    w.mod.boot();
    var s = w.H.settings.read('collect');
    t.assert.strictEqual(s.adventureZones, true);
    t.assert.strictEqual(s.enabled, true);
    t.assert.deepStrictEqual(s.namePatterns, ['Eggs']);
});

t.test('boot does not overwrite a stored adventureZones false', function () {
    var w = boot({});
    w.H.settings.write('collect', { enabled: true, namePatterns: ['Eggs'], adventureZones: false });
    w.mod.boot();
    t.assert.strictEqual(w.H.settings.read('collect').adventureZones, false);
});

// ---- dashboard surface ----------------------------------------------------------

var jq = require('../stubs/jq');

function uiRig(groups) {
    var H = harness.boot();
    var $ = jq.install(H);
    H.Steward.core.buildings.collectiblesByName = function () { return groups; };
    H.Steward.core.buildings.invalidate = function () {};
    return { H: H, $: $, h: H.Steward.kernel.ui.helpers, mod: H.Steward.modules.collect };
}

t.test('the section keeps "Collect Pickups" as the quick-toggle title and a sentence-case heading', function () {
    var section = harness.boot().module('collect').ui.section;
    t.assert.strictEqual(section.title, 'Collect Pickups');
    t.assert.strictEqual(section.heading, 'Collect pickups');
});

t.test('render lists the collectibles on the zone with their counts', function () {
    var r = uiRig([{ name: 'Bush', count: 3 }, { name: 'Chest', count: 1 }]);
    var $main = r.$('<div>');
    r.mod.render($main, r.h);
    t.assert.strictEqual($main.find('.steward-card-meta').eq(0).text(), '2 collectible types');
    var $rows = $main.find('tbody tr');
    t.assert.strictEqual($rows.length, 2);
    t.assert.strictEqual($rows.eq(0).children('td').eq(0).text(), 'Bush');
    t.assert.strictEqual($rows.eq(0).children('td').eq(1).text(), '3 on zone');
    t.assert.strictEqual($main.find('.steward-empty').length, 0);
});

t.test('render with no collectibles shows the empty state and still offers Discover', function () {
    var r = uiRig([]);
    var $main = r.$('<div>');
    r.mod.render($main, r.h);
    t.assert.strictEqual($main.find('.steward-empty-title').text(), 'Nothing to collect here right now.');
    t.assert.strictEqual($main.find('table').length, 0);
    t.assert.strictEqual($main.find('.steward-card-meta').eq(0).text(), '0 collectible types');
    t.assert.strictEqual($main.find('button').length, 1);
});

t.test('tiles describe the zone and the adventure setting from the buffer', function () {
    var r = uiRig([{ name: 'Bush', count: 3 }]);
    var one = r.mod.tiles(r.h);
    t.assert.strictEqual(one.length, 1);
    t.assert.strictEqual(one[0].title, 'Collect pickups');
    t.assert.strictEqual(one[0].lines[0], '1 collectible type on this zone');
    t.assert.strictEqual(one[0].lines[1], 'Home island only');
    r.h.set('collect', 'adventureZones', true);
    t.assert.strictEqual(r.mod.tiles(r.h)[0].lines[1], 'Also picks up on adventures');
    r.H.Steward.core.buildings.collectiblesByName = function () { return []; };
    t.assert.strictEqual(r.mod.tiles(r.h)[0].lines[0], 'Nothing collectible on this zone');
});
