/*
 * Breaker: counts unverified actions in a row and pauses their sender.
 *
 * An action the client accepts but never applies still reports success, so a
 * caller that only trusts the send would repeat it without limit. A caller
 * that can see the outcome reports each one here: miss() for an action that
 * was not seen to take effect, verify() for one that was. `misses` misses in
 * a row open the breaker, which warns once and from then on admits one probe
 * every `cooldownMs`. The first verify closes it again, and reset(by)
 * clears it at once for an owner whose user switched the work back on.
 *
 * create() returns an independent instance per caller, so a sender that
 * keeps failing pauses only itself: the specialist send guard holds one, the
 * mining buff phase another. Each instance keeps only the run counter, the
 * open flag and the probe time; pending entries, holds and how a miss is
 * judged stay with the caller.
 *
 * State is memory only and built fresh each time the owning file runs, so a
 * script reload resets every instance.
 *
 * Bundle slot: core, loads after battles.js and before buffs.js and every
 * core/specialists/ file; the top level only assigns S.core.breaker.
 */

(function (S) {

    // One or two slow actions never trip it; a desynced batch trips it at once.
    var MISSES      = 5;
    var COOLDOWN_MS = 300000;

    // opts: { category, label, missText, pausedText, resumeText, misses?,
    // cooldownMs?, clock? }. The texts complete the open/closed log lines.
    function create(opts) {
        var o = opts || {};
        var category = o.category || 'breaker';
        var label    = o.label || 'breaker';
        var misses   = o.misses > 0 ? o.misses : MISSES;
        var cooldown = o.cooldownMs > 0 ? o.cooldownMs : COOLDOWN_MS;

        var run         = 0;    // unverified actions in a row
        var open        = false;
        var nextProbeAt = 0;

        var inst = {};

        function miss() {
            var t = inst.clock();
            run += 1;
            if (!open && run >= misses) {
                open = true;
                nextProbeAt = t + cooldown;
                S.kernel.warn(category, label + ' open: ' + run + ' ' + o.missText + '; ' +
                    o.pausedText + ', one probe every ' + Math.round(cooldown / 60000) +
                    ' min; reloading scripts resets it');
            }
            return open;
        }

        // what: names the verified action in the closed line.
        function verify(what) {
            run = 0;
            if (open) {
                open = false;
                S.kernel.log(category, label + ' closed: ' + what + ' verified, ' + o.resumeText);
            }
        }

        // How many of n actions may go out now. While open the first caller
        // after each cooldown gets one probe; the cooldown re-arms at once, so
        // a probe that misses waits a full cooldown before the next.
        function admit(n) {
            if (!(n > 0)) return 0;
            if (!open) return n;
            var t = inst.clock();
            if (t >= nextProbeAt) {
                nextProbeAt = t + cooldown;
                S.kernel.debug(category, label + ' open: one probe send allowed');
                return 1;
            }
            return 0;
        }

        // by: names who reset it in the log line; optional.
        function reset(by) {
            run = 0;
            open = false;
            nextProbeAt = 0;
            S.kernel.log(category, label + ' reset' + (by ? ' by ' + by : ''));
        }

        function isOpen() {
            return open;
        }

        function snapshot() {
            return { open: open, run: run, nextProbeAt: nextProbeAt };
        }

        inst.clock       = typeof o.clock === 'function' ? o.clock : function () { return Date.now(); };
        inst.MISSES      = misses;
        inst.COOLDOWN_MS = cooldown;
        inst.miss        = miss;
        inst.verify      = verify;
        inst.admit       = admit;
        inst.reset       = reset;
        inst.isOpen      = isOpen;
        inst.snapshot    = snapshot;
        return inst;
    }

    S.core.breaker = {
        MISSES:      MISSES,
        COOLDOWN_MS: COOLDOWN_MS,
        create:      create
    };

}(Steward));
