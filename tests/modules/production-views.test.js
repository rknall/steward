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
        source: function () { return 'Automatic queue'; }, producing: true, auto: null
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

t.test('queues: an empty queue names its automatic queue, or says there is none', function () {
    var env = setup();
    var $c = env.$c();
    env.views.queues($c, env.h, { queues: [queueRow({ entries: [], producing: false,
        auto: { name: 'Provision house', item: 'CupidsArrow', label: "Cupid's Arrow" } })] });
    assert.strictEqual($c.find('table').length, 0);
    assert.ok($c.text().indexOf("Queue empty. Automatic queue Cupid's Arrow: orders when the building is idle.") >= 0, $c.text());

    $c = env.$c();
    env.views.queues($c, env.h, { queues: [queueRow({ entries: [], producing: false, auto: null })] });
    assert.ok($c.text().indexOf('Queue empty. No automatic queue.') >= 0, $c.text());
});

t.test('queues: the Source cell shows the row source', function () {
    var env = setup();
    var $c = env.$c();
    env.views.queues($c, env.h, { queues: [queueRow({
        entries: [{ item: 'Fish', amount: 5, produced: 0, remainingMs: 1000 }],
        source: function () { return 'Automatic queue'; }
    })] });
    assert.ok(texts(env, $c, 'td').indexOf('Automatic queue') >= 0);
});

t.test('queues: chips show Producing N and All M, defaulting to All', function () {
    var env = setup();
    var $c = env.$c();
    env.views.queues($c, env.h, { queues: [
        queueRow({ label: 'A', producing: true, entries: [{ item: 'Fish', amount: 1, produced: 0, remainingMs: 1000 }] }),
        queueRow({ label: 'B', producing: false, entries: [], auto: null }),
        queueRow({ label: 'C', producing: false, entries: null })
    ] });
    assert.ok(buttonNamed(env, $c, 'Producing 1'));
    assert.ok(buttonNamed(env, $c, 'All 3'));
    assert.ok(env.$(buttonNamed(env, $c, 'All 3')).hasClass('active'));
    assert.strictEqual($c.find('.steward-card').length, 3);
});

t.test('queues: Producing hides empty and unreadable cards and redraws from the same data', function () {
    var env = setup();
    var $c = env.$c();
    var data = { queues: [
        queueRow({ label: 'A', producing: true, entries: [{ item: 'Fish', amount: 1, produced: 0, remainingMs: 1000 }] }),
        queueRow({ label: 'B', producing: false, entries: [], auto: null }),
        queueRow({ label: 'C', producing: false, entries: null })
    ] };
    env.views.queues($c, env.h, data);
    buttonNamed(env, $c, 'Producing 1').trigger('click');
    assert.strictEqual($c.find('.steward-card').length, 1);
    assert.ok($c.text().indexOf('Queue empty.') < 0);
    buttonNamed(env, $c, 'All 3').trigger('click');
    assert.strictEqual($c.find('.steward-card').length, 3);
});

t.test('queues: with nothing producing the Producing chip shows the empty line', function () {
    var env = setup();
    var $c = env.$c();
    env.views.queues($c, env.h, { queues: [queueRow({ producing: false, entries: [], auto: null })] });
    buttonNamed(env, $c, 'Producing 0').trigger('click');
    assert.strictEqual($c.find('.steward-card').length, 0);
    assert.ok($c.text().indexOf('Nothing is in production right now.') >= 0, $c.text());
});

t.test('queues: no rows shows the empty card', function () {
    var env = setup();
    var $c = env.$c();
    env.views.queues($c, env.h, { queues: [] });
    assert.ok($c.text().indexOf('No production queues') >= 0);
});

t.test('views exposes only queues', function () {
    var env = setup();
    assert.deepStrictEqual(Object.keys(env.views), ['queues']);
});
