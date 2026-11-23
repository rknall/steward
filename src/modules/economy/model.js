/*
 * Read models of the economy module for its dashboard tab, tile, menu and
 * window.
 *
 * Every function reads the host through the core readers at call time and
 * is null-safe: an unreadable part shows as null or an empty list, never as
 * a thrown error, so a view can always render. Nothing here sends, enqueues
 * or stores.
 *
 * Each model builds inside one read pass (S.kernel.hostRead.pass), so the
 * star menu, the storehouse and the definitions cross the bridge once per
 * call however many rows it builds.
 *
 *   items()        the grid rows: every resource item of the star menu plus
 *                  every selected item that is not in it (so a selection
 *                  stays visible while its star stock is spent). Population
 *                  is never a row. An event item outside its event stays a
 *                  row in state offline. null when the star menu does not
 *                  read and nothing is selected.
 *   grid()         the rows grouped by storehouse tab in the storehouse's
 *                  tab order, rows by label; rows whose tab does not read go
 *                  to other, shown last. Empty tabs are left out.
 *   status(maxAge) the only count of the selection and its states, plus the
 *                  last plan pass, the last transfer, the ledger breaker and
 *                  the stale sends. The host part is reused when it is at
 *                  most maxAge ms old; without maxAge it is read fresh.
 *   snapshot()     status(SNAPSHOT_MAX_AGE_MS), one status object per read
 *                  pass, for the passive surfaces (menu line, tab, tile,
 *                  window header).
 *   emptyStatus()  the status shape with nothing read.
 *
 * A row's fits is what of the whole star stock fits the storehouse
 * (min of star and room, floored); 0 when the item or the warehouse is full,
 * null when star or room is unread or nothing is in the star menu. next stays
 * the first transfer's amount. The status adds none (selected rows with
 * nothing in the star menu) and fullItems (the selected full rows as
 * { name, label, back, at }, by label) for the words of the views.
 *
 * Row state, first match wins:
 *   unknown    a read the decision needs failed (a read refusal from
 *              storeNext, or an unread send ledger);
 *   offline    the item's event is not live, or it has no definition;
 *   pending    a transfer is out or was not seen yet (ledger sent/unseen);
 *   stale      an unseen transfer nobody could settle (ledger stale);
 *   full       the item came back to the star menu earlier (item full);
 *   warehouse  the warehouse cap is reached;
 *   none       nothing of it in the star menu;
 *   ready      selected, and a transfer may go;
 *   idle       not selected, in the star menu.
 *
 * Bundle slot: modules, economy/ in name order; core and the module are
 * read at call time.
 */

(function (S) {

    if (!S.modules.economy) S.modules.economy = {};

    // How old a status host part the passive surfaces accept: the counts
    // move by transfers seconds apart, and a label that re-reads the whole
    // star menu on every refresh would cost the client for nothing.
    var SNAPSHOT_MAX_AGE_MS = 30000;

    function M() { return S.modules.economy; }

    function safe(fn, fallback) {
        try {
            var v = fn();
            return v === undefined ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    function pass(fn) {
        return S.kernel.hostRead.pass(fn);
    }

    function clock() {
        return safe(function () { return S.core.ledger.clock(); }, null);
    }

    function settings() {
        return safe(function () { return M().readSettings(); }, null) || { enabled: false, items: {} };
    }

    function stateOf(selected, live, p, pending) {
        var B = S.core.buffs;
        if (pending === 'unread' || (p.reason && S.kernel.read.isReadRefusal(p.reason))) return 'unknown';
        if (live !== true) return 'offline';
        if (pending === 'sent' || pending === 'unseen') return 'pending';
        if (pending === 'stale') return 'stale';
        if (p.reason === B.ITEM_FULL) return 'full';
        if (p.reason === 'warehouse full') return 'warehouse';
        if (p.reason === 'none in star') return 'none';
        if (p.reason) return 'unknown';
        return selected ? 'ready' : 'idle';
    }

    // What of the whole star stock fits in the storehouse, which is what a
    // tile counts (next is only the first transfer). An item or warehouse
    // that is full takes nothing; an unread star or room, or nothing in the
    // star menu, is unknown.
    function fitsOf(state, p) {
        if (state === 'full' || state === 'warehouse') return 0;
        if (state === 'none') return null;
        if (!p.star || typeof p.star.total !== 'number' || typeof p.room !== 'number' || !(p.room > 0)) return null;
        return Math.floor(Math.min(p.star.total, p.room));
    }

    function row(name, selected) {
        var p = safe(function () { return S.core.buffs.storeNext(name); }, null) ||
            { amount: 0, room: null, stock: null, star: null, full: null, reason: 'star stock unreadable' };
        var live = safe(function () { return S.core.events.resourceLive(name); }, null);
        var pending = safe(function () { return S.core.ledger.blocked(M().key(name)); }, 'unread');
        var state = stateOf(selected, live, p, pending);
        return {
            name:     name,
            label:    safe(function () { return S.core.locale.res(name); }, name) || name,
            tab:      safe(function () { return S.core.resources.tabOf(name); }, null),
            selected: selected,
            live:     live,
            star:     p.star ? p.star.total : null,
            entries:  p.star ? p.star.entries : null,
            store:    p.stock,
            room:     p.room,
            next:     p.amount,
            fits:     fitsOf(state, p),
            full:     p.full || safe(function () { return S.core.buffs.storeFull(name); }, null),
            pending:  pending,
            state:    state
        };
    }

    function byLabel(a, b) {
        var x = String(a.label);
        var y = String(b.label);
        if (x < y) return -1;
        if (x > y) return 1;
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    }

    function items() {
        return pass(function () {
            var s = settings();
            var star = safe(function () { return S.core.buffs.starResources(); }, null);
            var pop = safe(function () { return S.core.resources.POPULATION; }, null);
            var seen = {};
            var names = [];
            var i;
            if (star) {
                for (i = 0; i < star.length; i++) {
                    if (!star[i] || typeof star[i].name !== 'string' || star[i].name === pop) continue;
                    if (seen[star[i].name]) continue;
                    seen[star[i].name] = true;
                    names.push(star[i].name);
                }
            }
            var picked = 0;
            for (var n in s.items) {
                if (!Object.prototype.hasOwnProperty.call(s.items, n) || s.items[n] !== true) continue;
                if (n === pop) continue;
                picked++;
                if (seen[n]) continue;
                seen[n] = true;
                names.push(n);
            }
            if (!star && !picked) return null;
            var rows = [];
            for (i = 0; i < names.length; i++) rows.push(row(names[i], s.items[names[i]] === true));
            rows.sort(byLabel);
            return rows;
        });
    }

    function grid() {
        return pass(function () {
            var rows = items();
            if (!rows) return null;
            var tabs = safe(function () { return S.core.resources.tabs(); }, null) || [];
            var slot = {};
            var out = [];
            var i;
            for (i = 0; i < tabs.length; i++) {
                slot[tabs[i].key] = { key: tabs[i].key, label: tabs[i].label, rows: [] };
                out.push(slot[tabs[i].key]);
            }
            var other = [];
            for (i = 0; i < rows.length; i++) {
                var t = rows[i].tab;
                if (typeof t === 'string' && Object.prototype.hasOwnProperty.call(slot, t)) slot[t].rows.push(rows[i]);
                else other.push(rows[i]);
            }
            var kept = [];
            for (i = 0; i < out.length; i++) {
                if (out[i].rows.length) kept.push(out[i]);
            }
            return { tabs: kept, other: other, readAt: clock() };
        });
    }

    // The last host part and when it was read.
    var cache = null;

    function emptyPart() {
        return { selected: 0, ready: 0, pending: 0, full: 0, warehouse: 0, offline: 0, unknown: 0, none: 0, fullItems: [], readable: false };
    }

    function hostPart() {
        var part = emptyPart();
        var rows = items();
        if (!rows) return part;
        part.readable = true;
        for (var i = 0; i < rows.length; i++) {
            if (!rows[i].selected) continue;
            part.selected++;
            var st = rows[i].state;
            if (st === 'ready') part.ready++;
            else if (st === 'pending') part.pending++;
            else if (st === 'full') {
                part.full++;
                part.fullItems.push({
                    name:  rows[i].name,
                    label: rows[i].label,
                    back:  rows[i].full ? rows[i].full.back : null,
                    at:    rows[i].full ? rows[i].full.at : null
                });
            }
            else if (st === 'none') part.none++;
            else if (st === 'warehouse') part.warehouse++;
            else if (st === 'offline') part.offline++;
            else if (st === 'unknown') part.unknown++;
        }
        part.fullItems.sort(byLabel);
        return part;
    }

    // The one builder of the status object, so status() and emptyStatus()
    // cannot drift apart in their fields.
    function shape(part, enabled, last, lastMoved, breaker, stale, readAt) {
        return {
            enabled:   enabled,
            selected:  part.selected,
            ready:     part.ready,
            pending:   part.pending,
            full:      part.full,
            warehouse: part.warehouse,
            offline:   part.offline,
            unknown:   part.unknown,
            none:      part.none,
            fullItems: part.fullItems,
            readable:  part.readable,
            lastPass:  last,
            lastMoved: lastMoved,
            breaker:   breaker,
            stale:     stale,
            readAt:    readAt
        };
    }

    function emptyStatus() {
        return shape(emptyPart(), false, null, null, null, [], null);
    }

    function staleSends() {
        var list = safe(function () { return S.core.ledger.snapshot(M().OWNER); }, null) || [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].state === 'stale') out.push(list[i]);
        }
        return out;
    }

    function status(maxAgeMs) {
        return pass(function () {
            var now = clock();
            var part;
            if (typeof maxAgeMs === 'number' && cache && typeof now === 'number' &&
                    now >= cache.at && now - cache.at <= maxAgeMs) {
                part = cache.value;
            } else {
                part = safe(hostPart, null);
                // A throw keeps the last part instead of caching a blank one,
                // so a view still gets numbers.
                if (part) cache = { at: now, value: part };
                else part = cache ? cache.value : emptyPart();
            }
            var moved = safe(function () { return M().moved(); }, null) || [];
            return shape(part,
                settings().enabled === true,
                safe(function () { return M().lastPass(); }, null),
                moved.length ? moved[moved.length - 1] : null,
                safe(function () { return S.core.ledger.breaker(M().OWNER).snapshot(); }, null),
                staleSends(),
                cache ? cache.at : null);
        });
    }

    // Memoized per read pass: every part of one dashboard draw gets the same
    // status object, even when the clock crosses the max age between them.
    function snapshot() {
        return pass(function () {
            return S.kernel.hostRead.cached('economy.status', function () {
                return status(SNAPSHOT_MAX_AGE_MS);
            });
        });
    }

    S.modules.economy.model = {
        items:       items,
        grid:        grid,
        status:      status,
        snapshot:    snapshot,
        emptyStatus: emptyStatus,
        SNAPSHOT_MAX_AGE_MS: SNAPSHOT_MAX_AGE_MS
    };

}(Steward));
