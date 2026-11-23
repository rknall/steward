/*
 * Send ledger: one persisted guard per paid or one-shot send.
 *
 * A send the client accepts may not be visible until the server answers,
 * which can take minutes under load. A plan that re-derives its work from
 * the game would send it again every tick, after a script reload or after a
 * client restart. The ledger writes an entry for the send's key to disk
 * BEFORE the host call and keeps that key blocked until a positive reading
 * settles it. Any core or module can own entries; each owner registers once
 * and gets its own breaker, so one owner that keeps missing pauses only
 * itself.
 *
 * Keys are '<kind>|<zone>|<target>', built with key(). States:
 *
 *   (none)  --attempt send-->        sent     written before the host call
 *   sent    --check true-->          (gone)   observed; the breaker verifies
 *   sent    --window over-->         unseen   persisted; one breaker miss
 *   sent    --send false or threw--> unseen   it may have gone out; no miss
 *   sent    --NOT_SENT-->            (gone)   nothing went out, key free
 *   sent    --refuted in the window-->
 *                                    (gone)   turned down; key free, no miss
 *   unseen  --reread, check true-->  (gone)   observed late; breaker verifies
 *   unseen  --reread, age >= resolveAfterMs and a failure proof-->
 *                                    (gone)   failed; the key is free for
 *                                             one new send
 *   unseen  --reread, age >= expireMs, no proof-->
 *                                    stale    warned once, stays blocked
 *   stale   --resolve(key, by)-->    (gone)   logged with who resolved it
 *
 * FAILED needs a positive proof: the def's failedProof(base) returns a
 * non-empty string only when readable state shows the effect did not
 * happen. A failed or empty read never frees a key, because a send that
 * landed unseen and a second one would be paid twice. Observed and failed
 * are terminal and leave no entry. The miss is counted when the window runs
 * out (unseen), so the breaker reacts within one window; failed and stale
 * do not count again. A refuted attempt (the def's refuted(base) named an
 * observed rejection inside the window) is a proof as well: the send was
 * answered and nothing is pending, so its key is freed with no miss.
 *
 * In memory the ledger also marks the keys whose attempt runs in this
 * session; reread() leaves those to their attempt. A 'sent' entry read back
 * from the file has no attempt any more and is treated as unseen; so is one
 * whose attempt was cancelled, once its owner calls release(owner).
 *
 * Without a writable folder, or while the file cannot be read, nothing that
 * goes through attempt() is sent and blocked() reports 'unread': an
 * unguarded send is what this file exists to prevent.
 *
 * Storage: <steward folder>/state/ledger.json, written whole with
 * S.kernel.files.writeText (temp file, then move). File format:
 * JSON.stringify of { version, entries }, indented, where entries maps a key
 * to { owner, label, name, state, sentAt, base, resolveAfterMs, expireMs };
 * the ms values are wall clock, because entries outlive the session.
 *
 * Bundle slot: core, after events.js and core/events/ and before locale.js
 * (name order); the top level only assigns S.core.ledger; files, breaker,
 * actions and text are used at call time.
 */

(function (S) {

    var SUBDIR       = 'state';
    var FILE_NAME    = 'ledger.json';
    var FILE_VERSION = 1;

    // A file that could not be read is tried again after this long, so a
    // passing read error neither blocks sends for good nor floods the log.
    var UNREAD_RETRY_MS = 10000;

    // An unseen send is not judged failed before this much time, even with a
    // proof: a late server answer can still turn a proof stale.
    var RESOLVE_MIN_MS = 60000;

    // An unseen send with no proof either way blocks its key and is reported
    // stale after this long, so a user can see it and resolve it.
    var EXPIRE_MS = 21600000;

    // Persisted states; observed and failed leave no entry.
    var STATES = { sent: true, unseen: true, stale: true };

    var CATEGORY = 'ledger';

    var entries      = {};      // key -> entry, see the header
    var flight       = {};      // key -> token of the attempt running in this session
    var owners       = {};      // owner -> { category, breaker }
    var loaded       = false;
    var persist      = true;    // false: no writable folder, nothing is sent
    var unread       = false;   // the last read failed; retried at retryAt
    var retryAt      = 0;
    var warnedNoDir  = false;
    var warnedUnread = false;

    var api = {};

    // Wall clock. Tests replace it through S.core.ledger.clock.
    api.clock = function () { return Date.now(); };

    function has(obj, key) { return S.kernel.is.has(obj, key); }

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    function positive(v) {
        return typeof v === 'number' && v > 0;
    }

    function key(kind, zone, target) {
        var parts = [kind, zone, target];
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            if (parts[i] === null || parts[i] === undefined) return null;
            var s = String(parts[i]);
            if (s === '' || s.indexOf('|') !== -1) return null;
            out.push(s);
        }
        return out.join('|');
    }

    function categoryOf(owner) {
        return has(owners, owner) ? owners[owner].category : CATEGORY;
    }

    function filePath() {
        var d = S.kernel.files.stewardDir(SUBDIR);
        if (!d || !d.dir) return null;
        try {
            return d.dir.resolvePath(FILE_NAME).nativePath;
        } catch (e) {
            S.kernel.warn(CATEGORY, 'cannot resolve the send ledger path:', e);
            return null;
        }
    }

    // Writes every entry. False when nothing could be written.
    function write() {
        var path = filePath();
        if (!path) return false;
        var w;
        try {
            w = S.kernel.files.writeText(path,
                JSON.stringify({ version: FILE_VERSION, entries: entries }, null, 2));
        } catch (e) {
            S.kernel.warn(CATEGORY, 'send ledger not written:', e);
            return false;
        }
        if (!w || !w.ok) {
            S.kernel.warn(CATEGORY, 'send ledger not written: ' +
                (w ? (w.message || w.error) : 'no result'));
            return false;
        }
        return true;
    }

    // Idempotent. True when the ledger may be used: read, missing, or known
    // to be unavailable (persist false). False while the file could not be
    // read; the read is retried after UNREAD_RETRY_MS.
    function load() {
        if (loaded) return true;
        var now = api.clock();
        if (unread && now < retryAt) return false;

        var path = filePath();
        if (!path) {
            persist = false;
            loaded = true;
            if (!warnedNoDir) {
                warnedNoDir = true;
                S.kernel.warn(CATEGORY, 'no writable steward/state folder: sends that need the send ledger are not made');
            }
            return true;
        }

        var r;
        try {
            r = S.kernel.files.readText(path);
        } catch (e) {
            r = { ok: false, error: S.FileError.Unreadable, message: String(e) };
        }
        if (!r.ok && r.error === S.FileError.Missing) {
            entries = {};
            loaded = true;
            unread = false;
            warnedUnread = false;
            return true;
        }
        if (!r.ok) {
            unread = true;
            retryAt = now + UNREAD_RETRY_MS;
            if (!warnedUnread) {
                warnedUnread = true;
                S.kernel.warn(CATEGORY, 'send ledger not read: ' + r.message + '; guarded sends wait');
            }
            return false;
        }

        var data = null;
        try {
            data = JSON.parse(r.text);
        } catch (e) {
            data = null;
        }
        entries = {};
        loaded = true;
        unread = false;
        warnedUnread = false;
        if (!isPlainObject(data) || data.version !== FILE_VERSION || !isPlainObject(data.entries)) {
            // The next write replaces the file.
            S.kernel.warn(CATEGORY, 'send ledger is invalid, starting empty');
            return true;
        }

        var changed = false;
        var count = 0;
        var k, e1;
        for (k in data.entries) {
            if (!has(data.entries, k)) continue;
            e1 = data.entries[k];
            if (!isPlainObject(e1) || typeof e1.state !== 'string' || !has(STATES, e1.state) ||
                typeof e1.sentAt !== 'number') {
                changed = true;
                continue;
            }
            var sentAt = e1.sentAt;
            // The clock moved back since the file was written: an entry never
            // counts as older than it can be.
            if (sentAt > now) {
                sentAt = now;
                changed = true;
            }
            entries[k] = {
                owner:          String(e1.owner),
                label:          typeof e1.label === 'string' ? e1.label : k,
                name:           typeof e1.name === 'string' ? e1.name : '',
                state:          e1.state,
                sentAt:         sentAt,
                base:           e1.base,
                resolveAfterMs: positive(e1.resolveAfterMs) ? e1.resolveAfterMs : RESOLVE_MIN_MS,
                expireMs:       positive(e1.expireMs) ? e1.expireMs : EXPIRE_MS
            };
            count++;
        }
        if (count > 0) {
            S.kernel.log(CATEGORY, 'read back ' + count + ' send ledger entr' + (count === 1 ? 'y' : 'ies') +
                ' from ' + S.kernel.files.stewardPath(SUBDIR) + '/' + FILE_NAME);
        }
        if (changed) write();
        return true;
    }

    function usable() {
        return load() && persist;
    }

    // null when key may be sent; else why not. An unread ledger blocks every
    // key, since null there would fail open.
    function blocked(k) {
        if (!load()) return 'unread';
        if (!has(entries, k)) return null;
        return entries[k].state;
    }

    // Removes the entry in memory and on disk. A failed write keeps the old
    // file, which only blocks the key again after a reload.
    function drop(k) {
        if (!has(entries, k)) return false;
        delete entries[k];
        write();
        return true;
    }

    function setState(k, state) {
        if (!has(entries, k)) return false;
        entries[k].state = state;
        write();
        return true;
    }

    function ageOf(e) {
        var a = api.clock() - e.sentAt;
        return a > 0 ? a : 0;
    }

    // opts: { category, breaker: { label, missText, pausedText, resumeText } }.
    // A second call for the same owner keeps the first.
    function register(owner, opts) {
        if (typeof owner !== 'string' || !owner) {
            S.kernel.error(CATEGORY, 'register: owner must be a non-empty string');
            return false;
        }
        if (has(owners, owner)) return true;
        var o = opts || {};
        var b = o.breaker || {};
        var category = (typeof o.category === 'string' && o.category) ? o.category : CATEGORY;
        owners[owner] = {
            category: category,
            breaker:  S.core.breaker.create({
                category:   category,
                label:      b.label || owner + ' breaker',
                missText:   b.missText || 'sends in a row were not seen',
                pausedText: b.pausedText || owner + ' sends are paused',
                resumeText: b.resumeText || owner + ' sends resume',
                clock:      function () { return api.clock(); }
            })
        };
        return true;
    }

    function breakerOf(owner) {
        return has(owners, owner) ? owners[owner].breaker : null;
    }

    // Whether the owner's breaker lets one more send out now. Spends the
    // probe while it is open, so callers ask only right before queuing.
    function admit(owner) {
        var b = breakerOf(owner);
        return b ? b.admit(1) > 0 : false;
    }

    // A copy of base the file can hold, so memory and disk agree on what a
    // later reread() checks against. Undefined when it cannot be stored.
    function storable(intent, base) {
        try {
            var b = typeof intent.persistBase === 'function' ? intent.persistBase(base) : base;
            if (b === undefined) return { ok: true, value: undefined };
            return { ok: true, value: JSON.parse(JSON.stringify(b)) };
        } catch (e) {
            return { ok: false, error: e };
        }
    }

    // intent: { key, owner, name, resolveAfterMs?, expireMs?, persistBase? }.
    // Wraps def's precheck, send and the attempt's onDone with the ledger and
    // runs it through S.core.actions.attempt.
    function attempt(def, intent, onDone) {
        var it = intent || {};
        var k = it.key;
        if (typeof k !== 'string' || !k) {
            S.kernel.error(CATEGORY, ((def && def.label) || 'action') + ': no send ledger key, nothing sent');
            return false;
        }
        if (!def || typeof def !== 'object' || typeof def.send !== 'function') {
            S.kernel.error(CATEGORY, k + ': attempt needs a def with send');
            return false;
        }
        var owner = it.owner;
        if (!has(owners, owner)) {
            S.kernel.error(CATEGORY, 'send ledger owner ' + owner + ' not registered');
            return false;
        }
        var category = owners[owner].category;
        var brk = owners[owner].breaker;
        var label = (typeof def.label === 'string' && def.label) ? def.label : k;
        var name = typeof it.name === 'string' ? it.name : label;
        var resolveAfterMs = positive(it.resolveAfterMs) ? it.resolveAfterMs :
            Math.max(3 * (positive(def.timeoutMs) ? def.timeoutMs : 0), RESOLVE_MIN_MS);
        var expireMs = positive(it.expireMs) ? it.expireMs : EXPIRE_MS;

        // One token per attempt: a retry of an idempotent def finds its own
        // entry and must not refuse itself as pending.
        var token = {};
        var origPre = def.precheck;
        var origSend = def.send;

        def.category = category;
        if (def.idempotent !== true) def.retries = 0;

        function own() {
            return has(flight, k) && flight[k] === token;
        }

        def.precheck = function () {
            if (!usable()) return 'send ledger unavailable';
            var st = blocked(k);
            if (st !== null && !own()) return 'pending: ' + st;
            return typeof origPre === 'function' ? origPre.apply(def, arguments) : null;
        };

        // The entry goes to the file before the host call, so a reload right
        // after the send still finds it.
        def.send = function (base) {
            if (!usable()) {
                S.kernel.debug(category, label + ': send ledger unavailable, nothing sent');
                return S.core.actions.NOT_SENT;
            }
            var mine = own();
            var st = blocked(k);
            if (st !== null && !mine) {
                S.kernel.debug(category, label + ': ' + k + ' is ' + st + ', nothing sent');
                return S.core.actions.NOT_SENT;
            }
            var b = storable(it, base);
            if (!b.ok) {
                S.kernel.warn(category, label + ': base for ' + k + ' cannot be stored, nothing sent:', b.error);
                return S.core.actions.NOT_SENT;
            }
            var prev = has(entries, k) ? entries[k] : null;
            entries[k] = {
                owner:          owner,
                label:          label,
                name:           name,
                state:          'sent',
                sentAt:         api.clock(),
                base:           b.value,
                resolveAfterMs: resolveAfterMs,
                expireMs:       expireMs
            };
            if (!write()) {
                if (prev) entries[k] = prev;
                else delete entries[k];
                S.kernel.warn(category, 'could not write the send ledger for ' + k + ', nothing sent');
                return S.core.actions.NOT_SENT;
            }
            flight[k] = token;
            var res = origSend.call(def, base);
            if (res === S.core.actions.NOT_SENT) {
                if (mine && prev) {
                    // A retry that made no call: the earlier send of this
                    // attempt did go out, so its entry stays.
                    entries[k] = prev;
                    write();
                } else {
                    drop(k);
                    delete flight[k];
                }
            } else if (res === true) {
                S.kernel.log(category, label + ': sent');
            }
            return res;
        };

        function done(r) {
            if (own()) delete flight[k];
            var R = S.ActionResult;
            if (r.status === R.Failed && r.refuted === true) {
                // The server answered with a rejection the def can read, so
                // nothing is pending and the breaker has nothing to count.
                drop(k);
                S.kernel.log(category, label + ': ' + r.reason + '; ' + k + ' is free');
            } else if (r.status === R.Verified && r.sends > 0) {
                drop(k);
                brk.verify(name);
                S.kernel.log(category, label + ': observed');
            } else if (r.status === R.Verified) {
                // Satisfied before any send: the effect is already there.
                if (!has(flight, k)) drop(k);
                S.kernel.debug(category, label + ' already done');
            } else if (r.status === R.Failed && r.unseen) {
                setState(k, 'unseen');
                brk.miss();
                S.kernel.warn(category, label + ': unseen, ' + k + ' stays blocked');
            } else if (r.status === R.Failed && has(entries, k)) {
                // The send itself failed; it may still have gone out, so the
                // key stays blocked, but only an unseen send counts a miss.
                setState(k, 'unseen');
                S.kernel.warn(category, label + ' failed: ' + r.reason + '; ' + k + ' stays blocked');
            }
            if (typeof onDone === 'function') {
                try {
                    onDone(r);
                } catch (e) {
                    S.kernel.error(category, label + ': onDone threw:', e);
                }
            }
        }

        return S.core.actions.attempt(def, done);
    }

    // Settles one entry at plan time from def's readers. Returns the state
    // after this check: null when there is no entry (or it was removed now),
    // 'unread', or the entry's state.
    function reread(k, def) {
        if (!load()) return 'unread';
        if (!has(entries, k)) return null;
        var e = entries[k];
        if (has(flight, k) || e.state === 'stale') return e.state;
        var category = categoryOf(e.owner);
        var d = def || {};

        if (e.state === 'sent') setState(k, 'unseen');

        if (typeof d.observable === 'function') {
            var obs = true;
            try {
                obs = d.observable();
            } catch (ex) {
                obs = true;
            }
            if (obs === false) return e.state;
        }

        var age = ageOf(e);
        var seen = false;
        try {
            seen = typeof d.check === 'function' && d.check(e.base) === true;
        } catch (ex2) {
            seen = false;
        }
        if (seen) {
            drop(k);
            var b = breakerOf(e.owner);
            if (b) b.verify(e.name);
            S.kernel.log(category, e.label + ': observed after ' + S.kernel.text.minText(age));
            return null;
        }

        if (age >= e.resolveAfterMs && typeof d.failedProof === 'function') {
            var proof = '';
            try {
                proof = d.failedProof(e.base);
            } catch (ex3) {
                proof = '';
            }
            if (typeof proof === 'string' && proof) {
                drop(k);
                S.kernel.warn(category, e.label + ': failed after ' + S.kernel.text.minText(age) +
                    ': ' + proof + '; ' + k + ' is free');
                return null;
            }
        }

        if (age >= e.expireMs) {
            setState(k, 'stale');
            S.kernel.warn(category, e.label + ': stale after ' + S.kernel.text.minText(age) +
                ', blocking ' + k + ' until resolved');
        }
        return e.state;
    }

    // Removes an entry that no attempt of this session runs for; by names
    // who resolved it in the log line.
    function resolve(k, by) {
        load();
        if (!has(entries, k) || has(flight, k)) return false;
        drop(k);
        S.kernel.log(CATEGORY, k + ' resolved by ' + (by || 'unknown'));
        return true;
    }

    // Drops the in-flight marks of owner's keys after its attempts were
    // cancelled (S.kernel.queue.cancelByModule): a cancelled attempt never
    // reaches its done, so its mark would block reread() and resolve() for
    // the rest of the session. The entries stay; reread() then settles them
    // as it does after a reload. Only for an owner whose queued steps are
    // gone, since a running attempt and reread() must not both settle a key.
    // Returns how many marks were dropped.
    function release(owner) {
        var n = 0;
        var k;
        for (k in flight) {
            if (!has(flight, k)) continue;
            if (!has(entries, k) || entries[k].owner !== owner) continue;
            delete flight[k];
            n++;
        }
        if (n > 0) {
            S.kernel.debug(categoryOf(owner), 'released ' + S.kernel.text.plural(n, 'send ledger key') +
                ' of cancelled ' + owner + ' attempts');
        }
        return n;
    }

    // Copies of the entries for owner (every owner when omitted), sorted by
    // key; base stays out.
    function snapshot(owner) {
        load();
        var keys = [];
        var k;
        for (k in entries) {
            if (!has(entries, k)) continue;
            if (owner !== undefined && entries[k].owner !== owner) continue;
            keys.push(k);
        }
        keys.sort();
        var out = [];
        for (var i = 0; i < keys.length; i++) {
            var e = entries[keys[i]];
            out.push({
                key: keys[i], owner: e.owner, label: e.label, name: e.name,
                state: e.state, sentAt: e.sentAt, ageMs: ageOf(e)
            });
        }
        return out;
    }

    api.SUBDIR       = SUBDIR;
    api.FILE_NAME    = FILE_NAME;
    api.FILE_VERSION = FILE_VERSION;
    api.key          = key;
    api.register     = register;
    api.load         = load;
    api.usable       = usable;
    api.blocked      = blocked;
    api.admit        = admit;
    api.attempt      = attempt;
    api.reread       = reread;
    api.resolve      = resolve;
    api.release      = release;
    api.snapshot     = snapshot;
    api.breaker      = breakerOf;

    S.core.ledger = api;

}(Steward));
