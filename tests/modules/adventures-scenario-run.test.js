'use strict';

// Scenario runs of the adventures module: the run kind in the one step table
// (the skip in go(), the folded menu rows, the options per kind, the
// persisted scenario fields) and the whole chain from home through the trips
// of one map and back, on the home world of tests/stubs/adventures.js with
// scenario items ({ items }).
//
// drive() ticks and plays one pass at a time and helps the world the way the
// game would between passes: production finishes at Produce, and the map's
// last quest finishes at Clear.

var t = require('../runner');
var harness = require('../harness');
var W = require('../stubs/adventures');

var assert = t.assert;

var HOME = W.HOME;
var ZONE = W.ZONE;
var PASS_MS = 10000;

var tick = W.tick;
var play = W.play;
var stepName = W.stepName;
var plain = W.plain;

var BRIDGE = 'ChangeSkin_BuffAd_Bridge';
var SHEET = 'ChangeSkin_BuffAd_Broadsheet';
var RESCUE = 'ChangeSkin_BuffAd_Rescueparty';
var DYN = 'BattleBuffHurt_BuffAd_SmallDynamite';
var GLUE = 'BattleBuffHurt_BuffAd_Glue';
var SPLASH = 'BattleBuffHurt_BuffAd_WaterSplash';
var BLAST = 'BattleBuffHurt_BuffAd_Explosive';
var EXPERT = 'BattleBuffHurt_BuffAd_Specialist';
var MEDIUM = 'BattleBuffHurt_BuffAd_MediumDynamite';
var BIG = 'BattleBuffHurt_BuffAd_BigDynamite';
var STINKY = 'BattleBuffHurt_BuffAd_StinkyPotion';
var DECOMP = 'BattleBuffHurt_BuffAd_Decomposer';
var POISON = 'BattleBuffHurt_BuffAd_Poison';
var SHOVEL = 'BattleBuffHurt_BuffAd_Shovel1';
var SCHOOL = 'ChangeSkin_BuffAd_SchoolKit';
var NOBLE = 'ChangeSkin_BuffAd_NobleResidenceKit';
var TAVERN = 'ChangeSkin_BuffAd_TavernKit1';
var RESID = 'ChangeSkin_BuffAd_ResidenceKit';

var COST = [{ name_string: 'Wood', amount: 2 }];

function items() {
    var out = {};
    [BRIDGE, SHEET, RESCUE, DYN, GLUE, SPLASH, BLAST, EXPERT, MEDIUM, BIG, STINKY, DECOMP,
        POISON, SHOVEL, SCHOOL, NOBLE, TAVERN, RESID].forEach(function (b) {
        out[b] = { group: '0', yield: 1, costs: COST };
    });
    return out;
}

// Twins-like: a visit trip, then two items on three grids each, then one item.
var TWINS = {
    id: 'twins_test', label: 'Twins (test)',
    trips: [
        {},
        { items: [{ buff: BRIDGE, grids: [11, 12, 13] }, { buff: SHEET, grids: [21, 22, 23] }] },
        { items: [{ buff: RESCUE, grids: [31] }] }
    ]
};

// Storm-like: small dynamite amount 10 as the trip total over four grids.
var STORM = {
    id: 'storm_test', label: 'Storm (test)',
    trips: [{ items: [{ buff: DYN, grids: [41, 42, 43, 44], amount: 10 }] }, {}]
};

// A record as the scenario store gives it: trips normalised by its parser.
function record(w, raw) {
    var trips = w.S.modules.adventures.scenarios.normTrips(plain(raw.trips));
    assert.ok(trips, 'test trips normalise');
    return { id: raw.id, label: raw.label, trips: trips };
}

// The home world with no generals, scenario items and the quests that want
// them; every grid needs one item unless o.gridNeed says otherwise.
function scenWorld(o) {
    o = o || {};
    var quests = o.quests || [
        { key: 'qb', name: 'Bridges', item: BRIDGE, grids: [11, 12, 13] },
        { key: 'qs', name: 'Papers', item: SHEET, grids: [21, 22, 23] },
        { key: 'qr', name: 'Rescue', item: RESCUE, grids: [31] },
        { key: 'qm', name: 'MainQuest', item: BRIDGE, grids: [11] },
        { key: 'q9', name: 'Final', finished: false, last: true }
    ];
    var need = o.gridNeed || { 11: 1, 12: 1, 13: 1, 21: 1, 22: 1, 23: 1, 31: 1 };
    var opts = {
        home: true, generals: [], free: {}, items: items(), resources: { Wood: 1000 },
        quests: quests, gridNeed: need, settings: { retrain: true }
    };
    for (var k in (o.world || {})) if (Object.prototype.hasOwnProperty.call(o.world, k)) opts[k] = o.world[k];
    var w = W.world(opts);
    w.gi = w.H.host.game.gi;
    return w;
}

function lastQuest(w) {
    var list = w.quests || [];
    for (var i = 0; i < list.length; i++) if (list[i].last) return list[i];
    return null;
}

// What the game does between two passes without being asked: production
// finishes while the run waits at Produce (unless o.noProduce), the last quest
// finishes at Clear.
function help(w, name, o) {
    if (name === 'Produce' && !o.noProduce) w.produce();
    if (name === 'Clear' && w.quests) {
        var q = lastQuest(w);
        if (q) q.finished = true;
    }
}

// Ticks and plays pass by pass until the run is no longer Running or
// o.until(w, name) holds. Returns the number of passes.
function drive(w, o) {
    o = o || {};
    var max = o.max || 600;
    for (var i = 0; i < max; i++) {
        var r = w.st.run();
        if (!r || r.status !== w.S.RunStatus.Running) return i;
        var name = stepName(w);
        if (o.until && o.until(w, name)) return i;
        if (o.help !== false) help(w, name, o);
        if (o.on) o.on(w, name);
        tick(w);
        play(w);
        w.t += typeof o.dt === 'number' ? o.dt : 5000;
    }
    return i;
}

function at(name) {
    return function (w, n) { return n === name; };
}

function passesFor(w, ms) {
    var end = w.t + ms;
    while (w.t < end) {
        W.ticksFor(w, Math.min(PASS_MS, end - w.t));
        play(w);
    }
}

function assertStep(w, name) {
    var r = w.st.run();
    assert.strictEqual(stepName(w), name, 'step ' + stepName(w) + (r.pause ? ' (' + r.pause.message + ')' : ''));
    assert.strictEqual(r.status, w.S.RunStatus.Running, 'status ' + r.status + (r.pause ? ': ' + r.pause.message : ''));
}

function assertPaused(w, reason, re) {
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Paused, 'status ' + r.status + ' at ' + stepName(w));
    assert.strictEqual(r.pause.reason, reason, 'reason ' + r.pause.reason + ': ' + r.pause.message);
    if (re) assert.ok(re.test(r.pause.message), r.pause.message);
}

function logLines(w) {
    return w.H.logs().filter(function (l) { return l.category === 'adventures'; })
        .map(function (l) { return l.args.join(' '); });
}

function logged(w, re) {
    return logLines(w).some(function (l) { return re.test(l); });
}

// Series transitions logged by state.go(): [{ from, to, text }] in order. The
// item lines ('b -> 11: took ...') are not transitions.
function transitions(w) {
    var out = [];
    w.H.logs().forEach(function (l) {
        if (l.category !== 'adventures' || l.level !== 'log') return;
        var m = /^([^:]+): (\w+) -> (\w+)(?: \(|$)/.exec(l.args.join(' '));
        if (m) out.push({ wave: /^wave /.test(m[1]), from: m[2], to: m[3], text: l.args.join(' ') });
    });
    return out;
}

function sendsTo(w, buff) {
    return w.itemSends.filter(function (s) { return s.buff === buff; });
}

// The run on the island at Apply of trip `trip`, the map open on ZONE.
function onIsland(w, rec, trip, o) {
    o = o || {};
    w.adventures = [{ adventureName: 'BlackKnights', zoneID: ZONE }];
    w.gi.visitZone(ZONE);
    return W.startScenario(w, rec, { step: o.step || w.S.RunStep.Apply, trip: trip, zoneId: ZONE });
}

// A script reload: the same files run again; the run state survives in the
// module namespace, the queue does not.
function reload(w) {
    var settings = w.S.kernel.settings.read('adventures');
    w.H = harness.reload(w.H);
    if (settings) w.H.Steward.kernel.settings.write('adventures', settings);
    w.H.clearQueued();
    w.pending = [];
    w.S = w.H.Steward;
    w.st = w.S.modules.adventures.state;
    w.ex = w.S.modules.adventures.executor;
    w.mod = w.H.module('adventures');
    w.st.now = function () { return w.t; };
    W.patchCore(w);
}

// A client restart: a fresh boot on the same disk, the run read back from its
// file. The game keeps what it holds; the record arrays are shared.
var CARRIED = ['t', 'adventures', 'stock', 'queues', 'quests', 'gridNeed', 'itemSends', 'buffActions',
    'productionOrders', 'claims', 'closes', 'auto', 'resources'];

function restart(w) {
    var viewed = w.gi.mCurrentViewedZoneID;
    var w2 = W.world({
        home: true, fs: w.fs, generals: [], free: {}, items: w.items,
        settings: w.S.kernel.settings.read('adventures') || {}
    });
    CARRIED.forEach(function (k) { w2[k] = w[k]; });
    w2.gi = w2.H.host.game.gi;
    w2.gi.visitZone(viewed);
    w2.mod.boot();
    assert.ok(w2.st.run(), 'the run came back from the file');
    return w2;
}

// ---- run kind in the step table ---------------------------------------------------

t.test('go(): a template run skips Produce on the way to Validate and logs the skip', function () {
    var w = scenWorld();
    var r = W.startRun(w, [], { step: w.S.RunStep.Muster });
    w.st.go(w.S.RunStep.Produce, 'generals home');
    assert.strictEqual(r.step, w.S.RunStep.Validate);
    assert.ok(logged(w, /Muster -> Validate \(generals home; skipped Produce\)$/), logLines(w).join('\n'));
});

t.test('go(): a scenario run skips the general rows, without why only the skip is named', function () {
    var w = scenWorld();
    var r = W.startScenario(w, record(w, TWINS), { step: w.S.RunStep.StartMap });
    w.st.go(w.S.RunStep.Depart);
    assert.strictEqual(r.step, w.S.RunStep.Jump);
    assert.ok(logged(w, /StartMap -> Jump \(skipped Depart\)$/), logLines(w).join('\n'));
    w.st.go(w.S.RunStep.Arrive, 'on the map');
    assert.strictEqual(r.step, w.S.RunStep.Apply);
    w.st.go(w.S.RunStep.Pickups);
    assert.strictEqual(r.step, w.S.RunStep.Trip, 'Pickups and StarAll skipped');
    w.st.go(w.S.RunStep.PackStar, 'waves done');
    assert.strictEqual(r.step, w.S.RunStep.Clear, 'PackStar and Pack skipped');
    w.st.go(w.S.RunStep.Account, 'generals home');
    assert.strictEqual(r.step, w.S.RunStep.Next);
    assert.ok(logged(w, /-> Next \(generals home; skipped Account, Population, Retrain\)$/), logLines(w).join('\n'));
});

t.test('go(): a template run keeps its horseshoe and retrain steps', function () {
    var w = scenWorld();
    var r = W.startRun(w, [], { step: w.S.RunStep.ArriveHome });
    w.st.go(w.S.RunStep.Account, 'generals home');
    assert.strictEqual(r.step, w.S.RunStep.Account);
    w.st.go(w.S.RunStep.Horseshoe);
    assert.strictEqual(r.step, w.S.RunStep.Horseshoe);
});

t.test('stepRows: neighbours fold only on equal group, label and option', function () {
    var w = scenWorld();
    var rows = w.st.stepRows();
    var labels = rows.map(function (x) { return x.waves ? 'waves' : x.label; });
    assert.strictEqual(labels[0], 'Wait between maps');
    assert.strictEqual(labels[1], 'Produce items');
    assert.strictEqual(labels[2], 'Check generals and files');
    var close = labels.indexOf('Claim last quest and close');
    assert.ok(close > 0, 'Close has its own row');
    assert.ok(labels.indexOf('Send generals home') < 0, 'closing the map returns the generals');
    assert.strictEqual(labels[close + 1], 'Return home');
    var ret = rows[close + 1];
    assert.strictEqual(ret.last - ret.first, 1, 'JumpHome and ArriveHome fold');
    var load = rows[labels.indexOf('Load generals')];
    assert.strictEqual(load.last - load.first, 5, 'the six load steps fold');
    var waves = rows.filter(function (x) { return x.waves; });
    assert.strictEqual(waves.length, 1);
    assert.strictEqual(waves[0].option, 'generals');
});

t.test('optionOff: each run kind switches off the other kind\'s rows', function () {
    var w = scenWorld();
    var tr = W.startRun(w, []);
    tr.speedBuff = 'GeneralSpeedBuff_x';
    assert.strictEqual(w.st.optionOff(tr, 'scenario'), true);
    assert.strictEqual(w.st.optionOff(tr, 'generals'), false);
    assert.strictEqual(w.st.optionOff(tr, 'horseshoe'), false);
    assert.strictEqual(w.st.optionOff(tr, ''), false);
    var sr = W.startScenario(w, record(w, TWINS));
    sr.speedBuff = 'GeneralSpeedBuff_x';
    assert.strictEqual(w.st.optionOff(sr, 'scenario'), false);
    assert.strictEqual(w.st.optionOff(sr, 'generals'), true);
    assert.strictEqual(w.st.optionOff(sr, 'horseshoe'), true);
    assert.strictEqual(w.st.optionOff(sr, 'retrain'), true);
    assert.strictEqual(w.st.optionOff(sr, ''), false);
    assert.strictEqual(w.st.isScenario(sr), true);
    assert.strictEqual(w.st.isScenario(tr), false);
});

t.test('newRun/normRun: scenarioId, trips and trip round-trip through the file', function () {
    var w = scenWorld();
    var rec = record(w, TWINS);
    W.startScenario(w, rec, { trip: 1 });
    var w2 = restart(w);
    var r = w2.st.run();
    assert.strictEqual(r.scenarioId, 'twins_test');
    assert.strictEqual(r.trip, 1);
    assert.deepStrictEqual(plain(r.trips), plain(rec.trips));
    assert.strictEqual(r.status, w2.S.RunStatus.Running);
    assert.strictEqual(w2.st.tripLabel(), 'trip 2/3');
    assert.ok(/Twins \(test\), run 1\/1, trip 2\/3/.test(w2.st.status()), w2.st.status());
});

t.test('normRun: a template run reads back with no trips', function () {
    var w = scenWorld();
    W.startRun(w, ['C:/b/w1.txt']);
    var w2 = restart(w);
    var r = w2.st.run();
    assert.strictEqual(r.scenarioId, '');
    assert.deepStrictEqual(plain(r.trips), []);
    assert.strictEqual(r.trip, 0);
    assert.strictEqual(w2.st.tripLabel(), '');
});

t.test('normRun: bad scenario trips in the file pause the run', function () {
    var w = scenWorld();
    W.startScenario(w, record(w, TWINS));
    var file = JSON.parse(w.fs.disk[W.RUN_FILE]);
    file.run.trips = [{ items: [{ buff: BRIDGE, grids: [] }] }];
    w.fs.disk[W.RUN_FILE] = JSON.stringify(file);
    var w2 = restart(w);
    var r = w2.st.run();
    assert.strictEqual(r.status, w2.S.RunStatus.Paused);
    assert.strictEqual(r.pause.reason, w2.S.RunPause.WaveFile);
    assert.ok(/no valid scenario trips/.test(r.pause.message), r.pause.message);
    assert.deepStrictEqual(plain(r.trips), []);
});

// ---- the whole chain ------------------------------------------------------------

t.test('chain: a 3-trip run from home passes every scenario step and no general step', function () {
    var w = scenWorld();
    var rec = record(w, TWINS);
    W.startScenario(w, rec);
    var firstOrders = null;
    drive(w, { max: 900, on: function (w2, name) {
        if (firstOrders === null && name === 'StartMap') firstOrders = plain(w2.productionOrders);
    } });
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Done, 'status ' + r.status + ' at ' + stepName(w) +
        (r.pause ? ': ' + r.pause.message : ''));
    assert.ok(!logged(w, /run paused/), 'no pause');

    // The first Produce orders the items of trip 2 while trip 1 is a visit.
    var first = {};
    firstOrders.forEach(function (o) { first[o.unit] = (first[o.unit] || 0) + o.amount; });
    assert.deepStrictEqual(first, { 'ChangeSkin_BuffAd_Bridge': 3, 'ChangeSkin_BuffAd_Broadsheet': 3 });

    var names = transitions(w).map(function (x) { return x.from + '->' + x.to; });
    var want = [
        'Muster->Produce', 'Produce->StartMap', 'StartMap->Jump', 'Jump->Apply', 'Apply->Trip', 'Trip->JumpHome',
        'JumpHome->ArriveHome', 'ArriveHome->Produce', 'Produce->StartMap', 'StartMap->Jump', 'Jump->Apply',
        'Apply->Trip', 'Trip->JumpHome', 'JumpHome->ArriveHome', 'ArriveHome->Produce', 'Produce->StartMap',
        'StartMap->Jump', 'Jump->Apply', 'Apply->Trip', 'Trip->Clear', 'Clear->LastQuest', 'LastQuest->Close',
        'Close->JumpHome', 'JumpHome->ArriveHome', 'ArriveHome->Next'
    ];
    assert.deepStrictEqual(names, want, names.join(' '));
    var general = ['Validate', 'Deploy', 'Snapshot', 'Supply', 'Unload', 'Load', 'Verify', 'Depart', 'Arrive',
        'Pickups', 'StarAll', 'Horseshoe', 'PackStar', 'Pack', 'Account', 'Population', 'Retrain'];
    transitions(w).forEach(function (x) {
        assert.ok(!x.wave, 'no wave step: ' + x.text);
        assert.ok(general.indexOf(x.to) < 0, 'no general step entered: ' + x.text);
    });

    assert.deepStrictEqual(sendsTo(w, BRIDGE).map(function (s) { return s.grid; }), [11, 12, 13]);
    assert.deepStrictEqual(sendsTo(w, SHEET).map(function (s) { return s.grid; }), [21, 22, 23]);
    assert.deepStrictEqual(sendsTo(w, RESCUE).map(function (s) { return s.grid; }), [31]);
    w.itemSends.forEach(function (s) { assert.strictEqual(s.amount, 1, s.buff + ' -> ' + s.grid); });
    assert.strictEqual(w.buffActions.filter(function (b) { return b.type === 'Adventure'; }).length, 1, 'one map');
    assert.strictEqual(w.closes.length, 1);
    assert.strictEqual(w.zoneSends.length, 0, 'no general sent');
    assert.strictEqual(w.H.host.game.gi.mCurrentViewedZoneID, HOME);
});

// ---- quest gating -----------------------------------------------------------------

var ONE = {
    id: 'one_test', label: 'One (test)',
    trips: [{ items: [{ buff: BRIDGE, grids: [11, 12] }] }, {}]
};

t.test('Apply: no send while the wanting quest is unread; sent once it is read', function () {
    var w = scenWorld({ quests: [{ key: 'qb', name: 'Bridges', item: BRIDGE, grids: [11, 12], unread: true },
        { key: 'q9', name: 'Final', last: true }] });
    w.auto.readFails = true;
    w.setStock(BRIDGE, 5);
    onIsland(w, record(w, ONE), 0);
    passesFor(w, 120000);
    assertStep(w, 'Apply');
    assert.strictEqual(w.itemSends.length, 0, 'nothing sent to an unread quest');
    assert.ok(/waiting for a quest that wants ChangeSkin_BuffAd_Bridge/.test(w.st.current().busy.text),
        w.st.current().busy.text);
    w.auto.readFails = false;
    drive(w, { until: at('Trip') });
    assert.deepStrictEqual(sendsTo(w, BRIDGE).map(function (s) { return s.grid; }), [11, 12]);
    assert.strictEqual(w.stockOf(BRIDGE), 3);
});

t.test('Apply: the wait for a quest that is not running is logged once with its mode', function () {
    var w = scenWorld({ quests: [{ key: 'qb', name: 'Bridges', item: BRIDGE, grids: [11, 12], unread: true },
        { key: 'q9', name: 'Final', last: true }] });
    w.auto.readFails = true;
    w.setStock(BRIDGE, 5);
    onIsland(w, record(w, ONE), 0);
    passesFor(w, 120000);
    var re = /waiting for quest Bridges to be running, mode 2/;
    var hits = logLines(w).filter(function (l) { return re.test(l); });
    assert.strictEqual(hits.length, 1, logLines(w).join('\n'));
    assert.strictEqual(w.itemSends.length, 0);
});

t.test('Apply: the main quest alone never wants an item; no quest pauses after the quiet time', function () {
    var w = scenWorld({ quests: [{ key: 'qm', name: 'MainQuest', item: BRIDGE, grids: [11, 12] },
        { key: 'q9', name: 'Final', last: true }] });
    w.setStock(BRIDGE, 5);
    onIsland(w, record(w, ONE), 0);
    passesFor(w, w.S.modules.adventures.trips.APPLY_QUIET_MS - 60000);
    assertStep(w, 'Apply');
    passesFor(w, 120000);
    assertPaused(w, w.S.RunPause.NotObserved, /no open quest wants ChangeSkin_BuffAd_Bridge after 10 min/);
    assert.strictEqual(w.itemSends.length, 0);
});

t.test('Apply: a quest that no longer wants the item skips its grids', function () {
    var w = scenWorld({ quests: [{ key: 'qb', name: 'Bridges', item: BRIDGE, grids: [11, 12], met: true,
        stayOpen: true }, { key: 'q9', name: 'Final', last: true }] });
    w.setStock(BRIDGE, 5);
    onIsland(w, record(w, ONE), 0);
    drive(w, { until: at('Trip') });
    assertStep(w, 'Trip');
    assert.strictEqual(w.itemSends.length, 0);
    assert.ok(logged(w, /quest no longer wants ChangeSkin_BuffAd_Bridge; 2 grid\(s\) skipped/), logLines(w).join('\n'));
});

t.test('Trip: a collectible a running quest counts holds the trip; JumpHome once it is picked up', function () {
    var w = scenWorld({ quests: [{ key: 'qb', name: 'Bridges', item: BRIDGE, grids: [11, 12], met: true,
        stayOpen: true }, { key: 'q9', name: 'Final', last: true }] });
    w.setStock(BRIDGE, 5);
    // The trip counts map objects only where collect picks up on adventures.
    w.H.settings.write('collect', { enabled: true, namePatterns: [], adventureZones: true });
    onIsland(w, record(w, ONE), 0);
    drive(w, { until: at('Trip') });
    assertStep(w, 'Trip');
    w.pickups = [{ grid: 31, name: 'BuildingBucket', kind: 'collectible', named: true, zoneId: ZONE }];
    passesFor(w, 60000);
    assertStep(w, 'Trip');
    assert.ok(!logged(w, /leaving with/), logLines(w).join('\n'));
    w.pickups = [];
    drive(w, { until: at('JumpHome') });
    assertStep(w, 'JumpHome');
});

// ---- trip end: settle, awaited pick-ups ------------------------------------------

var COLLECT_ON = { enabled: true, namePatterns: [], adventureZones: true };
var HAMMER = 'buffad_collectible_UsedHammer';

// The run at the Trip step of trip 0 on the island, collect picking up there.
function atTrip() {
    var w = scenWorld({ quests: [{ key: 'qb', name: 'Bridges', item: BRIDGE, grids: [11, 12], met: true,
        stayOpen: true }, { key: 'q9', name: 'Final', last: true }] });
    w.setStock(BRIDGE, 5);
    w.H.settings.write('collect', COLLECT_ON);
    onIsland(w, record(w, ONE), 0);
    drive(w, { until: at('Trip') });
    assertStep(w, 'Trip');
    return w;
}

function onePass(w) {
    W.ticksFor(w, PASS_MS);
    play(w);
}

// A look soon after the last one, inside READ_LAG_MS of it.
function shortPass(w) {
    W.ticksFor(w, 3000);
    play(w);
}

// Passes until the step is `name` or ms ran out; returns whether it was reached.
function passesUntil(w, name, ms) {
    var end = w.t + ms;
    while (w.t < end) {
        if (stepName(w) === name) return true;
        onePass(w);
    }
    return stepName(w) === name;
}

function settleMs(w) {
    return w.S.modules.adventures.trips.QUEST_SETTLE_MS;
}

function readLag(w) {
    return w.S.modules.adventures.loader.READ_LAG_MS;
}

// Passes until `have()` holds; returns the verified quest stamp of that pass.
function passUntilStamped(w, have, ms) {
    var end = w.t + ms;
    while (w.t < end && !have()) onePass(w);
    assert.ok(have(), 'the event happened');
    var q = w.st.current().questAt;
    assert.ok(q && typeof q.at === 'number', 'a verified stamp');
    return q.at;
}

t.test('Trip: a quest read during Trip restarts the settle; no leave within QUEST_SETTLE_MS of the read', function () {
    var w = atTrip();
    w.quests.push({ key: 'qn', name: 'Next', item: BRIDGE, grids: [11], unread: true, stayOpen: true });
    var tr = passUntilStamped(w, function () { return w.reads.length > 0; }, 60000);
    var limit = tr + settleMs(w);
    while (w.t < limit) {
        assertStep(w, 'Trip');
        onePass(w);
        if (w.t < limit) assertStep(w, 'Trip');
    }
    assert.ok(passesUntil(w, 'JumpHome', 4 * PASS_MS), 'left after the settle: ' + stepName(w));
    assert.ok(w.t >= limit, 'not before the settle ran out');
});

t.test('Trip: a running quest\'s pick-up not on the map yet holds the trip', function () {
    var w = atTrip();
    w.awaited = [{ name: HAMMER, zoneId: ZONE }];
    passesFor(w, 60000);
    assertStep(w, 'Trip');
    assert.ok(!logged(w, /leaving with/), logLines(w).join('\n'));
    assert.ok(logged(w, /not on the map yet|waiting for it to appear/), logLines(w).join('\n'));
    // It shows on the map: still held, now as an object.
    w.awaited = [];
    w.pickups = [{ grid: 31, name: HAMMER, kind: 'collectible', named: true, zoneId: ZONE }];
    onePass(w);
    assertStep(w, 'Trip');
    // Collect picked it up: the map must read clear once more before leaving.
    w.pickups = [];
    shortPass(w);
    assertStep(w, 'Trip');
    assert.ok(passesUntil(w, 'JumpHome', 60000), 'then it leaves: ' + stepName(w));
});

t.test('Trip: held and awaited pick-ups are each noted once across repeated passes', function () {
    var w = atTrip();
    w.held = [{ name: 'buffad_collectible_Other', quest: 'qx', mode: 2, zoneId: ZONE }];
    w.awaited = [{ name: HAMMER, zoneId: ZONE }];
    passesFor(w, 60000);
    assertStep(w, 'Trip');
    function count(re) {
        return logLines(w).filter(function (l) { return re.test(l); }).length;
    }
    assert.strictEqual(count(/waiting for quest qx to be running/), 1, logLines(w).join('\n'));
    assert.strictEqual(count(/waiting for it to appear on the map/), 1, logLines(w).join('\n'));
});

t.test('Trip: leaves once the awaited condition is met', function () {
    var w = atTrip();
    w.awaited = [{ name: HAMMER, zoneId: ZONE }];
    passesFor(w, 20000);
    assertStep(w, 'Trip');
    w.awaited = [];
    shortPass(w);
    assertStep(w, 'Trip');
    assert.ok(passesUntil(w, 'JumpHome', readLag(w) + 3 * PASS_MS), 'left: ' + stepName(w));
});

t.test('Trip: an awaited pick-up that never appears leaves after TRIP_MAX_MS when the next trip is not short, no pause', function () {
    var w = atTrip();
    w.awaited = [{ name: HAMMER, zoneId: ZONE }];
    passesFor(w, w.S.modules.adventures.trips.TRIP_MAX_MS + 30000);
    assert.ok(logged(w, /leaving with: .*not on the map yet/), logLines(w).join('\n'));
    assert.notStrictEqual(stepName(w), 'Trip');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
});

t.test('Trip: a quest claimed during Trip restarts the settle; a late next quest is read before JumpHome', function () {
    var w = atTrip();
    w.quests.push({ key: 'qf', name: 'Done', item: BRIDGE, grids: [11], finished: true });
    var tc = passUntilStamped(w, function () { return w.claims.length > 0; }, 60000);
    var late = false;
    var limit = tc + settleMs(w);
    var lateAt = null;
    while (w.t < limit + 3 * PASS_MS && stepName(w) === 'Trip') {
        if (!late && w.t >= tc + 5000) {
            w.quests.push({ key: 'qn', name: 'Next', item: BRIDGE, grids: [11], unread: true, stayOpen: true });
            late = true;
        }
        onePass(w);
        if (w.t < limit) assertStep(w, 'Trip');
        if (lateAt === null && w.reads.length > 0) lateAt = w.st.current().questAt.at;
    }
    assert.ok(late, 'the late quest appeared');
    assert.ok(w.reads.length > 0, 'the late quest was read before the step left Trip');
    assert.ok(lateAt !== null && lateAt > tc);
    assert.ok(passesUntil(w, 'JumpHome', settleMs(w) + 4 * PASS_MS), 'left: ' + stepName(w));
    assert.ok(w.t >= lateAt + settleMs(w), 'the settle counts from the late read');
});

t.test('Trip: after the last object is picked the map must stay clear for READ_LAG_MS', function () {
    var w = atTrip();
    w.pickups = [{ grid: 31, name: HAMMER, kind: 'collectible', named: true, zoneId: ZONE }];
    onePass(w);
    assertStep(w, 'Trip');
    w.pickups = [];
    var seen = w.st.current().tripSeenAt;
    assert.strictEqual(typeof seen, 'number', 'the last look that saw the object is stamped');
    shortPass(w);
    assertStep(w, 'Trip');
    assert.ok(/making sure no quest or object is left/.test(w.st.current().busy.text), w.st.current().busy.text);
    assert.ok(passesUntil(w, 'JumpHome', readLag(w) + 4 * PASS_MS), 'left: ' + stepName(w));
    assert.ok(w.t >= seen + readLag(w), 'not before READ_LAG_MS after the last look that saw it');
});

// ---- amounts and stock --------------------------------------------------------------

t.test('Apply: a send offers min(amount, stock); a full-bound send taken whole is done', function () {
    var rec = { id: 'amt', label: 'Amount (test)', trips: [{ items: [{ buff: DYN, grids: [41], amount: 10 }] }, {}] };
    var w = scenWorld({ quests: [{ key: 'qd', name: 'Rocks', item: DYN, grids: [41] },
        { key: 'q9', name: 'Final', last: true }], gridNeed: { 41: 10 } });
    w.setStock(DYN, 20);
    onIsland(w, record(w, rec), 0);
    drive(w, { until: at('Trip') });
    assert.deepStrictEqual(plain(sendsTo(w, DYN).map(function (s) { return [s.grid, s.amount, s.took]; })), [[41, 10, 10]]);
    assert.ok(logged(w, /apply BattleBuffHurt_BuffAd_SmallDynamite x10 -> 41 \(stock 20\)/), logLines(w).join('\n'));
    assert.ok(logged(w, /SmallDynamite -> 41: took 10 of 10; grid done/), 'a full-bound send taken whole is done');
    assert.strictEqual(w.stockOf(DYN), 10);
});

t.test('Apply: out of stock with grids left goes home and comes back to the same trip', function () {
    var w = scenWorld({ quests: [{ key: 'qb', name: 'Bridges', item: BRIDGE, grids: [11, 12] },
        { key: 'q9', name: 'Final', last: true }] });
    w.setStock(BRIDGE, 1);
    onIsland(w, record(w, ONE), 0);
    var steps = [];
    drive(w, { max: 400, until: function (w2) { return w2.st.run().trip === 1; }, on: function (w2, name) {
        var s = name + ':' + w2.st.run().trip;
        if (steps[steps.length - 1] !== s) steps.push(s);
    } });
    assert.deepStrictEqual(sendsTo(w, BRIDGE).map(function (s) { return s.grid; }), [11, 12]);
    assert.ok(logged(w, /out of ChangeSkin_BuffAd_Bridge with 1 grid\(s\) left; going home for more/), logLines(w).join('\n'));
    assert.ok(steps.indexOf('Produce:0') >= 0, 'Produce for the same trip: ' + steps.join(' '));
    assert.ok(steps.lastIndexOf('Apply:0') > steps.indexOf('Produce:0'), 'back to Apply of the same trip');
    var made = w.productionOrders.filter(function (o) { return o.unit === BRIDGE; });
    assert.deepStrictEqual(plain(made.map(function (o) { return o.amount; })), [1], 'only the open grid is made');
    assert.strictEqual(w.zoneSends.length, 0);
});

// Storm-like small dynamite: amount 10 over four grids whose needs add up to
// it (41:4, 42:3, 43:2, 44:1), stock 6, so the stock runs out on 42 and the
// trip home brings the rest.
function storm(o) {
    o = o || {};
    var need = { 41: 4, 42: 3, 43: 2, 44: 1 };
    for (var k in (o.need || {})) if (Object.prototype.hasOwnProperty.call(o.need, k)) need[k] = o.need[k];
    var w = scenWorld({ quests: [{ key: 'qd', name: 'Rocks', item: DYN, grids: [41, 42, 43, 44] },
        { key: 'q9', name: 'Final', last: true }], gridNeed: need });
    w.setStock(DYN, typeof o.stock === 'number' ? o.stock : 6);
    onIsland(w, record(w, STORM), 0);
    return w;
}

function dynSends(w) {
    return plain(sendsTo(w, DYN).map(function (s) { return [s.grid, s.amount, s.took]; }));
}

t.test('grid-done rule: a capped grid stays open, the trip home orders for it, and the top-up fills it', function () {
    var w = storm();
    drive(w, { max: 500, until: function (w2) { return w2.st.run().trip === 1; } });
    assert.deepStrictEqual(dynSends(w), [[41, 6, 4], [41, 2, 0], [42, 2, 2], [42, 4, 1], [42, 3, 0], [43, 3, 2],
        [43, 1, 0], [44, 1, 1]], JSON.stringify(dynSends(w)));
    assert.ok(logged(w, /SmallDynamite -> 41: took 4 of 6, 4 of 10 so far; sending the other 6/), logLines(w).join('\n'));
    assert.ok(logged(w, /SmallDynamite -> 42: took all 2 offered \(6 of 10 so far\); grid stays open/), logLines(w).join('\n'));
    assert.ok(logged(w, /out of BattleBuffHurt_BuffAd_SmallDynamite with 3 grid\(s\) left; going home for more/),
        logLines(w).join('\n'));
    assert.ok(logged(w, /SmallDynamite -> 42: took 1 of 4, 7 of 10 so far; sending the other 3/), logLines(w).join('\n'));
    assert.ok(logged(w, /SmallDynamite -> 42: took nothing more; grid done/));
    assert.ok(logged(w, /SmallDynamite -> 44: took 1 of 1; grid done/), logLines(w).join('\n'));
    var made = w.productionOrders.filter(function (o) { return o.unit === DYN; });
    assert.deepStrictEqual(plain(made.map(function (o) { return o.amount; })), [10], 'the trip total, not per grid');
    var q = w.quests.filter(function (x) { return x.key === 'qd'; })[0];
    assert.ok(!q || q.finished, 'the item quest finished');
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('grid-done rule: a capped grid that was already full takes nothing on the top-up and is done, no pause', function () {
    var w = storm({ need: { 42: 2 } });
    drive(w, { max: 500, until: function (w2) { return w2.st.run().trip === 1; } });
    assert.deepStrictEqual(dynSends(w), [[41, 6, 4], [41, 2, 0], [42, 2, 2], [42, 4, 0], [43, 4, 2], [43, 2, 0],
        [44, 2, 1]], JSON.stringify(dynSends(w)));
    assert.ok(logged(w, /SmallDynamite -> 42: took nothing more; grid done/), logLines(w).join('\n'));
    assert.ok(!logged(w, /run paused/), 'no pause');
    // The top-up after the trip home shows no drop; the next grid's send waits for its result.
    var s = sendsTo(w, DYN);
    var gap = s[4].t - s[3].t;
    assert.ok(gap >= 15000, 'the top-up result came in first: ' + gap);
    assert.ok(gap < w.S.modules.adventures.loader.ORDER_WAIT_MS, 'no order-wait stale wait: ' + gap);
});

t.test('grid-done rule: a top-up whose send really fails pauses BuffFailed', function () {
    var w = storm();
    drive(w, { max: 500, until: function (w2, name) {
        return name === 'Apply' && sendsTo(w2, DYN).length === 3 && w2.stockOf(DYN) > 0;
    } });
    assertStep(w, 'Apply');
    // The top-up is planned, then the stock is gone before its precheck runs.
    tick(w);
    w.setStock(DYN, 0);
    play(w);
    passesFor(w, 30000);
    assertPaused(w, w.S.RunPause.BuffFailed, /apply BattleBuffHurt_BuffAd_SmallDynamite to 42 failed/);
    assert.strictEqual(sendsTo(w, DYN).length, 3);
});

t.test('Apply: an item whose grids together took its amount is done, its other grids are not sent', function () {
    var w = storm({ stock: 20, need: { 41: 10 } });
    drive(w, { until: at('Trip') });
    assertStep(w, 'Trip');
    assert.deepStrictEqual(dynSends(w), [[41, 10, 10]], JSON.stringify(dynSends(w)));
    assert.ok(logged(w, /SmallDynamite -> 41: took 10 of 10; grid done/), logLines(w).join('\n'));
    assert.ok(logged(w, /SmallDynamite: trip total 10 taken; 3 grid\(s\) done/), logLines(w).join('\n'));
    assert.strictEqual(w.stockOf(DYN), 10);
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('grid-done rule: a run landing in the stock during a capped send still leaves the grid open', function () {
    var rec = { id: 'land', label: 'Land (test)', trips: [{ items: [{ buff: DYN, grids: [43], amount: 10 }] }, {}] };
    var w = scenWorld({ quests: [{ key: 'qd', name: 'Rocks', item: DYN, grids: [43] },
        { key: 'q9', name: 'Final', last: true }], gridNeed: { 43: 4 } });
    w.setStock(DYN, 2);
    w.queues[1].entries.push({ type: DYN, amount: 1 });
    onIsland(w, record(w, rec), 0);
    var gi = w.H.host.game.gi;
    var real = gi.SendServerAction;
    var once = true;
    gi.SendServerAction = function (id) {
        real.apply(this, arguments);
        if (id === 61 && once) {
            once = false;
            w.produce();
        }
    };
    tick(w);
    play(w);
    assert.deepStrictEqual(dynSends(w), [[43, 2, 2]]);
    assert.strictEqual(w.stockOf(DYN), 1, 'the stock dropped by 1 only');
    assert.ok(logged(w, /SmallDynamite -> 43: took all 2 offered \(2 of 10 so far\); grid stays open/), logLines(w).join('\n'));
    var r = w.st.run();
    var m = r.marks[w.S.modules.adventures.trips.applyMark(r, DYN, 43)];
    assert.ok(!(m && m.seen), 'the grid is open');
    var part = r.marks['part:0:' + DYN + ':43'];
    assert.ok(part && part.seen, 'the part mark is set');
    assert.strictEqual(part.taken, 2, 'the part mark keeps what the grid took');
});

// ---- items asked for by the building at the grid ------------------------------------

// Riches-like sabotage: four items to the building at 2631, whose quest names
// none of them, only a trigger on the building. One WaterSplash send takes at
// most 9 (o.cap), so 10 needs a second send.
var SABOTAGE_GRID = 2631;
var SABOTAGE = {
    id: 'sabotage_test', label: 'Sabotage (test)',
    trips: [{ items: [{ buff: GLUE, grids: [SABOTAGE_GRID] }, { buff: SPLASH, grids: [SABOTAGE_GRID], amount: 10 },
        { buff: BLAST, grids: [SABOTAGE_GRID] }, { buff: EXPERT, grids: [SABOTAGE_GRID] }] }, {}]
};

function sabotage(o) {
    o = o || {};
    var need = {};
    need[GLUE + ':' + SABOTAGE_GRID] = 1;
    need[SPLASH + ':' + SABOTAGE_GRID] = typeof o.splash === 'number' ? o.splash : 10;
    need[BLAST + ':' + SABOTAGE_GRID] = 1;
    need[EXPERT + ':' + SABOTAGE_GRID] = 1;
    var buildings = {};
    if (o.noBuilding !== true) buildings[SABOTAGE_GRID] = 'buffad_sabotage';
    var cap = {};
    cap[SPLASH] = typeof o.cap === 'number' ? o.cap : 9;
    var w = scenWorld({
        quests: [{ key: 'q6', name: 'BuffAd4_Sabotage_Sub6', building: 'buffad_sabotage',
            items: [GLUE, SPLASH, BLAST, EXPERT], grids: [SABOTAGE_GRID] }, { key: 'q9', name: 'Final', last: true }],
        gridNeed: need, world: { gridBuildings: buildings, sendCap: cap }
    });
    [GLUE, BLAST, EXPERT].forEach(function (b) { w.setStock(b, 2); });
    w.setStock(SPLASH, 20);
    onIsland(w, record(w, SABOTAGE), 0);
    return w;
}

function itemSends(w) {
    return plain(w.itemSends.map(function (s) { return [s.buff, s.amount, s.took]; }));
}

function sabotageQuest(w) {
    return w.quests.filter(function (q) { return q.key === 'q6'; })[0];
}

t.test('Apply: a quest whose trigger names the building at the grid takes the items in file order, the short WaterSplash send gets its remainder', function () {
    var w = sabotage();
    drive(w, { until: at('Trip') });
    assertStep(w, 'Trip');
    assert.deepStrictEqual(itemSends(w), [[GLUE, 1, 1], [SPLASH, 10, 9], [SPLASH, 1, 1], [BLAST, 1, 1], [EXPERT, 1, 1]],
        JSON.stringify(itemSends(w)));
    assert.ok(logged(w, /WaterSplash -> 2631: took 9 of 10, 9 of 10 so far; sending the other 1/), logLines(w).join('\n'));
    assert.ok(logged(w, /Apply -> Trip \(items applied\)/), logLines(w).join('\n'));
    assert.ok(!logged(w, /waiting for a quest that wants/), 'no item wait');
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('Apply: a building-trigger remainder that takes nothing ends the grid without a pause', function () {
    var w = sabotage({ splash: 9 });
    drive(w, { until: at('Trip') });
    assertStep(w, 'Trip');
    assert.deepStrictEqual(itemSends(w), [[GLUE, 1, 1], [SPLASH, 10, 9], [SPLASH, 1, 0], [BLAST, 1, 1], [EXPERT, 1, 1]],
        JSON.stringify(itemSends(w)));
    assert.ok(logged(w, /WaterSplash -> 2631: took nothing more; grid done/), logLines(w).join('\n'));
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('Apply: the building gone after Explosive still lets Specialist go to its trigger', function () {
    var w = sabotage();
    drive(w, { until: at('Trip'), on: function (w2) {
        if (sendsTo(w2, BLAST).length) delete w2.gridBuildings[SABOTAGE_GRID];
    } });
    assertStep(w, 'Trip');
    assert.strictEqual(w.S.core.buildings.byGrid(SABOTAGE_GRID), null, 'the building is gone');
    assert.deepStrictEqual(plain(sendsTo(w, EXPERT).map(function (s) { return s.took; })), [1]);
    assert.ok(!logged(w, /waiting for a quest that wants/), 'no item wait');
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('Apply: the building trigger closed before the last item skips it', function () {
    var w = sabotage();
    drive(w, { until: at('Trip'), on: function (w2) {
        if (sendsTo(w2, BLAST).length) sabotageQuest(w2).met = true;
    } });
    assertStep(w, 'Trip');
    assert.strictEqual(sendsTo(w, EXPERT).length, 0, 'nothing sent to a closed trigger');
    assert.ok(logged(w, /quest no longer wants BattleBuffHurt_BuffAd_Specialist; 1 grid\(s\) skipped/),
        logLines(w).join('\n'));
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('Apply: no building name at the grid waits for a quest that wants the item, as before', function () {
    var w = sabotage({ noBuilding: true });
    passesFor(w, 120000);
    assertStep(w, 'Apply');
    assert.strictEqual(w.itemSends.length, 0, 'nothing sent');
    assert.ok(logged(w, /waiting for a quest that wants BattleBuffHurt_BuffAd_Glue/), logLines(w).join('\n'));
});

t.test('Apply: a client restart between the short take and the remainder offers only the remainder', function () {
    var w = sabotage();
    var pn = 'part:0:' + SPLASH + ':' + SABOTAGE_GRID;
    drive(w, { until: function (w2) {
        var m = w2.st.run().marks[pn];
        return !!(m && m.taken === 9);
    } });
    assert.deepStrictEqual(itemSends(w), [[GLUE, 1, 1], [SPLASH, 10, 9]], JSON.stringify(itemSends(w)));
    var w2 = restart(w);
    w2.gridBuildings = w.gridBuildings;
    w2.sendCap = w.sendCap;
    var part = w2.st.run().marks[pn];
    assert.ok(part && part.seen, 'the part mark came back');
    assert.strictEqual(part.taken, 9, 'what the grid took came back from the file');
    drive(w2, { until: at('Trip') });
    assertStep(w2, 'Trip');
    var splash = sendsTo(w2, SPLASH);
    assert.deepStrictEqual(plain(splash.map(function (s) { return [s.amount, s.took]; })), [[10, 9], [1, 1]],
        JSON.stringify(itemSends(w2)));
    assert.strictEqual(sendsTo(w2, EXPERT).length, 1);
});

// ---- items asked for by the object they clear -------------------------------------

// Storm Recovery-like: three dynamites whose quest names the boulders they
// clear (onmap end conditions), never the dynamite. Small goes to both kinds
// of boulder's grids by file order; Medium mixes the two kinds.
var STORM_BOULDERS = {
    id: 'storm_boulders_test', label: 'Storm boulders (test)',
    trips: [{ items: [
        { buff: DYN, grids: [5680, 4394, 2152, 2070] },
        { buff: MEDIUM, grids: [5680, 2152, 2014, 5814] },
        { buff: BIG, grids: [2275, 2014, 5814] }
    ] }, {}]
};
var BOULDERS_01 = [2070, 2152, 4394, 5680];
var BOULDERS_02 = [2014, 2275, 5814];

// o.rec replaces the record, o.need ({ buff: { grid: n } }) the needs of 1 per
// grid, o.stock ({ buff: n }) the stock of 10 per item.
function stormBoulders(o) {
    o = o || {};
    var rec = o.rec || STORM_BOULDERS;
    var need = {};
    var buildings = {};
    rec.trips[0].items.forEach(function (it) {
        var given = (o.need || {})[it.buff] || {};
        it.grids.forEach(function (g) { need[it.buff + ':' + g] = typeof given[g] === 'number' ? given[g] : 1; });
    });
    BOULDERS_01.forEach(function (g) { buildings[g] = 'buffad_boulder_01'; });
    BOULDERS_02.forEach(function (g) { buildings[g] = 'buffad_boulder_02'; });
    var w = scenWorld({
        quests: [{ key: 'q2', name: 'Buff_Adv_StormRecovery_SubQuest02',
            onmap: ['buffad_boulder_01', 'buffad_boulder_02'], unread: o.unread },
        { key: 'q9', name: 'Final', last: true }],
        gridNeed: need, world: { gridBuildings: buildings }
    });
    [DYN, MEDIUM, BIG].forEach(function (b) {
        w.setStock(b, o.stock && typeof o.stock[b] === 'number' ? o.stock[b] : 10);
    });
    onIsland(w, record(w, rec), 0);
    return w;
}

function sentTo(w, buff) {
    return plain(sendsTo(w, buff).map(function (s) { return s.grid; }));
}

t.test('Apply: a quest whose onmap conditions name the boulders at the grids takes the dynamite', function () {
    var w = stormBoulders();
    drive(w, { until: at('Trip') });
    assertStep(w, 'Trip');
    assert.deepStrictEqual(sentTo(w, DYN), [5680, 4394, 2152, 2070]);
    assert.deepStrictEqual(sentTo(w, MEDIUM), [5680, 2152, 2014, 5814]);
    assert.deepStrictEqual(sentTo(w, BIG), [2275, 2014, 5814]);
    assert.ok(!logged(w, /waiting for a quest that wants/), logLines(w).join('\n'));
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('Apply: a boulder gone after its first blast still takes the next dynamite', function () {
    var w = stormBoulders();
    drive(w, { until: at('Trip'), on: function (w2) {
        if (sendsTo(w2, DYN).length && sendsTo(w2, DYN)[0].grid === 5680) delete w2.gridBuildings[5680];
    } });
    assertStep(w, 'Trip');
    assert.strictEqual(w.S.core.buildings.byGrid(5680), null, 'the boulder is gone');
    assert.deepStrictEqual(sentTo(w, MEDIUM), [5680, 2152, 2014, 5814]);
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('Apply: one boulder kind cleared skips only that kind\'s grids', function () {
    var w = stormBoulders();
    drive(w, { until: at('Trip'), on: function (w2) {
        if (sendsTo(w2, DYN).length === 4) BOULDERS_01.forEach(function (g) { delete w2.gridBuildings[g]; });
    } });
    assertStep(w, 'Trip');
    assert.deepStrictEqual(sentTo(w, MEDIUM), [2014, 5814]);
    assert.deepStrictEqual(sentTo(w, BIG), [2275, 2014, 5814]);
    assert.ok(logged(w, /quest no longer wants BattleBuffHurt_BuffAd_MediumDynamite; 2 grid\(s\) skipped/), logLines(w).join('\n'));
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('Apply: an unread onmap quest holds the dynamite', function () {
    var w = stormBoulders({ unread: true });
    w.auto.readFails = true;
    passesFor(w, 120000);
    assertStep(w, 'Apply');
    assert.strictEqual(w.itemSends.length, 0, 'nothing sent');
    assert.ok(logged(w, /waiting for quest Buff_Adv_StormRecovery_SubQuest02 to be running, mode 2/), logLines(w).join('\n'));
});

// ---- out of stock, other items first ----------------------------------------------

// Storm Recovery trip 2 as the 15:16 log has it: the three dynamites with
// their wiki totals as the trip amounts, over the boulders they clear.
var STORM_TOTALS = {
    id: 'storm_totals_test', label: 'Storm totals (test)',
    trips: [{ items: [
        { buff: DYN, grids: [5680, 4394, 2152, 2070], amount: 10 },
        { buff: MEDIUM, grids: [5680, 2152, 2014, 5814], amount: 6 },
        { buff: BIG, grids: [2275, 2014, 5814], amount: 5 }
    ] }, {}]
};

function sendList(w, buff) {
    return plain(sendsTo(w, buff).map(function (s) { return [s.grid, s.amount, s.took]; }));
}

// The steps a drive passes, as 'Step:trip', each change once.
function stepRecorder(steps) {
    return function (w2, name) {
        var s = name + ':' + w2.st.run().trip;
        if (steps[steps.length - 1] !== s) steps.push(s);
    };
}

function totalsWorld(smallNeed, smallStock) {
    var need = {};
    need[DYN] = smallNeed;
    need[MEDIUM] = { 5680: 2, 2152: 1, 2014: 2, 5814: 1 };
    need[BIG] = { 2275: 2, 2014: 2, 5814: 1 };
    var stock = {};
    stock[DYN] = smallStock;
    stock[MEDIUM] = 6;
    stock[BIG] = 5;
    return stormBoulders({ rec: STORM_TOTALS, need: need, stock: stock });
}

// No later item went to a grid before every earlier item on it was sent
// there for the last time.
function assertFileOrder(w, order) {
    for (var a = 0; a < order.length; a++) {
        var early = sendsTo(w, order[a]);
        for (var b = a + 1; b < order.length; b++) {
            sendsTo(w, order[b]).forEach(function (late) {
                early.forEach(function (e) {
                    if (e.grid === late.grid) {
                        assert.ok(e.t < late.t, order[b] + ' -> ' + late.grid + ' before ' + order[a]);
                    }
                });
            });
        }
    }
}

t.test('Apply: Storm Recovery 15:16 totals finish the trip without a home trip', function () {
    var w = totalsWorld({ 5680: 2, 4394: 5, 2152: 2, 2070: 1 }, 10);
    var steps = [];
    drive(w, { max: 400, until: at('Trip'), on: stepRecorder(steps) });
    assertStep(w, 'Trip');
    assert.deepStrictEqual(sendList(w, DYN), [[5680, 10, 2], [5680, 8, 0], [4394, 8, 5], [4394, 3, 0], [2152, 3, 2],
        [2152, 1, 0], [2070, 1, 1]], JSON.stringify(sendList(w, DYN)));
    assert.deepStrictEqual(sendList(w, MEDIUM), [[5680, 6, 2], [5680, 4, 0], [2152, 4, 1], [2152, 3, 0], [2014, 3, 2],
        [2014, 1, 0], [5814, 1, 1]], JSON.stringify(sendList(w, MEDIUM)));
    assert.deepStrictEqual(sendList(w, BIG), [[2275, 5, 2], [2275, 3, 0], [2014, 3, 2], [2014, 1, 0], [5814, 1, 1]],
        JSON.stringify(sendList(w, BIG)));
    assert.ok(logged(w, /SmallDynamite -> 2070: took 1 of 1; grid done/), logLines(w).join('\n'));
    assert.ok(!logged(w, /going home/), logLines(w).join('\n'));
    assert.ok(steps.indexOf('JumpHome:0') < 0, 'no home trip: ' + steps.join(' '));
    assertFileOrder(w, [DYN, MEDIUM, BIG]);
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('Apply: out of the first dynamite, the others go before the home trip', function () {
    var w = totalsWorld({ 5680: 2, 4394: 5, 2152: 1, 2070: 2 }, 9);
    var steps = [];
    var home = null;
    drive(w, { max: 600, until: function (w2) { return w2.st.run().trip === 1; }, on: function (w2, name) {
        stepRecorder(steps)(w2, name);
        if (home === null && name === 'JumpHome') home = w2.itemSends.length;
    } });
    assert.ok(home !== null, 'went home: ' + steps.join(' '));
    var before = w.itemSends.slice(0, home);
    var after = w.itemSends.slice(home);
    [MEDIUM, BIG].forEach(function (b) {
        assert.ok(before.some(function (s) { return s.buff === b; }), b + ' sent before the home trip');
        assert.ok(!after.some(function (s) { return s.buff === b; }), b + ' all sent before the home trip');
    });
    assert.ok(after.length > 0 && after.every(function (s) { return s.buff === DYN && s.grid === 2070; }),
        'after the return only Small to 2070: ' + JSON.stringify(plain(after)));
    var lines = logLines(w);
    assert.strictEqual(lines.filter(function (l) {
        return /out of BattleBuffHurt_BuffAd_SmallDynamite with 1 grid\(s\) left; going home for more/.test(l);
    }).length, 1, lines.join('\n'));
    assert.strictEqual(lines.filter(function (l) {
        return /out of BattleBuffHurt_BuffAd_SmallDynamite; continuing with the other items first/.test(l);
    }).length, 1, lines.join('\n'));
    assert.ok(steps.lastIndexOf('Apply:0') > steps.indexOf('JumpHome:0'), 'back to the same trip: ' + steps.join(' '));
    assert.strictEqual(sendsTo(w, DYN).reduce(function (n, s) { return n + s.took; }, 0), 10, 'Small trip total');
    assertFileOrder(w, [DYN, MEDIUM, BIG]);
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('Apply: an out-of-stock item holds its grid for later items on it (Riches 2631)', function () {
    var w = sabotage();
    w.setStock(GLUE, 0);
    var steps = [];
    var home = null;
    drive(w, { max: 600, until: function (w2, name) { return name === 'Trip' && home !== null; }, on: function (w2, name) {
        stepRecorder(steps)(w2, name);
        if (home === null && name === 'JumpHome') home = w2.itemSends.length;
    } });
    assert.strictEqual(home, 0, 'nothing sent before the home trip: ' + steps.join(' '));
    assertStep(w, 'Trip');
    assert.strictEqual(w.st.run().trip, 0, 'the same trip');
    assert.deepStrictEqual(itemSends(w), [[GLUE, 1, 1], [SPLASH, 10, 9], [SPLASH, 1, 1], [BLAST, 1, 1], [EXPERT, 1, 1]],
        JSON.stringify(itemSends(w)));
    assert.ok(logged(w, /out of BattleBuffHurt_BuffAd_Glue with 1 grid\(s\) left; going home for more/), logLines(w).join('\n'));
    assert.ok(!logged(w, /continuing with the other items first/), 'nothing else could go');
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('Apply: an out-of-stock wanted item goes home, never waits on held items', function () {
    var rec = { id: 'held', label: 'Held (test)', trips: [{ items: [{ buff: SHEET, grids: [21] },
        { buff: BRIDGE, grids: [11] }] }, {}] };
    var w = scenWorld({ quests: [{ key: 'qs', name: 'Papers', item: SHEET, grids: [21], unread: true },
        { key: 'qb', name: 'Bridges', item: BRIDGE, grids: [11] }, { key: 'q9', name: 'Final', last: true }] });
    w.auto.readFails = true;
    w.setStock(SHEET, 5);
    w.setStock(BRIDGE, 0);
    onIsland(w, record(w, rec), 0);
    drive(w, { max: 50, until: function (w2, name) { return name !== 'Apply'; } });
    assert.ok(transitions(w).some(function (x) { return x.from === 'Apply' && x.to === 'JumpHome'; }),
        JSON.stringify(transitions(w)));
    assert.ok(logged(w, /out of ChangeSkin_BuffAd_Bridge with 1 grid\(s\) left; going home for more/), logLines(w).join('\n'));
    assert.ok(!logged(w, /waiting for a quest that wants/), logLines(w).join('\n'));
    assert.strictEqual(w.itemSends.length, 0, 'nothing sent');
});

// ---- a grid whose building is gone --------------------------------------------------

var GONE = {
    id: 'gone_test', label: 'Gone (test)',
    trips: [{ items: [{ buff: DYN, grids: [5680], amount: 4 }] }, {}]
};

// One boulder at 5680 that needs 4 Small, stock 2. o.noBuilding: no name at
// the grid, the item asked for by a quest that names it.
function goneWorld(o) {
    o = o || {};
    var need = {};
    need[DYN + ':5680'] = 4;
    var buildings = {};
    if (!o.noBuilding) buildings[5680] = 'buffad_boulder_01';
    var quests = o.noBuilding ? [{ key: 'qd', name: 'Rocks', item: DYN, grids: [5680] }]
        : [{ key: 'q2', name: 'Buff_Adv_StormRecovery_SubQuest02', onmap: ['buffad_boulder_01'], stayOpen: true }];
    quests.push({ key: 'q9', name: 'Final', last: true });
    var w = scenWorld({ quests: quests, gridNeed: need, world: { gridBuildings: buildings } });
    w.setStock(DYN, 2);
    onIsland(w, record(w, GONE), 0);
    return w;
}

t.test('Apply: a stock-capped grid whose boulder is gone is done', function () {
    var w = goneWorld();
    drive(w, { max: 100, until: at('Trip'), on: function (w2) {
        if (sendsTo(w2, DYN).length) delete w2.gridBuildings[5680];
    } });
    assertStep(w, 'Trip');
    assert.deepStrictEqual(dynSends(w), [[5680, 2, 2]], JSON.stringify(dynSends(w)));
    assert.ok(logged(w, /SmallDynamite -> 5680: took all 2 offered \(2 of 4 so far\); grid stays open/), logLines(w).join('\n'));
    assert.ok(logged(w, /SmallDynamite -> 5680: building gone after 2; grid done/), logLines(w).join('\n'));
    assert.ok(!transitions(w).some(function (x) { return x.to === 'JumpHome'; }), JSON.stringify(transitions(w)));
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('Apply: a boulder gone during the capped send ends the grid at its check', function () {
    var w = goneWorld();
    var gi = w.H.host.game.gi;
    var real = gi.SendServerAction;
    gi.SendServerAction = function (id) {
        real.apply(this, arguments);
        if (id === 61) delete w.gridBuildings[5680];
    };
    drive(w, { max: 100, until: at('Trip') });
    assertStep(w, 'Trip');
    assert.deepStrictEqual(dynSends(w), [[5680, 2, 2]], JSON.stringify(dynSends(w)));
    assert.ok(logged(w, /SmallDynamite -> 5680: took all 2 offered; building gone, grid done/), logLines(w).join('\n'));
    assert.ok(!transitions(w).some(function (x) { return x.to === 'JumpHome'; }), JSON.stringify(transitions(w)));
});

t.test('Apply: a stock-capped grid with no building name stays open and the run goes home', function () {
    var w = goneWorld({ noBuilding: true });
    drive(w, { max: 100, until: function (w2, name) { return name !== 'Apply'; } });
    assert.deepStrictEqual(dynSends(w), [[5680, 2, 2]], JSON.stringify(dynSends(w)));
    assert.ok(logged(w, /SmallDynamite -> 5680: took all 2 offered \(2 of 4 so far\); grid stays open/), logLines(w).join('\n'));
    assert.ok(!logged(w, /building gone/), logLines(w).join('\n'));
    assert.ok(transitions(w).some(function (x) { return x.from === 'Apply' && x.to === 'JumpHome'; }),
        JSON.stringify(transitions(w)));
});

// ---- items bound to the quest they are for ----------------------------------------

// Storm Recovery trip index 2 as scenarios/storm_recovery.json has it. Every
// grid is a ruin; SubQuest04 asks for the ruins to be gone (onmap), so the
// grid's building alone also matches the kits that SubQuest05 asks for later.
var SQ4 = 'Buff_Adv_StormRecovery_SubQuest04';
var SQ5 = 'Buff_Adv_StormRecovery_SubQuest05';
var STORM3 = {
    id: 'storm3_test', label: 'Storm trip 3 (test)',
    trips: [{}, {}, { items: [
        { buff: POISON, grids: [5884, 3988, 3387, 2150, 1880, 1935], amount: 20 },
        { buff: SHOVEL, grids: [1880, 2424, 3387, 3988, 5884, 2342, 1935], amount: 16 },
        { buff: STINKY, grids: [5884, 5614, 3321, 2150, 1935], amount: 11, quest: SQ4 },
        { buff: DECOMP, grids: [2342, 1880, 2424, 3988], amount: 11, quest: SQ4 },
        { buff: SCHOOL, grids: [5614], quest: SQ5 },
        { buff: NOBLE, grids: [5884, 3988], quest: SQ5 },
        { buff: TAVERN, grids: [3387, 2342], quest: SQ5 },
        { buff: RESID, grids: [3321, 2424, 2150, 1880], quest: SQ5 }
    ] }, {}]
};
var RUIN_AT = { 2150: 'BuffAd_Ruin_01', 2424: 'BuffAd_Ruin_01', 3321: 'BuffAd_Ruin_01', 3387: 'BuffAd_Ruin_01',
    2342: 'BuffAd_Ruin_02', 3988: 'BuffAd_Ruin_02', 5884: 'BuffAd_Ruin_02',
    1880: 'BuffAd_Ruin_03', 1935: 'BuffAd_Ruin_03', 5614: 'BuffAd_Ruin_04' };
var SITE = 'BuffAd_Site';
var DESTROY = [POISON, SHOVEL, STINKY, DECOMP];
var KITS = [SCHOOL, NOBLE, TAVERN, RESID];
// What each ruin takes of each destroy item; per item it sums to the trip total.
var STORM3_NEED = {};
STORM3_NEED[POISON] = { 5884: 4, 3988: 4, 3387: 3, 2150: 3, 1880: 3, 1935: 3 };
STORM3_NEED[SHOVEL] = { 1880: 3, 2424: 2, 3387: 2, 3988: 3, 5884: 2, 2342: 2, 1935: 2 };
STORM3_NEED[STINKY] = { 5884: 3, 5614: 2, 3321: 2, 2150: 2, 1935: 2 };
STORM3_NEED[DECOMP] = { 2342: 3, 1880: 3, 2424: 2, 3988: 3 };
var STORM3_STOCK = {};
STORM3_STOCK[POISON] = 20;
STORM3_STOCK[SHOVEL] = 16;
STORM3_STOCK[STINKY] = 11;
STORM3_STOCK[DECOMP] = 11;
STORM3_STOCK[SCHOOL] = 1;
STORM3_STOCK[NOBLE] = 2;
STORM3_STOCK[TAVERN] = 2;
STORM3_STOCK[RESID] = 4;

// SubQuest05, the kits quest: the four kits with their counts and 8 unnamed
// triggers; o is merged in (mode, running, unread).
function kitQuest(o) {
    var applied = {};
    applied[TAVERN] = 2;
    applied[RESID] = 4;
    applied[NOBLE] = 2;
    applied[SCHOOL] = 1;
    var q = { key: 'q5', name: SQ5, applied: applied, extra: 8 };
    for (var k in (o || {})) if (Object.prototype.hasOwnProperty.call(o, k)) q[k] = o[k];
    return q;
}

function tookOf(w, buff) {
    return sendsTo(w, buff).reduce(function (n, s) { return n + s.took; }, 0);
}

function destroyDone(w) {
    return DESTROY.every(function (b) { return tookOf(w, b) >= STORM3_STOCK[b]; });
}

// The run at Apply of trip index 2 with SubQuest04 running and every ruin
// standing. w.s3 records what the map hook saw.
function storm3() {
    var need = {};
    DESTROY.forEach(function (b) {
        Object.keys(STORM3_NEED[b]).forEach(function (g) { need[b + ':' + g] = STORM3_NEED[b][g]; });
    });
    var w = scenWorld({
        quests: [{ key: 'q4', name: SQ4, onmap: ['BuffAd_Ruin_01', 'BuffAd_Ruin_02', 'BuffAd_Ruin_03', 'BuffAd_Ruin_04'] },
            { key: 'q9', name: 'Final', last: true }],
        gridNeed: need, world: { gridBuildings: plain(RUIN_AT) }
    });
    Object.keys(STORM3_STOCK).forEach(function (b) { w.setStock(b, STORM3_STOCK[b]); });
    onIsland(w, record(w, STORM3), 2);
    w.s3 = { busy: [], holdAt: null, afterHold: null, ruin02Stood: false };
    return w;
}

// The map's side of the trip: a ruin turns into a building site once every
// destroy item owed there took its share, and SubQuest04 finishes once no ruin
// is left. The 3988 ruin stands one pass longer than it is due, so one Apply
// pass sees the Decomposer done while Ruin_02 still stands (17:00:53).
function stormMap(w2) {
    var s = w2.s3;
    var b = w2.st.current().busy;
    if (b && b.text) s.busy.push(b.text);
    if (s.holdAt !== null && s.afterHold === null) {
        s.afterHold = plain(w2.itemSends.slice(s.holdAt));
        s.ruin02Stood = w2.gridBuildings[3988] === 'BuffAd_Ruin_02';
    }
    Object.keys(RUIN_AT).forEach(function (g) {
        if (w2.gridBuildings[g] !== RUIN_AT[g]) return;
        var owed = DESTROY.some(function (it) {
            var k = it + ':' + g;
            return typeof w2.gridNeed[k] === 'number' && w2.gridNeed[k] > 0;
        });
        if (owed) return;
        if (g === '3988' && s.holdAt === null) {
            s.holdAt = w2.itemSends.length;
            return;
        }
        if (g === '3988' && s.afterHold === null) return;
        w2.gridBuildings[g] = SITE;
    });
    var left = Object.keys(RUIN_AT).some(function (g) { return w2.gridBuildings[g] === RUIN_AT[g]; });
    (w2.quests || []).forEach(function (q) { if (q.key === 'q4' && !left) q.finished = true; });
}

function claimedQ4(w) {
    return w.claims.some(function (c) { return c.key === 'q4'; }) &&
        !(w.quests || []).some(function (q) { return q.key === 'q4'; });
}

// storm3 driven until the destroy items are done and SubQuest04 is claimed.
function stormDestroyed() {
    var w = storm3();
    drive(w, { max: 600, on: stormMap, until: function (w2) { return destroyDone(w2) && claimedQ4(w2); } });
    assert.ok(destroyDone(w), 'destroy items done: ' + JSON.stringify(DESTROY.map(function (b) { return tookOf(w, b); })));
    assert.ok(claimedQ4(w), 'SubQuest04 claimed');
    assertStep(w, 'Apply');
    return w;
}

function kitSends(w) {
    return w.itemSends.filter(function (s) { return KITS.indexOf(s.buff) >= 0; });
}

function assertNoKitMark(w) {
    var r = w.st.run();
    STORM3.trips[2].items.forEach(function (it) {
        if (KITS.indexOf(it.buff) < 0) return;
        it.grids.forEach(function (g) {
            var m = (r.marks || {})[w.S.modules.adventures.trips.applyMark(r, it.buff, g)];
            assert.ok(!(m && m.seen), it.buff + ' -> ' + g + ' is not marked');
        });
    });
}

t.test('Apply: Storm trip 3 sends the destroy items during SubQuest04 and holds the kits', function () {
    var w = stormDestroyed();
    drive(w, { max: 30, on: stormMap });
    var s = w.s3;
    assert.strictEqual(kitSends(w).length, 0, 'no kit sent: ' + JSON.stringify(plain(kitSends(w))));
    DESTROY.forEach(function (b) { assert.strictEqual(tookOf(w, b), STORM3_STOCK[b], b + ' trip total'); });
    assert.ok(!logged(w, /quest no longer wants ChangeSkin_/), logLines(w).join('\n'));
    assertNoKitMark(w);
    var re = /waiting for quest Buff_Adv_StormRecovery_SubQuest05 for ChangeSkin_/;
    assert.ok(s.busy.some(function (x) { return re.test(x); }) || logged(w, re), s.busy.join('\n'));
    // 17:00:53: the Decomposer at 3988 is the last destroy send, and Ruin_02
    // still stands there for one pass after it.
    var last = sendsTo(w, DECOMP).filter(function (x) { return x.took > 0; }).pop();
    assert.strictEqual(last.grid, 3988, 'the 3988 Decomposer goes last');
    assert.ok(s.afterHold !== null, 'a pass ran with the 3988 ruin due');
    assert.ok(s.ruin02Stood, 'Ruin_02 still stood at 3988 for that pass');
    assert.ok(!s.afterHold.some(function (x) { return x.buff === NOBLE; }), 'no Noble kit while Ruin_02 stands');
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('Apply: the kits go once SubQuest05 runs, one per grid, after the settle', function () {
    var w = stormDestroyed();
    w.quests.push(kitQuest({ unread: true }));
    var readAt = passUntilStamped(w, function () {
        return w.reads.some(function (x) { return x.key === 'q5'; }) &&
            !w.quests.some(function (q) { return q.key === 'q5' && q.unread; });
    }, 120000);
    drive(w, { max: 200, on: stormMap, until: at('Trip') });
    assertStep(w, 'Trip');
    var kits = kitSends(w);
    assert.ok(kits.length > 0, 'kits sent');
    kits.forEach(function (x) {
        assert.ok(x.t >= readAt + settleMs(w), x.buff + ' -> ' + x.grid + ' at ' + x.t + ', inside the settle of ' + readAt);
    });
    STORM3.trips[2].items.forEach(function (it) {
        if (KITS.indexOf(it.buff) < 0) return;
        assert.deepStrictEqual(sentTo(w, it.buff), it.grids, it.buff + ' once per grid');
    });
    assert.deepStrictEqual(sentTo(w, NOBLE), [5884, 3988]);
    assert.ok(!logged(w, /quest no longer wants ChangeSkin_/), logLines(w).join('\n'));
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('Apply: a bound kit waits while SubQuest05 is in the pool but not running', function () {
    [{ mode: 12 }, { running: false }].forEach(function (o) {
        var w = stormDestroyed();
        w.quests.push(kitQuest(o));
        passesFor(w, 120000);
        assertStep(w, 'Apply');
        assert.strictEqual(kitSends(w).length, 0, JSON.stringify(o) + ': no kit sent');
        assertNoKitMark(w);
        var mode = typeof o.mode === 'number' ? o.mode : 3;
        var re = new RegExp('ChangeSkin_BuffAd_\\w+: waiting for quest ' + SQ5 + ' to be running, mode ' + mode);
        assert.ok(logged(w, re), JSON.stringify(o) + '\n' + logLines(w).join('\n'));
    });
});

// ---- production -----------------------------------------------------------------

function made(w) {
    var out = {};
    w.productionOrders.forEach(function (o) { out[o.unit] = (out[o.unit] || 0) + o.amount; });
    return out;
}

t.test('Produce: a failed order is tried again after the retry time and never pauses', function () {
    var w = scenWorld();
    W.startScenario(w, record(w, TWINS), { step: w.S.RunStep.Produce, trip: 1 });
    // The provision house is gone for a moment: the queue reads, the order
    // is refused.
    w.queues[1].grid = null;
    tick(w);
    play(w);
    passesFor(w, 2 * PASS_MS);
    assertStep(w, 'Produce');
    assert.ok(/item order failed \(production building missing\), trying again/.test(w.st.current().busy.text),
        w.st.current().busy.text);
    assert.strictEqual(w.productionOrders.length, 0);
    w.queues[1].grid = 333;
    passesFor(w, w.S.modules.adventures.trips.PRODUCE_RETRY_MS + PASS_MS);
    assertStep(w, 'Produce');
    assert.deepStrictEqual(made(w), { 'ChangeSkin_BuffAd_Bridge': 3, 'ChangeSkin_BuffAd_Broadsheet': 3,
        'ChangeSkin_BuffAd_Rescueparty': 1 });
});

t.test('Produce: trip items the resources cannot pay pause ItemShort', function () {
    var w = scenWorld({ world: { resources: { Wood: 3 } } });
    W.startScenario(w, record(w, TWINS), { step: w.S.RunStep.Produce, trip: 1 });
    tick(w);
    play(w);
    assertPaused(w, w.S.RunPause.ItemShort, /^cannot produce: Wood 12\/3/);
    assert.strictEqual(w.productionOrders.length, 0);
});

t.test('Produce: next-trip items that cannot be paid wait; this trip is ordered', function () {
    var w = scenWorld({ world: { resources: { Wood: 12 } } });
    W.startScenario(w, record(w, TWINS), { step: w.S.RunStep.Produce, trip: 1 });
    tick(w);
    play(w);
    assertStep(w, 'Produce');
    assert.deepStrictEqual(made(w), { 'ChangeSkin_BuffAd_Bridge': 3, 'ChangeSkin_BuffAd_Broadsheet': 3 });
    assert.ok(logged(w, /next trip items wait for resources: Wood 14\/12/), logLines(w).join('\n'));
});

t.test('Produce: waits for the items of this trip only, then starts the map', function () {
    var w = scenWorld();
    W.startScenario(w, record(w, TWINS), { step: w.S.RunStep.Produce, trip: 1 });
    passesFor(w, 60000);
    assertStep(w, 'Produce');
    assert.ok(/waiting for production: ChangeSkin_BuffAd_Bridge 0\/3, ChangeSkin_BuffAd_Broadsheet 0\/3/
        .test(w.st.current().busy.text), w.st.current().busy.text);
    // Only this trip's items land; the next trip's stay queued.
    var rest = w.queues[1].entries.filter(function (e) { return e.type === RESCUE; });
    w.queues[1].entries = w.queues[1].entries.filter(function (e) { return e.type !== RESCUE; });
    w.produce();
    w.queues[1].entries = rest;
    passesFor(w, PASS_MS);
    assert.ok(['StartMap', 'Jump', 'Apply'].indexOf(stepName(w)) >= 0, 'left Produce: ' + stepName(w));
    assert.strictEqual(w.productionOrders.length, 3, 'nothing ordered twice');
});

// ---- reload safety ------------------------------------------------------------------

t.test('reload mid-Produce: the restarted run orders nothing twice', function () {
    var w = scenWorld();
    W.startScenario(w, record(w, TWINS), { step: w.S.RunStep.Produce, trip: 1 });
    tick(w);
    play(w, function () { return w.productionOrders.length === 1; });
    assert.strictEqual(w.productionOrders.length, 1);
    w = restart(w);
    passesFor(w, 60000);
    assert.deepStrictEqual(made(w), { 'ChangeSkin_BuffAd_Bridge': 3, 'ChangeSkin_BuffAd_Broadsheet': 3,
        'ChangeSkin_BuffAd_Rescueparty': 1 });
});

t.test('reload mid-Apply: the restarted run sends nothing twice and waits, then asks the user', function () {
    var w = scenWorld({ quests: [{ key: 'qb', name: 'Bridges', item: BRIDGE, grids: [11, 12] },
        { key: 'q9', name: 'Final', last: true }] });
    w.setStock(BRIDGE, 5);
    onIsland(w, record(w, ONE), 0);
    tick(w);
    play(w, function () { return w.itemSends.length === 1; });
    assert.strictEqual(w.itemSends.length, 1);
    w = restart(w);
    passesFor(w, w.S.modules.adventures.loader.ORDER_WAIT_MS - PASS_MS);
    assertStep(w, 'Apply');
    assert.strictEqual(w.itemSends.length, 1, 'no second send while the first is unseen');
    passesFor(w, 3 * PASS_MS);
    assertPaused(w, w.S.RunPause.NotObserved, /item ChangeSkin_BuffAd_Bridge sent to 11 but not seen/);
    assert.strictEqual(w.itemSends.length, 1);
});

t.test('reload mid-Apply: a script reload keeps the round and sends nothing twice', function () {
    var w = scenWorld({ quests: [{ key: 'qb', name: 'Bridges', item: BRIDGE, grids: [11, 12] },
        { key: 'q9', name: 'Final', last: true }] });
    w.setStock(BRIDGE, 5);
    onIsland(w, record(w, ONE), 0);
    tick(w);
    play(w, function () { return w.itemSends.length === 1; });
    reload(w);
    passesFor(w, w.S.modules.adventures.loader.ORDER_WAIT_MS + 3 * PASS_MS);
    assert.strictEqual(sendsTo(w, BRIDGE).filter(function (s) { return s.grid === 11; }).length, 1, 'grid 11 once');
});

// ---- series and pause --------------------------------------------------------------

t.test('series of 2 maps: map 2 waits the gap and starts again at trip 1', function () {
    var w = scenWorld();
    var rec = { id: 'visits', label: 'Visits (test)', trips: [{}, {}] };
    W.startScenario(w, record(w, rec), { count: 2 });
    var produce = [];
    var closed1 = null;
    drive(w, { max: 1500, on: function (w2, name) {
        var r = w2.st.run();
        if (name === 'Produce') produce.push(r.id + ':' + r.trip);
        if (closed1 === null && w2.st.current().request.finished === 1) closed1 = w2.st.current().request.closedAt;
        if (name === 'Clear' && !lastQuest(w2)) w2.quests.push({ key: 'q' + r.id, name: 'Final', last: true });
    } });
    var r = w.st.run();
    assert.strictEqual(r.status, w.S.RunStatus.Done, 'status ' + r.status + ' at ' + stepName(w) +
        (r.pause ? ': ' + r.pause.message : ''));
    assert.strictEqual(w.st.current().request.finished, 2);
    var maps = w.buffActions.filter(function (b) { return b.type === 'Adventure'; });
    assert.strictEqual(maps.length, 2);
    assert.ok(typeof closed1 === 'number', 'run 1 stored closedAt');
    assert.ok(maps[1].t >= closed1 + w.S.modules.adventures.home.GAP_MS, 'map 2 after the gap');
    var ids = [];
    produce.forEach(function (x) {
        var id = x.split(':')[0];
        if (ids.indexOf(id) < 0) ids.push(id);
    });
    assert.strictEqual(ids.length, 2, 'two runs: ' + produce.join(' '));
    assert.strictEqual(produce.filter(function (x) { return x.split(':')[0] === ids[1]; })[0], ids[1] + ':0');
});

t.test('Pause and Resume mid-trip: nothing is sent while paused, every grid once after Resume', function () {
    var w = scenWorld();
    w.setStock(BRIDGE, 3);
    w.setStock(SHEET, 3);
    onIsland(w, record(w, TWINS), 1);
    drive(w, { until: function (w2) { return w2.itemSends.length === 2; } });
    var run = w.S.modules.adventures.run;
    assert.strictEqual(run.pause(), true);
    w.kernelPause();
    passesFor(w, 120000);
    assert.strictEqual(w.itemSends.length, 2, 'nothing sent while paused');
    assert.strictEqual(run.resume(), true);
    drive(w, { until: at('Trip') });
    assertStep(w, 'Trip');
    assert.deepStrictEqual(sendsTo(w, BRIDGE).map(function (s) { return s.grid; }), [11, 12, 13]);
    assert.deepStrictEqual(sendsTo(w, SHEET).map(function (s) { return s.grid; }), [21, 22, 23]);
});

// ---- storm recovery: re-visit, no-packet sends -------------------------------------

// A visit-only trip 0, then a trip 1 whose items cost Wood 12 (14 with the
// last trip's): with Wood 3 the next trip is short at Produce of trip 0.
var SHORTREC = {
    id: 'short_test', label: 'Short (test)',
    trips: [{}, { items: [{ buff: BRIDGE, grids: [11, 12, 13] }, { buff: SHEET, grids: [21, 22, 23] }] }]
};

// The run through Produce of trip 0 on a world short of Wood, up to Trip of
// trip 0 on the island, collect picking up there.
function shortTrip(wood) {
    var w = scenWorld({ world: { resources: { Wood: wood === undefined ? 3 : wood } },
        quests: [{ key: 'q9', name: 'Final', last: true }] });
    w.H.settings.write('collect', COLLECT_ON);
    W.startScenario(w, record(w, SHORTREC), { step: w.S.RunStep.Produce, trip: 0 });
    drive(w, { until: at('Trip') });
    assertStep(w, 'Trip');
    assert.strictEqual(w.st.run().trip, 0);
    return w;
}

// Steps entered by the run, in order, with the trip each had.
function stepTrail(w, steps) {
    return function (w2, name) {
        var s = name + ':' + w2.st.run().trip;
        if (steps[steps.length - 1] !== s) steps.push(s);
    };
}

t.test('Trip: next trip short and a pick-up not on the map: re-visits the island instead of leaving', function () {
    var w = shortTrip();
    assert.ok(w.st.run().marks['short:0'], 'Produce noted the shortfall on trip 0');
    w.awaited = [{ name: HAMMER, zoneId: ZONE }];
    var steps = [];
    drive(w, { max: 200, until: function (w2, name) { return name === 'Trip' && steps.indexOf('JumpHome:0') >= 0; },
        on: stepTrail(w, steps), dt: PASS_MS });
    assert.ok(steps.indexOf('JumpHome:0') >= 0, steps.join(' '));
    assert.ok(logged(w, /going home and back to reload the island \(1\/2\)/), logLines(w).join('\n'));
    assert.ok(!logged(w, /leaving with/), logLines(w).join('\n'));
    var jh = steps.indexOf('JumpHome:0');
    assert.ok(steps.indexOf('ArriveHome:0') > jh, steps.join(' '));
    assert.ok(steps.indexOf('Produce:0') > jh, steps.join(' '));
    assert.strictEqual(w.st.run().trip, 0);
    assertStep(w, 'Trip');
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    assert.ok(!logged(w, /run paused/), logLines(w).join('\n'));
    // The pick-up shows up and the stock covers trip 1: the trip ends normally.
    w.awaited = [];
    w.resources.Wood = 1000;
    drive(w, { max: 400, until: function (w2) { return w2.st.run().trip === 1 && stepName(w2) === 'Produce'; } });
    assert.strictEqual(w.st.run().trip, 1, 'left to trip 1');
    assert.ok(logged(w, /trip 1\/.* done/), logLines(w).join('\n'));
    drive(w, { max: 400, until: function (w2) { return w2.productionOrders.length > 0; } });
    assert.ok(w.productionOrders.length > 0, 'trip 1 orders');
    assert.notStrictEqual(w.st.run().status, w.S.RunStatus.Paused);
    assert.ok(!w.st.run().marks['short:0'] && !w.st.run().marks['revisit:0'], 'marks gone');
});

t.test('Trip: still missing after TRIP_REVISITS re-visits pauses on the island', function () {
    var w = shortTrip();
    w.awaited = [{ name: HAMMER, zoneId: ZONE }];
    var steps = [];
    drive(w, { max: 600, on: stepTrail(w, steps), dt: PASS_MS });
    assertPaused(w, w.S.RunPause.NotObserved, /still left after 2 re-visits; the next trip is short of Wood/);
    assert.strictEqual(w.st.run().trip, 0);
    assert.strictEqual(steps.filter(function (s) { return s === 'JumpHome:0'; }).length, 2, steps.join(' '));
    assert.ok(steps.indexOf('JumpHome:1') < 0, steps.join(' '));
    assert.ok(logged(w, /\(2\/2\)/), logLines(w).join('\n'));
});

t.test('Trip: next trip short but nothing left leaves as before', function () {
    var w = shortTrip();
    var steps = [];
    drive(w, { max: 200, until: function (w2, name) { return name === 'JumpHome'; }, on: stepTrail(w, steps), dt: PASS_MS });
    assertStep(w, 'JumpHome');
    assert.strictEqual(w.st.run().trip, 1, 'trip 1 after the settle');
    assert.ok(!logged(w, /going home and back to reload/), logLines(w).join('\n'));
});

t.test('Produce: the next-trip shortfall is noted on the trip and cleared once covered', function () {
    var w = scenWorld({ world: { resources: { Wood: 3 } } });
    W.startScenario(w, record(w, SHORTREC), { step: w.S.RunStep.Produce, trip: 0 });
    tick(w);
    play(w);
    var m = w.st.run().marks['short:0'];
    assert.ok(m && m.seen, 'short:0 mark');
    assert.ok(/Wood/.test(m.text), String(m.text));
    var w2 = scenWorld({ world: { resources: { Wood: 1000 } } });
    W.startScenario(w2, record(w2, SHORTREC), { step: w2.S.RunStep.Produce, trip: 0 });
    tick(w2);
    play(w2);
    assert.ok(!(w2.st.run().marks || {})['short:0'], 'no mark once covered');
});

// The Bridge trip of ONE on the island at Apply, stock enough for both grids.
function bridgeTrip() {
    var w = scenWorld({ quests: [{ key: 'qb', name: 'Bridges', item: BRIDGE, grids: [11, 12], met: false,
        stayOpen: true }, { key: 'q9', name: 'Final', last: true }] });
    w.setStock(BRIDGE, 5);
    w.H.settings.write('collect', COLLECT_ON);
    onIsland(w, record(w, ONE), 0);
    return w;
}

function notSentLines(w) {
    return logLines(w).filter(function (l) { return /not sent \(nothing went out\)/.test(l); }).length;
}

t.test('Apply: a send whose star-menu entry has no unique id is tried again, no pause, one packet', function () {
    var w = bridgeTrip();
    w.noUid[BRIDGE] = true;
    drive(w, { until: function () { return notSentLines(w) > 0; } });
    assert.ok(notSentLines(w) > 0, logLines(w).join('\n'));
    assert.strictEqual(w.st.run().status, w.S.RunStatus.Running);
    assert.strictEqual(sendsTo(w, BRIDGE).length, 0);
    var mk = w.st.run().marks;
    var name = Object.keys(mk).filter(function (k) { return /^apply:/.test(k); })[0];
    assert.ok(name, 'apply mark');
    assert.strictEqual(mk[name].sentAt, null);
    assert.strictEqual(mk[name].notSent, 1);
    w.noUid[BRIDGE] = false;
    drive(w, { until: at('Trip') });
    assertStep(w, 'Trip');
    var grids = sendsTo(w, BRIDGE).map(function (s) { return s.grid; }).sort();
    assert.deepStrictEqual(grids, [11, 12]);
});

t.test('Apply: no packet three times to a grid pauses BuffFailed', function () {
    var w = bridgeTrip();
    var spacing = w.S.modules.adventures.trips.NOT_SENT_RETRY_MS;
    w.noUid[BRIDGE] = true;
    drive(w, { until: function () { return notSentLines(w) > 0; } });
    var first = w.t;
    // Inside the gap: waiting, no second try.
    W.ticksFor(w, 3000);
    play(w);
    assert.strictEqual(notSentLines(w), 1, logLines(w).join('\n'));
    assert.ok(/not sent, trying again/.test(w.st.current().busy.text), JSON.stringify(w.st.current().busy));
    drive(w, { max: 400, dt: 2000 });
    assertPaused(w, w.S.RunPause.BuffFailed, /nothing sent after 3 tries/);
    assert.ok(w.t - first >= 2 * spacing, 'spaced: ' + (w.t - first));
    assert.strictEqual(notSentLines(w), 3);
    assert.strictEqual(w.itemSends.length, 0);
    assert.strictEqual(w.S.modules.adventures.run.resume(), true);
    drive(w, { until: function () { return notSentLines(w) > 3; } });
    assert.ok(notSentLines(w) > 3, 'resume tries again');
});

t.test('Apply: a real packet failure still pauses BuffFailed', function () {
    var w = bridgeTrip();
    w.buffSendThrows = true;
    drive(w, { max: 400 });
    assertPaused(w, w.S.RunPause.BuffFailed, /failed: send failed/);
    var mk = w.st.run().marks;
    var name = Object.keys(mk).filter(function (k) { return /^apply:/.test(k); })[0];
    assert.ok(name && typeof mk[name].sentAt === 'number', 'the mark keeps sentAt');
});

t.test('Reload: notSent, notSentAt, count and text marks survive a reload; other marks keep their shape', function () {
    // A no-packet send leaves notSent and notSentAt on the apply mark.
    var w = bridgeTrip();
    w.noUid[BRIDGE] = true;
    drive(w, { until: function () { return notSentLines(w) > 0; } });
    var mk = w.st.run().marks;
    var an = Object.keys(mk).filter(function (k) { return /^apply:/.test(k); })[0];
    assert.ok(typeof mk[an].notSentAt === 'number');
    var wa = w;
    // A short and a revisit mark with their fields (one re-visit taken).
    var w1 = shortTrip();
    w1.awaited = [{ name: HAMMER, zoneId: ZONE }];
    drive(w1, { max: 200, until: function (w2) { return !!(w2.st.run().marks['revisit:0']); }, dt: PASS_MS });
    var m1 = w1.st.run().marks;
    assert.strictEqual(m1['revisit:0'].count, 1);
    assert.ok(/Wood/.test(m1['short:0'].text));

    function boot(src) {
        var x = W.world({ home: true, fs: src.fs, generals: [], free: {}, items: items() });
        x.mod.boot();
        assert.ok(x.st.run(), 'the run came back');
        return x;
    }
    function back(x, name) { return plain(x.st.run().marks[name]); }
    var wa2 = boot(wa);
    assert.deepStrictEqual(back(wa2, an), plain(mk[an]));
    var w12 = boot(w1);
    assert.deepStrictEqual(back(w12, 'revisit:0'), plain(m1['revisit:0']));
    assert.deepStrictEqual(back(w12, 'short:0'), plain(m1['short:0']));

    // Wrong types are dropped; the plain fields stay as written.
    var data = JSON.parse(w1.fs.disk[W.RUN_FILE]);
    var marks = data.run.marks;
    marks['revisit:0'].count = null;
    marks['short:0'].text = 5;
    marks['short:0'].notSent = 'x';
    marks['plain:0'] = { sentAt: 7, seen: true, sentOnce: true };
    w1.fs.disk[W.RUN_FILE] = JSON.stringify(data);
    var w13 = boot(w1);
    var rv = back(w13, 'revisit:0');
    var sh = back(w13, 'short:0');
    assert.ok(!('count' in rv), JSON.stringify(rv));
    assert.ok(!('text' in sh) && !('notSent' in sh), JSON.stringify(sh));
    assert.deepStrictEqual(Object.keys(back(w13, 'plain:0')).sort(), ['seen', 'sentAt', 'sentOnce']);
    assert.deepStrictEqual(back(w13, 'plain:0'), { sentAt: 7, seen: true, sentOnce: true });
});
