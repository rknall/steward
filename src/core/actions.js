/*
 * Action attempt runner.
 *
 * The one send / verify / retry state machine for every write to the game.
 * Other cores build a plain "def" object that says how to check, send and
 * observe one action; the caller runs it with
 * S.core.actions.attempt(def, onDone). Which action to run and when stays with
 * the caller, so the cores remain policy-free.
 *
 * Def shape (send, check and timeoutMs are required, the rest optional):
 *   label        string for the log lines
 *   category     log category of the owning core (default 'actions')
 *   satisfied()  true when the effect already holds; checked once before the
 *                first send, and then the action verifies with zero sends
 *   precheck()   null when the action may be sent, else a reason string
 *   baseline()   read once, right before the first send; passed on as base
 *   send(base)   issues the host call(s); true when they were issued;
 *                NOT_SENT when it made no host call (nothing went out)
 *   check(base)  true when the expected effect is observed
 *   observable() false while the effect cannot be read right now (for
 *                example the caller's zone is not viewed). Such a poll runs
 *                no check and does not use up the window or the quiet time.
 *                Held polls are capped at HOLD_MAX_MS per attempt; after
 *                that every poll counts again. A throwing observable counts
 *                as observable
 *   refuted(base)  a non-empty string when readable state shows the send
 *                was processed and turned down (for example a stack the
 *                server put back). Asked only on a poll whose check ran and
 *                came back false; a string ends the attempt at once as
 *                Failed with refuted: true and no retry, even when retries
 *                allows one. Unlike a ledger failedProof ("the effect is
 *                absent", safe only late), it names an observed rejection,
 *                so it may end the window early. A throwing refuted counts
 *                as no proof
 *   describe(base)  optional extra text for the final log line
 *   timeoutMs    verify window per send
 *   checkAfterMs no check runs before this much time has passed since the
 *                send, counted in polls like timeoutMs; it must be below
 *                timeoutMs. For a send whose effect is only read once the
 *                game has settled, so an early read cannot end it
 *   retries      how many more sends may follow the first (default RETRIES);
 *                0 for an action that must not go out twice
 * Every callback is wrapped in try/catch. satisfied, precheck, check and
 * describe re-find host objects themselves; send may use what its precheck
 * found, since sendStep always runs precheck right before send in the same
 * step.
 *
 * Observation rule: satisfied and check return true only on a positive,
 * successful observation of the effect. A packet that went out is not success,
 * and neither is an absent object or a failed read. The readers that defs use
 * report a failed read as null (or { ok: false }) so a def can tell "read
 * failed" from "empty", and a def treats a failed read as not observed.
 *
 * Each send is followed by checks until the window is used up, then the retry
 * the def allows (which first checks whether the effect arrived late), then a
 * named failure. A failure because the effect was never seen carries
 * unseen: true on its result, so a caller can tell it from a refusal or a send
 * that failed; the action may still have gone out. A failure that refuted()
 * proved carries refuted: true instead and no unseen: the send was answered
 * with a rejection, so nothing is pending.
 * The window counts the polls that actually ran, not wall time: a check that
 * the modal guard or a queue backlog deferred does not use up the window,
 * and neither does a poll held because observable() returned false.
 *
 * Every step runs as a 'core.attempt' queue entry carrying the poll gap, so
 * the gap between a send and its first check, and between checks, is one
 * poll. A reload resets the kernel queue, which drops an attempt in flight
 * without calling its onDone; callers re-derive what to do from game state.
 *
 * Bundle slot: core, first core file (before adventures.js). The top level
 * fills S.ActionResult, assigns S.core.actions and registers the queue
 * action; everything else happens at call time.
 */

(function (S) {

    S.ActionResult.Verified = 'ActionVerified';
    S.ActionResult.Refused  = 'ActionRefused';
    S.ActionResult.Failed   = 'ActionFailed';

    // By default at most one retry, so an action is sent at most twice and
    // never a third time.
    var RETRIES = 1;

    var STEP = 'core.attempt';

    var DEFAULT_CATEGORY = 'actions';

    // Returned by a send that made no host call. Nothing went out, so the
    // attempt ends without a retry and the caller may try again later with
    // no risk of a double send.
    var NOT_SENT = 'nothing sent';

    // Reason of a Failed result whose last send returned false: the host call
    // was made, so whether the packet went out is not known.
    var SEND_FAILED = 'send failed';

    // Most time per attempt that polls may be held by observable(). A held
    // attempt stays queued and keeps its module busy, so a hold must end on
    // its own even when the effect never becomes readable.
    var HOLD_MAX_MS = 60000;

    // Poll gap: the kernel's own spacing between queued actions, read at call
    // time. A non-positive value would make the window never close, so it is
    // floored at 1 ms.
    function pollGap() {
        var ms = S.kernel.TIMEOUTS && S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS;
        return (typeof ms === 'number' && ms > 0) ? ms : 1;
    }

    function retriesOf(def) {
        return (typeof def.retries === 'number' && def.retries >= 0) ? def.retries : RETRIES;
    }

    function categoryOf(def) {
        return (typeof def.category === 'string' && def.category) ? def.category : DEFAULT_CATEGORY;
    }

    function labelOf(def) {
        return (typeof def.label === 'string' && def.label) ? def.label : 'action';
    }

    // Calls an optional def callback. Returns { ok, value }; ok is false when
    // the callback threw (warned under the def's category).
    function call(state, name, arg) {
        var def = state.def;
        if (typeof def[name] !== 'function') return { ok: true, value: undefined };
        try {
            return { ok: true, value: def[name](arg) };
        } catch (e) {
            S.kernel.warn(categoryOf(def), labelOf(def) + ': ' + name + ' threw:', e);
            return { ok: false, value: undefined };
        }
    }

    // A throwing check counts as not observed.
    function observed(state) {
        var r = call(state, 'check', state.base);
        return r.ok && r.value === true;
    }

    // The def's proof that the send was turned down, or null. A throwing,
    // missing or non-string answer, or an empty string, is no proof.
    function refutation(state) {
        var r = call(state, 'refuted', state.base);
        return (r.ok && typeof r.value === 'string' && r.value !== '') ? r.value : null;
    }

    function enqueue(state) {
        return S.kernel.queue.add(STEP, [state], pollGap()) === true;
    }

    function finish(state, status, reason, unseen, refuted) {
        var def = state.def;
        state.phase = 'done';
        var result = {
            status: status,
            label:  labelOf(def),
            reason: reason || '',
            sends:  state.sends
        };
        if (unseen === true) result.unseen = true;
        if (refuted === true) result.refuted = true;
        var text = result.label + ': ' + status + ' after ' + state.sends + ' send(s)';
        if (result.reason) text += ' (' + result.reason + ')';
        var extra = call(state, 'describe', state.base);
        if (extra.ok && extra.value !== undefined && extra.value !== null && extra.value !== '') {
            text += '; ' + String(extra.value);
        }
        if (status === S.ActionResult.Verified) S.kernel.log(categoryOf(def), text);
        else S.kernel.warn(categoryOf(def), text);

        if (typeof state.onDone === 'function') {
            try {
                state.onDone(result);
            } catch (e) {
                S.kernel.error(categoryOf(def), result.label + ': onDone threw:', e);
            }
        }
        return result;
    }

    function sendStep(state) {
        var first = state.sends === 0;

        if (first && !state.started) {
            var sat = call(state, 'satisfied');
            if (sat.ok && sat.value === true) {
                finish(state, S.ActionResult.Verified, '');
                return;
            }
        }

        // A retry first looks for an effect that arrived after the window.
        if (!first && observed(state)) {
            finish(state, S.ActionResult.Verified, '');
            return;
        }

        var pre = call(state, 'precheck');
        var reason = null;
        if (!pre.ok) reason = 'precheck threw';
        else if (pre.value !== null && pre.value !== undefined) reason = String(pre.value) || 'precheck refused';
        if (reason !== null) {
            if (first) finish(state, S.ActionResult.Refused, reason);
            else finish(state, S.ActionResult.Failed, 'retry refused: ' + reason);
            return;
        }

        if (!state.started) {
            state.started = true;
            state.base = call(state, 'baseline').value;
        }

        var sent = call(state, 'send', state.base);
        // Not counted as a send. On a retry an earlier send did go out, so
        // ending there is a real failure, as with a precheck refusing.
        if (sent.ok && sent.value === NOT_SENT) {
            if (first) finish(state, S.ActionResult.Refused, NOT_SENT);
            else finish(state, S.ActionResult.Failed, 'retry refused: ' + NOT_SENT);
            return;
        }
        state.sends++;
        if (!sent.ok || sent.value !== true) {
            if (state.sends <= retriesOf(state.def)) {
                S.kernel.warn(categoryOf(state.def), labelOf(state.def) + ': send failed, retrying');
                enqueue(state);
            } else {
                finish(state, S.ActionResult.Failed, SEND_FAILED);
            }
            return;
        }
        state.phase = 'check';
        state.polls = 0;
        enqueue(state);
    }

    // Whether this poll is still inside the def's quiet time. It uses the
    // poll count that also closes the window, so the quiet time and the
    // window can never disagree.
    function quiet(state) {
        var after = state.def.checkAfterMs;
        return typeof after === 'number' && (state.polls + 1) * pollGap() < after;
    }

    // Whether this poll is held: observable() returned false, so a check
    // now could only read the wrong state. A held poll is not counted, which
    // keeps the window and the quiet time on polls that could observe. Once
    // HOLD_MAX_MS of held polls are used up the hook is no longer asked.
    function hold(state) {
        if (state.holdDone) return false;
        var r = call(state, 'observable');
        if (!r.ok || r.value !== false) {
            state.holding = false;
            return false;
        }
        if (state.held * pollGap() >= HOLD_MAX_MS) {
            state.holdDone = true;
            S.kernel.warn(categoryOf(state.def), labelOf(state.def) + ': not observable for ' +
                HOLD_MAX_MS + ' ms, checking again');
            return false;
        }
        if (!state.holding) {
            state.holding = true;
            S.kernel.log(categoryOf(state.def), labelOf(state.def) + ': not observable, holding the check');
        }
        state.held++;
        return true;
    }

    function checkStep(state) {
        if (hold(state)) {
            enqueue(state);
            return;
        }
        if (!quiet(state)) {
            if (observed(state)) {
                finish(state, S.ActionResult.Verified, '');
                return;
            }
            // Only a poll that read the state may hear a rejection; a retry
            // would only be turned down the same way.
            var no = refutation(state);
            if (no !== null) {
                finish(state, S.ActionResult.Failed, no, false, true);
                return;
            }
        }
        state.polls++;
        if (state.polls * pollGap() >= state.def.timeoutMs) {
            if (state.sends <= retriesOf(state.def)) {
                S.kernel.warn(categoryOf(state.def), labelOf(state.def) + ': not observed, retrying');
                state.phase = 'send';
                enqueue(state);
            } else {
                finish(state, S.ActionResult.Failed, 'not observed within ' + state.def.timeoutMs + ' ms', true);
            }
            return;
        }
        enqueue(state);
    }

    // Queue handler: one call does one step of one attempt.
    function step(params) {
        var state = params && params[0];
        if (!state || !state.def) {
            S.kernel.error(DEFAULT_CATEGORY, 'step: missing attempt state');
            return;
        }
        if (state.phase === 'send') sendStep(state);
        else if (state.phase === 'check') checkStep(state);
        // phase 'done': a finished attempt ignores a stray entry.
    }

    function attempt(def, onDone) {
        if (!def || typeof def !== 'object') {
            S.kernel.error(DEFAULT_CATEGORY, 'attempt: def must be an object');
            return false;
        }
        if (typeof def.send !== 'function' || typeof def.check !== 'function') {
            S.kernel.error(categoryOf(def), labelOf(def) + ': attempt needs send and check functions');
            return false;
        }
        if (typeof def.timeoutMs !== 'number' || !(def.timeoutMs > 0)) {
            S.kernel.error(categoryOf(def), labelOf(def) + ': attempt needs timeoutMs > 0');
            return false;
        }
        if (def.checkAfterMs !== undefined &&
            (typeof def.checkAfterMs !== 'number' || !(def.checkAfterMs >= 0) || !(def.checkAfterMs < def.timeoutMs))) {
            S.kernel.error(categoryOf(def), labelOf(def) + ': attempt needs checkAfterMs >= 0 and below timeoutMs');
            return false;
        }
        var state = {
            def: def, onDone: onDone, phase: 'send', sends: 0, polls: 0, base: undefined, started: false,
            held: 0, holding: false, holdDone: false
        };
        return enqueue(state);
    }

    S.core.actions = {
        RETRIES:  RETRIES,
        STEP:     STEP,
        NOT_SENT: NOT_SENT,
        SEND_FAILED: SEND_FAILED,
        HOLD_MAX_MS: HOLD_MAX_MS,
        attempt:  attempt,
        step:     step
    };

    // The kernel loads before core, and a reload re-runs the kernel queue
    // file first, so this never replaces an earlier handler.
    S.kernel.queue.action(STEP, step);

}(Steward));
