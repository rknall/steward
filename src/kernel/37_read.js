/*
 * Reads with readiness: one Result per game read.
 *
 * A game read can fail in ways a plain value hides: the bridge throws, a list
 * drops entries it cannot read, or the zone is still loading. Folding those
 * into 0, [], false or Idle makes a caller act on facts that were never read.
 * A source here returns a Result instead, so every caller can tell "nothing
 * there" from "could not look".
 *
 * Result: { state, value, lost, why, zoneId }, never null.
 *   ok          value is complete; lost is 0.
 *   partial     value holds the facts that were read; lost counts the ones
 *               that were not, so "absent from the value" proves nothing.
 *   unreadable  the read failed; value is null and why says how.
 *   notReady    the game cannot answer yet (zone loading); value is null.
 * has() accepts ok and partial (present facts are usable); isOk() and
 * absent() accept only ok, because only a complete read proves an absence.
 *
 * Sources register with a scope that says how long one answer holds:
 *   zone    memoized per read pass and viewed zone id, so a zone switch inside
 *           a pass misses the memo instead of serving the old island.
 *   pass    memoized per read pass, without a zone part.
 *   static  game definitions: an ok answer is kept for the session, because a
 *           definition never changes once read; a non-ok answer is kept only
 *           for the pass, so a bridge hiccup never sticks.
 *   live    never memoized.
 * The memo is hostRead's, so there is one memo and it dies with the pass.
 * opts.live and opts.zone bypass it, and so does any argument that is not a
 * string or a number (it would not make a stable key). A throwing source is
 * unreadable and not memoized, so the next read in the pass tries again.
 * Inside a pass every non-ok answer marks the pass unsettled, so a view can
 * redraw once the game has caught up.
 *
 * A pass never wraps an action def, a send or actions.attempt: those run later
 * from the kernel queue, so their reads stay live and verification never sees
 * a planning-time answer.
 *
 * wait() turns a non-ready read into a bounded wait instead of a decision: the
 * caller skips its work, the module is woken to try again, and after enough
 * tries and time the wait expires once so the caller can warn. readRefusal()
 * names the precheck refusals that only mean "a read failed, nothing went
 * out", so a caller can tell them from real refusals in one place.
 *
 * Bundle slot: kernel, after 36_hostread.js and before 40_registry.js. It needs
 * the namespace, TIMEOUTS, LIMITS and hostRead at load; zone, registry and
 * scheduler only at run time, so every core file can register its sources
 * while it loads. Sources and the static cache start empty on a script reload,
 * and the core files register again.
 */

(function (S) {
    'use strict';

    var HR = S.kernel.hostRead;
    var has = Object.prototype.hasOwnProperty;

    var OK = 'ok';
    var PARTIAL = 'partial';
    var UNREADABLE = 'unreadable';
    var NOT_READY = 'notReady';

    var STATES = {};
    STATES[OK] = true;
    STATES[PARTIAL] = true;
    STATES[UNREADABLE] = true;
    STATES[NOT_READY] = true;

    // A list, not an object literal: 'static' is a reserved word the minifier
    // would turn into a bare key, which the AIR engine may not parse.
    var SCOPES = ['zone', 'pass', 'static', 'live'];

    var sources = {};     // name -> { read, scope }
    var staticOk = {};    // name + '|' + arg -> ok Result of a static source
    var waits = {};       // owner + '|' + key -> wait record kept here
    var refusals = {};    // registered read-refusal strings

    function make(state, value, lost, why, zoneId) {
        return {
            state: state,
            value: value,
            lost: lost,
            why: why === undefined ? null : why,
            zoneId: zoneId === undefined ? null : zoneId
        };
    }

    function ok(value, zoneId) { return make(OK, value, 0, null, zoneId); }

    function partial(value, lost, why, zoneId) {
        return make(PARTIAL, value, typeof lost === 'number' ? lost : 0, why, zoneId);
    }

    function unreadable(why, zoneId) { return make(UNREADABLE, null, 0, why, zoneId); }

    function notReady(why, zoneId) { return make(NOT_READY, null, 0, why, zoneId); }

    function isResult(r) {
        return !!r && typeof r === 'object' && typeof r.state === 'string' && has.call(STATES, r.state);
    }

    function isOk(r) { return !!r && r.state === OK; }

    function hasFacts(r) { return !!r && (r.state === OK || r.state === PARTIAL); }

    // Absence is proven only by a complete list: a partial one may have lost
    // exactly the entry the caller looks for.
    function absent(r, test) {
        if (!isOk(r)) return false;
        var v = r.value;
        if (!v || typeof v.length !== 'number') return false;
        for (var i = 0; i < v.length; i++) {
            if (test(v[i])) return false;
        }
        return true;
    }

    function num(r) {
        if (!isOk(r)) return null;
        return (typeof r.value === 'number' && isFinite(r.value)) ? r.value : null;
    }

    function show(r, fmt) {
        if (!isOk(r)) return '?';
        return typeof fmt === 'function' ? fmt(r.value) : String(r.value);
    }

    function message(e) {
        return (e && e.message) ? e.message : String(e);
    }

    // A second registration replaces the first: a script reload re-runs the
    // core files, and the newest read function must win.
    function source(name, def) {
        if (typeof name !== 'string' || !name) throw new Error('read.source: name required');
        if (!def || typeof def.read !== 'function') throw new Error('read.source: ' + name + ' needs a read function');
        if (SCOPES.indexOf(def.scope) < 0) throw new Error('read.source: ' + name + ' has unknown scope ' + def.scope);
        sources[name] = { read: def.read, scope: def.scope };
        // A replaced static source must not answer from the old one's cache.
        var prefix = name + '|';
        var drop = [];
        for (var k in staticOk) {
            if (has.call(staticOk, k) && k.indexOf(prefix) === 0) drop.push(k);
        }
        for (var i = 0; i < drop.length; i++) delete staticOk[drop[i]];
    }

    // The zone id is read once per get and only for zone sources; a missing or
    // throwing zone reader leaves it null rather than failing the read.
    function readZoneId() {
        try {
            var z = S.core && S.core.zone;
            if (!z || typeof z.id !== 'function') return null;
            var id = z.id();
            return id === undefined ? null : id;
        } catch (e) {
            return null;
        }
    }

    function keyable(arg) {
        return arg === undefined || typeof arg === 'string' || typeof arg === 'number';
    }

    function argPart(arg) {
        return arg === undefined ? '' : String(arg);
    }

    // A source that returns something other than a Result is a fault of the
    // source, reported as unreadable so callers keep one contract.
    function checked(r, zoneId) {
        return isResult(r) ? r : unreadable('bad result', zoneId);
    }

    function get(name, arg, opts) {
        if (typeof name !== 'string' || !has.call(sources, name)) {
            throw new Error('read.get: unknown source ' + name);
        }
        opts = opts || {};
        var src = sources[name];
        var live = opts.live === true;
        var staticKey = name + '|' + argPart(arg);

        if (!live && src.scope === 'static' && keyable(arg) && has.call(staticOk, staticKey)) {
            return staticOk[staticKey];
        }

        var zoneId = src.scope === 'zone' ? readZoneId() : null;
        var ctx = { zone: opts.zone || null, zoneId: zoneId, live: live };
        var memo = HR.inPass() && !live && !opts.zone && src.scope !== 'live' && keyable(arg);
        var r;
        try {
            if (memo) {
                var key = 'read.' + name + '|' + argPart(arg);
                if (src.scope === 'zone') key += '|' + zoneId;
                // A throw inside cached is not memoized; it is caught here.
                r = HR.cached(key, function () { return checked(src.read(arg, ctx), zoneId); });
            } else {
                r = checked(src.read(arg, ctx), zoneId);
            }
        } catch (e) {
            r = unreadable('threw: ' + message(e), zoneId);
        }

        if (r.state === OK) {
            if (src.scope === 'static' && keyable(arg)) staticOk[staticKey] = r;
        } else if (HR.inPass()) {
            HR.markUnsettled();
        }
        return r;
    }

    function clearRecord(rec) {
        rec.since = null;
        rec.tries = 0;
    }

    // 'go' when the read is usable, 'wait' while it may still settle, and
    // 'expired' once per window when it did not settle within both the tries
    // and the time limit; expiry starts a fresh window, so a caller that warns
    // on 'expired' warns once per window instead of on every plan.
    function wait(owner, key, r, opts) {
        opts = opts || {};
        var go = opts.accept === PARTIAL ? hasFacts(r) : isOk(r);
        var memKey = owner + '|' + key;
        var rec = opts.record || null;

        if (go) {
            if (rec) clearRecord(rec);
            else delete waits[memKey];
            return 'go';
        }

        if (!rec) {
            if (!has.call(waits, memKey)) waits[memKey] = { since: null, tries: 0 };
            rec = waits[memKey];
        }
        var now = Date.now();
        if (typeof rec.since !== 'number') {
            rec.since = now;
            rec.tries = 0;
        }
        rec.tries = (typeof rec.tries === 'number' ? rec.tries : 0) + 1;

        var maxTries = opts.tries || S.kernel.LIMITS.READ_WAIT_TRIES;
        var maxMs = opts.ms || S.kernel.TIMEOUTS.READ_MAX_MS;
        if (rec.tries >= maxTries && now - rec.since >= maxMs) {
            if (opts.record) clearRecord(rec);
            else delete waits[memKey];
            return 'expired';
        }

        // Only a registered module can be woken; any other owner simply tries
        // again on its own next run.
        if (opts.wake !== false && S.kernel.registry && S.kernel.scheduler &&
                S.kernel.registry.get(owner)) {
            S.kernel.scheduler.wake(owner, S.kernel.TIMEOUTS.READ_RETRY_MS);
        }
        return 'wait';
    }

    function clearWait(owner, key) {
        delete waits[owner + '|' + key];
    }

    function readRefusal(reason) {
        refusals[reason] = true;
        return reason;
    }

    function isReadRefusal(reason) {
        return typeof reason === 'string' && has.call(refusals, reason);
    }

    S.kernel.read = {
        OK: OK,
        PARTIAL: PARTIAL,
        UNREADABLE: UNREADABLE,
        NOT_READY: NOT_READY,
        ok: ok,
        partial: partial,
        unreadable: unreadable,
        notReady: notReady,
        isOk: isOk,
        has: hasFacts,
        absent: absent,
        num: num,
        show: show,
        message: message,
        source: source,
        get: get,
        wait: wait,
        clearWait: clearWait,
        readRefusal: readRefusal,
        isReadRefusal: isReadRefusal
    };

}(Steward));
