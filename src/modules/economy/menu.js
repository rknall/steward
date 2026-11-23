/*
 * Economy submenu of the native ~Steward~ menu, and the one set of status
 * words every economy surface uses.
 *
 * Layout, always the same three rows:
 *
 *   ✓/✕ Economy                  flips enabled
 *   6 selected · 3 ready · ...   display-only status line
 *   Open economy manager…        opens the Steward economy window
 *
 * There is no Transfer now row: selected items move on the next plan pass
 * anyway, so it would only skip the wait.
 *
 * The rows are built once and the same row objects are handed out on every
 * call; only their label functions follow the state. The submenu is never
 * rebuilt, because every native rebuild leaks objects in AIR, and a label
 * is written in place only when its text changed.
 *
 * A flip goes through the module's setEnabled, the one switch every economy
 * surface calls: it writes an object holding only `enabled`, at once and
 * with no Save (the host's settings store deep-merges, so the selection and
 * every other key keep their stored values), then runs the module's off
 * path, so the module alone decides what an off switch stops.
 *
 * openWindow is the one opener of the economy window; the dashboard tab and
 * tile use it too.
 *
 * Status words. stateOf(st) names the one state of a status object
 * (model.snapshot() or model.emptyStatus(); null reads as off). The first
 * state that holds wins:
 *
 *   off         no status, or enabled is not true      Economy off
 *   breaker     the ledger breaker is open             transfers paused
 *   unreadable  the star menu could not be read        star menu unreadable
 *   storehouse  warehouse cap hit, nothing ready or    <n> selected · storehouse full
 *               sending
 *   full        an item came back from the storehouse  <n> selected · <full> full
 *   sending     a transfer is in flight                <n> selected · <pending> sending
 *   empty       every selected item is none in star    <n> selected · star menu empty
 *               or out of its event
 *   ready       an item can move now                   <n> selected · <ready> ready
 *   idle        otherwise                              no items selected, or
 *                                                      <n> selected · <unknown> unreadable, or
 *                                                      <n> selected · nothing to move
 *
 * statusText(st) gives those words; statusLine(st) adds " · last pass HH:MM"
 * in the states where a pass time means something (full, sending, ready,
 * idle, empty). The submenu status row and the Overview tile use
 * statusLine, the dashboard and the window use statusText. No other file
 * words an economy status, so the surfaces cannot drift apart.
 *
 * Bundle slot: module, loads before module.js (name order); every other
 * S.modules.economy.* reference happens at call time.
 */

(function (S) {

    if (!S.modules.economy) S.modules.economy = {};

    var OWNER = 'economy';
    var SEP = ' · ';

    // The states that carry the last pass time: in the others (off, paused,
    // unreadable, storehouse full) a pass moves nothing, so its time would
    // only suggest work that is not happening.
    var PASS_STATES = { full: true, sending: true, ready: true, idle: true, empty: true };

    function M() { return S.modules.economy; }

    function num(v) { return S.kernel.is.finite(v) ? v : 0; }

    // The settings with their defaults applied, so a never stored `enabled`
    // reads as its default and flips from there. Falls back to the raw
    // stored object when the module part that merges them is not loaded.
    function current() {
        try {
            if (typeof M().readSettings === 'function') return M().readSettings() || {};
        } catch (e) {
            S.kernel.error(OWNER, 'readSettings threw:', e);
        }
        return S.kernel.settings.read(OWNER) || {};
    }

    function mark(on) { return on ? '✓ ' : '✕ '; }

    // One settings read per refresh pass.
    function settingsOf(pass) {
        if (!pass) return current();
        if (!pass.settings) pass.settings = current();
        return pass.settings;
    }

    // One status read per refresh pass. The snapshot is at most a few
    // seconds old, so the 5 s label refresh does not walk the star menu.
    function statusOf(pass) {
        if (pass && pass.status) return pass.status;
        var st = null;
        try {
            var model = M().model;
            if (model && typeof model.snapshot === 'function') st = model.snapshot();
        } catch (e) {
            S.kernel.error(OWNER, 'model snapshot threw:', e);
        }
        if (pass) pass.status = st;
        return st;
    }

    function stateOf(st) {
        if (!st || st.enabled !== true) return 'off';
        if (st.breaker && st.breaker.open === true) return 'breaker';
        if (st.readable === false) return 'unreadable';
        var selected = num(st.selected);
        var ready = num(st.ready);
        var pending = num(st.pending);
        if (num(st.warehouse) > 0 && ready === 0 && pending === 0) return 'storehouse';
        if (num(st.full) > 0) return 'full';
        if (pending > 0) return 'sending';
        if (selected > 0 && num(st.none) + num(st.offline) === selected) return 'empty';
        if (ready > 0) return 'ready';
        return 'idle';
    }

    function statusText(st) {
        var state = stateOf(st);
        if (state === 'off') return 'Economy off';
        if (state === 'breaker') return 'transfers paused';
        if (state === 'unreadable') return 'star menu unreadable';
        var head = num(st.selected) + ' selected' + SEP;
        if (state === 'storehouse') return head + 'storehouse full';
        if (state === 'full') return head + num(st.full) + ' full';
        if (state === 'sending') return head + num(st.pending) + ' sending';
        if (state === 'empty') return head + 'star menu empty';
        if (state === 'ready') return head + num(st.ready) + ' ready';
        if (num(st.selected) === 0) return 'no items selected';
        if (num(st.unknown) > 0) return head + num(st.unknown) + ' unreadable';
        return head + 'nothing to move';
    }

    function statusLine(st) {
        var text = statusText(st);
        if (!PASS_STATES[stateOf(st)]) return text;
        if (!st.lastPass || typeof st.lastPass.at !== 'number') return text;
        var at = S.kernel.ui && S.kernel.ui.helpers
            ? S.kernel.ui.helpers.clock(new Date(st.lastPass.at)) : '';
        return at ? text + SEP + 'last pass ' + at : text;
    }

    function flip() {
        try {
            M().setEnabled(current().enabled !== true);
            // The labels follow the flag on the next status tick anyway;
            // refreshing now shows the flip at once.
            if (S.kernel.ui && S.kernel.ui.status && typeof S.kernel.ui.status.refresh === 'function') {
                S.kernel.ui.status.refresh();
            }
        } catch (e) {
            S.kernel.error(OWNER, 'menu flip of enabled threw:', e);
        }
    }

    function openWindow() {
        var w = M().window;
        if (w && typeof w.open === 'function') {
            try { w.open(); }
            catch (e) { S.kernel.error(OWNER, 'window.open threw:', e); }
        } else {
            S.kernel.warn(OWNER, 'economy window is not loaded');
        }
    }

    var rows = [
        {
            label:    function (pass) { return mark(settingsOf(pass).enabled === true) + 'Economy'; },
            onSelect: flip
        },
        { label: function (pass) { return statusLine(statusOf(pass)); }, enabled: false },
        { label: 'Open economy manager…', onSelect: openWindow }
    ];

    // A copy of the list, so a caller that edits it cannot change the rows
    // the next call hands out; the row objects themselves are the same.
    function items() { return rows.slice(); }

    S.modules.economy.menu = {
        items:      items,
        stateOf:    stateOf,
        statusText: statusText,
        statusLine: statusLine,
        openWindow: openWindow
    };

}(Steward));
