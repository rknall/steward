'use strict';

var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');

var assert = t.assert;

// A booted steward with the element fake, the dashboard helpers as h, and
// attempts captured instead of run.
function setup() {
    var H = harness.boot();
    var $ = jq.install(H);
    var S = H.Steward;
    var env = { H: H, S: S, $: $, h: S.kernel.ui.helpers, views: S.modules.production.views,
                attempts: [], writes: [] };
    S.core.actions.attempt = function (def, onDone) {
        env.attempts.push({ def: def, onDone: onDone });
        return true;
    };
    var write = S.kernel.settings.write;
    S.kernel.settings.write = function (id, value) {
        env.writes.push({ id: id, value: JSON.parse(JSON.stringify(value)) });
        return write.apply(S.kernel.settings, arguments);
    };
    env.$c = function () { return $('<div>'); };
    return env;
}

function finish(env, status, extra) {
    var a = env.attempts[env.attempts.length - 1];
    var r = { status: env.S.ActionResult[status], label: a.def.label, reason: '' };
    for (var k in (extra || {})) r[k] = extra[k];
    a.onDone(r);
}

function texts(env, $c, sel) {
    var out = [];
    $c.find(sel).each(function () { out.push(env.$(this).text()); });
    return out;
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function buttonNamed(env, $c, label) {
    var found = null;
    $c.find('button').each(function () {
        if (env.$(this).text() === label) found = env.$(this);
    });
    return found;
}

// ---- Queues -----------------------------------------------------------------

function queueRow(o) {
    var q = {
        type: 30, kind: 'ProductionTimed', label: 'Provision house', level: 5, count: 2,
        entries: [], remainingMs: 0, doneAt: null, cooldownMs: null, buff: null,
        source: function () { return 'Standing order'; }
    };
    for (var k in o) q[k] = o[k];
    if (q.entries && !q.lines) q.lines = lineList(q.entries);
    return q;
}

// One line per entry, as the model gives for entries that do not merge.
function lineList(entries) {
    var out = [];
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i], l = {};
        for (var k in e) l[k] = e[k];
        l['repeat'] = 1;
        l.total = e.amount;
        l.entries = [e];
        out.push(l);
    }
    return out;
}

function groupLine(item, amount, n, produced, remainingMs) {
    return { item: item, amount: amount, 'repeat': n, total: amount * n, produced: produced,
             remainingMs: remainingMs, finished: false, timeMs: 1000, bonus: 1,
             producedItems: null, entries: [] };
}

t.test('queues: Produced reads "p of a" for a workshop and a percent for books', function () {
    var env = setup();
    var $c = env.$c();
    env.views.queues($c, env.h, { queues: [
        queueRow({ entries: [{ item: 'Fish', amount: 5, produced: 3, remainingMs: 41000 }],
                   remainingMs: 41000, doneAt: Date.now() + 41000 }),
        queueRow({ type: 2, kind: env.S.ProductionKind.Books, label: 'Bookbinder', count: 1,
                   entries: [{ item: 'Tome', amount: 1, produced: 0, timeMs: 1000, bonus: 1,
                               remainingMs: 380, finished: false }] })
    ], rows: [] });
    var cells = texts(env, $c, 'td');
    assert.ok(cells.indexOf('3 of 5') >= 0, cells.join('|'));
    assert.ok(cells.indexOf('62 %') >= 0, cells.join('|'));
    var meta = texts(env, $c, '.steward-card-meta');
    assert.ok(/^1 entry · done \d\d:\d\d$/.test(meta[0]), meta[0]);
    var heads = texts(env, $c, '.steward-card-h');
    assert.ok(heads[0].indexOf('Provision house ×2 · level 5 · no buff') >= 0, heads[0]);
});

t.test('queues: a group shows "n x amount", "p of total" and the meta counts entries', function () {
    var env = setup();
    var $c = env.$c();
    var single = lineList([{ item: 'Fish', amount: 5, produced: 1, remainingMs: 1000 }])[0];
    env.views.queues($c, env.h, { queues: [queueRow({
        entries: [{}, {}, {}, {}],
        lines: [single, groupLine('Fish', 3, 3, 4, 9000)]
    })], rows: [] });
    var cells = texts(env, $c, 'td');
    assert.ok(cells.indexOf('3 × 3') >= 0, cells.join('|'));
    assert.ok(cells.indexOf('5') >= 0 && cells.join('|').indexOf('1 ×') < 0, cells.join('|'));
    assert.ok(cells.indexOf('4 of 9') >= 0, cells.join('|'));
    assert.ok(/^4 entries/.test(texts(env, $c, '.steward-card-meta')[0]));
});

t.test('queues: Done at accumulates per line and an unknown time dashes the rest', function () {
    var env = setup();
    var $c = env.$c();
    env.views.queues($c, env.h, { queues: [queueRow({
        entries: [{}, {}, {}],
        lines: [groupLine('Fish', 2, 2, 0, 60000), groupLine('Fish', 3, 1, 0, null),
                groupLine('Bread', 1, 1, 0, 1000)]
    })], rows: [] });
    var rows = $c.find('tr');
    var last = function (i) { var td = rows.eq(i).find('td'); return td.eq(4).text(); };
    assert.ok(/^\d\d:\d\d$/.test(last(1)), last(1));
    assert.strictEqual(last(2), '\u2013');
    assert.strictEqual(last(3), '\u2013');
});

t.test('queues: entries without lines read as unreadable', function () {
    var env = setup();
    var $c = env.$c();
    var q = queueRow({ entries: [{ item: 'Fish', amount: 1 }] });
    q.lines = null;
    env.views.queues($c, env.h, { queues: [q], rows: [] });
    assert.strictEqual($c.find('table').length, 0);
    assert.ok($c.text().indexOf('Queue unreadable.') >= 0);
});

t.test('queues: a running buff shows its name and end time', function () {
    var env = setup();
    var $c = env.$c();
    env.views.queues($c, env.h, { queues: [queueRow({
        entries: [{ item: 'Fish', amount: 5, produced: 0, remainingMs: 1000 }],
        buff: { name: 'GrilledSteak', remainingMs: 3600000 }
    })], rows: [] });
    var head = texts(env, $c, '.steward-card-h')[0];
    assert.ok(/· buff GrilledSteak until \d\d:\d\d/.test(head), head);
});

t.test('queues: a Cooldown type shows the cooldown end instead of a table', function () {
    var env = setup();
    var $c = env.$c();
    env.views.queues($c, env.h, { queues: [queueRow({ kind: env.S.ProductionKind.Cooldown, entries: null,
                                            cooldownMs: 600000 })], rows: [] });
    assert.strictEqual($c.find('table').length, 0);
    assert.ok(/cooldown \d\d:\d\d/.test($c.text()), $c.text());
});

t.test('queues: an empty queue shows the standing order reason from the given rows', function () {
    var env = setup();
    var S = env.S;
    // The view must not reach for the planner's last pass any more.
    S.modules.production.lastPass = function () { throw new Error('lastPass must not be read'); };
    var rows = [{ owner: 'production', key: 'Provision house', type: 30, item: 'Fish',
                  status: S.DemandStatus.Short, reserved: true,
                  shortfall: { name: 'Bread', need: 10, have: 20 } }];
    var $c = env.$c();
    env.views.queues($c, env.h, { queues: [queueRow({ entries: [] })], rows: rows });
    assert.strictEqual($c.find('table').length, 0);
    assert.ok($c.text().indexOf('Queue empty. Standing order Fish: short of Bread (reserved).') >= 0, $c.text());

    $c = env.$c();
    env.views.queues($c, env.h, { queues: [queueRow({ entries: [] })], rows: [] });
    assert.ok($c.text().indexOf('Queue empty. No standing order.') >= 0, $c.text());

    $c = env.$c();
    env.views.queues($c, env.h, { queues: [queueRow({ entries: [] })] });
    assert.ok($c.text().indexOf('Queue empty. No standing order.') >= 0, $c.text());
});

// ---- Demand -----------------------------------------------------------------

t.test('demand: each DemandStatus has its status words', function () {
    var env = setup();
    var S = env.S;
    var D = S.DemandStatus;
    S.core.production.demand.hold('adventures', 'troops',
        { label: 'Storm Recovery (troops)', kind: S.ProductionKind.Units });
    S.core.production.profile = function () { return { kind: S.ProductionKind.Units }; };
    var cases = [
        [{ status: D.Covered }, 'covered'],
        [{ status: D.Waiting }, 'waiting for production'],
        [{ status: D.Short, shortfall: { name: 'Bronze', need: 200, have: 20 } }, 'short of 180 Bronze'],
        [{ status: D.Short, reserved: true, shortfall: { name: 'Fish', need: 30, have: 30 } }, 'short of Fish (reserved)'],
        [{ status: D.Held, owner: 'production', item: 'Recruit', type: 0 }, 'held by Storm Recovery (troops)'],
        [{ status: D.QueueFull }, 'queue full'],
        [{ status: D.NotOrderable }, 'not orderable'],
        [{ status: D.Unreadable }, 'unreadable'],
        [{ status: D.Order }, 'ordering'],
        [{ status: D.Deferred }, 'next pass']
    ];
    var seen = {};
    for (var i = 0; i < cases.length; i++) {
        seen[cases[i][0].status] = true;
        assert.strictEqual(env.views.statusOf(cases[i][0]).text, cases[i][1]);
    }
    for (var k in D) assert.ok(seen[D[k]], 'no case for ' + k);

    var rows = cases.map(function (c, n) {
        var r = { owner: 'production', key: 'K' + n, label: 'Standing order: K' + n, type: 0, item: 'Recruit',
                  need: 5, stock: 1, queued: 2, priority: S.ProductionPriority.Standing };
        for (var f in c[0]) r[f] = c[0][f];
        return r;
    });
    var $c = env.$c();
    env.views.demand($c, env.h, { rows: rows, reservations: [] });
    var cells = texts(env, $c, 'td');
    for (var j = 0; j < cases.length; j++) assert.ok(cells.indexOf(cases[j][1]) >= 0, cases[j][1]);
});

t.test('demand: priority labels and the priority order come from the enum', function () {
    var env = setup();
    var S = env.S;
    var P = S.ProductionPriority;
    assert.strictEqual(env.views.priorityLabel(P.RunNow), 'Run now');
    assert.strictEqual(env.views.priorityLabel(P.RunAhead), 'Run ahead');
    assert.strictEqual(env.views.priorityLabel(P.Quest), 'Quest');
    assert.strictEqual(env.views.priorityLabel(P.Standing), 'Standing');
    assert.deepStrictEqual(plain(env.views.priorityOrder()),['Run now', 'Run ahead', 'Quest', 'Standing']);

    var $c = env.$c();
    env.views.demand($c, env.h, {
        rows: [],
        reservations: [{ name: 'Fish', reserved: 30, stock: 30, forLabel: 'Trip 2', priority: P.RunNow, free: 0 },
                       { name: 'Bread', reserved: 30, stock: 412, forLabel: 'Trip 2', priority: P.RunNow, free: 382 }]
    });
    var text = $c.text();
    assert.ok(text.indexOf('Priority order: Run now, Run ahead, Quest, Standing') >= 0, text);
    assert.ok(text.indexOf('Free for standing orders after reservations: Fish 0 · Bread 382') >= 0, text);
    assert.ok(texts(env, $c, 'td').indexOf('Run now') >= 0);
    assert.ok(text.indexOf('held back from Standing orders') >= 0);
});

t.test('demand: unknown stock shows ?, not applicable shows the dash, zero shows 0', function () {
    var env = setup();
    var S = env.S;
    function row(k, f) {
        var r = { owner: 'production', key: k, label: 'Row ' + k, item: 'Fish', need: 7, queued: 0, status: S.DemandStatus.Waiting };
        for (var n in f) r[n] = f[n];
        return r;
    }
    function stockCell(f) {
        var $c = env.$c();
        env.views.demand($c, env.h, { rows: [row('a', f)], reservations: [] });
        return texts(env, $c, 'td')[3];
    }
    assert.strictEqual(stockCell({ stock: null, stockUnknown: true }), '?');
    assert.strictEqual(stockCell({ stock: null }), '–');
    assert.strictEqual(stockCell({ stock: 0 }), '0');

    var $r = env.$c();
    env.views.demand($r, env.h, { rows: [], reservations: [{ name: 'Fish', reserved: 30, stock: null, forLabel: 'Trip 2', priority: S.ProductionPriority.RunNow, free: null }] });
    assert.ok(texts(env, $r, 'td').indexOf('?') >= 0, $r.text());
    assert.ok($r.text().indexOf('Fish ?') >= 0, $r.text());
});

t.test('demand: the Runs chip shows only other owners', function () {
    var env = setup();
    var S = env.S;
    var rows = [
        { owner: 'adventures', key: 'a', label: 'Adventure: Trip', item: 'Fish', status: S.DemandStatus.Waiting },
        { owner: 'production', key: 'b', label: 'Standing order: Barracks', item: 'Recruit', status: S.DemandStatus.Covered }
    ];
    var $c = env.$c();
    env.views.demand($c, env.h, { rows: rows, reservations: [] });
    buttonNamed(env, $c, 'Runs').trigger('click');
    var cells = texts(env, $c, 'td');
    assert.ok(cells.indexOf('Adventure: Trip') >= 0);
    assert.ok(cells.indexOf('Standing order: Barracks') < 0);
    buttonNamed(env, $c, 'All').trigger('click');
});

// ---- Bookbinder and on/off ----------------------------------------------------

function bookData(finished) {
    return {
        books: { level: 4, grid: 14207, finished: finished, standing: { item: 'Tome', amount: 1 },
                 head: { item: 'Tome', amount: 1, timeMs: 1000, bonus: 1,
                         remainingMs: finished ? 0 : 380, finished: finished },
                 info: { costs: [{ name: 'Paper', amount: 1200 }] } },
        onOff: [],
        counts: { stopped: 0, miningOwned: 0 },
        recent: []
    };
}

t.test('books: Complete is enabled only when the head book is finished', function () {
    var env = setup();
    var $c = env.$c();
    env.views.books($c, env.h, bookData(false));
    assert.strictEqual(buttonNamed(env, $c, 'Complete').attr('disabled'), 'disabled');
    buttonNamed(env, $c, 'Complete').trigger('click');
    assert.strictEqual(env.attempts.length, 0);

    $c = env.$c();
    env.views.books($c, env.h, bookData(true));
    assert.ok(!buttonNamed(env, $c, 'Complete').attr('disabled'));
    assert.ok($c.text().indexOf('Tome · standing order keep 1') >= 0, $c.text());
});

t.test('books: Complete runs attempt(complete(type)) once per click and notes the result', function () {
    var env = setup();
    var S = env.S;
    var types = [];
    var complete = S.core.production.complete;
    S.core.production.complete = function (type) { types.push(type); return complete(type); };
    var $c = env.$c();
    env.views.books($c, env.h, bookData(true));
    var $b = buttonNamed(env, $c, 'Complete');
    $b.trigger('click');
    $b.trigger('click');
    assert.strictEqual(env.attempts.length, 1);
    assert.deepStrictEqual(plain(types), [S.core.production.QUEUE_BOOKS]);
    assert.strictEqual(env.attempts[0].def.label, 'complete queue ' + S.core.production.QUEUE_BOOKS);
    finish(env, 'Verified');
    var r = S.modules.production.recent()[0];
    assert.strictEqual(r.kind, 'Complete');
    assert.strictEqual(r.item, 'Tome');
    assert.strictEqual(r.text, 'completed');
});

t.test('books: Last completed reads the latest Complete in recent', function () {
    var env = setup();
    var data = bookData(false);
    data.recent = [{ at: new Date(2024, 0, 1, 11, 12).getTime(), kind: 'Complete', name: 'queue 2',
                     item: 'Manual', status: env.S.ActionResult.Verified, text: 'completed' }];
    var $c = env.$c();
    env.views.books($c, env.h, data);
    assert.ok($c.text().indexOf('Manual at 11:12 verified') >= 0, $c.text());
});

t.test('books: the auto-complete toggle writes only { bookComplete }', function () {
    var env = setup();
    var $c = env.$c();
    env.views.books($c, env.h, bookData(false));
    var $in = $c.find('input');
    assert.strictEqual($in.length, 1);
    $in.prop('checked', true);
    $in.trigger('change');
    assert.deepStrictEqual(env.writes, [{ id: 'production', value: { bookComplete: true } }]);
    assert.strictEqual(env.attempts.length, 0);
});

t.test('on/off: card head, Owner column, Resume only for steward rows', function () {
    var env = setup();
    var S = env.S;
    var data = bookData(false);
    data.onOff = [
        { name: 'Toolmaker', label: 'Toolmaker', grid: 9311, state: 0, active: false, mining: false },
        { name: 'CopperMine', label: 'Copper mine', grid: 15102, state: 0, active: false, mining: true }
    ];
    data.counts = { stopped: 2, miningOwned: 1 };
    var $c = env.$c();
    env.views.books($c, env.h, data);
    assert.ok(texts(env, $c, '.steward-card-meta').indexOf('2 stopped · 1 mining-owned') >= 0);
    var heads = texts(env, $c, 'th');
    assert.ok(heads.indexOf('Owner') >= 0);
    assert.ok(heads.indexOf('Turned off by') < 0);
    assert.ok($c.text().indexOf('owned by Mining') >= 0);
    var resumes = 0;
    $c.find('button').each(function () { if (env.$(this).text() === 'Resume') resumes++; });
    assert.strictEqual(resumes, 1);

    var calls = [];
    var setActive = S.core.production.setActive;
    S.core.production.setActive = function (g, n, on) { calls.push([g, n, on]); return setActive(g, n, on); };
    buttonNamed(env, $c, 'Resume').trigger('click');
    assert.deepStrictEqual(plain(calls),[[9311, 'Toolmaker', true]]);
    assert.strictEqual(env.attempts.length, 1);
    finish(env, 'Failed', { reason: 'timeout' });
    var r = S.modules.production.recent()[0];
    assert.strictEqual(r.kind, 'Toggle');
    assert.strictEqual(r.text, 'failed: timeout');
});

t.test('on/off: without counts the card has no meta and onOffCounts is never called', function () {
    var env = setup();
    var data = bookData(false);
    data.onOff = [{ name: 'Toolmaker', label: 'Toolmaker', grid: 9311, state: 0, active: false, mining: false }];
    delete data.counts;
    env.S.modules.production.model.onOffCounts = function () { throw new Error('onOffCounts must not be read'); };
    var $c = env.$c();
    env.views.books($c, env.h, data);
    var metas = texts(env, $c, '.steward-card-meta');
    for (var i = 0; i < metas.length; i++) assert.ok(metas[i].indexOf('stopped') < 0, metas[i]);
    assert.ok($c.text().indexOf('Toolmaker') >= 0);
});

// ---- Recent -----------------------------------------------------------------

t.test('recent: the Failed chip counts failed entries and colours results', function () {
    var env = setup();
    var list = [
        { at: 3, kind: 'Order', name: 'Weaponsmith', item: 'Sword', status: env.S.ActionResult.Verified, detail: 'queued 10 -> 35', text: 'Order verified: queued 10 -> 35' },
        { at: 2, kind: 'Order', name: 'Pumpkin', item: 'Pie', status: env.S.ActionResult.Failed, detail: '', text: 'failed: not seen' },
        { at: 1, kind: 'Complete', name: 'queue 2', item: 'Manual', status: env.S.ActionResult.Failed, detail: '', text: 'failed: timeout' },
        { at: 0, kind: 'Buff', name: 'Provision', item: 'Steak', status: env.S.ActionResult.Refused, detail: '', text: 'refused: no stock' }
    ];
    var $c = env.$c();
    env.views.recent($c, env.h, list);
    assert.ok(buttonNamed(env, $c, 'Failed 2'), 'Failed chip with count');
    assert.strictEqual($c.find('td.steward-ok').length, 1);
    assert.strictEqual($c.find('td.steward-bad').length, 3);
    buttonNamed(env, $c, 'Failed 2').trigger('click');
    assert.strictEqual($c.find('tbody tr').length, 2);
    buttonNamed(env, $c, 'All').trigger('click');
    assert.strictEqual($c.find('tbody tr').length, 4);
});

// ---- Completion, notes and hold wording -------------------------------------

t.test('books: Complete calls the module completeNow with (2, item)', function () {
    var env = setup();
    var calls = [];
    env.S.modules.production.completeNow = function (type, item) { calls.push([type, item]); return true; };
    var $c = env.$c();
    env.views.books($c, env.h, bookData(true));
    buttonNamed(env, $c, 'Complete').trigger('click');
    assert.deepStrictEqual(plain(calls), [[2, 'Tome']]);
});

t.test('books: the card is a table and has no key-value list', function () {
    var env = setup();
    var $c = env.$c();
    env.views.books($c, env.h, bookData(true));
    assert.ok($c.find('table.steward-tbl').length >= 1);
    assert.strictEqual($c.find('.stw-kv').length, 0);
});

t.test('recent: classification reads status, not the text', function () {
    var env = setup();
    var R = env.S.ActionResult;
    var list = [
        { at: 2, kind: 'Order', name: 'X', item: 'Sword', status: R.Verified, detail: '', text: 'failed: x' },
        { at: 1, kind: 'Skip', name: 'Y', item: 'Pie', status: null, detail: 'held', text: '' }
    ];
    var $c = env.$c();
    env.views.recent($c, env.h, list);
    assert.ok(buttonNamed(env, $c, 'Failed 0'), 'Failed chip counts only Failed status');
    assert.strictEqual($c.find('td.steward-bad').length, 0);
    var all = $c.text();
    assert.ok(all.indexOf('verified') >= 0 && all.indexOf('skipped') >= 0, all);
    assert.ok(all.indexOf('standing order: held') >= 0, all);
});

t.test('demand: a held row words its hold through the module holdLabel', function () {
    var env = setup();
    var S = env.S;
    var D = S.DemandStatus;
    S.modules.production.holdLabel = function () { return 'an unseen order'; };
    assert.strictEqual(env.views.statusOf({ status: D.Held }).text, 'held by an unseen order');
    S.modules.production.holdLabel = function () { return null; };
    assert.strictEqual(env.views.statusOf({ status: D.Held }).text, 'held');
});
