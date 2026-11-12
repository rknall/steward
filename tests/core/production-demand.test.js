'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var t = require('../runner');
var harness = require('../harness');

var REPO_ROOT = path.resolve(__dirname, '..', '..');
var SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/core/production/demand.js'), 'utf8');

// A booted harness with a fresh ledger on a test clock. The ledger file is
// run again into the context so every test starts from an empty ledger and
// does not depend on how production.js assigns its exports. T is read at
// call time, so a test moves time by assigning env.T.
function setup() {
    var H = harness.boot();
    vm.runInContext(SOURCE, H.ctx, { filename: 'src/core/production/demand.js' });
    var env = { H: H, T: 1000000 };
    env.d = H.Steward.core.production.demand;
    env.d.clock = function () { return env.T; };
    env.P = H.Steward.ProductionPriority;
    env.K = H.Steward.ProductionKind;
    H.clearLogs();
    return env;
}

function warns(env) {
    return env.H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === 'production';
    });
}

function need(env, extra) {
    var n = { label: 'L', type: 0, item: 'Recruit', items: 10, basis: env.H.Steward.DemandBasis.Queue, priority: env.P.Standing };
    for (var k in (extra || {})) n[k] = extra[k];
    return n;
}

function keys(rows) {
    // Arrays from the vm context are another realm's; copy for deepStrictEqual.
    return JSON.parse(JSON.stringify(rows.map(function (r) { return r.owner + '/' + r.key; })));
}

t.test('put stores a copy that list returns with the documented fields', function () {
    var env = setup();
    var n = need(env);
    t.assert.strictEqual(env.d.put('production', 'Barracks', n), true);
    n.items = 99;
    var rows = env.d.list();
    t.assert.strictEqual(rows.length, 1);
    t.assert.deepStrictEqual(JSON.parse(JSON.stringify(rows[0])), {
        owner: 'production', key: 'Barracks', label: 'L', type: 0, item: 'Recruit',
        items: 10, basis: env.H.Steward.DemandBasis.Queue, priority: env.P.Standing
    });
    rows[0].items = 1;
    t.assert.strictEqual(env.d.list()[0].items, 10);
    t.assert.strictEqual(env.d.TTL_MS, 120000);
});

t.test('a need expires at TTL_MS and is pruned', function () {
    var env = setup();
    env.d.put('production', 'a', need(env));
    env.T += env.d.TTL_MS - 1;
    t.assert.strictEqual(env.d.list().length, 1);
    env.T += 1;
    t.assert.strictEqual(env.d.list().length, 0);
    env.T -= 10;
    t.assert.strictEqual(env.d.list().length, 0, 'an expired need is gone, not hidden');
});

t.test('re-put is idempotent and refreshes the stamp', function () {
    var env = setup();
    env.d.put('production', 'a', need(env));
    env.T += 100000;
    env.d.put('production', 'a', need(env, { items: 12 }));
    var rows = env.d.list();
    t.assert.strictEqual(rows.length, 1);
    t.assert.strictEqual(rows[0].items, 12);
    env.T += 100000;
    t.assert.strictEqual(env.d.list().length, 1);
});

t.test('drop removes one need; dropOwner removes needs and holds of that owner only', function () {
    var env = setup();
    env.d.put('production', 'a', need(env));
    env.d.put('production', 'b', need(env));
    env.d.put('adventures', 'x', need(env));
    env.d.hold('production', 'h', { label: 'H', kind: env.K.Units });
    env.d.hold('adventures', 'h', { label: 'H', item: 'Recruit' });
    env.d.drop('production', 'a');
    t.assert.deepStrictEqual(keys(env.d.list()), ['adventures/x', 'production/b']);
    env.d.dropOwner('production');
    t.assert.deepStrictEqual(keys(env.d.list()), ['adventures/x']);
    t.assert.deepStrictEqual(keys(env.d.holds()), ['adventures/h']);
    env.d.drop('nobody', 'k');
});

t.test('holds expire at TTL_MS like needs', function () {
    var env = setup();
    env.d.hold('adventures', 'run', { label: 'Run', kind: env.K.Units });
    env.T += env.d.TTL_MS - 1;
    t.assert.strictEqual(env.d.holds().length, 1);
    env.T += 1;
    t.assert.strictEqual(env.d.holds().length, 0);
    t.assert.strictEqual(env.d.isHeld(env.K.Units, 'Recruit', 'production'), null);
});

t.test('list sorts by priority, then owner, then key', function () {
    var env = setup();
    env.d.put('production', 'b', need(env, { priority: env.P.Standing }));
    env.d.put('production', 'a', need(env, { priority: env.P.Standing }));
    env.d.put('quests', 'q', need(env, { priority: env.P.Quest }));
    env.d.put('adventures', 'z', need(env, { priority: env.P.RunNow }));
    env.d.put('adventures', 'y', need(env, { priority: env.P.RunAhead }));
    env.d.put('adventures', 'c', need(env, { priority: env.P.Standing }));
    t.assert.deepStrictEqual(keys(env.d.list()), [
        'adventures/z', 'adventures/y', 'quests/q', 'adventures/c', 'production/a', 'production/b'
    ]);
});

t.test('invalid needs are warned and ignored', function () {
    var env = setup();
    var bad = [
        ['', 'k', need(env)],
        ['o', null, need(env)],
        ['o', 'k', null],
        ['o', 'k', need(env, { items: 0 })],
        ['o', 'k', need(env, { items: -3 })],
        ['o', 'k', need(env, { items: 2.5 })],
        ['o', 'k', need(env, { items: '4' })],
        ['o', 'k', need(env, { priority: 9 })],
        ['o', 'k', need(env, { priority: 'RunNow' })],
        ['o', 'k', need(env, { basis: 'later' })],
        ['o', 'k', need(env, { basis: 'queue' })]
    ];
    for (var i = 0; i < bad.length; i++) {
        t.assert.strictEqual(env.d.put(bad[i][0], bad[i][1], bad[i][2]), false, 'case ' + i);
    }
    t.assert.strictEqual(env.d.list().length, 0);
    t.assert.strictEqual(warns(env).length, bad.length);
});

t.test('invalid holds are warned and ignored', function () {
    var env = setup();
    t.assert.strictEqual(env.d.hold('o', 'k', { label: 'no target' }), false);
    t.assert.strictEqual(env.d.hold('', 'k', { kind: env.K.Units }), false);
    t.assert.strictEqual(env.d.hold('o', 'k', null), false);
    t.assert.strictEqual(env.d.holds().length, 0);
    t.assert.strictEqual(warns(env).length, 3);
});

t.test('providers are pulled on every read and need no re-put', function () {
    var env = setup();
    var calls = 0;
    env.d.provide('adventures', function () {
        calls++;
        return {
            needs: [need(env, { key: 'run', priority: env.P.RunNow, items: 3 })],
            holds: [{ key: 'run', label: 'Run', kind: env.K.Units }]
        };
    });
    env.d.put('production', 'a', need(env));
    env.T += 10 * env.d.TTL_MS;
    env.d.put('production', 'a', need(env));
    var rows = env.d.list();
    t.assert.deepStrictEqual(keys(rows), ['adventures/run', 'production/a']);
    t.assert.strictEqual(rows[0].items, 3);
    t.assert.strictEqual(rows[0].key, 'run');
    t.assert.deepStrictEqual(keys(env.d.holds()), ['adventures/run']);
    t.assert.ok(calls >= 2);
    env.d.provide('adventures', null);
    t.assert.deepStrictEqual(keys(env.d.list()), ['production/a']);
    t.assert.strictEqual(env.d.holds().length, 0);
});

t.test('a throwing provider is logged once per owner and contributes nothing', function () {
    var env = setup();
    env.d.provide('broken', function () { throw new Error('boom'); });
    env.d.provide('good', function () { return { needs: [need(env, { key: 'g' })] }; });
    t.assert.deepStrictEqual(keys(env.d.list()), ['good/g']);
    t.assert.deepStrictEqual(keys(env.d.list()), ['good/g']);
    t.assert.strictEqual(env.d.holds().length, 0);
    var w = warns(env);
    t.assert.strictEqual(w.length, 1);
    t.assert.ok(w[0].args.join(' ').indexOf('broken') !== -1);
});

t.test('a provider entry that is invalid is skipped and logged once', function () {
    var env = setup();
    env.d.provide('adventures', function () {
        return { needs: [need(env, { key: 'ok' }), need(env, { key: 'bad', items: 0 }), need(env)] };
    });
    t.assert.deepStrictEqual(keys(env.d.list()), ['adventures/ok']);
    env.d.list();
    t.assert.strictEqual(warns(env).length, 1);
});

t.test('isHeld matches by kind and by item and skips the excepted owner', function () {
    var env = setup();
    env.d.hold('adventures', 'troops', { label: 'Run troops', kind: env.K.Units });
    env.d.hold('quests', 'book', { label: 'Quest book', item: 'Manuscript' });
    env.d.hold('production', 'own', { label: 'Own', kind: env.K.Buffs });

    var h = env.d.isHeld(env.K.Units, 'Recruit', 'production');
    t.assert.ok(h);
    t.assert.strictEqual(h.owner, 'adventures');
    t.assert.strictEqual(h.label, 'Run troops');

    h = env.d.isHeld(env.K.Books, 'Manuscript', 'production');
    t.assert.ok(h);
    t.assert.strictEqual(h.owner, 'quests');
    t.assert.strictEqual(env.d.isHeld(env.K.Books, 'Tome', 'production'), null);

    t.assert.strictEqual(env.d.isHeld(env.K.Units, 'Recruit', 'adventures'), null);
    t.assert.strictEqual(env.d.isHeld(env.K.Buffs, 'Fish', 'production'), null);
    t.assert.strictEqual(env.d.isHeld(env.K.Buffs, 'Fish', 'adventures').owner, 'production');
    t.assert.strictEqual(env.d.isHeld(env.K.Timed, undefined, 'production'), null,
        'a missing item never matches a kind-only hold by item');
});
