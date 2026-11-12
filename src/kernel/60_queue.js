/*
 * Action queue.
 *
 * Modules call Steward.kernel.queue.add(name, params, delay) from their plan()
 * functions. Actions are registered once per name via queue.action(name, fn).
 *
 * drain() runs from the scheduler at the end of each tick and of each wake.
 * Each entry carries its own delay (default QUEUE_ACTION_GAP_MS), which holds
 * the queue after that action runs: the next action never fires sooner than one
 * entry delay after the previous one, however often drain() is called.
 *
 * The guard defers the queue while a host dialog is visible. It logs the start
 * of a deferral, a rate-limited repeat, one stale warning and the end, and it
 * never expires on its own, because a false resume would close a window the
 * user is working in.
 */

(function (S) {

    var actions = {};                  // { name: fn(params) }
    var queue = [];                    // [{ name, params, delay, moduleId }]
    var draining = false;
    var currentlyRunningModule = null; // moduleId of the action currently executing
    var deferral = null;               // { since, loggedAt, ids, warned } while the guard holds
    // A throw outside the action call repeats on every poll, so a persistent
    // fault writes one line per LOG_REPEAT_MS with a count of the lines held
    // back. The limiter never throws, so logging never stops the queue.
    var runOneThrewNote = S.kernel.log.limited(function () { return S.kernel.TIMEOUTS.LOG_REPEAT_MS; });
    var generation = 0;                // bumped by reset(), so a stale poll timer cannot start a second chain

    function action(name, fn) {
        if (!name || typeof name !== 'string') {
            S.kernel.error('queue', 'action: name must be a non-empty string');
            return false;
        }
        if (typeof fn !== 'function') {
            S.kernel.error('queue', 'action:', name, 'requires a function');
            return false;
        }
        if (actions[name]) {
            S.kernel.warn('queue', 'action:', name, 'replacing previous handler');
        }
        actions[name] = fn;
        return true;
    }

    function add(name, params, delay) {
        if (!actions[name]) {
            S.kernel.warn('queue', 'add: unknown action', name, '— dropping');
            return false;
        }
        // moduleId is the id of the module currently inside its plan() / boot()
        // call. Tracked by the scheduler / lifecycle via S.kernel._currentModule.
        // Entries added while a tagged action runs inherit that action's tag, so
        // an action that re-enqueues itself (a send-then-verify loop) keeps its
        // module busy and stays cancellable with it. Standalone calls (e.g. from
        // event handlers) get null.
        var moduleId = S.kernel._currentModule || currentlyRunningModule || null;
        queue.push({
            name:     name,
            params:   params || [],
            delay:    typeof delay === 'number' ? delay : S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS,
            moduleId: moduleId
        });
        if (queue.length > S.kernel.LIMITS.QUEUE_DEPTH_WARN) {
            S.kernel.warn('queue', 'depth=' + queue.length, 'exceeds threshold');
        }
        return true;
    }

    function cancelByModule(targetModuleId) {
        if (!targetModuleId) return 0;
        var kept = [];
        var removed = 0;
        for (var i = 0; i < queue.length; i++) {
            if (queue[i].moduleId === targetModuleId) removed++;
            else kept.push(queue[i]);
        }
        queue = kept;
        if (removed > 0) S.kernel.log('queue', 'cancelled', removed, 'pending action(s) for module', targetModuleId);
        return removed;
    }

    function depthByModule(targetModuleId) {
        if (!targetModuleId) return 0;
        var n = 0;
        for (var i = 0; i < queue.length; i++) {
            if (queue[i].moduleId === targetModuleId) n++;
        }
        return n;
    }

    // A module is "busy" while it has any pending or in-flight queue work.
    // The scheduler consults this before invoking plan() — a busy module is
    // skipped so it can't pile new actions on top of unfinished ones. See
    // docs/SCHEDULER.md "Module busy contract".
    function isModuleBusy(targetModuleId) {
        if (!targetModuleId) return false;
        if (currentlyRunningModule === targetModuleId) return true;
        return depthByModule(targetModuleId) > 0;
    }

    function runningModule() { return currentlyRunningModule; }

    // The raw id ('' when it has none) of every visible host dialog, in
    // document order. Bootstrap modals (used by the host's Modal class and
    // userscripts) carry role="dialog". We treat any visible one as a "user
    // has a window open" signal and defer to avoid taking it away from them.
    // A missing $ or a throwing lookup counts as no dialog.
    function visibleDialogs() {
        var ids = [];
        try {
            if (typeof $ === 'undefined') return [];
            var $d = $(S.kernel.HOST_DIALOG_SELECTOR);
            if (!$d || $d.length === 0) return [];
            $d.each(function (i, el) {
                var $el = $(el);
                if ($el.is(':visible')) {
                    var id = $el.attr('id');
                    ids.push(typeof id === 'string' ? id : '');
                }
            });
        } catch (e) {
            return [];
        }
        return ids;
    }

    // The one formatter for a dialog id list, shared by every line that names
    // the dialogs holding the queue.
    function dialogList(ids) {
        if (!ids || ids.length === 0) return 'none';
        var parts = [];
        for (var i = 0; i < ids.length; i++) {
            parts.push(ids[i] ? '#' + ids[i] : '(no id)');
        }
        return parts.join(', ');
    }

    function seconds(ms) { return Math.round(ms / 1000); }

    // Logs the start of a deferral, a repeat at most once per LOG_REPEAT_MS
    // and one stale warning. Nothing is written per poll, and a logging fault
    // never reaches runOne, so it cannot skip the next poll.
    function noteDeferring(ids) {
        try {
            var now = Date.now();
            var depthNow = queue.length;
            if (deferral === null) {
                deferral = { since: now, loggedAt: now, ids: ids, warned: false };
                S.kernel.log('queue', 'deferring ' + depthNow + ' action(s): dialog visible: ' + dialogList(ids));
                return;
            }
            deferral.ids = ids;
            if (now - deferral.loggedAt >= S.kernel.TIMEOUTS.LOG_REPEAT_MS) {
                deferral.loggedAt = now;
                S.kernel.log('queue', 'still deferring ' + depthNow + ' action(s) after ' +
                    seconds(now - deferral.since) + ' s: dialog visible: ' + dialogList(ids));
            }
            // A wedged stage can keep a steward modal shown behind the game,
            // where the user cannot see it, so a long hold says where to look.
            if (!deferral.warned && now - deferral.since >= S.kernel.TIMEOUTS.QUEUE_MODAL_STALE_MS) {
                deferral.warned = true;
                S.kernel.warn('queue', 'held ' + Math.floor((now - deferral.since) / 60000) +
                    ' min by dialog ' + dialogList(ids) +
                    '; if no steward window is on screen the game may be covering it: restart the client');
            }
        } catch (e) { /* logging never stops the queue */ }
    }

    // Ends a deferral: 'resumed' (no dialog left), 'empty' (the queue emptied
    // while held) or 'reset' (the queue is about to be dropped while held).
    function noteDeferralEnd(kind) {
        try {
            if (deferral === null) return;
            var s = seconds(Date.now() - deferral.since);
            if (kind === 'resumed') {
                S.kernel.log('queue', 'resumed after ' + s + ' s');
            } else if (kind === 'empty') {
                S.kernel.log('queue', 'deferral ended after ' + s + ' s: queue empty');
            } else if (kind === 'reset') {
                S.kernel.log('queue', 'reset while deferring after ' + s + ' s, ' +
                    queue.length + ' action(s) dropped');
            }
        } catch (e) { /* logging never stops the queue */ }
        deferral = null;
    }

    // One queue step. Returns null to stop draining, else the delay before
    // the next poll.
    function step() {
        if (queue.length === 0) {
            noteDeferralEnd('empty');
            return null;
        }
        // Modal guard — defer (do NOT consume) while a host modal is visible.
        // The user has a window open; firing SelectBuilding / similar would
        // close it. Re-poll on a short cadence; resume the moment they close.
        var ids = visibleDialogs();
        if (ids.length > 0) {
            noteDeferring(ids);
            return S.kernel.TIMEOUTS.QUEUE_MODAL_RECHECK_MS;
        }
        noteDeferralEnd('resumed');
        var entry = queue.shift();
        currentlyRunningModule = entry.moduleId || null;
        try {
            actions[entry.name](entry.params);
        } catch (e) {
            S.kernel.error('queue', entry.name, 'threw:', e);
        }
        currentlyRunningModule = null;
        // The next poll waits for this action's delay.
        return entry.delay;
    }

    // A poll armed before reset() belongs to an older generation and does
    // nothing, so a later drain() cannot end up running two paced chains.
    function schedule(ms) {
        var gen = generation;
        setTimeout(function () { if (gen === generation) runOne(); }, ms);
    }

    // Always either arms the next poll or clears draining: a throw that left
    // draining set with no timer pending would make every later drain()
    // return at once and stop the queue for the life of the instance.
    function runOne() {
        var next = null;
        try {
            next = step();
        } catch (e) {
            runOneThrewNote('error', 'queue', 'runOne threw', e);
            next = queue.length > 0 ? S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS : null;
        }
        if (next === null) {
            draining = false;
            return;
        }
        schedule(next);
    }

    function drain() {
        if (draining) return;        // a previous drain is still pacing
        if (queue.length === 0) return;
        draining = true;
        runOne();
    }

    function depth() { return queue.length; }

    function isDraining() { return draining; }

    // The guard's current hold, or null. A fresh object on each call, so a
    // caller cannot change the queue's state through it.
    function deferralInfo() {
        if (deferral === null) return null;
        return {
            since: deferral.since,
            ms:    Date.now() - deferral.since,
            ids:   deferral.ids.slice(),
            depth: queue.length
        };
    }

    function reset() {
        noteDeferralEnd('reset');
        queue = [];
        draining = false;
        generation++;
        // Note: currentlyRunningModule is intentionally NOT cleared here.
        // If reset() is called while an action is mid-execution, that action
        // will finish and clear the flag itself.
    }

    S.kernel.queue = {
        action:         action,
        add:            add,
        drain:          drain,
        depth:          depth,
        reset:          reset,
        cancelByModule: cancelByModule,
        depthByModule:  depthByModule,
        isModuleBusy:   isModuleBusy,
        runningModule:  runningModule,
        visibleDialogs: visibleDialogs,
        dialogList:     dialogList,
        deferral:       deferralInfo,
        isDraining:     isDraining
    };

}(Steward));
