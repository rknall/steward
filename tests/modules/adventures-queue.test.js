'use strict';

// The queue on the run request: the running copy survives the run file, the
// position helpers walk the entries and passes, enterEntry makes an entry the
// current series, a queue with an entry to come is never settled, and the
// status texts put the queue's place in front of the run.

var t = require('../runner');
var W = require('../stubs/adventures');

var assert = t.assert;

var RUN_FILE = W.RUN_FILE;
var plain = W.plain;

// A x2, S x1, A x1: two template entries around a scenario entry, which
// carries templateId '' as a single scenario request does.
function queue(over) {
    var q = {
        id: 'q1', label: 'Long and short',
        entries: [
            { kind: 'template', id: 't1', templateId: 't1', label: 'Long map', adventure: 'BlackKnights', count: 2 },
            { kind: 'scenario', id: 's1', templateId: '', label: 'Event chain', adventure: 'BlackKnights', count: 1 },
            { kind: 'template', id: 't2', templateId: 't2', label: 'Short map', adventure: 'BlackKnights', count: 1 }
        ],
        index: 0, loop: false, passes: 0, pass: 0, early: false,
        retrain: 'settings', noMap: 'pause', width: 3, skip: 0, tried: null
    };
    for (var k in (over || {})) if (Object.prototype.hasOwnProperty.call(over, k)) q[k] = over[k];
    return q;
}

function request(q) {
    var e = q.entries[q.index];
    return {
        templateId: e.templateId, label: e.label, adventure: e.adventure, count: e.count, ended: false,
        requested: 1000, finished: 0, closedAt: null, queue: q
    };
}

// A template run of the current entry at `step`, begun with the request.
function begin(w, req, step) {
    var r = w.st.newRun({
        id: 42, templateId: req.templateId, label: req.label, adventure: req.adventure,
        paths: ['C:/b/w1.txt'], loadoutPath: W.LOADOUT, loadoutKeys: { '1.1': true },
        step: step || w.S.RunStep.Muster
    });
    w.st.begin(req, r);
    return w.st.run();
}

function reload(w) {
    var w2 = W.world({ fs: w.fs, home: true });
    w2.st.load();
    return w2;
}

// ---- request file -------------------------------------------------------------

t.test('normRequest keeps a valid mixed queue through the run file', function () {
    var w = W.world({ home: true });
    begin(w, request(queue()));
    var q = reload(w).st.current().request.queue;
    assert.deepStrictEqual(plain(q), queue());
});

t.test('an old request without a queue loads with queue null', function () {
    var w = W.world({ home: true });
    W.writeJson(w.fs, RUN_FILE, {
        version: 1,
        request: { templateId: 't1', label: 'Long map', adventure: 'BlackKnights', count: 2, ended: false,
            requested: 1, finished: 1, closedAt: null },
        run: w.st.newRun({ templateId: 't1', label: 'Long map', adventure: 'BlackKnights',
            paths: ['C:/b/w1.txt'], loadoutKeys: { '1.1': true }, step: w.S.RunStep.Muster })
    });
    w.st.load();
    var req = w.st.current().request;
    assert.strictEqual(req.queue, null);
    assert.strictEqual(req.finished, 1);
    assert.strictEqual(w.st.status().indexOf('Running: Long map, run 2/2'), 0);
});

t.test('normRequest repairs a queue: counts, strings kept, no entries is no queue', function () {
    var w = W.world({ home: true });
    var q = queue({ index: 9, passes: -1, width: 0, skip: 2.7, retrain: 'bogus', noMap: 5, loop: 'yes' });
    q.entries[1].count = 0;
    q.entries.push('junk');
    begin(w, request(queue()));
    w.st.current().request.queue = q;
    w.st.save();
    var got = reload(w).st.current().request.queue;
    assert.strictEqual(got.entries.length, 3);
    assert.strictEqual(got.entries[1].count, 1);
    assert.strictEqual(got.index, 2);
    assert.strictEqual(got.passes, 0);
    assert.strictEqual(got.width, 1);
    assert.strictEqual(got.skip, 2);
    assert.strictEqual(got.tried, null);
    assert.strictEqual(got.retrain, 'bogus');
    assert.strictEqual(got.noMap, '');
    assert.strictEqual(got.loop, false);

    w.st.current().request.queue = queue({ tried: { index: 1.6, pass: 2 } });
    w.st.save();
    assert.deepStrictEqual(plain(reload(w).st.current().request.queue.tried), { index: 1, pass: 2 });
    w.st.current().request.queue = queue({ tried: { index: 3, pass: 0 } });
    w.st.save();
    assert.strictEqual(reload(w).st.current().request.queue.tried, null, 'no such entry');

    w.st.current().request.queue = queue({ entries: [] });
    w.st.save();
    assert.strictEqual(reload(w).st.current().request.queue, null);
});

// ---- position -----------------------------------------------------------------

function walk(st, req) {
    var out = [];
    var at = { index: req.queue.index, pass: req.queue.pass };
    for (var i = 0; i < 10 && at; i++) {
        out.push(at.index + '/' + at.pass);
        at = st.queueAt(req, at);
    }
    return out;
}

t.test('queueAt walks A x2, S x1, A x1 once without loop', function () {
    var w = W.world({ home: true });
    var req = request(queue());
    assert.deepStrictEqual(walk(w.st, req), ['0/0', '1/0', '2/0']);
    assert.deepStrictEqual(plain(w.st.queueNext(req)), { index: 1, pass: 0 });
    req.queue.index = 2;
    assert.strictEqual(w.st.queueNext(req), null, 'the last entry without loop has no next');
});

t.test('queueAt loops endless with passes 0 and stops after passes 2', function () {
    var w = W.world({ home: true });
    var endless = request(queue({ loop: true, passes: 0 }));
    assert.deepStrictEqual(walk(w.st, endless).length, 10);
    assert.deepStrictEqual(plain(w.st.queueAt(endless, { index: 2, pass: 7 })), { index: 0, pass: 8 });
    var two = request(queue({ loop: true, passes: 2 }));
    assert.deepStrictEqual(walk(w.st, two), ['0/0', '1/0', '2/0', '0/1', '1/1', '2/1']);
});

t.test('queueNext is null when ended or without a queue; stepping over one entry', function () {
    var w = W.world({ home: true });
    var req = request(queue({ loop: true }));
    req.ended = true;
    assert.strictEqual(w.st.queueNext(req), null);
    assert.strictEqual(w.st.queueNext(null), null);
    var single = request(queue());
    single.queue = null;
    assert.strictEqual(w.st.queueNext(single), null);
    assert.strictEqual(w.st.queueAt(single, { index: 0, pass: 0 }), null);
    req.ended = false;
    var over = w.st.queueAt(req, w.st.queueNext(req));
    assert.deepStrictEqual(plain(over), { index: 2, pass: 0 }, 'the scenario entry is stepped over');
});

t.test('enterEntry copies templateId empty for a scenario entry and resets skip', function () {
    var w = W.world({ home: true });
    var req = request(queue({ skip: 1, tried: { index: 2, pass: 0 } }));
    req.finished = 1;
    req.closedAt = 500;
    assert.strictEqual(w.st.enterEntry(req, { index: 1, pass: 0 }), true);
    assert.strictEqual(req.templateId, '');
    assert.strictEqual(req.label, 'Event chain');
    assert.strictEqual(req.adventure, 'BlackKnights');
    assert.strictEqual(req.count, 1);
    assert.strictEqual(req.finished, 0);
    assert.strictEqual(req.ended, false);
    assert.strictEqual(req.closedAt, 500, 'the gap after the closed map still holds');
    assert.strictEqual(req.queue.index, 1);
    assert.strictEqual(req.queue.skip, 0);
    assert.strictEqual(req.queue.tried, null);
    assert.strictEqual(w.st.enterEntry(req, { index: 2, pass: 1 }), true);
    assert.strictEqual(req.templateId, 't2');
    assert.strictEqual(req.queue.pass, 1);
    assert.strictEqual(w.st.enterEntry(req, { index: 5, pass: 0 }), false);
    assert.strictEqual(req.templateId, 't2');
});

// ---- settled ------------------------------------------------------------------

t.test('settled is false between entries and for a loop, true after the last entry', function () {
    var w = W.world({ home: true });
    var q = queue();
    q.index = 0;
    var req = request(q);
    req.finished = 1;
    var r = begin(w, req, w.S.RunStep.ArriveHome);
    var rs = w.st.current();
    assert.strictEqual(w.st.settled(rs), false, 'entry 2 is still to come');
    assert.ok(JSON.parse(w.fs.disk[RUN_FILE]).request.queue, 'the file keeps the queue');

    w.st.enterEntry(req, { index: 2, pass: 0 });
    r.label = req.label;
    assert.strictEqual(w.st.settled(rs), true, 'the last entry home settles the queue');

    req.queue.loop = true;
    assert.strictEqual(w.st.settled(rs), false, 'a looping queue goes on');
    req.ended = true;
    assert.strictEqual(w.st.settled(rs), true, 'End repetition ends the loop');
});

t.test('toFile and load round trip mid-queue with skip 1', function () {
    var w = W.world({ home: true });
    var req = request(queue({ loop: true, passes: 3 }));
    w.st.enterEntry(req, { index: 1, pass: 1 });
    req.finished = 0;
    req.queue.skip = 1;
    begin(w, req, w.S.RunStep.Next);
    var data = JSON.parse(w.fs.disk[RUN_FILE]);
    assert.strictEqual(data.request.queue.skip, 1);
    var w2 = reload(w);
    var got = w2.st.current().request;
    assert.strictEqual(got.queue.index, 1);
    assert.strictEqual(got.queue.pass, 1);
    assert.strictEqual(got.queue.skip, 1);
    assert.strictEqual(got.templateId, '');
    assert.strictEqual(got.label, 'Event chain');
    assert.deepStrictEqual(plain(w2.st.queueNext(got)), { index: 2, pass: 1 });
});

// ---- texts --------------------------------------------------------------------

t.test('runPart puts the queue place in front of a template entry', function () {
    var w = W.world({ home: true });
    begin(w, request(queue()));
    assert.strictEqual(w.st.title(), 'Running: Long and short 1/3: Long map, run 1/2');
    assert.strictEqual(w.st.status(), 'Running: Long and short 1/3: Long map, run 1/2, Muster');
});

t.test('runPart of a scenario entry keeps its trip; a loop shows the pass', function () {
    var w = W.world({ home: true });
    var req = request(queue({ loop: true }));
    w.st.enterEntry(req, { index: 1, pass: 1 });
    var trips = [{ items: [] }, { items: [] }, { items: [] }];
    var r = w.st.newRun({
        id: 42, templateId: '', scenarioId: 's1', label: req.label, adventure: req.adventure,
        trips: trips, trip: 1, step: w.S.RunStep.Muster
    });
    w.st.begin(req, r);
    assert.strictEqual(w.st.title(), 'Running: Long and short 2/3, pass 2/\u221e: Event chain, run 1/1, trip 2/3');
    req.queue.passes = 3;
    assert.strictEqual(w.st.title(), 'Running: Long and short 2/3, pass 2/3: Event chain, run 1/1, trip 2/3');
});

t.test('Done and Stopped lines name the queue; a single run keeps its lines', function () {
    var w = W.world({ home: true });
    var req = request(queue({ loop: true, passes: 2 }));
    w.st.enterEntry(req, { index: 2, pass: 1 });
    begin(w, req, w.S.RunStep.ArriveHome);
    req.finished = 1;
    w.st.done();
    assert.strictEqual(w.st.status(), 'Done: Long and short, 3 entries, 2 passes');
    assert.strictEqual(w.st.title(), 'Done: Long and short, 3 entries, 2 passes');

    var w2 = W.world({ home: true });
    var req2 = request(queue());
    begin(w2, req2, w2.S.RunStep.Muster);
    w2.st.stop('troops short');
    assert.strictEqual(w2.st.status(), 'Stopped: Long and short 1/3: Long map, 0 run(s): troops short');

    var w3 = W.world({ home: true });
    var single = request(queue());
    single.queue = null;
    begin(w3, single, w3.S.RunStep.Muster);
    assert.strictEqual(w3.st.title(), 'Running: Long map, run 1/2');
    w3.st.done();
    assert.strictEqual(w3.st.status(), 'Done: Long map, 0 run(s)');
});

t.test('the queue entry pause reason exists', function () {
    var w = W.world({ home: true });
    assert.strictEqual(w.S.RunPause.QueueEntry, 'PauseQueueEntry');
});

t.test('queueTarget steps over queue.skip entries and counts the step-overs', function () {
    var w = W.world({ home: true });
    var req = request(queue());
    assert.deepStrictEqual(plain(w.st.queueTarget(req)), { at: { index: 1, pass: 0 }, stepped: 0 });
    req.queue.skip = 1;
    assert.deepStrictEqual(plain(w.st.queueTarget(req)), { at: { index: 2, pass: 0 }, stepped: 1 });
    req.queue.skip = 3;
    assert.deepStrictEqual(plain(w.st.queueTarget(req)), { at: null, stepped: 2 },
        'the queue ends on the way');
    var looped = request(queue({ loop: true, passes: 2, skip: 2 }));
    assert.deepStrictEqual(plain(w.st.queueTarget(looped)), { at: { index: 0, pass: 1 }, stepped: 2 });
    req.ended = true;
    assert.deepStrictEqual(plain(w.st.queueTarget(req)), { at: null, stepped: 0 });
});

t.test('queueTried prefers queue.tried; queueSkipPast counts to past that entry', function () {
    var w = W.world({ home: true });
    var req = request(queue());
    assert.deepStrictEqual(plain(w.st.queueTried(req)), { index: 1, pass: 0 }, 'queueTarget without tried');
    req.queue.tried = { index: 2, pass: 0 };
    assert.deepStrictEqual(plain(w.st.queueTried(req)), { index: 2, pass: 0 });
    assert.strictEqual(w.st.queueSkipPast(req, { index: 1, pass: 0 }), 1);
    assert.strictEqual(w.st.queueSkipPast(req, { index: 2, pass: 0 }), 2);
    assert.strictEqual(w.st.queueSkipPast(req, { index: 0, pass: 0 }), null, 'behind the next entry');
    var endless = request(queue({ loop: true, passes: 0 }));
    assert.strictEqual(w.st.queueSkipPast(endless, { index: 0, pass: 1 }), 3);
    assert.strictEqual(w.st.queueSkipPast(endless, { index: 0, pass: 9 }), null, 'bounded walk');
});
