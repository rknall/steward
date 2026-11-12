'use strict';

// The adventure queue store: files in <steward>/adventures/queues, entries of
// mixed kinds, option defaults, validation and the running copy a request
// carries.

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');

var assert = t.assert;

var ROOT = 'C:/client/steward/adventures';
var QDIR = ROOT + '/queues';
var SDIR = ROOT + '/scenarios';

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup() {
    var fs = airfs.make();
    var H = harness.boot({ host: { air: fs.air } });
    var S = H.Steward;
    var w = { fs: fs, S: S, q: S.modules.adventures.queues, tp: S.modules.adventures.templates };
    return w;
}

function template(w, label, waves) {
    var r = w.tp.save({
        label: label,
        adventure: 'Adv_' + label.replace(/\s/g, ''),
        loadout: 'C:/battles/loadout.json',
        waves: waves || ['C:/battles/w1.json'],
        speedBuff: 'SpeedBuffDefault'
    }, 1000 + label.length);
    assert.ok(r.ok, 'template ' + label + ': ' + JSON.stringify(r.problems));
    return r.id;
}

function scenario(w, id, label) {
    w.fs.dirs[SDIR] = true;
    w.fs.disk[SDIR + '/' + id + '.json'] = JSON.stringify({
        version: 1, label: label, adventure: 'Scen_' + id, trips: [{}]
    });
    return id;
}

// Long map (3 waves) x2, Chain (scenario) x1, Short map (1 wave) x1.
function mixed(w) {
    var a = template(w, 'Long map', ['C:/b/w1.json', 'C:/b/w2.json', 'C:/b/w3.json']);
    var s = scenario(w, 'chain', 'Chain');
    var b = template(w, 'Short map', ['C:/b/s1.json']);
    return {
        ids: { a: a, s: s, b: b },
        rec: {
            label: 'Event loop',
            entries: [
                { kind: 'template', id: a, count: 2 },
                { kind: 'scenario', id: s, count: 1 },
                { kind: 'template', id: b, count: 1 }
            ],
            loop: true, passes: 2, early: true, retrain: 'off', noMap: 'skip'
        }
    };
}

t.test('the enums are the only kind and option lists', function () {
    var w = setup();
    assert.deepStrictEqual(plain(w.q.KIND), { Template: 'template', Scenario: 'scenario' });
    assert.deepStrictEqual(plain(w.q.RETRAIN), { Settings: 'settings', On: 'on', Off: 'off' });
    assert.deepStrictEqual(plain(w.q.NO_MAP), { Pause: 'pause', Skip: 'skip' });
    assert.strictEqual(w.q.SUBDIR, 'adventures/queues');
});

t.test('save, list and get round-trip a mixed queue with its options', function () {
    var w = setup();
    var m = mixed(w);
    var r = w.q.save(m.rec, 5000);
    assert.ok(r.ok, JSON.stringify(r.problems));
    assert.strictEqual(r.id, 't5000');
    var path = QDIR + '/t5000.json';
    assert.ok(Object.prototype.hasOwnProperty.call(w.fs.disk, path), 'file written');
    var file = JSON.parse(w.fs.disk[path]);
    assert.strictEqual(file.version, 1);
    assert.strictEqual(file.id, undefined, 'the id is never written');
    assert.deepStrictEqual(plain(file.entries), plain(m.rec.entries));

    var got = w.q.get('t5000');
    assert.strictEqual(got.id, 't5000');
    assert.strictEqual(got.label, 'Event loop');
    assert.deepStrictEqual(plain(got.entries), plain(m.rec.entries));
    assert.strictEqual(got.loop, true);
    assert.strictEqual(got.passes, 2);
    assert.strictEqual(got.early, true);
    assert.strictEqual(got.retrain, 'off');
    assert.strictEqual(got.noMap, 'skip');
    assert.strictEqual(got.saved, 5000);

    var all = w.q.list();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].id, 't5000');

    // Re-saving keeps the id and its own label.
    got.passes = 0;
    var again = w.q.save(got, 6000);
    assert.ok(again.ok, JSON.stringify(again.problems));
    assert.strictEqual(again.id, 't5000');
    assert.strictEqual(w.q.get('t5000').passes, 0);
});

t.test('a broken file is listed after the records, and get returns null for it', function () {
    var w = setup();
    var m = mixed(w);
    w.q.save(m.rec, 5000);
    w.fs.disk[QDIR + '/bad.json'] = '{ nope';
    w.fs.disk[QDIR + '/arr.json'] = '[1, 2]';
    var all = w.q.list();
    assert.deepStrictEqual(plain(all.map(function (e) { return e.id; })), ['t5000', 'arr', 'bad']);
    assert.ok(/not valid JSON/.test(all[2].error), all[2].error);
    assert.ok(/top level is not an object/.test(all[1].error), all[1].error);
    assert.strictEqual(all[2].path, QDIR + '/bad.json');
    assert.strictEqual(w.q.get('bad'), null);
});

t.test('get refuses an invalid id and a missing file', function () {
    var w = setup();
    assert.strictEqual(w.q.get('../x'), null);
    assert.strictEqual(w.q.get('a b'), null);
    assert.strictEqual(w.q.get(''), null);
    assert.strictEqual(w.q.get(null), null);
    assert.strictEqual(w.q.get('nothere'), null);
    assert.strictEqual(w.q.remove('../x'), false);
});

t.test('remove deletes the file', function () {
    var w = setup();
    var m = mixed(w);
    w.q.save(m.rec, 5000);
    assert.ok(w.q.remove('t5000'));
    assert.strictEqual(w.q.get('t5000'), null);
    assert.strictEqual(w.q.list().length, 0);
});

t.test('normalize defaults the options, floors counts and keeps unknown kinds', function () {
    var w = setup();
    var n = w.q.normalize({
        label: '  Padded  ',
        entries: [
            { kind: 'template', id: 'a', count: 2.7 },
            { kind: 'template', id: 'b', count: 0 },
            { kind: 'scenario', id: 'c' },
            { kind: 'venture', id: 'v', count: 3 },
            { kind: 'template', id: 'bad id', count: 1 },
            { kind: 'template', count: 1 },
            'x',
            null
        ],
        loop: 'yes', passes: -3, early: 1, retrain: 'sometimes', noMap: 'later'
    });
    assert.strictEqual(n.label, 'Padded');
    assert.deepStrictEqual(plain(n.entries), [
        { kind: 'template', id: 'a', count: 2 },
        { kind: 'template', id: 'b', count: 1 },
        { kind: 'scenario', id: 'c', count: 1 },
        { kind: 'venture', id: 'v', count: 3 }
    ]);
    assert.strictEqual(n.loop, false);
    assert.strictEqual(n.passes, 0);
    assert.strictEqual(n.early, false);
    assert.strictEqual(n.retrain, 'settings');
    assert.strictEqual(n.noMap, 'pause');
    assert.strictEqual(n.saved, null);

    var empty = w.q.normalize(undefined);
    assert.deepStrictEqual(plain(empty.entries), []);
    assert.strictEqual(empty.retrain, 'settings');
    assert.strictEqual(empty.noMap, 'pause');
    assert.strictEqual(w.q.normalize({ passes: 4.9, retrain: 'on' }).passes, 4);
    assert.strictEqual(w.q.normalize({ retrain: 'on' }).retrain, 'on');
});

t.test('a file with an unknown kind loads with the entry kept', function () {
    var w = setup();
    w.fs.dirs[QDIR] = true;
    w.fs.disk[QDIR + '/later.json'] = JSON.stringify({
        version: 1, label: 'Later', id: 'other',
        entries: [{ kind: 'venture', id: 'chain1', count: 1 }]
    });
    var rec = w.q.get('later');
    assert.strictEqual(rec.id, 'later', 'id from the file name');
    assert.deepStrictEqual(plain(rec.entries), [{ kind: 'venture', id: 'chain1', count: 1 }]);
    var ps = w.q.validate(rec);
    assert.strictEqual(ps.length, 1);
    assert.strictEqual(ps[0].index, 0);
    assert.ok(/^Entry 1: unknown kind venture/.test(ps[0].message), ps[0].message);
});

t.test('validate names every problem by entry number', function () {
    var w = setup();
    var m = mixed(w);
    assert.deepStrictEqual(plain(w.q.validate(w.q.normalize(m.rec), [])), []);

    var rec = w.q.normalize({
        label: '',
        entries: [
            { kind: 'template', id: m.ids.a, count: 1 },
            { kind: 'template', id: 'gone', count: 1 },
            { kind: 'scenario', id: 'oldchain', count: 1 },
            { kind: 'venture', id: 'v', count: 1 }
        ]
    });
    var ps = w.q.validate(rec, []);
    assert.deepStrictEqual(plain(ps.map(function (p) { return p.field + ':' + (p.index === undefined ? '' : p.index); })),
        ['label:', 'entries:1', 'entries:2', 'entries:3']);
    assert.strictEqual(ps[0].message, 'Label is empty');
    assert.ok(/^Entry 2: template gone is missing/.test(ps[1].message), ps[1].message);
    assert.ok(/^Entry 3: scenario oldchain is missing/.test(ps[2].message), ps[2].message);
    assert.ok(/^Entry 4: unknown kind venture/.test(ps[3].message), ps[3].message);

    var none = w.q.validate(w.q.normalize({ label: 'Empty' }), []);
    assert.deepStrictEqual(plain(none.map(function (p) { return p.message; })), ['This queue has no entries']);
});

t.test('validate reports a broken scenario file and a label taken by another queue', function () {
    var w = setup();
    var m = mixed(w);
    w.fs.disk[SDIR + '/chain.json'] = '{ broken';
    var ps = w.q.validate(w.q.normalize(m.rec), []);
    assert.strictEqual(ps.length, 1);
    assert.ok(/^Entry 2: scenario chain is missing or unreadable/.test(ps[0].message), ps[0].message);

    scenario(w, 'chain', 'Chain');
    assert.ok(w.q.save(m.rec, 5000).ok);
    var twin = w.q.normalize(m.rec);
    twin.label = 'EVENT loop';
    var taken = w.q.validate(twin, w.q.list());
    assert.strictEqual(taken.length, 1);
    assert.strictEqual(taken[0].field, 'label');
    assert.ok(/already used by another queue/.test(taken[0].message), taken[0].message);
    assert.strictEqual(w.q.validate(twin).length, 0, 'no label check without queue records');

    var refused = w.q.save(twin, 7000);
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.problems[0].field, 'label');
    assert.strictEqual(w.q.list().length, 1, 'nothing written');
});

t.test('save refuses an invalid queue and writes nothing', function () {
    var w = setup();
    var r = w.q.save({ label: 'X', entries: [{ kind: 'template', id: 'gone', count: 1 }] }, 5000);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.problems[0].index, 0);
    assert.strictEqual(w.q.list().length, 0);
});

t.test('toRun builds the running copy with labels, templateId by kind and width', function () {
    var w = setup();
    var m = mixed(w);
    var id = w.q.save(m.rec, 5000).id;
    var run = w.q.toRun(w.q.get(id));
    assert.deepStrictEqual(plain(run), {
        id: id,
        label: 'Event loop',
        entries: [
            { kind: 'template', id: m.ids.a, templateId: m.ids.a, label: 'Long map', adventure: 'Adv_Longmap', count: 2 },
            { kind: 'scenario', id: 'chain', templateId: '', label: 'Chain', adventure: 'Scen_chain', count: 1 },
            { kind: 'template', id: m.ids.b, templateId: m.ids.b, label: 'Short map', adventure: 'Adv_Shortmap', count: 1 }
        ],
        index: 0, loop: true, passes: 2, pass: 0, early: true,
        retrain: 'off', noMap: 'skip', width: 3, skip: 0
    });
});

t.test('toRun of a scenario-only queue has width 1', function () {
    var w = setup();
    scenario(w, 'one', 'One');
    scenario(w, 'two', 'Two');
    var run = w.q.toRun(w.q.normalize({
        label: 'Scenarios',
        entries: [{ kind: 'scenario', id: 'one', count: 3 }, { kind: 'scenario', id: 'two', count: 1 }]
    }));
    assert.strictEqual(run.width, 1);
    assert.strictEqual(run.entries[0].templateId, '');
    assert.strictEqual(run.entries[1].label, 'Two');
    assert.strictEqual(run.entries[0].count, 3);
    assert.strictEqual(run.retrain, 'settings');
    assert.strictEqual(run.noMap, 'pause');
    assert.strictEqual(run.skip, 0);
});

t.test('entryRecord reads the template or scenario record by kind', function () {
    var w = setup();
    var m = mixed(w);
    assert.strictEqual(w.q.entryRecord({ kind: 'template', id: m.ids.a }).label, 'Long map');
    assert.strictEqual(w.q.entryRecord({ kind: 'scenario', id: 'chain' }).label, 'Chain');
    assert.strictEqual(w.q.entryRecord({ kind: 'scenario', id: m.ids.a }), null);
    assert.strictEqual(w.q.entryRecord({ kind: 'venture', id: 'chain' }), null);
    assert.strictEqual(w.q.entryRecord(null), null);
});

t.test('toFile writes only the file fields', function () {
    var w = setup();
    var rec = w.q.normalize({ id: 'x', label: 'L', entries: [{ kind: 'template', id: 'a', count: 1, label: 'drop' }] });
    var o = JSON.parse(w.q.toFile(rec));
    assert.deepStrictEqual(Object.keys(o), ['version', 'label', 'entries', 'loop', 'passes', 'early', 'retrain', 'noMap', 'saved']);
    assert.deepStrictEqual(o.entries, [{ kind: 'template', id: 'a', count: 1 }]);
});
