/*
 * "Steward economy" window of the economy module.
 *
 * A separate host Modal rather than a dashboard tab: a grid of item icons
 * needs more room than a tab has.
 *
 * Two tabs, opening on Star to store: Star to store and Settings. There is
 * no Advisor tab: the advisor does not exist yet, and an empty tab would
 * only promise it.
 *
 * Header: a badge naming the state (one row per state of the menu's
 * stateOf, below) and the menu's statusText, so the window, the submenu and
 * the dashboard never word a status differently.
 *
 * Star to store: the status line, a note for the states that need one, the
 * storehouse tab strip and the grid of the active storehouse tab. One
 * storehouse tab shows at a time. The active one is window memory
 * (state.storeTab), never a setting: it starts on the first tab of the
 * strip, survives a redraw, and falls back to the first when its tab has
 * no rows any more. A strip click swaps only the grid body below the strip.
 *
 * A tile click applies at once, with no draft and no Save: it flips that
 * item's selection through S.modules.economy.toggle (one settings key),
 * reads that one row again and refills only that tile.
 *
 * Settings: the module switch, the ledger breaker with Reset, and the stale
 * sends with Clear. Every write applies at once.
 *
 * A tab body is built detached and swapped in only once complete: a view
 * that throws leaves a failure line in that tab, never a half-built body.
 *
 * Reload safety: the file starts no timers and caches no function from
 * another file. Every handler calls S.modules.economy.*, S.core.* and
 * S.kernel.* when it runs, so a window left open across a script reload
 * drives the new instance's code.
 *
 * Every user-visible string goes in with .text() through the kernel
 * helpers, never as HTML.
 *
 * Bundle slot: module, loads after the other economy files (name order);
 * every S.modules.economy.* reference happens at call time.
 */

(function (S) {
    'use strict';

    if (!S.modules.economy) S.modules.economy = {};

    var MODAL_ID = 'StewardEconomy';
    var TITLE = 'Steward economy';
    var OWNER = 'economy';

    var TABS = ['store', 'settings'];
    var TAB_LABELS = { store: 'Star to store', settings: 'Settings' };

    // Header badge per stateOf state. Only existing badge kinds; paused is
    // the red one.
    var HEADER = {
        off:        { kind: 'off',    text: 'Economy off' },
        breaker:    { kind: 'paused', text: 'Breaker open' },
        unreadable: { kind: 'paused', text: 'Unreadable' },
        storehouse: { kind: 'paused', text: 'Storehouse full' },
        sending:    { kind: 'busy',   text: 'Sending' },
        full:       { kind: 'ok',     text: 'Economy on' },
        ready:      { kind: 'ok',     text: 'Economy on' },
        empty:      { kind: 'ok',     text: 'Economy on' },
        idle:       { kind: 'ok',     text: 'Economy on' }
    };

    var FOOT_NOTE = 'Click a tile to select it; changes apply at once';

    var modal = null;
    var state = null;

    // ---- Small helpers --------------------------------------------------------

    function M() { return S.modules.economy; }
    function H() { return S.kernel.ui.helpers; }

    function textEl(tag, cls, text) {
        var $e = $('<' + tag + '>');
        if (cls) $e.addClass(cls);
        return $e.text(text);
    }

    function safe(fn, fallback) {
        try {
            var v = fn();
            return v === undefined ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    function pass(fn) {
        var hr = S.kernel.hostRead;
        if (hr && typeof hr.pass === 'function') return hr.pass(fn);
        return fn();
    }

    function shown() {
        var ui = S.kernel.ui;
        return !!(modal && ui && typeof ui.isModalShown === 'function' && ui.isModalShown(modal));
    }

    function readStatus() {
        return safe(function () { return M().model.status(); }, null) ||
            safe(function () { return M().model.emptyStatus(); }, null);
    }

    function stateName(st) {
        return safe(function () { return M().menu.stateOf(st); }, 'off');
    }

    function statusText(st) {
        return safe(function () { return M().menu.statusText(st); }, 'Economy status unavailable');
    }

    function applyNow() {
        var apply = S.kernel.lifecycle && S.kernel.lifecycle.applySettings
            ? S.kernel.lifecycle.applySettings[OWNER] : null;
        if (typeof apply === 'function') apply();
    }

    // ---- Shell ----------------------------------------------------------------

    // One read pass per render: the status and the grid share the host
    // lists they would otherwise each read again.
    function render() {
        pass(renderNow);
    }

    function renderNow() {
        if (!modal || !state) return;
        var $body = modal.Body();
        if (!$body || !$body.length) return;
        var st = readStatus();
        var $panel = $('<div>', { 'class': 'steward-panel steward-compact' });
        $panel.append(headerLine(st));
        $panel.append(tabBar());
        $panel.append(tabBody(st));
        $body.empty();
        $body.append($panel);
        if (!state.footDone) renderFooter();
    }

    function headerLine(st) {
        var h = H();
        var row = HEADER[stateName(st)] || HEADER.off;
        var $line = $('<div>', { 'class': 'steward-subhead' });
        $line.append(h.badge(row.kind, row.text));
        $line.append(textEl('span', null, ' ' + statusText(st)));
        return $line;
    }

    function tabBar() {
        var items = [];
        for (var i = 0; i < TABS.length; i++) items.push({ id: TABS[i], label: TAB_LABELS[TABS[i]] });
        return H().chips(items, state.tab, function (id) {
            if (TABS.indexOf(id) === -1) return;
            state.tab = id;
            render();
        });
    }

    function failureLine($c, e) {
        var message = e && e.message ? e.message : String(e);
        $c.append(textEl('div', 'steward-bad',
            'This view could not be shown: ' + message + ' (details in the console log)'));
    }

    function tabBody(st) {
        var $box = $('<div>');
        try {
            if (state.tab === 'settings') renderSettings($box, st);
            else renderStore($box, st);
        } catch (e) {
            S.kernel.error(OWNER, 'render ' + state.tab + ' tab threw:', e);
            $box = $('<div>');
            failureLine($box, e);
        }
        return $box;
    }

    // ---- Star to store tab ----------------------------------------------------

    function resetBreaker() {
        try { S.core.ledger.breaker(M().OWNER).reset('the user'); }
        catch (e) { S.kernel.error(OWNER, 'breaker reset threw:', e); }
        render();
    }

    function rowsOf(grid, key) {
        if (!grid) return null;
        if (key === M().views.OTHER) return grid.other || [];
        var tabs = grid.tabs || [];
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i] && tabs[i].key === key) return tabs[i].rows || [];
        }
        return [];
    }

    // The active strip key: kept while its tab is in the strip, else the
    // first one.
    function activeKey(grid) {
        var keys = M().views.stripKeys(grid);
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].key === state.storeTab) return state.storeTab;
        }
        return keys.length ? keys[0].key : null;
    }

    function drawGrid() {
        if (!state || !state.$grid) return;
        var rows = state.grid ? rowsOf(state.grid, state.storeTab) : null;
        M().views.grid(state.$grid, H(), rows, {}, { toggle: onTile, redraw: redrawGrid });
    }

    // The icon retry: reads the grid again and redraws only the grid body,
    // unless the active tab left the strip, which needs the strip redrawn.
    function redrawGrid() {
        if (!shown() || !state || state.tab !== 'store') return;
        pass(function () {
            var grid = safe(function () { return M().model.grid(); }, null);
            if (!grid || activeKey(grid) !== state.storeTab) {
                renderNow();
                return;
            }
            state.grid = grid;
            drawGrid();
        });
    }

    function onTile(name, $tile) {
        M().toggle(name);
        pass(function () {
            var rows = safe(function () { return M().model.items(); }, null) || [];
            var row = null;
            for (var i = 0; i < rows.length; i++) {
                if (rows[i] && rows[i].name === name) { row = rows[i]; break; }
            }
            // A deselected item that is not in the star menu is no row any
            // more, so its tile goes.
            if (!row) { $tile.remove(); return; }
            M().views.tile(H(), row, {}, null, $tile);
        });
    }

    function renderStore($c, st) {
        var h = H();
        var V = M().views;
        var name = stateName(st);
        $c.append(textEl('div', 'steward-muted', statusText(st)));
        if (name === 'breaker') $c.append(V.breakerBanner(h, st, resetBreaker));
        else {
            var $note = V.note(h, name);
            if ($note) $c.append($note);
        }
        var grid = M().model.grid();
        state.grid = grid;
        state.$grid = $('<div>');
        if (!grid) {
            // The unreadable state already says so above.
            if (name !== 'unreadable') V.grid(state.$grid, h, null);
            $c.append(state.$grid);
            return;
        }
        state.storeTab = activeKey(grid);
        $c.append(V.strip(grid, state.storeTab, function (key) {
            state.storeTab = key;
            drawGrid();
        }));
        $c.append(state.$grid);
        drawGrid();
    }

    // ---- Settings tab ---------------------------------------------------------

    function staleLine(h, entry) {
        var label = safe(function () { return S.core.locale.res(entry.name); }, entry.name) || entry.name;
        var at = typeof entry.sentAt === 'number' ? h.clock(new Date(entry.sentAt)) : '';
        return String(label) + ' · sent ' + (at || '-') + ', never seen';
    }

    function clearStale(key) {
        try { S.core.ledger.resolve(key, 'the user'); }
        catch (e) { S.kernel.error(OWNER, 'stale send clear threw:', e); }
        render();
    }

    function renderSettings($c, st) {
        var h = H();
        var s = safe(function () { return M().readSettings(); }, null) || {};
        var $card = h.card({ icon: '⚙', title: 'Settings', meta: 'Applies at once' });
        $card.append(h.field('Economy', 'Moves the selected star items into the storehouse',
            h.toggle({
                checked: s.enabled === true,
                write: function (v) {
                    S.kernel.settings.write(OWNER, { enabled: v });
                    S.kernel.log('ui', OWNER, 'enabled', '→', v);
                    applyNow();
                    render();
                }
            })));
        var open = !!(st && st.breaker && st.breaker.open === true);
        var $ctl = $('<span>');
        $ctl.append(h.badge(open ? 'paused' : 'ok', open ? 'Open' : 'Closed'));
        $ctl.append(h.button('Reset', { size: 'sm', disabled: !open, onClick: resetBreaker }));
        $card.append(h.field('Breaker', 'Stops repeats when sends are not confirmed', $ctl));
        $c.append($card);

        var stale = st && st.stale ? st.stale : [];
        var $stale = h.card({ title: 'Stale sends', meta: 'Sends the game never confirmed or refused' });
        if (!stale.length) $stale.append(textEl('div', 'steward-muted', 'No stale sends.'));
        for (var i = 0; i < stale.length; i++) {
            (function (entry) {
                if (!entry) return;
                var $row = $('<div>', { 'class': 'steward-tool' });
                $row.append(h.button('Clear', { size: 'sm', onClick: function () { clearStale(entry.key); } }));
                $row.append(textEl('span', null, staleLine(h, entry)));
                $stale.append($row);
            }(stale[i]));
        }
        $c.append($stale);
    }

    // ---- Footer ---------------------------------------------------------------

    function closeWindow() {
        // Hides only a shown window: a second hide during the fade would
        // unbalance the host's stage layer swap.
        if (S.kernel.ui && typeof S.kernel.ui.hideModal === 'function') S.kernel.ui.hideModal(modal);
    }

    // The same footer on both tabs, built once per open.
    function renderFooter() {
        var $footer = modal.Footer ? modal.Footer() : null;
        if (!$footer || !$footer.length) return;
        state.footDone = true;
        var $close = H().button('Close', { onClick: closeWindow });
        $close.addClass('steward-foot-right');
        $footer.empty();
        $footer.append(textEl('span', 'steward-foot-note', FOOT_NOTE)).append($close);
    }

    // ---- Open -----------------------------------------------------------------

    function open(tab) {
        if (typeof Modal === 'undefined') {
            S.kernel.error(OWNER, 'host Modal class unavailable — cannot open the economy window');
            S.kernel.ui.notify('The economy window needs the game window; try again once the island is loaded.');
            return;
        }
        // Hiding the dashboard would strand its unsaved changes, so an open
        // edit refuses.
        var ui = S.kernel.ui;
        if (ui && typeof ui.hasOpenEdits === 'function' && ui.hasOpenEdits()) {
            S.kernel.ui.notify('Save or close the open window first');
            return;
        }
        if (ui && typeof ui.ensureStyle === 'function') ui.ensureStyle(MODAL_ID);
        state = {
            tab: TABS.indexOf(tab) === -1 ? 'store' : tab,
            storeTab: null,
            grid: null,
            $grid: null,
            footDone: false
        };
        try {
            modal = new Modal(MODAL_ID, TITLE, true);
            modal.create();
            render();
            // The dashboard is clean here. Releasing it resets its buffer, so
            // its next open re-reads the settings and a write in this window
            // is never overwritten by a stale dashboard snapshot. It is not
            // hidden here: the host's Modal.show hides it, and a hide first
            // would fire a second hide event during its fade.
            if (ui && typeof ui.releaseDashboard === 'function') ui.releaseDashboard();
            if (ui && typeof ui.showModal === 'function') ui.showModal(modal);
            else modal.show();
        } catch (e) {
            S.kernel.error(OWNER, 'open economy window threw:', e);
        }
    }

    function close() {
        if (shown()) closeWindow();
    }

    function isOpen() {
        return shown();
    }

    // Redraws a shown window, keeping its tab and storehouse tab.
    function redraw() {
        if (shown()) render();
    }

    S.modules.economy.window = {
        open:   open,
        close:  close,
        isOpen: isOpen,
        redraw: redraw
    };

}(Steward));
