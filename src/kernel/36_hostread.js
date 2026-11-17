/*
 * Host reads: single member read and read pass.
 *
 * call(o, m) reads a host member once and invokes it on its owner. The AIR
 * bridge can show a member as a function and then as undefined on the next
 * read (docs/TSO_API.md), so the familiar `o.M ? o.M() : x` pattern reads twice
 * and can still throw "is not a function". Reading into a local first means
 * the check and the call see the same value. call() never catches: callers
 * keep their own try, because only they know what an unreadable member means.
 *
 * list(vec) copies a host vector into a plain array, or returns null when it
 * is not array-like. It is the one read here that catches, and only a throwing
 * toArray, because the index walk is a complete fallback; an index read that
 * throws still reaches the caller.
 *
 * A read pass is one synchronous, read-only stretch of work (a view model, a
 * window render, a module's planning pass) in which the same host lists would
 * otherwise be read many times. pass(fn) opens a memo for the length of fn;
 * cached(key, compute) answers from that memo inside a pass and computes fresh
 * outside one, so callers outside a pass see exactly today's behaviour. A pass
 * never wraps an action def, a send or actions.attempt: those run later from
 * the kernel queue and their verification reads must stay live. A cached value
 * is shared by every reader in the pass, so it is read-only to all of them.
 * Keys are namespaced '<area>.<what>' or '<area>.<what>|<arg>'.
 *
 * forget(prefix) drops the open pass's keys that start with prefix, for a
 * caller that changed the game inside the pass and needs the next read fresh.
 * markUnsettled() records that some read of the open pass was not complete;
 * unsettled() tells a view at the end of its pass that it drew from partial
 * facts and may redraw later. The flag belongs to the outermost pass: it resets
 * when that pass opens and reads false outside a pass. Both are no-ops outside
 * a pass, where nothing is memoized and no view is being drawn.
 *
 * Bundle slot: kernel, after 35_host.js and before 40_registry.js. It needs
 * only the namespace; core and modules call it at run time. No state survives
 * a pass, so a script reload never inherits a memo.
 */

(function (S) {
    'use strict';

    // The open pass's memo, or null when no pass is open.
    var memo = null;

    // Whether a read of the open pass came back incomplete.
    var unsettledFlag = false;

    function call(o, m) {
        if (!o) return undefined;
        var f = o[m];
        return typeof f === 'function' ? f.call(o) : undefined;
    }

    // Plain array copy of a host vector, or null when it is not array-like.
    // toArray() is tried first; a throwing toArray is swallowed because the
    // index walk below reads the same vector completely. An index read that
    // throws is not caught and reaches the caller.
    function list(vec) {
        if (!vec) return null;
        if (typeof vec.toArray === 'function') {
            try {
                var arr = vec.toArray();
                if (arr && typeof arr.length === 'number') vec = arr;
            } catch (e) {
                // The index walk below still reads the vector.
            }
        }
        if (typeof vec.length !== 'number') return null;
        var out = [];
        for (var i = 0; i < vec.length; i++) out.push(vec[i]);
        return out;
    }

    // A nested pass joins the open one, so an inner view model shares the
    // outer render's reads. Only the outermost pass drops the memo, also when
    // fn throws, so a failed pass never leaks values into the next one.
    function pass(fn) {
        if (memo !== null) return fn();
        memo = {};
        unsettledFlag = false;
        try {
            return fn();
        } finally {
            memo = null;
            unsettledFlag = false;
        }
    }

    // A throwing compute is not memoized, so the next read in the same pass
    // tries the host again. Null and undefined results are memoized: an
    // unreadable list stays unreadable for the rest of the pass.
    function cached(key, compute) {
        if (memo === null) return compute();
        if (Object.prototype.hasOwnProperty.call(memo, key)) return memo[key];
        // A pass opened inside compute joins this one, so memo is still open here.
        var v = compute();
        memo[key] = v;
        return v;
    }

    function inPass() {
        return memo !== null;
    }

    // Keys are collected first so deleting never disturbs the walk.
    function forget(prefix) {
        if (memo === null) return;
        var p = String(prefix);
        var drop = [];
        for (var k in memo) {
            if (Object.prototype.hasOwnProperty.call(memo, k) && k.indexOf(p) === 0) drop.push(k);
        }
        for (var i = 0; i < drop.length; i++) delete memo[drop[i]];
    }

    function markUnsettled() {
        if (memo !== null) unsettledFlag = true;
    }

    function unsettled() {
        return memo !== null && unsettledFlag;
    }

    S.kernel.hostRead = {
        call: call,
        list: list,
        pass: pass,
        cached: cached,
        inPass: inPass,
        forget: forget,
        markUnsettled: markUnsettled,
        unsettled: unsettled
    };

}(Steward));
