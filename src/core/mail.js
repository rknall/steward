/*
 * Mail: inbox headers, mail bodies and verified mail actions.
 *
 * One shared, policy-free mail API. It reads the inbox headers as a Result,
 * fetches a mail body, tells subscribers about new matching mails and builds
 * the defs that act on mails (collect and dismiss, accept or reject a trade,
 * collect an own trade result, accept an adventure invite). Run a def with
 * S.core.actions.attempt(def, onDone). Which mail to act on, and how often
 * the inbox is read, stays with the caller: this file has no tick and decides
 * nothing.
 *
 * Reading. refresh(opts) asks the server for the headers (message 1175). It
 * is single-flight and rate-floored for all callers together, so two modules
 * with different cadences still send at most one request at a time and never
 * two closer than MIN_REFRESH_GAP_MS. The answer comes from our request's
 * responder, or else from the mail service's last GetHeaders result once it
 * has changed since our send. headers(maxAgeMs) is the mail.headers source:
 * notReady before any answer, unreadable after a failed fetch, partial when
 * entries were lost, the page was full or the answer may belong to the
 * game's own mail window, and never an empty list for a failed read. Reads
 * are home-island only and are not held by the mail window.
 *
 * Subscribing. subscribe(owner, filter) registers interest. When a new
 * snapshot holds a matching mail the owner was not told about, the owner
 * module is woken, and its plan() calls news(owner) to get those headers
 * once. No callback runs module code: it would run inside the host's
 * responder dispatch, outside plan() and the queue's module tag.
 *
 * Writing. Every write def's precheck runs gate(): home island only, and held
 * while the game's own mail window is open, so steward never changes the
 * inbox under the player's eyes. An unknown window state holds the write as
 * well. HELD is not a read refusal; isHold(reason) is true for HELD and for
 * every read refusal, which both mean "try again later". A hold on a retry
 * ends the attempt, and nothing more is sent.
 *
 * Verification: a mail counts as gone only when it is absent from a complete
 * header snapshot requested after the def's own send. A partial snapshot, or
 * one requested before the send, proves nothing. A dismiss is verified by
 * that absence alone, since what the server reports per mail is not known.
 * A trade answer, an own-trade collect or an invite accept is also verified
 * by the server's result for the current send. Those three are sent at most
 * once per mail per script instance, even by a second def.
 *
 * Reload: all state is memory only and starts empty when the file re-runs.
 * Every host callback and queue handler first checks that S.core.mail is
 * still this file's object, so a late answer to the previous instance's
 * request changes nothing and wakes no one.
 *
 * Bundle slot: core, after locale.js and before packets.js (core files load
 * in name order). At load it needs only the kernel: read sources and
 * refusals, queue.action and the S.MailKind slot. S.core.packets, zone and
 * actions are read at call time.
 */

(function (S) {
    'use strict';

    var R = S.kernel.read;
    var is = S.kernel.is;

    var CATEGORY = 'mail';

    // Defs and gates read the zone live: they run from the queue, after the
    // plan that built them.
    var LIVE = { live: true };

    // Server messages. The header page size is the one autoTSO asks for, far
    // above any real inbox, so a full page means mails may be missing.
    var MSG_HEADERS = 1175;
    var MSG_BODY = 1177;
    var MSG_DISMISS = 1201;
    var MSG_TRADE_ACCEPT = 1050;
    var MSG_TRADE_REJECT = 1053;
    var MSG_TRADE_COLLECT = 1054;
    var MSG_INVITE_ACCEPT = 93;
    var HEADERS_PAGE = 5000;

    // autoTSO's retry delay between header fetches; the floor keeps every
    // caller together polite to the server.
    var MIN_REFRESH_GAP_MS = 15000;
    // autoTSO's wait before it reads the mail service's last result.
    var PASSIVE_AFTER_MS = 7000;
    // A request (or a queued one that never ran) older than this has failed.
    var ANSWER_TIMEOUT_MS = 30000;
    // A failed body may be asked for again only after this long.
    var BODY_RETRY_MS = 30000;
    // A collected mail does not leave the list at once; no check runs sooner.
    var CHECK_AFTER_MS = 3000;
    // Room for about three header round trips at the gap floor.
    var DISMISS_TIMEOUT_MS = 60000;
    // Room for about two header round trips at the gap floor.
    var ONE_SHOT_TIMEOUT_MS = 45000;
    // Ids per dismiss: autoTSO's batch size, a small packet.
    var DISMISS_MAX = 50;

    var STEP_HEADERS = 'core.mail.headers';
    var STEP_BODY = 'core.mail.body';

    var REFRESH = {
        Fresh:   'MailRefreshFresh',
        Pending: 'MailRefreshPending',
        Queued:  'MailRefreshQueued',
        Gap:     'MailRefreshGap',
        Held:    'MailRefreshHeld'
    };

    var NOT_HOME = 'not on home island';
    var HELD = 'mail window open';
    var WINDOW_UNREADABLE = R.readRefusal('mail window unreadable');
    var HEADERS_UNREADABLE = R.readRefusal('mail headers unreadable');
    var BODY_UNREADABLE = R.readRefusal('mail body not read');
    var ALREADY_SENT = 'mail action already sent';
    var NOT_FOUND = 'mail not found';
    var WRONG_KIND = 'wrong mail kind';
    var NOT_COLLECTABLE = 'mail not collectable';
    var COLLECT_CHECK_MISSING = 'collect check unavailable';
    var BAD_IDS = 'bad mail ids';

    S.MailKind.Loot             = 'MailKindLoot';
    S.MailKind.Geologist        = 'MailKindGeologist';
    S.MailKind.AdventureLoot    = 'MailKindAdventureLoot';
    S.MailKind.AdventureMessage = 'MailKindAdventureMessage';
    S.MailKind.Gift             = 'MailKindGift';
    S.MailKind.Trade            = 'MailKindTrade';
    S.MailKind.TradeResult      = 'MailKindTradeResult';
    S.MailKind.Invite           = 'MailKindInvite';
    S.MailKind.Unknown          = 'MailKindUnknown';

    // Host mail type numbers per kind. The groups are autoTSO's; what the
    // types left out mean is not known, so they read as Unknown.
    var RAW_TYPES = [
        [S.MailKind.Loot,             [6, 25, 26, 27, 28, 41, 42, 43, 44, 45]],
        [S.MailKind.Geologist,        [32]],
        [S.MailKind.AdventureLoot,    [7, 19, 24, 30, 33, 46]],
        [S.MailKind.AdventureMessage, [8, 29, 63]],
        [S.MailKind.Gift,             [9]],
        [S.MailKind.Trade,            [1]],
        [S.MailKind.TradeResult,      [4, 5]],
        [S.MailKind.Invite,           [23]]
    ];

    // Kinds a dismiss must never touch: they need their own answer.
    var NOT_DISMISSABLE = [S.MailKind.Trade, S.MailKind.TradeResult, S.MailKind.Invite];

    var KIND_OF_TYPE = {};
    (function () {
        for (var i = 0; i < RAW_TYPES.length; i++) {
            var types = RAW_TYPES[i][1];
            for (var j = 0; j < types.length; j++) KIND_OF_TYPE[types[j]] = RAW_TYPES[i][0];
        }
    }());

    var api = null;               // the object assigned to S.core.mail below
    var snapshot = null;          // { headers, raw, at, requestedAt, zoneId, seq, state, lost, why }
    var lastError = null;         // why the last header fetch failed, or null
    var inflight = null;          // { token, queued, queuedAt } or { token, sentAt, passiveRef, zoneId }
    var lastRequestAt = null;     // when the last header request went out
    var requestSeq = 0;           // token of every queued read request
    var subs = {};                // owner -> { filter, told: { id: true } }
    var bodies = {};              // id -> { state, at, token, why, record }
    var sentOnce = {};            // one-shot key -> true once its send was made

    function current() {
        return S.core.mail === api;
    }

    function now() {
        return S.kernel.now();
    }

    function kindOf(type) {
        return is.has(KIND_OF_TYPE, type) ? KIND_OF_TYPE[type] : S.MailKind.Unknown;
    }

    function typesOf(kind) {
        for (var i = 0; i < RAW_TYPES.length; i++) {
            if (RAW_TYPES[i][0] === kind) return RAW_TYPES[i][1].slice();
        }
        return [];
    }

    // The zone view when it reads ok and is the home island, else null.
    function homeView(opts) {
        var v;
        try {
            v = S.core.zone.view(opts);
        } catch (e) {
            return null;
        }
        return (R.isOk(v) && v.value && v.value.home === true) ? v.value : null;
    }

    function wakeOwner(owner) {
        if (!current()) return;
        try {
            if (S.kernel.registry && S.kernel.scheduler && S.kernel.registry.get(owner)) {
                S.kernel.scheduler.wake(owner, S.kernel.TIMEOUTS.READ_RETRY_MS);
            }
        } catch (e) {
            S.kernel.warn(CATEGORY, 'wake of ' + owner + ' threw:', e);
        }
    }

    // A fresh dIntegerVO holding value, or null when the host has no def.
    function intVO(value) {
        try {
            var vo = game.def('Communication.VO::dIntegerVO', true);
            if (!vo) return null;
            vo.value = value;
            return vo;
        } catch (e) {
            S.kernel.warn(CATEGORY, 'dIntegerVO threw:', e);
            return null;
        }
    }

    // The mail service's last GetHeaders result, or null. The game's own mail
    // window fills it too, which is why an answer read here is only trusted
    // as complete while that window is closed.
    function passiveResult() {
        try {
            var inst = game.def('ServerState::cConnectionManager').GetInstance();
            var op = inst.mMailService.operations['GetHeaders'];
            return (op && op.lastResult) || null;
        } catch (e) {
            return null;
        }
    }

    // The first of the given readers that finds a collection, or null.
    function firstOf(readers) {
        for (var i = 0; i < readers.length; i++) {
            try {
                var c = readers[i]();
                if (c !== null && c !== undefined) return c;
            } catch (e) { /* try the next shape */ }
        }
        return null;
    }

    function responderCollection(e, d) {
        return firstOf([
            function () { return d.data.headers_collection; },
            function () { return d.headers_collection; },
            function () { return d.data.data.headers_collection; },
            function () { return e.data.headers_collection; }
        ]);
    }

    function passiveCollection(lr) {
        return firstOf([
            function () { return lr.data.data.headers_collection; },
            function () { return lr.data.headers_collection; }
        ]);
    }

    function copyHeader(h) {
        return {
            id: h.id, type: h.type, kind: h.kind, senderId: h.senderId,
            senderName: h.senderName, timestamp: h.timestamp, subject: h.subject
        };
    }

    // Normalised headers plus the host objects by id. An entry without a
    // finite id, or one whose read throws, is lost.
    function normalize(list) {
        var headers = [];
        var raw = {};
        var lost = 0;
        for (var i = 0; i < list.length; i++) {
            try {
                var m = list[i];
                if (!m || !is.finite(m.id)) {
                    lost++;
                    continue;
                }
                if (is.has(raw, m.id)) continue;
                var type = is.finite(m.type) ? m.type : null;
                headers.push({
                    id:         m.id,
                    type:       type,
                    kind:       kindOf(type),
                    senderId:   is.finite(m.senderId) ? m.senderId : null,
                    senderName: S.kernel.text.plain(m.senderName),
                    timestamp:  is.finite(m.timestamp) ? m.timestamp : null,
                    subject:    is.str(m.subject_string)
                });
                raw[m.id] = m;
            } catch (e) {
                lost++;
            }
        }
        return { headers: headers, raw: raw, lost: lost };
    }

    // Whether filter takes header. A throwing filter counts as no match and
    // is warned once per note.
    function matches(filter, header, note) {
        if (filter === null || filter === undefined) return true;
        if (typeof filter === 'function') {
            try {
                return filter(header) === true;
            } catch (e) {
                if (!note.warned) {
                    note.warned = true;
                    S.kernel.warn(CATEGORY, 'mail filter threw:', e);
                }
                return false;
            }
        }
        if (filter && is.array(filter.kinds)) return filter.kinds.indexOf(header.kind) >= 0;
        return false;
    }

    function match(filter, header) {
        return matches(filter, header, { warned: false });
    }

    function validFilter(filter) {
        if (filter === null || filter === undefined || typeof filter === 'function') return true;
        return typeof filter === 'object' && is.array(filter.kinds);
    }

    // Wakes owner when the snapshot holds a matching mail it was not told of.
    function notify(owner) {
        var s = subs[owner];
        if (!s || !snapshot) return;
        var note = { warned: false };
        var hs = snapshot.headers;
        for (var i = 0; i < hs.length; i++) {
            if (s.told[hs[i].id] !== true && matches(s.filter, hs[i], note)) {
                wakeOwner(owner);
                return;
            }
        }
    }

    // Keeps only the entries of map whose id is in present.
    function prune(map, present) {
        var drop = [];
        for (var k in map) {
            if (is.has(map, k) && !is.has(present, k)) drop.push(k);
        }
        for (var i = 0; i < drop.length; i++) delete map[drop[i]];
    }

    // Takes a header collection as the new snapshot. complete is false when
    // the answer may not be the one we asked for.
    function adopt(collection, complete, requestedAt) {
        var zoneId = inflight && is.finite(inflight.zoneId) ? inflight.zoneId : null;
        var list = null;
        try {
            list = S.kernel.hostRead.list(collection);
        } catch (e) {
            list = null;
        }
        inflight = null;
        if (list === null) {
            lastError = 'headers unreadable';
            S.kernel.warn(CATEGORY, 'headers: answer is not a list');
            return;
        }
        var n = normalize(list);
        var state = R.OK;
        var why = null;
        if (n.lost > 0) {
            state = R.PARTIAL;
            why = n.lost + ' mail header(s) unreadable';
        } else if (!complete) {
            state = R.PARTIAL;
            why = 'foreign answer';
        } else if (n.headers.length >= HEADERS_PAGE) {
            state = R.PARTIAL;
            why = 'page full';
        }
        var previous = snapshot ? snapshot.headers.length : -1;
        snapshot = {
            headers: n.headers, raw: n.raw, at: now(), requestedAt: requestedAt, zoneId: zoneId,
            seq: snapshot ? snapshot.seq + 1 : 1, state: state, lost: n.lost, why: why
        };
        lastError = null;
        var text = 'headers: ' + n.headers.length + ' mail(s), ' + state + (why ? ' (' + why + ')' : '');
        if (previous === n.headers.length) S.kernel.debug(CATEGORY, text);
        else S.kernel.log(CATEGORY, text);

        // Only a complete snapshot proves a mail has left the inbox.
        if (state === R.OK) {
            prune(bodies, n.raw);
            for (var owner in subs) {
                if (is.has(subs, owner)) prune(subs[owner].told, n.raw);
            }
        }
        for (var o in subs) {
            if (is.has(subs, o)) notify(o);
        }
    }

    // Reads host memory only and never sends, so it is safe inside a read
    // pass: adopts the passive answer once it has changed since our send, and
    // ends a request or a queued entry that waited too long. A queue reset
    // drops a queued entry without running it, which the expiry also covers.
    function settle() {
        if (!inflight) return;
        var t = now();
        if (inflight.queued) {
            if (t - inflight.queuedAt > ANSWER_TIMEOUT_MS) inflight = null;
            return;
        }
        if (t - inflight.sentAt >= PASSIVE_AFTER_MS) {
            var lr = passiveResult();
            if (lr && lr !== inflight.passiveRef) {
                var c = passiveCollection(lr);
                if (c !== null) {
                    var w = windowOpen();
                    adopt(c, R.isOk(w) && w.value === false, inflight.sentAt);
                    return;
                }
            }
        }
        if (t - inflight.sentAt > ANSWER_TIMEOUT_MS) {
            inflight = null;
            lastError = 'no answer';
            S.kernel.warn(CATEGORY, 'headers: no answer within ' + ANSWER_TIMEOUT_MS + ' ms');
        }
    }

    function readHeaders(maxAgeMs) {
        settle();
        if (!snapshot) {
            return lastError ? R.unreadable(lastError) : R.notReady('no header answer yet');
        }
        if (is.finite(maxAgeMs) && now() - snapshot.at > maxAgeMs) {
            return lastError ? R.unreadable(lastError) : R.notReady('stale');
        }
        var copy = [];
        for (var i = 0; i < snapshot.headers.length; i++) copy.push(copyHeader(snapshot.headers[i]));
        if (snapshot.state === R.OK) return R.ok(copy, snapshot.zoneId);
        return R.partial(copy, snapshot.lost, snapshot.why, snapshot.zoneId);
    }

    R.source('mail.headers', { scope: 'live', read: readHeaders });

    function headers(maxAgeMs) {
        return R.get('mail.headers', maxAgeMs);
    }

    function stamp() {
        settle();
        if (!snapshot) return null;
        return { seq: snapshot.seq, at: snapshot.at, requestedAt: snapshot.requestedAt };
    }

    // A host responder for one read request. The callbacks act only while
    // this instance is current and the request is still the latest one, and
    // nothing may escape them: they run inside the host's dispatch loop.
    // Reads need the fault as well as the result, so they match the request
    // token themselves instead of using a send state.
    function readResponder(label, isLatest, onResult, onFault) {
        var r = S.core.packets.hostResponder(CATEGORY,
            function () {
                try {
                    if (!current() || !isLatest()) {
                        S.kernel.debug(CATEGORY, label + ': late answer ignored');
                        return;
                    }
                    onResult(arguments[0], arguments[1]);
                } catch (e) {
                    S.kernel.error(CATEGORY, label + ': result callback threw:', e);
                }
            },
            function (f) {
                try {
                    if (!current() || !isLatest()) return;
                    S.kernel.warn(CATEGORY, label + ': server fault', f);
                    onFault();
                } catch (e) {
                    S.kernel.error(CATEGORY, label + ': fault callback threw:', e);
                }
            }
        );
        if (!r) S.kernel.debug(CATEGORY, label + ': no host responder, waiting for the passive answer');
        return r;
    }

    function refresh(opts) {
        settle();
        opts = opts || {};
        var t = now();
        if (opts.force !== true && snapshot) {
            if (is.finite(opts.after)) {
                if (snapshot.requestedAt > opts.after) return REFRESH.Fresh;
            } else if (is.finite(opts.maxAgeMs) && t - snapshot.at <= opts.maxAgeMs) {
                return REFRESH.Fresh;
            }
        }
        if (inflight) return REFRESH.Pending;
        if (lastRequestAt !== null && t - lastRequestAt < MIN_REFRESH_GAP_MS) return REFRESH.Gap;
        if (!homeView()) return REFRESH.Held;
        requestSeq++;
        if (S.kernel.queue.add(STEP_HEADERS, [requestSeq]) !== true) return REFRESH.Held;
        inflight = { token: requestSeq, queued: true, queuedAt: t };
        return REFRESH.Queued;
    }

    function runHeaders(params) {
        if (!current()) return;
        var token = params && params[0];
        if (!inflight || inflight.queued !== true || inflight.token !== token) return;
        var view = homeView(LIVE);
        if (!view) {
            inflight = null;
            return;
        }
        var vo = intVO(HEADERS_PAGE);
        if (!vo) {
            lastError = 'no dIntegerVO';
            inflight = null;
            return;
        }
        var sentAt = now();
        lastRequestAt = sentAt;
        inflight = { token: token, queued: false, sentAt: sentAt, passiveRef: passiveResult(), zoneId: view.id };
        var r = readResponder('headers',
            function () { return !!inflight && inflight.queued === false && inflight.token === token; },
            function (e, d) {
                var c = responderCollection(e, d);
                if (c !== null) {
                    adopt(c, true, inflight.sentAt);
                } else if (!inflight.shapeLogged) {
                    inflight.shapeLogged = true;
                    S.kernel.debug(CATEGORY, 'headers: answer without a collection, waiting for the passive answer');
                }
            },
            function () {
                lastError = 'server fault';
                inflight = null;
            }
        );
        if (S.core.packets.sendTo(MSG_HEADERS, view.id, vo, r) !== true) {
            lastError = 'send failed';
            inflight = null;
        }
    }

    // Body records: queued (waiting in the queue), pending (sent), ok or
    // failed. Expired lazily, like the header request.
    function settleBody(id) {
        var b = is.has(bodies, id) ? bodies[id] : null;
        if (!b) return;
        var t = now();
        if (b.state === 'queued' && t - b.at > ANSWER_TIMEOUT_MS) {
            delete bodies[id];
        } else if (b.state === 'pending' && t - b.at > ANSWER_TIMEOUT_MS) {
            b.state = 'failed';
            b.why = 'no answer';
            b.at = t;
            S.kernel.warn(CATEGORY, 'body ' + id + ': no answer within ' + ANSWER_TIMEOUT_MS + ' ms');
        }
    }

    function failBody(b, why) {
        b.state = 'failed';
        b.why = why;
        b.at = now();
    }

    function requestBody(id) {
        if (!is.finite(id)) {
            S.kernel.warn(CATEGORY, 'requestBody: mail id is not a finite number:', id);
            return REFRESH.Held;
        }
        settleBody(id);
        var b = is.has(bodies, id) ? bodies[id] : null;
        if (b && b.state === 'ok') return REFRESH.Fresh;
        if (b && (b.state === 'queued' || b.state === 'pending')) return REFRESH.Pending;
        if (b && b.state === 'failed' && now() - b.at < BODY_RETRY_MS) return REFRESH.Gap;
        if (!homeView()) return REFRESH.Held;
        requestSeq++;
        if (S.kernel.queue.add(STEP_BODY, [id, requestSeq]) !== true) return REFRESH.Held;
        bodies[id] = { state: 'queued', at: now(), token: requestSeq, why: null, record: null };
        return REFRESH.Queued;
    }

    function runBody(params) {
        if (!current()) return;
        var id = params && params[0];
        var token = params && params[1];
        var b = is.has(bodies, id) ? bodies[id] : null;
        if (!b || b.state !== 'queued' || b.token !== token) return;
        var view = homeView(LIVE);
        if (!view) {
            delete bodies[id];
            return;
        }
        var vo = intVO(id);
        if (!vo) {
            failBody(b, 'no dIntegerVO');
            return;
        }
        b.state = 'pending';
        b.at = now();
        var label = 'body ' + id;
        var latest = function () { return bodies[id] === b && b.state === 'pending'; };
        var r = readResponder(label, latest,
            function (e, d) {
                var data = (d && d.data) || d;
                if (!data || typeof data !== 'object') {
                    failBody(b, 'empty body answer');
                    return;
                }
                b.record = {
                    id:          id,
                    body:        data.body,
                    attachments: data.attachments,
                    senderId:    data.senderId,
                    senderName:  S.kernel.text.plain(data.senderName)
                };
                b.state = 'ok';
                b.at = now();
                S.kernel.debug(CATEGORY, label + ': read');
            },
            function () { failBody(b, 'server fault'); }
        );
        if (S.core.packets.sendTo(MSG_BODY, view.id, vo, r) !== true) failBody(b, 'send failed');
    }

    function readBody(id) {
        settleBody(id);
        var b = is.has(bodies, id) ? bodies[id] : null;
        if (!b) return R.notReady('body not requested');
        if (b.state === 'queued' || b.state === 'pending') return R.notReady('body requested');
        if (b.state === 'failed') return R.unreadable(b.why);
        var rec = b.record;
        return R.ok({
            id: rec.id, body: rec.body, attachments: rec.attachments,
            senderId: rec.senderId, senderName: rec.senderName
        });
    }

    R.source('mail.body', { scope: 'live', read: readBody });

    function body(id) {
        return R.get('mail.body', id);
    }

    // Trade items: 'name,amount|name,amount', or 'type,name,amount' for
    // buffs. Any malformed part makes the whole text null, never a partial
    // list.
    function parseItems(text) {
        if (typeof text !== 'string' || text === '') return null;
        var parts = text.split('|');
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var f = parts[i].split(',');
            if (f.length !== 2 && f.length !== 3) return null;
            var amountText = is.trim(f[f.length - 1]);
            var amount = Number(amountText);
            var name = is.trim(f[f.length - 2]);
            if (amountText === '' || !is.finite(amount) || name === '') return null;
            if (f.length === 2) out.push({ name: name, amount: amount });
            else out.push({ type: is.trim(f[0]), name: name, amount: amount });
        }
        return out;
    }

    // Whether the game's own mail window is shown. Which member tells it is
    // not confirmed live yet, so the known shapes are tried in turn and the
    // diagnostics mail probe dumps the window's members. A window that was
    // never created is closed.
    function windowOpen() {
        var gui;
        try {
            if (typeof globalFlash === 'undefined' || !globalFlash || !globalFlash.gui) return R.unreadable('no gui');
            gui = globalFlash.gui;
        } catch (e) {
            return R.unreadable('no gui');
        }
        try {
            var w = gui.mMailWindow;
            if (w === null || w === undefined) return R.ok(false);
            if (typeof w.IsOpen === 'function') return R.ok(!!w.IsOpen());
            if (typeof w.isOpen === 'boolean') return R.ok(w.isOpen);
            if (typeof w.visible === 'boolean') {
                // A display object off the stage is not shown, whatever its
                // visible flag says; stage counts only where it exists.
                var onStage = w.stage === undefined ? true : w.stage !== null;
                return R.ok(w.visible && onStage);
            }
            return R.unreadable('no visibility member');
        } catch (e2) {
            return R.unreadable('mail window threw: ' + R.message(e2));
        }
    }

    // Null when a write may go out now, else the reason it may not.
    function gate() {
        var v;
        try {
            v = S.core.zone.view(LIVE);
        } catch (e) {
            return S.core.zone.UNREADABLE;
        }
        if (!R.isOk(v)) return S.core.zone.UNREADABLE;
        if (!v.value || v.value.home !== true) return NOT_HOME;
        var w = windowOpen();
        if (!R.isOk(w)) return WINDOW_UNREADABLE;
        return w.value === true ? HELD : null;
    }

    function isHold(reason) {
        return reason === HELD || R.isReadRefusal(reason);
    }

    function subscribe(owner, filter) {
        if (typeof owner !== 'string' || !owner) return false;
        if (!validFilter(filter)) {
            S.kernel.warn(CATEGORY, 'subscribe: bad filter for ' + owner);
            return false;
        }
        subs[owner] = { filter: filter === undefined ? null : filter, told: {} };
        notify(owner);
        return true;
    }

    function unsubscribe(owner) {
        if (typeof owner !== 'string' || !is.has(subs, owner)) return false;
        delete subs[owner];
        return true;
    }

    // The matching headers owner was not told about yet, once. A hint only:
    // the owner still decides from headers() and game state.
    function news(owner) {
        settle();
        if (typeof owner !== 'string' || !is.has(subs, owner)) return R.unreadable('not subscribed');
        var s = subs[owner];
        var r = headers();
        if (!R.has(r)) return r;
        var note = { warned: false };
        var out = [];
        for (var i = 0; i < r.value.length; i++) {
            var h = r.value[i];
            if (s.told[h.id] !== true && matches(s.filter, h, note)) {
                s.told[h.id] = true;
                out.push(h);
            }
        }
        if (R.isOk(r)) return R.ok(out, r.zoneId);
        return R.partial(out, r.lost, r.why, r.zoneId);
    }

    // The header with this id in a header list, or null.
    function headerOf(list, id) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return list[i];
        }
        return null;
    }

    // Whether every id is gone: absent from a complete snapshot requested
    // after sentAt. Until then a header request is asked for; the gap floor
    // and single-flight keep that to one per MIN_REFRESH_GAP_MS. force,
    // because a newer snapshot that still lists the mail or is partial must
    // not count as fresh enough to stop asking.
    function gone(ids, sentAt) {
        if (!is.finite(sentAt)) return false;
        var r = headers();
        if (snapshot && snapshot.requestedAt > sentAt && R.isOk(r)) {
            var seen = R.absent(r, function (h) { return ids.indexOf(h.id) >= 0; });
            if (seen) return true;
        }
        refresh({ force: true });
        return false;
    }

    // 1 to DISMISS_MAX distinct finite ids, or null.
    function idList(ids) {
        if (!is.array(ids) || ids.length < 1) return null;
        var out = [];
        for (var i = 0; i < ids.length; i++) {
            if (!is.finite(ids[i])) return null;
            if (out.indexOf(ids[i]) < 0) out.push(ids[i]);
        }
        return out.length <= DISMISS_MAX ? out : null;
    }

    // A def that refuses at once, for arguments no send could use.
    function refused(label, reason, timeoutMs) {
        return {
            label: label, category: CATEGORY, timeoutMs: timeoutMs,
            precheck: function () { return reason; },
            send: function () { return S.core.actions.NOT_SENT; },
            check: function () { return false; }
        };
    }

    // Collected loot goes where the host's own route setting sends it: the
    // storehouse unless the player routed mail loot to the star menu.
    function claimDefault() {
        try {
            if (typeof mainSettings !== 'undefined' && mainSettings && mainSettings.mailRouteStorage === false) {
                return false;
            }
        } catch (e) { /* the storehouse */ }
        return true;
    }

    // The host's collect check for a raw header: null when it may be
    // collected, else the refusal.
    function collectRefusal(raw) {
        var mu;
        try {
            mu = game.def('com.bluebyte.tso.util::MailUtils');
        } catch (e) {
            mu = null;
        }
        if (!mu || typeof mu.CanCollectMail !== 'function') return COLLECT_CHECK_MISSING;
        try {
            return mu.CanCollectMail(raw) === true ? null : NOT_COLLECTABLE;
        } catch (e2) {
            S.kernel.warn(CATEGORY, 'CanCollectMail threw:', e2);
            return COLLECT_CHECK_MISSING;
        }
    }

    // Def that collects the attachments of these mails and dismisses them.
    // opts.toStar sends the loot to the star menu (true) or the storehouse
    // (false); without it the host's route setting decides. A second send of
    // the same ids is harmless, so the default retry applies; it re-checks
    // the effect first.
    function dismiss(ids, opts) {
        var list = idList(ids);
        if (list === null) return refused('mail dismiss', BAD_IDS, DISMISS_TIMEOUT_MS);
        var claim = (opts && typeof opts.toStar === 'boolean') ? !opts.toStar : claimDefault();
        var label = 'mail dismiss ' + list.join(',');
        var ss = S.core.packets.sendState();
        var sentAt = null;
        var pending = [];

        return {
            label:        label,
            category:     CATEGORY,
            timeoutMs:    DISMISS_TIMEOUT_MS,
            checkAfterMs: CHECK_AFTER_MS,

            // After a send, ids already gone are skipped; with none left the
            // send makes no host call.
            precheck: function () {
                var g = gate();
                if (g) return g;
                var r = headers();
                if (!R.has(r)) return HEADERS_UNREADABLE;
                var present = [];
                for (var i = 0; i < list.length; i++) {
                    var h = headerOf(r.value, list[i]);
                    if (!h) {
                        if (ss.sent) continue;
                        return R.isOk(r) ? NOT_FOUND : HEADERS_UNREADABLE;
                    }
                    if (NOT_DISMISSABLE.indexOf(h.kind) >= 0) return WRONG_KIND;
                    var why = collectRefusal(snapshot.raw[h.id]);
                    if (why) return why;
                    present.push(h.id);
                }
                pending = present;
                return null;
            },

            baseline: function () {
                return { found: true };
            },

            send: function () {
                var NOT_SENT = S.core.actions.NOT_SENT;
                if (pending.length === 0) return NOT_SENT;
                var view = homeView(LIVE);
                if (!view) return NOT_SENT;
                var vo;
                try {
                    vo = game.def('Communication.VO.Mail::dDismissMailsRequestVO', true);
                    var coll = game.def('mx.collections::ArrayCollection', true);
                    if (!vo || !coll) return NOT_SENT;
                    for (var i = 0; i < pending.length; i++) coll.addItem(pending[i]);
                    vo.mailsIDs_collection = coll;
                    vo.claim = claim;
                } catch (e) {
                    S.kernel.warn(CATEGORY, label + ': building the request threw:', e);
                    return NOT_SENT;
                }
                sentAt = now();
                return S.core.packets.sendTo(MSG_DISMISS, view.id, vo,
                    S.core.packets.trackedResponder(ss, CATEGORY, label)) === true;
            },

            // The server's answer alone proves nothing: whether it reports a
            // mail it could not collect is not known.
            check: function (base) {
                if (!base || base.found !== true) return false;
                return gone(list, sentAt);
            },

            describe: function () {
                return list.length + ' mail(s), claim=' + claim;
            }
        };
    }

    // One def shape for the answers that must never go out twice: retries 0,
    // and a key per mail that a second def for the same mail refuses on.
    // spec: { id, key, label, kind, messageId, zone() -> number, extra() ->
    // null or refusal }.
    function oneShot(spec) {
        if (!is.finite(spec.id)) return refused(spec.label, BAD_IDS, ONE_SHOT_TIMEOUT_MS);
        var id = spec.id;
        var ss = S.core.packets.sendState();
        var sentAt = null;

        return {
            label:        spec.label,
            category:     CATEGORY,
            retries:      0,
            timeoutMs:    ONE_SHOT_TIMEOUT_MS,
            checkAfterMs: CHECK_AFTER_MS,

            precheck: function () {
                var g = gate();
                if (g) return g;
                var r = headers();
                if (!R.has(r)) return HEADERS_UNREADABLE;
                var h = headerOf(r.value, id);
                if (!h) return R.isOk(r) ? NOT_FOUND : HEADERS_UNREADABLE;
                if (h.kind !== spec.kind) return WRONG_KIND;
                if (sentOnce[spec.key] === true) return ALREADY_SENT;
                return spec.extra ? spec.extra() : null;
            },

            baseline: function () {
                return { found: true };
            },

            // Marked sent before the host call: once the call is made the
            // packet may be out.
            send: function () {
                var NOT_SENT = S.core.actions.NOT_SENT;
                var zoneId = spec.zone();
                if (!is.finite(zoneId)) return NOT_SENT;
                var vo = intVO(id);
                if (!vo) return NOT_SENT;
                sentOnce[spec.key] = true;
                sentAt = now();
                return S.core.packets.sendTo(spec.messageId, zoneId, vo,
                    S.core.packets.trackedResponder(ss, CATEGORY, spec.label)) === true;
            },

            check: function (base) {
                if (!base || base.found !== true) return false;
                if (S.core.packets.answered(ss)) return true;
                return gone([id], sentAt);
            }
        };
    }

    function playerZone() {
        try {
            return S.core.zone.playerId();
        } catch (e) {
            return null;
        }
    }

    // Accepting and rejecting share one key: a trade is answered once.
    function trade(id, accept) {
        return oneShot({
            id: id, key: 'trade ' + id, kind: S.MailKind.Trade,
            label: 'mail trade ' + (accept === true ? 'accept ' : 'reject ') + id,
            messageId: accept === true ? MSG_TRADE_ACCEPT : MSG_TRADE_REJECT,
            zone: playerZone
        });
    }

    function completeTrade(id) {
        return oneShot({
            id: id, key: 'trade result ' + id, kind: S.MailKind.TradeResult,
            label: 'mail trade collect ' + id, messageId: MSG_TRADE_COLLECT, zone: playerZone
        });
    }

    // The invite's adventure zone from its body, or null.
    function inviteZone(id) {
        var r = body(id);
        if (!R.isOk(r)) return null;
        try {
            var z = r.value.attachments.zoneID;
            return is.finite(z) ? z : null;
        } catch (e) {
            return null;
        }
    }

    // Needs the body first (requestBody), since the zone to address is in it.
    function acceptInvite(id) {
        return oneShot({
            id: id, key: 'invite ' + id, kind: S.MailKind.Invite,
            label: 'mail invite accept ' + id, messageId: MSG_INVITE_ACCEPT,
            zone: function () { return inviteZone(id); },
            extra: function () { return inviteZone(id) === null ? BODY_UNREADABLE : null; }
        });
    }

    api = {
        headers:       headers,
        stamp:         stamp,
        refresh:       refresh,
        REFRESH:       REFRESH,
        requestBody:   requestBody,
        body:          body,
        parseItems:    parseItems,
        windowOpen:    windowOpen,
        isHold:        isHold,
        subscribe:     subscribe,
        unsubscribe:   unsubscribe,
        news:          news,
        match:         match,
        kindOf:        kindOf,
        typesOf:       typesOf,
        dismiss:       dismiss,
        trade:         trade,
        completeTrade: completeTrade,
        acceptInvite:  acceptInvite,

        NOT_HOME:              NOT_HOME,
        HELD:                  HELD,
        WINDOW_UNREADABLE:     WINDOW_UNREADABLE,
        HEADERS_UNREADABLE:    HEADERS_UNREADABLE,
        BODY_UNREADABLE:       BODY_UNREADABLE,
        ALREADY_SENT:          ALREADY_SENT,
        NOT_FOUND:             NOT_FOUND,
        WRONG_KIND:            WRONG_KIND,
        NOT_COLLECTABLE:       NOT_COLLECTABLE,
        COLLECT_CHECK_MISSING: COLLECT_CHECK_MISSING,
        BAD_IDS:               BAD_IDS,

        HEADERS_PAGE:        HEADERS_PAGE,
        MIN_REFRESH_GAP_MS:  MIN_REFRESH_GAP_MS,
        PASSIVE_AFTER_MS:    PASSIVE_AFTER_MS,
        ANSWER_TIMEOUT_MS:   ANSWER_TIMEOUT_MS,
        BODY_RETRY_MS:       BODY_RETRY_MS,
        CHECK_AFTER_MS:      CHECK_AFTER_MS,
        DISMISS_TIMEOUT_MS:  DISMISS_TIMEOUT_MS,
        ONE_SHOT_TIMEOUT_MS: ONE_SHOT_TIMEOUT_MS,
        DISMISS_MAX:         DISMISS_MAX,

        // Queue names and their handlers, so a test can play queued entries
        // as the kernel queue would (as core/actions.js exports step).
        STEP_HEADERS: STEP_HEADERS,
        STEP_BODY:    STEP_BODY,
        stepHeaders:  runHeaders,
        stepBody:     runBody
    };
    S.core.mail = api;

    S.kernel.queue.action(STEP_HEADERS, runHeaders);
    S.kernel.queue.action(STEP_BODY, runBody);

}(Steward));
