/*
 * Action queue.
 *
 * Modules call Steward.kernel.queue.add(name, params, delay) from their plan()
 * functions. Actions are registered once per name via queue.action(name, fn).
 *
 * drain() runs from the scheduler at the end of each tick. Each action runs
 * after its own delay (default QUEUE_ACTION_GAP_MS). Actions never fire faster
 * than the kernel tick.
 */

(function (S) {

    var actions = {};    // { name: fn(params) }
    var queue = [];      // [{ name, params, delay }]
    var draining = false;

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
        queue.push({
            name:   name,
            params: params || [],
            delay:  typeof delay === 'number' ? delay : S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS
        });
        if (queue.length > S.kernel.LIMITS.QUEUE_DEPTH_WARN) {
            S.kernel.warn('queue', 'depth=' + queue.length, 'exceeds threshold');
        }
        return true;
    }

    function isHostModalVisible() {
        try {
            // Bootstrap modals (used by host's Modal class and userscripts) carry
            // role="dialog". We treat any visible one as a "user has a window
            // open" signal and defer to avoid taking it away from them.
            if (typeof $ !== 'undefined' && $.fn && $.fn.length !== undefined) {
                return $('div[role="dialog"]:visible').length > 0;
            }
        } catch (e) { /* fall through */ }
        return false;
    }

    function runOne() {
        if (queue.length === 0) {
            draining = false;
            return;
        }
        // Modal guard — defer (do NOT consume) while a host modal is visible.
        // The user has a window open; firing SelectBuilding / similar would
        // close it. Re-poll on a short cadence; resume the moment they close.
        if (isHostModalVisible()) {
            setTimeout(runOne, S.kernel.TIMEOUTS.QUEUE_MODAL_RECHECK_MS);
            return;
        }
        var entry = queue.shift();
        try {
            actions[entry.name](entry.params);
        } catch (e) {
            S.kernel.error('queue', entry.name, 'threw:', e);
        }
        // Schedule next after this action's delay.
        setTimeout(runOne, entry.delay);
    }

    function drain() {
        if (draining) return;        // a previous drain is still pacing
        if (queue.length === 0) return;
        draining = true;
        runOne();
    }

    function depth() { return queue.length; }

    function reset() {
        queue = [];
        draining = false;
    }

    S.kernel.queue = {
        action: action,
        add:    add,
        drain:  drain,
        depth:  depth,
        reset:  reset
    };

}(Steward));
