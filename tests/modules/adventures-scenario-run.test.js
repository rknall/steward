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

var COST = [{ name_string: 'Wood', amount: 2 }];

function items() {
    var out = {};
    [BRIDGE, SHEET, RESCUE, DYN].forEach(function (b) { out[b] = { group: '0', yield: 1, costs: COST }; });
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

// Storm-like: small dynamite amount 10 as the trip total over four grids that each need 4 (more than 10 in all, so the top-up trip is the fallback).
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

// Storm-like small dynamite: amount 10, four grids that each need 4, stock 10 (the wiki total over the four grids).
function storm(o) {
    o = o || {};
    var need = {};
    [41, 42, 43, 44].forEach(function (g) { need[g] = 4; });
    for (var k in (o.need || {})) if (Object.prototype.hasOwnProperty.call(o.need, k)) need[k] = o.need[k];
    var w = scenWorld({ quests: [{ key: 'qd', name: 'Rocks', item: DYN, grids: [41, 42, 43, 44] },
        { key: 'q9', name: 'Final', last: true }], gridNeed: need });
    w.setStock(DYN, 10);
    onIsland(w, record(w, STORM), 0);
    return w;
}

function dynSends(w) {
    return plain(sendsTo(w, DYN).map(function (s) { return [s.grid, s.amount, s.took]; }));
}

t.test('grid-done rule: a capped grid stays open, the trip home orders for it, and the top-up fills it', function () {
    var w = storm();
    drive(w, { max: 500, until: function (w2) { return w2.st.run().trip === 1; } });
    assert.deepStrictEqual(dynSends(w), [[41, 10, 4], [42, 6, 4], [43, 2, 2], [43, 10, 2], [44, 8, 4]]);
    assert.ok(logged(w, /SmallDynamite -> 43: took all 2 offered \(up to 10\); grid stays open/), logLines(w).join('\n'));
    assert.ok(logged(w, /SmallDynamite -> 42: took 4 of 6; grid done/));
    var made = w.productionOrders.filter(function (o) { return o.unit === DYN; });
    assert.deepStrictEqual(plain(made.map(function (o) { return o.amount; })), [10], 'the trip total, not per grid');
    var q = w.quests.filter(function (x) { return x.key === 'qd'; })[0];
    assert.ok(!q || q.finished, 'the item quest finished');
    assert.ok(!logged(w, /run paused/), 'no pause');
});

t.test('grid-done rule: a capped grid that was already full takes nothing on the top-up and is done, no pause', function () {
    var w = storm({ need: { 43: 2 } });
    drive(w, { max: 500, until: function (w2) { return w2.st.run().trip === 1; } });
    assert.deepStrictEqual(dynSends(w), [[41, 10, 4], [42, 6, 4], [43, 2, 2], [43, 10, 0], [44, 10, 4]]);
    assert.ok(logged(w, /SmallDynamite -> 43: took nothing more; grid done/), logLines(w).join('\n'));
    assert.ok(!logged(w, /run paused/), 'no pause');
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
    assertPaused(w, w.S.RunPause.BuffFailed, /apply BattleBuffHurt_BuffAd_SmallDynamite to 43 failed/);
    assert.strictEqual(sendsTo(w, DYN).length, 3);
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
    assert.ok(logged(w, /SmallDynamite -> 43: took all 2 offered \(up to 10\); grid stays open/), logLines(w).join('\n'));
    var r = w.st.run();
    var m = r.marks[w.S.modules.adventures.trips.applyMark(r, DYN, 43)];
    assert.ok(!(m && m.seen), 'the grid is open');
    var part = r.marks['part:0:' + DYN + ':43'];
    assert.ok(part && part.seen, 'the part mark is set');
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
