/*
 * Builders of the Steward economy window's Star to store grid, and the
 * breaker banner the window and the dashboard tab share.
 *
 *   strip(grid, active, onPick)   the storehouse tab strip: one link per
 *                                 non-empty storehouse tab of grid.tabs, in
 *                                 the storehouse's order, then Other when
 *                                 grid.other has rows. A click marks its
 *                                 link active and calls onPick(key).
 *   grid($c, h, rows, pass, on)   empties $c and builds one tile per row,
 *                                 in the given order. rows null means the
 *                                 star menu did not read: the unreadable
 *                                 note, no tiles.
 *   tile(h, row, pass, on, $into) one tile. With $into the existing tile
 *                                 node is refilled in place, so a click
 *                                 changes that tile and no other node.
 *   breakerBanner(h, st, onReset) the banner of an open ledger breaker.
 *   note(h, state)                the line under the status for a window
 *                                 state that needs one (off, storehouse,
 *                                 empty, unreadable), else null.
 *
 * on is { toggle(name, $tile), redraw() }: a tile click hands its item name
 * to toggle; redraw is the one redraw of the grid body that is scheduled
 * when an icon was still a placeholder (the host had not decoded its
 * bitmap yet).
 *
 * A tile shows the icon, the label, the star stock ('-' when unread), what
 * of that stock fits the storehouse ("fits N", only for a number) and a
 * badge for a state worth a word. Its border is the selection (is-on); the
 * is-<state> classes give the muted and dashed looks. Offline event items
 * are muted, never hidden, so a selection outside its event stays visible.
 *
 * Pure builders: nothing here reads the host, the settings or the model.
 * Every user or host string goes in with .text(); only the host's own
 * image markup goes in as HTML.
 *
 * Bundle slot: module, economy/ in name order; every S.* reference happens
 * at call time.
 */

(function (S) {
    'use strict';

    if (!S.modules.economy) S.modules.economy = {};

    var OTHER = 'other';
    var OTHER_LABEL = 'Other';

    // The row states that carry a class of their own; ready and idle look
    // plain, the border alone telling selected from not.
    var STATE_CLASS = {
        full: true, warehouse: true, pending: true, stale: true,
        none: true, offline: true, unknown: true
    };

    // Badge words per row state. ready is said only for a selected row,
    // since an unselected item never moves; idle has nothing to say.
    var BADGE = {
        ready:     'ready',
        pending:   'sending',
        stale:     'stale',
        full:      'full',
        warehouse: 'no room',
        none:      'none in star',
        offline:   'event over',
        unknown:   'unknown'
    };

    var NOTES = {
        off:        'Economy is off. The selection is kept and nothing moves until it is switched on in Settings.',
        storehouse: 'The storehouse is full. Nothing can move until room is freed.',
        empty:      'No resource items in the star menu right now. Selected items stay selected and show as none in star.',
        unreadable: 'The star menu or storehouse could not be read. Nothing is sent until it can; reopen the window to retry.'
    };

    var NO_ROWS = 'No resource items in the star menu right now.';

    function textEl(tag, cls, text) {
        var $e = $('<' + tag + '>');
        if (cls) $e.addClass(cls);
        return $e.text(text);
    }

    function isNum(n) { return typeof n === 'number' && isFinite(n); }

    function note(h, state) {
        if (!Object.prototype.hasOwnProperty.call(NOTES, state)) return null;
        return textEl('div', 'steward-muted', NOTES[state]);
    }

    function breakerBanner(h, st, onReset) {
        var run = st && st.breaker && isNum(st.breaker.run) ? st.breaker.run : 0;
        return h.banner('Transfers stopped after ' + run + ' sends the game did not confirm. ' +
            'Check the star and storehouse, then reset.', {
            icon: '⚠',
            $action: h.button('Reset', { size: 'sm', onClick: function () {
                if (typeof onReset === 'function') onReset();
            } })
        });
    }

    // The strip's entries: the non-empty tabs as the model gave them, then
    // Other when it has rows.
    function stripKeys(grid) {
        var out = [];
        if (!grid) return out;
        var tabs = grid.tabs || [];
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i] && tabs[i].rows && tabs[i].rows.length) out.push({ key: tabs[i].key, label: tabs[i].label });
        }
        if (grid.other && grid.other.length) out.push({ key: OTHER, label: OTHER_LABEL });
        return out;
    }

    function strip(grid, active, onPick) {
        var $s = $('<div>', { 'class': 'steward-tabs steward-store-strip' });
        var keys = stripKeys(grid);
        var links = [];
        for (var i = 0; i < keys.length; i++) {
            (function (entry) {
                var $a = $('<a>', { href: '#', 'class': 'steward-tab' }).text(String(entry.label || entry.key));
                if (entry.key === active) $a.addClass('active');
                $a.on('click', function (e) {
                    if (e && typeof e.preventDefault === 'function') e.preventDefault();
                    for (var j = 0; j < links.length; j++) links[j].removeClass('active');
                    $a.addClass('active');
                    if (typeof onPick !== 'function') return;
                    try { onPick(entry.key); }
                    catch (err) { S.kernel.error('economy', 'strip pick threw:', err); }
                });
                links.push($a);
                $s.append($a);
            }(keys[i]));
        }
        return $s;
    }

    function classesOf(row) {
        var cls = 'steward-store-item';
        if (row.selected === true) cls += ' is-on';
        if (Object.prototype.hasOwnProperty.call(STATE_CLASS, row.state)) cls += ' is-' + row.state;
        return cls;
    }

    function badgeOf(row) {
        if (row.state === 'ready' && row.selected !== true) return null;
        return Object.prototype.hasOwnProperty.call(BADGE, row.state) ? BADGE[row.state] : null;
    }

    function fill(h, row, pass, $t) {
        $t.attr('class', classesOf(row));
        $t.empty();
        var $icon = $('<span>', { 'class': 'steward-store-icon' });
        var tag = h.imageTag(row.name, '32px', pass);
        if (tag) $icon.html(tag);
        $t.append($icon);
        $t.append(textEl('span', 'steward-store-name', String(row.label || row.name)));
        $t.append(textEl('span', 'steward-store-star', isNum(row.star) ? String(row.star) : '-'));
        // Always built, empty when there is no number, so tiles line up.
        $t.append(textEl('span', 'steward-store-fit', isNum(row.fits) ? 'fits ' + row.fits : ''));
        var word = badgeOf(row);
        if (word) $t.append(textEl('span', 'steward-store-badge', word));
        return $t;
    }

    function tile(h, row, pass, on, $into) {
        if ($into && $into.length) return fill(h, row, pass, $into);
        var $t = $('<div>');
        var name = row.name;
        $t.on('click', function (e) {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            if (!on || typeof on.toggle !== 'function') return;
            try { on.toggle(name, $t); }
            catch (err) { S.kernel.error('economy', 'tile click threw:', err); }
        });
        return fill(h, row, pass, $t);
    }

    function grid($c, h, rows, pass, on) {
        $c.empty();
        if (!rows) {
            $c.append(note(h, 'unreadable'));
            return $c;
        }
        if (!rows.length) {
            $c.append(textEl('div', 'steward-muted', NO_ROWS));
            return $c;
        }
        var p = pass && typeof pass === 'object' ? pass : {};
        var $g = $('<div>', { 'class': 'steward-store-grid' });
        for (var i = 0; i < rows.length; i++) {
            if (rows[i]) $g.append(tile(h, rows[i], p, on));
        }
        $c.append($g);
        if (p.imageMissed && on && typeof on.redraw === 'function') {
            h.redrawOnce($c, on.redraw, S.kernel.TIMEOUTS.PORTRAIT_RETRY_MS);
        }
        return $c;
    }

    S.modules.economy.views = {
        OTHER:         OTHER,
        stripKeys:     stripKeys,
        strip:         strip,
        grid:          grid,
        tile:          tile,
        breakerBanner: breakerBanner,
        note:          note
    };

}(Steward));
