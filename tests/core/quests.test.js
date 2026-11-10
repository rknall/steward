'use strict';

var t = require('../runner');
var harness = require('../harness');
var AC = require('../stubs/actions');

// A fake quest pool. Each quest: { key, name, finished, special, throwOn, half,
// mode, active, noIsActive }. half: true yields an object that is not a quest
// (only GetUniqueId); throwOn 'finished' makes isFinished throw. mode sets
// mQuestMode (left undefined when absent) and SetQuestMode changes it, so a
// mode set by a send is observable. active (default true) feeds IsActive;
// noIsActive drops IsActive so the fallback to IsQuestActive can be tested.
// The pool can be made unreadable through world.broken.
function world(H, quests) {
    var w = { quests: quests, broken: false, modes: [] };
    function fake(q) {
        if (q.half === true) {
            return {
                GetUniqueId: function () {
                    return { toKeyString: function () { return q.key; } };
                }
            };
        }
        var obj = {
            GetUniqueId:       function () {
                if (q.throwOn === 'uid') throw new Error('uid failed');
                return { toKeyString: function () { return q.key; } };
            },
            getQuestName_string: function () { return q.name || q.key; },
            isFinished:          function () {
                if (q.throwOn === 'finished') throw new Error('finished failed');
                return q.finished === true;
            },
            SetQuestMode:        function (mode) {
                w.modes.push(mode);
                q.mode = mode;
                obj.mQuestMode = mode;
            },
            GetQuestDefinition:  function () { return { specialType_string: q.special || '' }; },
            IsQuestActive:       function () { return q.active !== false; }
        };
        if (q.mode !== undefined) obj.mQuestMode = q.mode;
        if (q.noIsActive !== true) obj.IsActive = function () { return q.active !== false; };
        return obj;
    }
    H.host.game.quests = {
        GetQuestPool: function () {
            if (w.broken) throw new Error('pool failed');
            return {
                GetQuest_vector: function () {
                    var out = [];
                    for (var i = 0; i < w.quests.length; i++) out.push(fake(w.quests[i]));
                    return out;
                }
            };
        }
    };
    return w;
}

// opts.noResponder leaves the host without game.createResponder.
function boot(quests, opts) {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    H.host.game.gi.mCurrentViewedZoneID = 5;
    if (!(opts && opts.noResponder)) {
        H.host.game.createResponder = function (onResult, onFault) {
            return { onResult: onResult, onFault: onFault };
        };
    }
    var sent = AC.wire(H);
    var w = world(H, quests);
    return { H: H, S: H.Steward, Q: H.Steward.core.quests, sent: sent, w: w };
}

function run(b, def, onStep) {
    var result = null;
    b.S.core.actions.attempt(def, function (r) { result = r; });
    AC.drive(b.H, { onStep: onStep });
    return result;
}

function keys(l) {
    return l.map(function (e) { return e.key; }).join(',');
}

// Fires a callback of the responder that went out with message i.
function respond(b, i, kind) {
    b.sent.messages[i].responder[kind]({});
}

function drop(b, key) {
    b.w.quests = b.w.quests.filter(function (q) { return q.key !== key; });
}

t.test('list marks finished and last', function () {
    var b = boot([
        { key: 'a', name: 'First', finished: true },
        { key: 'b', name: 'Final', finished: false, special: 'x,lastQuest' }
    ]);
    var l = b.Q.list();
    t.assert.strictEqual(l.length, 2);
    t.assert.strictEqual(JSON.stringify(l[0]), JSON.stringify({ key: 'a', name: 'First', finished: true, last: false, unread: false }));
    t.assert.strictEqual(l[1].last, true);
    t.assert.strictEqual(l[1].finished, false);
    t.assert.strictEqual(keys(b.Q.finished()), 'a');
});

t.test('list returns an empty array for an empty pool', function () {
    var b = boot([]);
    t.assert.strictEqual(b.Q.list().length, 0);
    t.assert.strictEqual(b.Q.finished().length, 0);
});

t.test('list returns null when the pool cannot be read', function () {
    var b = boot([{ key: 'a', finished: true }]);
    b.w.broken = true;
    t.assert.strictEqual(b.Q.list(), null);
    t.assert.strictEqual(b.Q.finished(), null);
    b.w.broken = false;
    b.H.host.game.quests = undefined;
    t.assert.strictEqual(b.Q.list(), null);
});

t.test('list skips an entry that cannot be read', function () {
    var b = boot([{ key: 'a', finished: true, throwOn: 'uid' }, { key: 'b', finished: true }]);
    t.assert.strictEqual(keys(b.Q.list()), 'b');
});

t.test('claim refuses the last quest unless allowed', function () {
    var b = boot([{ key: 'z', finished: true, special: 'lastQuest' }]);
    var r = run(b, b.Q.claim('z'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Refused);
    t.assert.strictEqual(r.reason, 'last quest');
    t.assert.strictEqual(b.sent.messages.length, 0);

    r = run(b, b.Q.claim('z', { allowLast: true }), function () { drop(b, 'z'); });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(b.sent.messages.length, 1);
});

t.test('claim refuses an unknown key without sending', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var r = run(b, b.Q.claim('nope'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Refused);
    t.assert.strictEqual(r.reason, 'quest not found');
    t.assert.strictEqual(r.sends, 0);
    t.assert.strictEqual(b.sent.messages.length, 0);
});

t.test('claim refuses a quest that is not finished', function () {
    var b = boot([{ key: 'a', finished: false }]);
    var r = run(b, b.Q.claim('a'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Refused);
    t.assert.strictEqual(r.reason, 'quest not finished');
    t.assert.strictEqual(b.sent.messages.length, 0);
});

t.test('claim refuses while the pool cannot be read', function () {
    var b = boot([{ key: 'a', finished: true }]);
    b.w.broken = true;
    var r = run(b, b.Q.claim('a'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Refused);
    t.assert.strictEqual(r.reason, 'quests unreadable');
    t.assert.strictEqual(b.sent.messages.length, 0);
});

t.test('claim sends 100 with type 1 and the quest uid', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var r = run(b, b.Q.claim('a'), function () { drop(b, 'a'); });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(r.sends, 1);
    t.assert.strictEqual(b.sent.messages.length, 1);
    var m = b.sent.messages[0];
    t.assert.strictEqual(m.id, 100);
    t.assert.strictEqual(m.data.type, 1);
    t.assert.strictEqual(m.data.data.toKeyString(), 'a');
    t.assert.deepStrictEqual(b.w.modes, [1]);
});

t.test('claim verified when the quest leaves the pool', function () {
    var b = boot([{ key: 'a', finished: true }, { key: 'b', finished: true }]);
    var r = run(b, b.Q.claim('a'), function (n) { if (n === 2) drop(b, 'a'); });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(r.sends, 1);
});

t.test('claim is not verified when only isFinished turns false', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var r = run(b, b.Q.claim('a'), function () { b.w.quests[0].finished = false; });
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
    t.assert.strictEqual(r.sends, 2);
    t.assert.strictEqual(b.sent.messages.length, 2);
});

t.test('claim does not verify while the pool cannot be read', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var r = run(b, b.Q.claim('a'), function () { b.w.broken = true; });
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
    t.assert.strictEqual(b.sent.messages.length, 1);
});

t.test('claim retry is not refused because the quest no longer reads finished', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var d = b.Q.claim('a');
    d.timeoutMs = 1;
    var r = run(b, d, function () {
        if (b.w.quests[0]) b.w.quests[0].finished = false;
        if (b.sent.messages.length === 2) drop(b, 'a');
    });
    // The retry went out (two sends) instead of being refused on isFinished.
    t.assert.strictEqual(b.sent.messages.length, 2);
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(r.sends, 2);
});

t.test('claim is not verified when the zone changes and the quest is absent there', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var r = run(b, b.Q.claim('a'), function () {
        if (b.sent.messages.length < 1) return;
        b.H.host.game.gi.mCurrentViewedZoneID = 6;
        drop(b, 'a');
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
    // The retry is refused (the quest is not in the new zone's pool); the
    // point is that the absence is never taken as a claim.
    t.assert.strictEqual(r.sends, 1);
});

t.test('claim verified by the server result while the quest stays in the pool', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var r = run(b, b.Q.claim('a'), function () {
        b.w.quests[0].finished = false;
        if (b.sent.messages.length === 1) respond(b, 0, 'onResult');
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(r.sends, 1);
    t.assert.strictEqual(b.sent.messages.length, 1);
    t.assert.ok(b.sent.messages[0].responder !== null);
});

t.test('claim is not verified by a server fault', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var fired = false;
    var r = run(b, b.Q.claim('a'), function () {
        if (!fired && b.sent.messages.length === 1) {
            fired = true;
            respond(b, 0, 'onFault');
        }
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
    t.assert.strictEqual(r.sends, 2);
    t.assert.strictEqual(r.unseen, true);
    var warned = b.H.logs().filter(function (e) {
        return e.level === 'warn' && e.category === 'quests' && String(e.args[0]).indexOf('server fault') >= 0;
    });
    t.assert.ok(warned.length >= 1);
});

t.test('claim without any response fails after two sends', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var r = run(b, b.Q.claim('a'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
    t.assert.strictEqual(r.sends, 2);
    t.assert.strictEqual(b.sent.messages.length, 2);
});

t.test('claim ignores a stale result from an earlier send', function () {
    var b = boot([{ key: 'a', finished: true }]);
    var fired = false;
    var r = run(b, b.Q.claim('a'), function () {
        if (!fired && b.sent.messages.length === 2) {
            fired = true;
            respond(b, 0, 'onResult');
        }
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
    t.assert.strictEqual(r.sends, 2);

    var c = boot([{ key: 'a', finished: true }]);
    fired = false;
    r = run(c, c.Q.claim('a'), function () {
        if (!fired && c.sent.messages.length === 2) {
            fired = true;
            respond(c, 1, 'onResult');
        }
    });
    t.assert.strictEqual(r.status, c.S.ActionResult.Verified);
    t.assert.strictEqual(r.sends, 2);
});

t.test('claim falls back to absence when the host has no createResponder', function () {
    var b = boot([{ key: 'a', finished: true }], { noResponder: true });
    var r = run(b, b.Q.claim('a'), function () { drop(b, 'a'); });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(r.sends, 1);
    t.assert.strictEqual(b.sent.messages.length, 1);
    t.assert.strictEqual(b.sent.messages[0].responder, null);
});

t.test('list skips an entry that is not a quest without a warning', function () {
    var b = boot([{ key: 'h', half: true }, { key: 'b', finished: true }]);
    t.assert.strictEqual(keys(b.Q.list()), 'b');
    var logs = b.H.logs().filter(function (e) { return e.category === 'quests'; });
    t.assert.strictEqual(logs.filter(function (e) { return e.level === 'warn'; }).length, 0);
    var dbg = logs.filter(function (e) {
        return e.level === 'debug' && String(e.args[0]).indexOf('not a quest') >= 0;
    });
    t.assert.strictEqual(dbg.length, 1);
});

t.test('list still warns when isFinished throws', function () {
    var b = boot([{ key: 'x', throwOn: 'finished' }, { key: 'b', finished: true }]);
    t.assert.strictEqual(keys(b.Q.list()), 'b');
    var warned = b.H.logs().filter(function (e) {
        return e.level === 'warn' && e.category === 'quests';
    });
    t.assert.ok(warned.length >= 1);
});

t.test('claim refuses a key whose only entry is not a quest', function () {
    var b = boot([{ key: 'h', half: true }]);
    var r = run(b, b.Q.claim('h'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Refused);
    t.assert.strictEqual(r.reason, 'quest not found');
    t.assert.strictEqual(b.sent.messages.length, 0);
    t.assert.strictEqual(b.w.modes.length, 0);
});

// ---- unread and read ----------------------------------------------------------

function unreadFlags(b) {
    return b.Q.list().map(function (e) { return e.key + ':' + e.unread; }).join(',');
}

t.test('list marks unread only for mode 2 and active', function () {
    var b = boot([
        { key: 'a', mode: 2 },
        { key: 'b', mode: 2, active: false },
        { key: 'c', mode: 3 },
        { key: 'd' },
        { key: 'e', mode: 2, special: 'lastQuest' }
    ]);
    t.assert.strictEqual(unreadFlags(b), 'a:true,b:false,c:false,d:false,e:true');
    t.assert.strictEqual(keys(b.Q.unread()), 'a,e');
});

t.test('unread is null when the pool cannot be read', function () {
    var b = boot([{ key: 'a', mode: 2 }]);
    b.w.broken = true;
    t.assert.strictEqual(b.Q.unread(), null);
});

t.test('unread falls back to IsQuestActive when IsActive is absent', function () {
    var b = boot([
        { key: 'a', mode: 2, noIsActive: true },
        { key: 'b', mode: 2, noIsActive: true, active: false }
    ]);
    t.assert.strictEqual(unreadFlags(b), 'a:true,b:false');
});

t.test('read sends 100 with type 0 and the quest uid and sets mode 3', function () {
    var b = boot([{ key: 'a', mode: 2 }]);
    var r = run(b, b.Q.read('a'), function () {
        if (b.sent.messages.length === 1) respond(b, 0, 'onResult');
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(b.sent.messages.length, 1);
    var m = b.sent.messages[0];
    t.assert.strictEqual(m.id, 100);
    t.assert.strictEqual(m.data.type, 0);
    t.assert.strictEqual(m.data.data.toKeyString(), 'a');
    t.assert.ok(m.responder !== null);
    t.assert.deepStrictEqual(b.w.modes, [3]);
});

t.test('read verified by the server result for the latest send', function () {
    var b = boot([{ key: 'a', mode: 2 }]);
    var r = run(b, b.Q.read('a'), function () {
        if (b.sent.messages.length === 1) respond(b, 0, 'onResult');
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(r.sends, 1);
});

t.test('read verified when new quests enter the same zone\'s pool', function () {
    var b = boot([{ key: 'a', mode: 2 }]);
    var added = false;
    var r = run(b, b.Q.read('a'), function () {
        if (!added && b.sent.messages.length === 1) {
            added = true;
            b.w.quests.push({ key: 'sub1', mode: 3 });
        }
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(r.sends, 1);
});

t.test('read is not verified by mode 3 alone', function () {
    var b = boot([{ key: 'a', mode: 2 }]);
    var r = run(b, b.Q.read('a'));
    t.assert.strictEqual(b.w.quests[0].mode, 3);
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
});

t.test('read is not verified by a server fault', function () {
    var b = boot([{ key: 'a', mode: 2 }]);
    var fired = false;
    var r = run(b, b.Q.read('a'), function () {
        if (!fired && b.sent.messages.length === 1) {
            fired = true;
            respond(b, 0, 'onFault');
        }
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
    var warned = b.H.logs().filter(function (e) {
        return e.level === 'warn' && e.category === 'quests' && String(e.args[0]).indexOf('server fault') >= 0;
    });
    t.assert.ok(warned.length >= 1);
});

t.test('read ignores a stale result', function () {
    var b = boot([{ key: 'a', mode: 2 }]);
    var fired = false;
    var r = run(b, b.Q.read('a'), function () {
        if (!fired && b.sent.messages.length === 2) {
            fired = true;
            respond(b, 0, 'onResult');
        }
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
    t.assert.strictEqual(r.sends, 2);

    var c = boot([{ key: 'a', mode: 2 }]);
    fired = false;
    r = run(c, c.Q.read('a'), function () {
        if (!fired && c.sent.messages.length === 2) {
            fired = true;
            respond(c, 1, 'onResult');
        }
    });
    t.assert.strictEqual(r.status, c.S.ActionResult.Verified);
    t.assert.strictEqual(r.sends, 2);
});

t.test('read is not verified when the zone changes', function () {
    var b = boot([{ key: 'a', mode: 2 }]);
    var done = false;
    var r = run(b, b.Q.read('a'), function () {
        if (!done && b.sent.messages.length >= 1) {
            done = true;
            b.H.host.game.gi.mCurrentViewedZoneID = 6;
            b.w.quests.push({ key: 'sub1', mode: 3 });
        }
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Failed);
});

t.test('read refuses a quest that is not unread or not found or while the pool is unreadable', function () {
    var b = boot([{ key: 'a', mode: 3 }, { key: 'b', mode: 2, active: false }]);
    var r = run(b, b.Q.read('a'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Refused);
    t.assert.strictEqual(r.reason, 'quest not unread');
    r = run(b, b.Q.read('b'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Refused);
    t.assert.strictEqual(r.reason, 'quest not unread');
    r = run(b, b.Q.read('nope'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Refused);
    t.assert.strictEqual(r.reason, 'quest not found');
    b.w.broken = true;
    r = run(b, b.Q.read('a'));
    t.assert.strictEqual(r.status, b.S.ActionResult.Refused);
    t.assert.strictEqual(r.reason, 'quests unreadable');
    t.assert.strictEqual(b.sent.messages.length, 0);
});

t.test('read of the last quest is allowed', function () {
    var b = boot([{ key: 'z', mode: 2, special: 'lastQuest' }]);
    var r = run(b, b.Q.read('z'), function () {
        if (b.sent.messages.length === 1) respond(b, 0, 'onResult');
    });
    t.assert.strictEqual(r.status, b.S.ActionResult.Verified);
    t.assert.strictEqual(b.sent.messages.length, 1);
});

// ---- clickNames and definition ------------------------------------------------

// A quest the client counts for pick-up-all: open, active, with the given
// triggers and per-trigger statuses. opts: triggers, statuses, finished,
// active (false, or 'missing' for no IsQuestActive), field (definition only
// on mQuestDefinition), noDef.
function clickQuest(opts) {
    var def = { questTriggers_vector: opts.triggers || [] };
    var q = {
        isFinished: function () { return opts.finished === true; },
        mQuestTriggersFinished_vector: opts.statuses
    };
    if (opts.active !== 'missing') {
        q.IsQuestActive = function () { return opts.active !== false; };
    }
    if (opts.field) q.mQuestDefinition = def;
    else if (!opts.noDef) q.GetQuestDefinition = function () { return def; };
    return q;
}

function trig(name, idx, extra) {
    var t = { triggerIdx: idx, type: 1, condition: 9, name_string: name };
    for (var k in (extra || {})) t[k] = extra[k];
    return t;
}

function bootClick(list) {
    var b = boot([]);
    b.H.host.game.quests = {
        GetQuestPool: function () {
            return { GetQuest_vector: function () { return list; } };
        }
    };
    return b;
}

function names(b) {
    var n = b.Q.clickNames();
    return n === null ? null : Object.keys(n).sort().join(',');
}

t.test('clickNames collects the open click triggers of an active quest', function () {
    var b = bootClick([clickQuest({
        triggers: [trig('crate', 0), trig('barrel', 1)],
        statuses: [{ status: 0 }, { status: 0 }]
    })]);
    t.assert.strictEqual(names(b), 'barrel,crate');
});

t.test('clickNames is null when the pool cannot be read', function () {
    var b = boot([]);
    b.H.host.game.quests = undefined;
    t.assert.strictEqual(b.Q.clickNames(), null);
    b.w.broken = true;
    b.H.host.game.quests = {
        GetQuestPool: function () { throw new Error('pool failed'); }
    };
    t.assert.strictEqual(b.Q.clickNames(), null);
});

t.test('clickNames is empty for an empty pool', function () {
    var b = bootClick([]);
    t.assert.strictEqual(names(b), '');
});

t.test('clickNames skips triggers that are done, of another type or condition, or unnamed', function () {
    var b = bootClick([clickQuest({
        triggers: [
            trig('done', 0), trig('open', 1),
            trig('kill', 2, { type: 2 }), trig('other', 3, { condition: 8 }),
            trig('', 4), trig(undefined, 5)
        ],
        statuses: [{ status: 1 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }]
    })]);
    t.assert.strictEqual(names(b), 'open');
});

t.test('clickNames counts a trigger whose status entry is missing', function () {
    var b = bootClick([clickQuest({ triggers: [trig('crate', 3)], statuses: [{ status: 1 }] })]);
    t.assert.strictEqual(names(b), 'crate');
    b = bootClick([clickQuest({ triggers: [trig('crate', 0)] })]);
    t.assert.strictEqual(names(b), 'crate');
});

t.test('clickNames skips finished, inactive and half-loaded quests', function () {
    var open = [trig('x', 0)];
    var st = [{ status: 0 }];
    var b = bootClick([
        clickQuest({ triggers: open, statuses: st, finished: true }),
        clickQuest({ triggers: open, statuses: st, active: false }),
        clickQuest({ triggers: open, statuses: st, active: 'missing' }),
        { GetUniqueId: function () { return null; } },
        clickQuest({ triggers: [trig('ok', 0)], statuses: st })
    ]);
    t.assert.strictEqual(names(b), 'ok');
});

t.test('clickNames skips a quest whose read throws and warns', function () {
    var bad = clickQuest({ triggers: [trig('x', 0)] });
    bad.isFinished = function () { throw new Error('finished failed'); };
    var b = bootClick([bad, clickQuest({ triggers: [trig('ok', 0)], statuses: [{ status: 0 }] })]);
    t.assert.strictEqual(names(b), 'ok');
    var warned = b.H.logs().filter(function (e) {
        return e.level === 'warn' && e.category === 'quests';
    });
    t.assert.ok(warned.length >= 1);
});

t.test('clickNames reads the definition from the field when the getter is absent', function () {
    var b = bootClick([clickQuest({
        triggers: [trig('crate', 0)], statuses: [{ status: 0 }], field: true
    })]);
    t.assert.strictEqual(names(b), 'crate');
});

t.test('clickNames skips an unread quest and lists a read one', function () {
    var unreadQ = clickQuest({ triggers: [trig('wait', 0)], statuses: [{ status: 0 }] });
    unreadQ.mQuestMode = 2;
    var readQ = clickQuest({ triggers: [trig('go', 0)], statuses: [{ status: 0 }] });
    readQ.mQuestMode = 3;
    var b = bootClick([unreadQ, readQ]);
    t.assert.strictEqual(names(b), 'go');
});

// ---- itemWant -----------------------------------------------------------------

// A quest for itemWant: opts.name, mode, finished, ends, triggers, statuses.
function itemQuest(opts) {
    var q = clickQuest({
        triggers: opts.triggers || [], statuses: opts.statuses, finished: opts.finished
    });
    var def = q.GetQuestDefinition();
    def.endConditions_vector = opts.ends || [];
    q.getQuestName_string = function () { return opts.name || 'Sub quest'; };
    if (opts.mode !== undefined) q.mQuestMode = opts.mode;
    return q;
}

function endCond(item, idx, action) {
    return { action_string: action || 'buffappliedonadventure', item_string: item, triggerIdx: idx };
}

function want(list, name, targets) {
    return bootClick(list).Q.itemWant(name, targets);
}

t.test('itemWant is open while the matching end condition is unmet', function () {
    var q = itemQuest({ ends: [endCond('Shovel', 0)], statuses: [{ status: 0 }], mode: 3 });
    t.assert.strictEqual(want([q], 'Shovel'), 'open');
});

t.test('itemWant is done when the trigger status is finished or the quest is finished', function () {
    var q = itemQuest({ ends: [endCond('Shovel', 0)], statuses: [{ status: 1 }], mode: 3 });
    t.assert.strictEqual(want([q], 'Shovel'), 'done');
    var f = itemQuest({ ends: [endCond('Shovel', 0)], statuses: [{ status: 0 }], finished: true });
    t.assert.strictEqual(want([f], 'Shovel'), 'done');
});

t.test('itemWant ignores unread and Main quests', function () {
    var unreadQ = itemQuest({ ends: [endCond('Shovel', 0)], statuses: [{ status: 0 }], mode: 2 });
    t.assert.strictEqual(want([unreadQ], 'Shovel'), 'none');
    var main = itemQuest({ name: 'Main quest', ends: [endCond('Shovel', 0)], statuses: [{ status: 0 }], mode: 3 });
    t.assert.strictEqual(want([main], 'Shovel'), 'none');
});

t.test('itemWant matches a target name and ignores other items and actions', function () {
    var q = itemQuest({ ends: [endCond('Camp', 0, 'onmap')], statuses: [{ status: 0 }], mode: 3 });
    t.assert.strictEqual(want([q], 'Tent', ['Camp']), 'open');
    t.assert.strictEqual(want([q], 'Tent'), 'none');
    var other = itemQuest({ ends: [endCond('Shovel', 0, 'kill')], statuses: [{ status: 0 }], mode: 3 });
    t.assert.strictEqual(want([other], 'Shovel'), 'none');
});

t.test('itemWant falls back to the quest triggers of type 1', function () {
    var q = itemQuest({
        triggers: [{ triggerIdx: 0, type: 1, item_string: 'Shovel' }],
        statuses: [{ status: 0 }], mode: 3
    });
    t.assert.strictEqual(want([q], 'Shovel'), 'open');
});

t.test('itemWant prefers open over done and is none for an empty pool', function () {
    var d = itemQuest({ ends: [endCond('Shovel', 0)], statuses: [{ status: 1 }], mode: 3 });
    var o = itemQuest({ ends: [endCond('Shovel', 0)], statuses: [{ status: 0 }], mode: 3 });
    t.assert.strictEqual(want([d, o], 'Shovel'), 'open');
    t.assert.strictEqual(want([], 'Shovel'), 'none');
});

t.test('itemWant is null when the pool cannot be read', function () {
    var b = boot([]);
    b.H.host.game.quests = undefined;
    t.assert.strictEqual(b.Q.itemWant('Shovel'), null);
});

// ---- strict gate (opts.running) -------------------------------------------------

t.test('clickNames running lists only mode-3 quests and holds the others with their mode', function () {
    var modes = [2, 1, 0, undefined, 3];
    var list = [];
    for (var i = 0; i < modes.length; i++) {
        var q = clickQuest({ triggers: [trig('obj' + i, 0)], statuses: [{ status: 0 }] });
        if (modes[i] !== undefined) q.mQuestMode = modes[i];
        q.getQuestName_string = (function (n) { return function () { return n; }; }('Q' + i));
        list.push(q);
    }
    var b = bootClick(list);
    var held = {};
    var n = b.Q.clickNames({ running: true, held: held });
    t.assert.deepStrictEqual(Object.keys(n), ['obj4']);
    t.assert.deepStrictEqual(Object.keys(held).sort(), ['obj0', 'obj1', 'obj2', 'obj3']);
    t.assert.strictEqual(JSON.stringify(held.obj0), JSON.stringify({ quest: 'Q0', mode: 2 }));
    t.assert.strictEqual(JSON.stringify(held.obj3), JSON.stringify({ quest: 'Q3', mode: null }));
    // The loose gate still lists everything but the unread quest.
    t.assert.strictEqual(names(b), 'obj1,obj2,obj3,obj4');
});

t.test('clickNames running skips inactive and finished quests and lists a held name a running quest wants', function () {
    var inactive = clickQuest({ triggers: [trig('a', 0)], statuses: [{ status: 0 }], active: false });
    inactive.mQuestMode = 3;
    var fin = clickQuest({ triggers: [trig('b', 0)], statuses: [{ status: 0 }], finished: true });
    fin.mQuestMode = 3;
    var unreadQ = clickQuest({ triggers: [trig('c', 0)], statuses: [{ status: 0 }] });
    unreadQ.mQuestMode = 2;
    var runQ = clickQuest({ triggers: [trig('c', 0)], statuses: [{ status: 0 }] });
    runQ.mQuestMode = 3;
    var held = {};
    var n = bootClick([inactive, fin, unreadQ, runQ]).Q.clickNames({ running: true, held: held });
    t.assert.deepStrictEqual(Object.keys(n), ['c']);
    t.assert.deepStrictEqual(Object.keys(held), ['a']);
});

t.test('itemWant running is open only for a mode-3 quest and held otherwise', function () {
    var b;
    var held;
    var modes = [2, 1, 0];
    for (var i = 0; i < modes.length; i++) {
        var q = itemQuest({ name: 'Bridges', ends: [endCond('Shovel', 0)], statuses: [{ status: 0 }], mode: modes[i] });
        held = [];
        b = bootClick([q]);
        t.assert.strictEqual(b.Q.itemWant('Shovel', null, { running: true, held: held }), 'held', 'mode ' + modes[i]);
        t.assert.strictEqual(JSON.stringify(held), JSON.stringify([{ quest: 'Bridges', mode: modes[i] }]));
    }
    var run = itemQuest({ ends: [endCond('Shovel', 0)], statuses: [{ status: 0 }], mode: 3 });
    t.assert.strictEqual(bootClick([run]).Q.itemWant('Shovel', null, { running: true }), 'open');
    // The loose gate counts the mode-1 quest as open.
    var m1 = itemQuest({ ends: [endCond('Shovel', 0)], statuses: [{ status: 0 }], mode: 1 });
    t.assert.strictEqual(want([m1], 'Shovel'), 'open');
});

t.test('itemWant running: held beats done, met held quests and finished quests are done', function () {
    var done = itemQuest({ ends: [endCond('Shovel', 0)], statuses: [{ status: 1 }], mode: 3 });
    var waiting = itemQuest({ ends: [endCond('Shovel', 0)], statuses: [{ status: 0 }], mode: 2 });
    t.assert.strictEqual(bootClick([done, waiting]).Q.itemWant('Shovel', null, { running: true }), 'held');
    var metHeld = itemQuest({ ends: [endCond('Shovel', 0)], statuses: [{ status: 1 }], mode: 2 });
    t.assert.strictEqual(bootClick([metHeld]).Q.itemWant('Shovel', null, { running: true }), 'none');
    var fin = itemQuest({ ends: [endCond('Shovel', 0)], statuses: [{ status: 0 }], finished: true, mode: 3 });
    t.assert.strictEqual(bootClick([fin]).Q.itemWant('Shovel', null, { running: true }), 'done');
    var main = itemQuest({ name: 'Main quest', ends: [endCond('Shovel', 0)], statuses: [{ status: 0 }], mode: 2 });
    t.assert.strictEqual(bootClick([main]).Q.itemWant('Shovel', null, { running: true }), 'none');
});

t.test('definition falls back from getter to field to none', function () {
    var b = boot([]);
    var d = { specialType_string: '' };
    var r = b.Q.definition({ GetQuestDefinition: function () { return d; } });
    t.assert.strictEqual(r.source, 'getter');
    t.assert.strictEqual(r.def, d);

    r = b.Q.definition({ mQuestDefinition: d });
    t.assert.strictEqual(r.source, 'field');
    t.assert.strictEqual(r.def, d);

    r = b.Q.definition({
        GetQuestDefinition: function () { throw new Error('getter failed'); },
        mQuestDefinition: d
    });
    t.assert.strictEqual(r.source, 'field');

    r = b.Q.definition({ GetQuestDefinition: function () { return null; } });
    t.assert.strictEqual(r.source, 'none');
    t.assert.strictEqual(r.def, null);
});

// ---- destroyNames ---------------------------------------------------------------

// A quest with buildingdestroyed end conditions for the given items. opts:
// items (names), name, finished, active, mode, statuses, ends (full override).
function destroyQuest(opts) {
    var ends = opts.ends;
    if (!ends) {
        ends = [];
        for (var i = 0; i < (opts.items || []).length; i++) {
            ends.push(endCond(opts.items[i], i, 'buildingdestroyed'));
        }
    }
    var q = itemQuest({
        name: opts.name, ends: ends, statuses: opts.statuses || [], finished: opts.finished
    });
    if (opts.active === false) q.IsQuestActive = function () { return false; };
    if (opts.mode !== undefined) q.mQuestMode = opts.mode;
    return q;
}

function destroyList(list, opts) {
    var n = bootClick(list).Q.destroyNames(opts);
    return n === null ? null : Object.keys(n).sort().join(',');
}

t.test('destroyNames lists buildingdestroyed items of an open quest', function () {
    var q = destroyQuest({
        ends: [
            endCond('BuildingBucket', 0, 'buildingdestroyed'),
            endCond('Ore', 1, 'onmap'),
            endCond('Shovel', 2),
            endCond('', 3, 'buildingdestroyed'),
            { action_string: 'buildingdestroyed', triggerIdx: 4 },
            endCond('Fire wood', 5, 'buildingdestroyed')
        ]
    });
    var noVector = destroyQuest({ items: [] });
    delete noVector.GetQuestDefinition().endConditions_vector;
    t.assert.strictEqual(destroyList([q, noVector]), 'BuildingBucket,Fire wood');
});

t.test('destroyNames skips the main quest', function () {
    var main = destroyQuest({ name: 'Main quest', items: ['BuildingBucket'] });
    var sub = destroyQuest({ name: 'Sabotage', items: ['Ore'] });
    t.assert.strictEqual(destroyList([main, sub]), 'Ore');
});

t.test('destroyNames ignores trigger status', function () {
    var q = destroyQuest({ items: ['BuildingBucket'], statuses: [{ status: 1 }] });
    t.assert.strictEqual(destroyList([q]), 'BuildingBucket');
});

t.test('destroyNames is null when the pool cannot be read', function () {
    var b = boot([]);
    b.H.host.game.quests = {
        GetQuestPool: function () { throw new Error('pool failed'); }
    };
    t.assert.strictEqual(b.Q.destroyNames(), null);
    b.H.host.game.quests = undefined;
    t.assert.strictEqual(b.Q.destroyNames(), null);
});

t.test('destroyNames running lists mode-3 quests and holds the others with their mode', function () {
    var modes = [2, 1, 0, undefined, 3];
    var list = [];
    for (var i = 0; i < modes.length; i++) {
        list.push(destroyQuest({ name: 'Q' + i, items: ['obj' + i], mode: modes[i] }));
    }
    var held = {};
    var n = bootClick(list).Q.destroyNames({ running: true, held: held });
    t.assert.deepStrictEqual(Object.keys(n), ['obj4']);
    t.assert.deepStrictEqual(Object.keys(held).sort(), ['obj0', 'obj1', 'obj2', 'obj3']);
    t.assert.strictEqual(JSON.stringify(held.obj0), JSON.stringify({ quest: 'Q0', mode: 2 }));
    t.assert.strictEqual(JSON.stringify(held.obj3), JSON.stringify({ quest: 'Q3', mode: null }));
    // The loose gate lists everything but the unread quest.
    t.assert.strictEqual(destroyList(list), 'obj1,obj2,obj3,obj4');
});

t.test('destroyNames skips finished and inactive quests', function () {
    var fin = destroyQuest({ items: ['a'], finished: true, mode: 3 });
    var inactive = destroyQuest({ items: ['b'], active: false, mode: 3 });
    var ok = destroyQuest({ items: ['c'], mode: 3 });
    t.assert.strictEqual(destroyList([fin, inactive, ok]), 'c');
    t.assert.strictEqual(destroyList([fin, inactive, ok], { running: true }), 'c');
});

function openList(list, opts) {
    var n = bootClick(list).Q.openDestroyNames(opts);
    return n === null ? null : Object.keys(n).sort().join(',');
}

t.test('openDestroyNames lists an open buildingdestroyed item of a running quest', function () {
    var q = destroyQuest({ items: ['BuildingBucket'], statuses: [{ status: 0 }], mode: 3 });
    t.assert.strictEqual(openList([q], { running: true }), 'BuildingBucket');
});

t.test('openDestroyNames drops a condition whose trigger is closed', function () {
    var q = destroyQuest({ items: ['BuildingBucket', 'Ore'], statuses: [{ status: 1 }, { status: 0 }], mode: 3 });
    t.assert.strictEqual(openList([q], { running: true }), 'Ore');
});

t.test('openDestroyNames keeps a condition whose trigger status is missing', function () {
    var q = destroyQuest({ items: ['BuildingBucket', 'Ore'], statuses: [{ status: 0 }], mode: 3 });
    t.assert.strictEqual(openList([q], { running: true }), 'BuildingBucket,Ore');
});

t.test('openDestroyNames skips the main quest and non-running quests under running', function () {
    var main = destroyQuest({ name: 'Main quest', items: ['a'], mode: 3 });
    var waiting = destroyQuest({ name: 'Waiting', items: ['b'], mode: 2 });
    var sub = destroyQuest({ name: 'Sabotage', items: ['c'], mode: 3 });
    t.assert.strictEqual(openList([main, waiting, sub], { running: true }), 'c');
});

t.test('openDestroyNames is null when the pool cannot be read', function () {
    var b = boot([]);
    b.H.host.game.quests = {
        GetQuestPool: function () { throw new Error('pool failed'); }
    };
    t.assert.strictEqual(b.Q.openDestroyNames({ running: true }), null);
    b.H.host.game.quests = undefined;
    t.assert.strictEqual(b.Q.openDestroyNames({ running: true }), null);
});

t.test('destroyNames still lists a closed-trigger item', function () {
    var q = destroyQuest({ items: ['BuildingBucket'], statuses: [{ status: 1 }], mode: 3 });
    t.assert.strictEqual(destroyList([q], { running: true }), 'BuildingBucket');
    t.assert.strictEqual(openList([q], { running: true }), '');
});
