/*
 * Production submenu of the native ~Steward~ menu.
 *
 * Layout, always the same seven rows:
 *
 *   ✓/✕ Auto-production          flips enabled
 *   N queues · M entries · ...   display-only status line
 *   Open production manager…     opens the Steward production window
 *   ----
 *   ✓/✕ Standing orders          flips standing
 *   ✓/✕ Building buffs           flips buffs
 *   ✓/✕ Bookbinder auto-complete flips bookComplete
 *
 * The row set never changes with state, only the label functions do, so
 * the submenu is never rebuilt: every native rebuild leaks objects in AIR,
 * and a label is written in place only when its text changed.
 *
 * A flip writes at once, with no Save, like the kernel's quick toggle. It
 * writes an object holding only the flipped key: the host's settings store
 * deep-merges, so the other keys keep their stored values and a stale read
 * never overwrites a key changed elsewhere in between. A dashboard Save
 * writes its buffer only for a namespace it changed, so it does not undo a
 * flip either.
 *
 * Every flip, on or off, then runs the module's applySettings, the same
 * hook a dashboard Save runs, so the submenu and the Save share one off
 * path and the module alone decides what an off switch stops. Off stops
 * only the module's own work; adventure runs keep ordering their own items.
 *
 * Bundle slot: module, loads before module.js (name order); every other
 * S.modules.production.* reference happens at call time.
 */

(function (S) {

    if (!S.modules.production) S.modules.production = {};

    var OWNER = 'production';

    function M() { return S.modules.production; }

    // The settings with their defaults applied, because a key never stored
    // (standing and buffs default to on) must read as its default and flip
    // from there. Falls back to the raw stored object when the module part
    // that merges them is not loaded.
    function current() {
        try {
            if (typeof M().readSettings === 'function') return M().readSettings() || {};
        } catch (e) {
            S.kernel.error('production', 'readSettings threw:', e);
        }
        return S.kernel.settings.read(OWNER) || {};
    }

    function mark(on) { return on ? '✓ ' : '✕ '; }

    // One settings read per refresh pass, shared by the four switch labels.
    function settingsOf(pass) {
        if (!pass) return current();
        if (!pass.settings) pass.settings = current();
        return pass.settings;
    }

    // One status read per refresh pass. The label reads the model's
    // snapshot, at most 30 s old, so the 5 s refresh does not walk the
    // queues; status() is the fallback when the model has no snapshot.
    function statusOf(pass) {
        if (pass && pass.status) return pass.status;
        var st = null;
        try {
            var model = M().model;
            if (model && typeof model.snapshot === 'function') st = model.snapshot();
            else if (model && typeof model.status === 'function') st = model.status();
        } catch (e) {
            S.kernel.error('production', 'model snapshot threw:', e);
        }
        if (pass) pass.status = st;
        return st;
    }

    function breakerOpen(snap) { return !!(snap && snap.open); }

    // The one status-line builder: the production window header reuses it
    // through S.modules.production.menu.statusText.
    function statusText(st) {
        if (!st) return 'Production status unavailable';
        var parts = [
            (st.queues || 0) + ' queues',
            (st.entries || 0) + ' entries'
        ];
        if (typeof st.nextDoneAt === 'number') {
            var at = S.kernel.ui && S.kernel.ui.helpers
                ? S.kernel.ui.helpers.clock(new Date(st.nextDoneAt)) : '';
            if (at) parts.push('next done ' + at);
        }
        var open = breakerOpen(st.orderBreaker) || breakerOpen(st.buffBreaker);
        parts.push('breaker ' + (open ? 'open' : 'ok'));
        return parts.join(' · ');
    }

    function flip(key) {
        try {
            var value = !current()[key];
            var o = {};
            o[key] = value;
            S.kernel.settings.write(OWNER, o);
            S.kernel.log('ui', OWNER, key, '→', value);
            // The module's applySettings decides what an off switch stops,
            // so the submenu and the dashboard Save share one off path.
            var apply = S.kernel.lifecycle && S.kernel.lifecycle.applySettings
                ? S.kernel.lifecycle.applySettings[OWNER] : null;
            if (typeof apply === 'function') apply();
            // The quick toggle and these labels follow the flag on the next
            // status tick anyway; refreshing now shows the flip at once.
            if (S.kernel.ui && S.kernel.ui.status && typeof S.kernel.ui.status.refresh === 'function') {
                S.kernel.ui.status.refresh();
            }
        } catch (e) {
            S.kernel.error('production', 'menu flip of', key, 'threw:', e);
        }
    }

    function toggleRow(key, text) {
        return {
            label:    function (pass) { return mark(!!settingsOf(pass)[key]) + text; },
            onSelect: function () { flip(key); }
        };
    }

    function openWindow() {
        var w = M().window;
        if (w && typeof w.open === 'function') {
            try { w.open(); }
            catch (e) { S.kernel.error('production', 'window.open threw:', e); }
        } else {
            S.kernel.warn('production', 'production window is not loaded');
        }
    }

    function items() {
        return [
            toggleRow('enabled', 'Auto-production'),
            { label: function (pass) { return statusText(statusOf(pass)); }, enabled: false },
            { label: 'Open production manager…', onSelect: openWindow },
            { separator: true },
            toggleRow('standing', 'Standing orders'),
            toggleRow('buffs', 'Building buffs'),
            toggleRow('bookComplete', 'Bookbinder auto-complete')
        ];
    }

    S.modules.production.menu = {
        items:      items,
        statusText: statusText
    };

}(Steward));
