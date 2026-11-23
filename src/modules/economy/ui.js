/*
 * Dashboard surface for the economy module.
 *
 * Owns the Economy tab and the Overview tile. The tab holds the module
 * switch and a read-only summary; the grid of star items lives only in the
 * Steward economy window, which the buttons and the tile link open, because
 * a grid of icons needs more room than a tab column has.
 *
 *   side      the settings column: the module switch, the status words and
 *             the Open manager button.
 *   render    the main column: the breaker banner (only while the ledger
 *             breaker is open), what economy does now (Selected, Ready,
 *             Full, Last moved), the items that came back full, the latest
 *             transfers and the pointer to the manager window.
 *   summary   the one-line strip.
 *   tiles     the Overview tile, its badge by state (table below).
 *
 * The switch calls the module's setEnabled, as the submenu and the window
 * do: it writes `enabled` at once, with no Save (the host's settings store
 * deep-merges, so the selection keeps its stored value), and runs the one
 * off path, so turning the module off here stops the same work as anywhere
 * else. The manager buttons use the submenu's openWindow and Reset the
 * module's resetBreaker.
 *
 * Every count comes from the model's status snapshot
 * (S.modules.economy.model.snapshot(), else its emptyStatus()), so the card,
 * the strip and the tile agree, a repaint costs no host reads, and one draw
 * shows one status. Every status word comes from the menu's stateOf,
 * statusText and statusLine, and the breaker banner from views.breakerBanner,
 * so the tab, the submenu and the window never word a state differently.
 *
 * Tile badge per state (only existing badge kinds; paused is the red one):
 *
 *   off                 Off            off
 *   breaker             Breaker open   paused
 *   unreadable          Unreadable     paused
 *   storehouse, full    Some full      paused
 *   sending, ready      Moving         busy
 *   empty, idle         Idle           ok
 *
 * Nothing here throws: a missing model, menu or view leaves the part empty.
 *
 * Bundle slot: modules, economy/ in name order (after settings, before
 * views and window); every S.modules.economy.* reference happens at call
 * time.
 */

(function (S) {
    'use strict';

    if (!S.modules.economy) S.modules.economy = {};

    var OWNER = 'economy';
    var SEP = ' · ';
    var MOVED_ROWS = 5;

    // One row per stateOf state, so no state words its badge twice.
    var TILE = {
        off:        { kind: 'off',    text: 'Off' },
        breaker:    { kind: 'paused', text: 'Breaker open' },
        unreadable: { kind: 'paused', text: 'Unreadable' },
        storehouse: { kind: 'paused', text: 'Some full' },
        full:       { kind: 'paused', text: 'Some full' },
        sending:    { kind: 'busy',   text: 'Moving' },
        ready:      { kind: 'busy',   text: 'Moving' },
        empty:      { kind: 'ok',     text: 'Idle' },
        idle:       { kind: 'ok',     text: 'Idle' }
    };

    // Ready and Full are counts of a pass that would run; off or paused
    // nothing runs, so a number there would promise work.
    var NO_COUNTS = { off: true, breaker: true };

    function M() { return S.modules.economy; }

    function safe(fn, fallback) {
        try {
            var v = fn();
            return v === undefined ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    function num(v) { return S.kernel.is.finite(v) ? v : 0; }

    // The model's snapshot, else its empty status, so a draw never shows a
    // hand-kept copy of the status shape that could drift from the builder.
    function status() {
        var st = safe(function () { return M().model.snapshot(); }, null);
        if (st && typeof st === 'object') return st;
        st = safe(function () { return M().model.emptyStatus(); }, null);
        return (st && typeof st === 'object') ? st : null;
    }

    function stateOf(st) {
        return safe(function () { return M().menu.stateOf(st); }, 'off');
    }

    function statusText(st) {
        return safe(function () { return M().menu.statusText(st); }, '');
    }

    function statusLine(st) {
        return safe(function () { return M().menu.statusLine(st); }, '');
    }

    function label(name) {
        return safe(function () { return S.core.locale.res(name); }, name) || name;
    }

    function hhmm(h, ms) {
        return typeof ms === 'number' ? h.clock(new Date(ms)) : '';
    }

    // The submenu's opener, so every economy surface opens the window the
    // same way and says the same when it is missing.
    function openManager() {
        try { M().menu.openWindow(); }
        catch (e) { S.kernel.error(OWNER, 'open economy manager threw:', e); }
    }

    // The main column last drawn, so a Reset or a switch flip redraws it in
    // place; a fresh dashboard draw replaces both.
    var lastMain = null;
    var lastH = null;

    function redrawMain() {
        if (!lastMain || !lastH) return;
        var $main = lastMain;
        var h = lastH;
        $main.empty();
        try {
            render($main, h);
            if (typeof h.fit === 'function') h.fit();
        } catch (e) {
            S.kernel.error(OWNER, 'dashboard redraw threw:', e);
        }
    }

    function resetBreaker() {
        try { M().resetBreaker(); }
        catch (e) { S.kernel.error(OWNER, 'breaker reset threw:', e); }
        redrawMain();
    }

    function summary(h) {
        return statusText(status());
    }

    function side($side, h) {
        var s = safe(function () { return M().readSettings(); }, null) || {};
        var $line = $('<div>', { 'class': 'steward-muted' }).text(statusText(status()));
        var $card = h.card({ icon: '⚖', title: 'Economy' });
        $card.append(h.field('Economy', 'Moves the selected star items into the storehouse',
            h.toggle({
                checked: s.enabled === true,
                label: 'Economy',
                write: function (v) {
                    try { M().setEnabled(v); }
                    catch (e) { S.kernel.error(OWNER, 'switch of enabled threw:', e); }
                    $line.text(statusText(status()));
                    redrawMain();
                }
            })));
        $card.append($line);
        $card.append(h.button('Open manager', { onClick: openManager }));
        $side.append($card);
    }

    function lastMovedText(h, m) {
        if (!m || typeof m.name !== 'string') return '-';
        var at = hhmm(h, m.at);
        return label(m.name) + ' ' + num(m.amount) + (at ? SEP + at : '');
    }

    function movedCard(h) {
        var list = safe(function () { return M().moved(); }, null) || [];
        var rows = [];
        for (var i = list.length - 1; i >= 0 && rows.length < MOVED_ROWS; i--) {
            var m = list[i];
            if (!m || typeof m.name !== 'string') continue;
            rows.push([label(m.name), String(num(m.amount)), hhmm(h, m.at) || '-']);
        }
        var $card = h.card({ title: 'Moved lately' });
        $card.append(h.table({
            cols: [{ label: 'Item' }, { label: 'Amount' }, { label: 'When' }],
            rows: rows,
            emptyText: 'Nothing moved yet'
        }));
        return $card;
    }

    function fullCard(h, st) {
        var items = st && st.fullItems && st.fullItems.length ? st.fullItems : null;
        if (!items) return null;
        var $card = h.card({ title: 'Full items' });
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (!it) continue;
            // The core mark holds the amount that came back, not the one sent.
            $card.append($('<div>').text(String(it.label || label(it.name)) +
                ' came back to the star menu (' + num(it.back) + ')'));
        }
        return $card;
    }

    function render($main, h) {
        lastMain = $main;
        lastH = h;
        var st = status();
        var state = stateOf(st);
        var c = st || {};

        if (state === 'breaker') {
            var $banner = safe(function () { return M().views.breakerBanner(h, st, resetBreaker); }, null);
            if ($banner) $main.append($banner);
        }

        var dash = NO_COUNTS[state] === true;
        var $now = h.card({ title: 'Economy now' });
        $now.append(h.stats([
            { k: 'Selected',   v: num(c.selected) },
            { k: 'Ready',      v: dash ? '-' : num(c.ready) },
            { k: 'Full',       v: dash ? '-' : num(c.full) },
            { k: 'Last moved', v: lastMovedText(h, c.lastMoved) }
        ]));
        $main.append($now);

        var $full = fullCard(h, st);
        if ($full) $main.append($full);

        $main.append(movedCard(h));

        var $open = h.card({ title: 'Choose items in the economy manager' });
        $open.append($('<div>', { 'class': 'steward-muted' }).text('The grid of star items lives in the window'));
        $open.append(h.button('Open economy manager…', { onClick: openManager }));
        $main.append($open);
    }

    function tiles(h) {
        var st = status();
        var badge = TILE[stateOf(st)] || TILE.off;
        return [{
            title: 'Economy',
            icon:  '⚖',
            badge: { kind: badge.kind, text: badge.text },
            lines: [statusLine(st)],
            links: [{ label: 'Manager', onClick: openManager }]
        }];
    }

    S.modules.economy.ui = {
        render:  render,
        side:    side,
        summary: summary,
        tiles:   tiles
    };

}(Steward));
