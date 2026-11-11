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
 * Bundle slot: kernel, after 35_host.js and before 40_registry.js. It needs
 * only the namespace; core and modules call it at run time. No state survives
 * a pass, so a script reload never inherits a memo.
 */

(function (S) {
    'use strict';

    // The open pass's memo, or null when no pass is open.
    var memo = null;

    function call(o, m) {
        if (!o) return undefined;
        var f = o[m];
        return typeof f === 'function' ? f.call(o) : undefined;
    }

    // A nested pass joins the open one, so an inner view model shares the
    // outer render's reads. Only the outermost pass drops the memo, also when
    // fn throws, so a failed pass never leaks values into the next one.
    function pass(fn) {
        if (memo !== null) return fn();
        memo = {};
        try {
            return fn();
        } finally {
            memo = null;
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

    S.kernel.hostRead = { call: call, pass: pass, cached: cached, inPass: inPass };

}(Steward));
