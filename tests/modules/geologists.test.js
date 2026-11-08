'use strict';

var t = require('../runner');
var harness = require('../harness');
var jq = require('../stubs/jq');
var jq = require('../stubs/jq');

// Settings helper: only the named deposit is enabled. Others stay defined
// (defaults' enabled:true would otherwise leak through the deep-merge in
// modules/geologists/ui.js readSettings).
function onlyEnable(depositName, max) {
    var names = ['Stone', 'BronzeOre', 'Marble', 'IronOre', 'GoldOre',
                 'Coal', 'Granite', 'TitaniumOre', 'Salpeter'];
    var deposits = {};
    for (var i = 0; i < names.length; i++) {
        deposits[names[i]] = (names[i] === depositName)
            ? { enabled: true,  max: max }
            : { enabled: false, max: 0 };
    }
    return { enabled: true, dispatchDelay: 0, deposits: deposits };
}

t.test('plan enqueues one dispatch per wanted slot when an idle geologist exists', function () {
    var H = harness.boot();
    var z = H.zone.zone()
        .deposits('IronOre', [])  // 0 on map, max=1 → wanted=1
        .specialists([
            H.specs.geologist({ name: 'irongut', uid: 'g1' })
        ])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    H.settings.write('geologists', onlyEnable('IronOre', 1));

    var mod = H.module('geologists');
    t.assert.ok(mod, 'geologists module should be registered');
    mod.plan({ zone: { isHome: true } });

    var q = H.queued();
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].name, 'geologists.dispatch');
    t.assert.strictEqual(q[0].params[2], 'IronOre');
});

t.test('plan enqueues nothing when no idle geologists are available', function () {
    var H = harness.boot();
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists([])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    H.settings.write('geologists', onlyEnable('IronOre', 1));

    H.module('geologists').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('plan enqueues nothing when wanted slots are already filled (deposits on map)', function () {
    var H = harness.boot();
    var existing = H.zone.deposit({ name: 'IronOre', grid: 5 });
    var z = H.zone.zone()
        .deposits('IronOre', [existing])
        .specialists([H.specs.geologist({ name: 'irongut', uid: 'g1' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    H.settings.write('geologists', onlyEnable('IronOre', 1));   // 1 on map, max 1 → wanted 0

    H.module('geologists').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

// "Ghost" specialist: a real geologist whose members read undefined for a
// moment on the JS side of the AIR bridge (GetType still answers). The reader
// leaves such an entry out and counts it, and the plan treats a read that
// dropped anything as unreadable: a dropped busy geologist would shorten the
// busy count and over-dispatch the healthy idle ones.
function ghostGeologist(H, uid) {
    var g = H.specs.geologist({ name: 'ghost', uid: uid || 'ghost1' });
    H.specs.ghost(g);
    return g;
}

function planWith(H, list, max) {
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists(list)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('geologists', onlyEnable('IronOre', max));
    H.module('geologists').plan({ zone: { isHome: true } });
}

// The registered dispatch queue action, captured while the module boots.
function dispatchAction(H) {
    var q = H.Steward.kernel.queue;
    var orig = q.action;
    var fn = null;
    q.action = function (name, f) {
        if (name === 'geologists.dispatch') fn = f;
        return orig.apply(q, arguments);
    };
    H.module('geologists').boot();
    q.action = orig;
    return fn;
}

function geoWarns(H) {
    return H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === 'geologists';
    });
}

t.test('plan queues nothing when a ghost is in the list next to a healthy idle geologist', function () {
    var H = harness.boot();
    planWith(H, [ghostGeologist(H), H.specs.geologist({ name: 'irongut', uid: 'g1' })], 1);

    t.assert.strictEqual(H.queued().length, 0);
    t.assert.strictEqual(H.Steward.core.specialists.dropped(), 1);
    t.assert.strictEqual(geoWarns(H).length, 0);
});

t.test('plan queues the healthy geologist again once the ghost is gone', function () {
    var H = harness.boot();
    var ghost = ghostGeologist(H);
    var real = H.specs.geologist({ name: 'irongut', uid: 'g1' });
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists([ghost, real])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('geologists', onlyEnable('IronOre', 1));
    var mod = H.module('geologists');
    mod.plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);

    z.specialists([real]);
    mod.plan({ zone: { isHome: true } });
    var q = H.queued();
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].params[0], 'g1');
});

t.test('plan with only ghost geologists queues nothing and warns about nothing', function () {
    var H = harness.boot();
    planWith(H, [ghostGeologist(H, 'a'), ghostGeologist(H, 'b'), ghostGeologist(H, 'c')], 5);

    t.assert.strictEqual(H.queued().length, 0);
    t.assert.strictEqual(geoWarns(H).length, 0);
    var perEntry = H.logs().filter(function (l) {
        return /no uniqueID|ghost/i.test(String(l.args && l.args[0]));
    });
    t.assert.strictEqual(perEntry.length, 0);
});

t.test('plan queues nothing when a busy geologist turns into a ghost inside the pass', function () {
    var H = harness.boot();
    var idle = H.specs.geologist({ name: 'irongut', uid: 'g1' });
    // The busy geologist is counted before the idle one's name is read, so the
    // flip lands after the counts and the pick, and only the last list check
    // can still stop the dispatch. Its sub type is not the deposit's, so the
    // wanted slot stays open.
    var busy = H.specs.geologist({ name: 'busy', uid: 'g2', task: H.specs.task(1, 999, 1000) });
    var flipped = false;
    ['GetName_string', 'GetName', 'getName'].forEach(function (member) {
        var orig = idle[member];
        idle[member] = function () {
            var v = orig.apply(this, arguments);
            if (!flipped) { flipped = true; H.specs.ghost(busy); }
            return v;
        };
    });
    planWith(H, [idle, busy], 1);

    t.assert.strictEqual(flipped, true, 'the flip should have happened during the pass');
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('plan still queues when nobody flips during the pass (control for the flip test)', function () {
    var H = harness.boot();
    var idle = H.specs.geologist({ name: 'irongut', uid: 'g1' });
    var busy = H.specs.geologist({ name: 'busy', uid: 'g2', task: H.specs.task(1, 999, 1000) });
    planWith(H, [idle, busy], 1);

    t.assert.strictEqual(H.queued().length, 1);
    t.assert.strictEqual(H.queued()[0].params[0], 'g1');
});

t.test('rank skips a geologist whose uid key reads null', function () {
    var H = harness.boot();
    var c = H.Steward.core.specialists;
    var bad = H.specs.geologist({ name: 'bad', uid: 'x' });
    bad.GetUniqueID = function () { return { toKeyString: function () { return null; } }; };
    var good = H.specs.geologist({ name: 'good', uid: 'g1' });
    var rows = c.rankGeologistsForDeposit('IronOre', { from: [bad, good] });
    t.assert.strictEqual(rows.length, 1);
    t.assert.strictEqual(rows[0].uid, 'g1');
    rows = c.rankGeologistsForDeposit('IronOre', { from: [bad], exclude: { g1: true } });
    t.assert.strictEqual(rows.length, 0);
});

t.test('dispatch on a dropped read that lacks its key is silent and sends nothing', function () {
    var H = harness.boot();
    var c = H.Steward.core.specialists;
    var sends = [];
    c.send = function () { sends.push(arguments); return true; };
    var z = H.zone.zone()
        .specialists([ghostGeologist(H), H.specs.geologist({ name: 'other', uid: 'g2' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var fire = dispatchAction(H);
    t.assert.strictEqual(typeof fire, 'function');
    H.clearLogs();

    fire(['g1', 'irongut', 'IronOre']);

    t.assert.strictEqual(sends.length, 0);
    t.assert.strictEqual(geoWarns(H).length, 0);
    t.assert.strictEqual(H.logs().filter(function (l) { return l.level === 'error'; }).length, 0);
});

t.test('dispatch on a clean read sends to the re-found geologist', function () {
    var H = harness.boot();
    var c = H.Steward.core.specialists;
    var sends = [];
    c.send = function (spec) { sends.push(spec); return true; };
    var g1 = H.specs.geologist({ name: 'irongut', uid: 'g1' });
    var z = H.zone.zone()
        .specialists([H.specs.geologist({ name: 'other', uid: 'g2' }), g1])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var fire = dispatchAction(H);

    fire(['g1', 'irongut', 'IronOre']);

    t.assert.strictEqual(sends.length, 1);
    t.assert.strictEqual(sends[0], g1);
    t.assert.strictEqual(geoWarns(H).length, 0);
});

t.test('dispatch of a key that is really absent on a clean read still warns', function () {
    var H = harness.boot();
    var c = H.Steward.core.specialists;
    var sends = [];
    c.send = function () { sends.push(arguments); return true; };
    var z = H.zone.zone()
        .specialists([H.specs.geologist({ name: 'other', uid: 'g2' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    var fire = dispatchAction(H);

    fire(['g1', 'irongut', 'IronOre']);

    t.assert.strictEqual(sends.length, 0);
    var warns = geoWarns(H);
    t.assert.strictEqual(warns.length, 1);
    t.assert.ok(/could not re-find/.test(String(warns[0].args[0])), String(warns[0].args[0]));
});

t.test('plan dispatches nothing for a type whose byType fails', function () {
    var H = harness.boot();
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists([H.specs.geologist({ name: 'irongut', uid: 'g1' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    z.zone.mStreetDataMap.getDeposits_vectorByType = function () {
        throw new Error('[undefined] is not a function');
    };

    H.settings.write('geologists', onlyEnable('IronOre', 3));
    H.module('geologists').plan({ zone: { isHome: true } });

    t.assert.strictEqual(H.queued().length, 0);
    var warns = H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === 'geologists';
    });
    t.assert.ok(warns.length >= 1, 'a geologists warning should be logged');
});

var TAGGED = '<b>A &amp; B</b>';

function planTagged(H, overrides, max) {
    var cfg = onlyEnable('IronOre', max || 1);
    cfg.overrides = overrides;
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists([H.specs.geologist({ name: TAGGED, uid: 'g1' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('geologists', cfg);
    H.module('geologists').plan({ zone: { isHome: true } });
    return H.queued();
}

t.test('plan applies an override keyed by the clean, entity or raw name', function () {
    ['A & B', 'A &amp; B', TAGGED].forEach(function (key) {
        var other = {};
        other[key] = ['Stone'];
        var H = harness.boot();
        t.assert.strictEqual(planTagged(H, other).length, 0, key);

        var allowed = {};
        allowed[key] = ['IronOre'];
        H = harness.boot();
        t.assert.strictEqual(planTagged(H, allowed).length, 1, key);
    });
});

t.test('plan queues the clean name as the dispatch label', function () {
    var H = harness.boot();
    var q = planTagged(H, {});
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].params[1], 'A & B');
});

// The Live state card (render) or the settings column (side) of the module,
// built with the real helpers over the element-tree jq fake.
function build(H, part) {
    jq.install(H);
    var $el = H.ctx.$('<div>');
    H.Steward.modules.geologists[part]($el, H.Steward.kernel.ui.helpers);
    return $el;
}

function rowsOf($el) { return $el.find('tbody tr'); }

// The table row whose first cell carries the raw `name` as its tooltip.
function rowFor($el, name) {
    var $rows = rowsOf($el);
    for (var i = 0; i < $rows.length; i++) {
        if ($rows.eq(i).find('td').eq(0).attr('title') === name) return $rows.eq(i);
    }
    return null;
}

function mountList(H, list) {
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists(list)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
}

// A geologist that is busy or idle from the start.
function geoWith(H, name, uid, busy) {
    var s = H.specs.geologist({ name: name, uid: uid });
    var task = busy ? H.specs.task(1, 1, 1000) : null;
    s.GetTask = function () { return task; };
    s.IsInUse = function () { return !!task; };
    return s;
}

t.test('the name cell escapes the decoded name and keeps it raw in the tooltip', function () {
    var H = harness.boot();
    mountList(H, [H.specs.geologist({ name: 'A &amp; &lt;B&gt;', uid: 'g1' })]);
    var $name = rowsOf(build(H, 'render')).eq(0).find('td').eq(0);
    t.assert.ok($name.hasClass('steward-who'));
    t.assert.strictEqual($name.html(), '<span>A &amp; &lt;B&gt;</span>');
    t.assert.strictEqual($name.attr('title'), 'A & <B>');
});

t.test('the chips carry the filter counts and a click narrows the table', function () {
    var H = harness.boot();
    mountList(H, [geoWith(H, 'bee', 'g1', true), geoWith(H, 'ida', 'g2', false), geoWith(H, 'ivo', 'g3', false)]);
    var $main = build(H, 'render');
    var $chips = $main.find('.steward-chip');
    t.assert.deepStrictEqual([0, 1, 2, 3].map(function (i) { return $chips.eq(i).text(); }),
        ['All 3', 'Busy 1', 'Idle 2', 'With a trait 0']);
    t.assert.strictEqual(rowsOf($main).length, 3);
    t.assert.strictEqual($main.find('.steward-card-meta').eq(0).text(), '3 geologists · 1 busy');

    $chips.eq(2).trigger('click');
    t.assert.strictEqual(rowsOf($main).length, 2);
    $main.find('.steward-chip').eq(3).trigger('click');
    t.assert.strictEqual(rowsOf($main).eq(0).find('td').eq(0).text(), 'No geologist has a trait.');
});

t.test('a busy geologist with remaining 0 or null shows a plain Busy, a positive time shows it', function () {
    [0, null, 90 * 60000].forEach(function (rem) {
        var H = harness.boot();
        mountList(H, [geoWith(H, 'bee', 'g1', true)]);
        H.Steward.core.specialists.orders.remaining = function () { return rem; };
        var text = rowsOf(build(H, 'render')).eq(0).find('.steward-b-busy').text();
        if (rem) t.assert.ok(/^Busy .+/.test(text), String(text));
        else t.assert.strictEqual(text, 'Busy', String(rem));
    });
});

t.test('deposit names go through the locale and keep the raw name as the tooltip', function () {
    var H = harness.boot();
    H.Steward.core.locale.res = function (name) { return 'Res ' + name; };
    var $first = rowsOf(build(H, 'side')).eq(0).find('td').eq(0);
    var raw = $first.attr('title');
    t.assert.ok(raw && raw.length > 0);
    t.assert.strictEqual($first.text(), 'Res ' + raw);
});

t.test('switching a deposit on keeps its stored max, and a missing row starts from the defaults', function () {
    var H = harness.boot();
    H.settings.write('geologists', { deposits: { IronOre: { enabled: false, max: 7 } } });
    rowFor(build(H, 'side'), 'IronOre').find('input').eq(0).prop('checked', true).trigger('change');
    var kept = H.Steward.kernel.ui.helpers.get('geologists', 'deposits.IronOre');
    t.assert.strictEqual(kept.enabled, true);
    t.assert.strictEqual(kept.max, 7);

    var fresh = harness.boot();
    fresh.settings.write('geologists', { deposits: {} });
    var defaults = fresh.Steward.modules.geologists.readSettings().deposits.IronOre;
    rowFor(build(fresh, 'side'), 'IronOre').find('input').eq(0).prop('checked', !defaults.enabled).trigger('change');
    var row = fresh.Steward.kernel.ui.helpers.get('geologists', 'deposits.IronOre');
    t.assert.strictEqual(row.max, defaults.max);
    t.assert.strictEqual(row.enabled, !defaults.enabled);
});

t.test('tiles count the geologists and the searched deposit types', function () {
    var H = harness.boot();
    mountList(H, [geoWith(H, 'bee', 'g1', true), geoWith(H, 'ida', 'g2', false)]);
    H.settings.write('geologists', onlyEnable('IronOre', 2));
    jq.install(H);
    var tiles = H.Steward.modules.geologists.tiles(H.Steward.kernel.ui.helpers);
    t.assert.strictEqual(tiles.length, 1);
    t.assert.strictEqual(tiles[0].title, 'Geologists');
    t.assert.strictEqual(tiles[0].lines[0], '2 geologists · 1 busy · 1 idle');
    t.assert.strictEqual(tiles[0].lines[1], '1 deposit type searched, 1 below max');

    H = harness.boot();
    mountList(H, [geoWith(H, 'ida', 'g2', false)]);
    H.settings.write('geologists', onlyEnable('IronOre', 0));
    jq.install(H);
    tiles = H.Steward.modules.geologists.tiles(H.Steward.kernel.ui.helpers);
    t.assert.strictEqual(tiles[0].lines[0], '1 geologist · all idle');
    t.assert.strictEqual(tiles[0].lines[1], '1 deposit type searched, 0 below max');
});

t.test('the geologists module keeps its quick-toggle title and registers a wide screen spec', function () {
    var mod = harness.boot().module('geologists');
    t.assert.strictEqual(mod.ui.section.title, 'Geologists');
    t.assert.strictEqual(mod.ui.section.wide, true);
    t.assert.strictEqual(typeof mod.ui.section.render, 'function');
    t.assert.strictEqual(typeof mod.ui.section.tiles, 'function');
    t.assert.strictEqual(mod.ui.section.action, undefined);
});

// --- send guard ------------------------------------------------------------

// A booted harness with a test clock on the shared send guard; env.T is read
// at call time.
function guarded() {
    var H = harness.boot();
    var env = { H: H, T: 1000000 };
    env.g = H.Steward.core.specialists.sendGuard;
    env.g.clock = function () { return env.T; };
    return env;
}

// Mounts `list` with IronOre enabled at `max` and boots the module. plan()
// returns what that pass queued.
function guardedGeos(env, list, max) {
    var H = env.H;
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists(list)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;
    H.settings.write('geologists', onlyEnable('IronOre', max));
    var fire = dispatchAction(H);
    return {
        zone: z,
        fire: fire,
        plan: function () {
            H.clearQueued();
            H.module('geologists').plan({ zone: { isHome: true } });
            return H.queued();
        }
    };
}

t.test('guard: a pending geologist counts as on task for its deposit', function () {
    var env = guarded();
    var f = guardedGeos(env, [idleGeo(env, 'g1'), idleGeo(env, 'g2')], 1);
    env.H.Steward.core.specialists.send = function () { return true; };

    var q = f.plan();
    t.assert.strictEqual(q.length, 1);
    f.fire(q[0].params);
    env.T += env.g.VERIFY_MS - 1;
    t.assert.strictEqual(f.plan().length, 0, 'the other idle geologist is not sent to the same slot');
});

t.test('guard: a held geologist is replaced by another idle one', function () {
    var env = guarded();
    var f = guardedGeos(env, [idleGeo(env, 'g1'), idleGeo(env, 'g2')], 1);
    env.H.Steward.core.specialists.send = function () { return true; };

    var q = f.plan();
    t.assert.strictEqual(q.length, 1);
    var first = q[0].params[0];
    f.fire(q[0].params);
    env.T += env.g.VERIFY_MS;

    q = f.plan();
    t.assert.strictEqual(env.g.blocked(first), true, 'the first geologist is held');
    t.assert.strictEqual(q.length, 1);
    t.assert.notStrictEqual(q[0].params[0], first);
});

t.test('guard: the breaker is shared, so explorer misses stop geologists until one probe', function () {
    var env = guarded();
    var H = env.H;
    var list = [idleGeo(env, 'g1'), idleGeo(env, 'g2')];
    var explorerUids = ['e1', 'e2', 'e3', 'e4', 'e5'];
    explorerUids.forEach(function (u) {
        var s = H.specs.spec({ name: u, uid: u, type: 1 });
        list.push(s);
    });
    var f = guardedGeos(env, list, 2);

    explorerUids.forEach(function (u) { env.g.note('explorers', u, u, 'Short'); });
    env.T += env.g.VERIFY_MS;
    env.g.settle('explorers', H.Steward.core.specialists.explorers(), true);
    t.assert.strictEqual(env.g.isOpen(), true);

    t.assert.strictEqual(f.plan().length, 0, 'paused while open');
    env.T = env.g.snapshot().nextProbeAt;
    t.assert.strictEqual(f.plan().length, 1, 'exactly one probe');
    t.assert.strictEqual(f.plan().length, 0, 'no second probe in the same cooldown');
});

t.test('guard: a geologist send that sends nothing leaves nothing pending', function () {
    var cases = {
        'send false': function (c) { c.send = function () { return false; }; },
        'lookup ok:false': function (c) { c.lookup = function () { return { ok: false }; }; }
    };
    Object.keys(cases).forEach(function (name) {
        var env = guarded();
        var f = guardedGeos(env, [idleGeo(env, 'g1')], 1);
        var c = env.H.Steward.core.specialists;
        var lookup = c.lookup;
        c.send = function () { return true; };
        var q = f.plan();
        t.assert.strictEqual(q.length, 1, name);
        cases[name](c);
        f.fire(q[0].params);
        c.lookup = lookup;

        t.assert.strictEqual(env.g.snapshot().pending, 0, name);
        t.assert.strictEqual(env.g.pendingTags('geologists').length, 0, name);
        t.assert.strictEqual(f.plan().length, 1, name);
    });
});

// An idle geologist with uid and name `uid`.
function idleGeo(env, uid) {
    return env.H.specs.geologist({ name: uid, uid: uid });
}

t.test('busyOnDeposit is exported and counts only busy geologists on the given index', function () {
    var H = harness.boot();
    var g = H.Steward.modules.geologists;
    t.assert.strictEqual(typeof g.busyOnDeposit, 'function');
    var onTwo  = H.specs.geologist({ uid: 'a', task: H.specs.task(1, 2, 1000) });
    var onTwoB = H.specs.geologist({ uid: 'b', task: H.specs.task(1, 2, 1000) });
    var onFive = H.specs.geologist({ uid: 'c', task: H.specs.task(1, 5, 1000) });
    var idle   = H.specs.geologist({ uid: 'd' });
    var list = [onTwo, onTwoB, onFive, idle, null];
    t.assert.strictEqual(g.busyOnDeposit(list, 2), 2);
    t.assert.strictEqual(g.busyOnDeposit(list, 5), 1);
    t.assert.strictEqual(g.busyOnDeposit(list, 0), 0, 'idle geologist is not counted');
});
