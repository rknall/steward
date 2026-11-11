/*
 * Dashboard surface for the production module.
 *
 * Owns the slim Production tab and the Overview tile. The tab only holds
 * the module's switches and a read-only summary; standing orders, queues
 * and demand live in the production manager window, which the button and
 * the tile link open.
 *
 *   side      the settings column: the module switch, delay and caps, the
 *             standing/buff/Bookbinder flags, and the counts.
 *   render    the main column: breaker banner, what production does now,
 *             short rows, and the pointer to the manager window.
 *   summary   the one-line strip.
 *   tiles     the Overview tile, in one of four states (off, breaker, idle,
 *             running).
 *
 * Every count comes from the model's status snapshot
 * (S.modules.production.model.snapshot()), so the card, the strip and the tile
 * agree and a repaint costs no host reads. The dashboard draws inside one read
 * pass and the snapshot is memoized per pass, so summary, side, render and
 * tiles of one draw show one status. It never throws. Shown values are the stored settings
 * overlaid with the dashboard buffer, so a re-render keeps a pending edit.
 * Turning the module off stops only its own work; runs keep producing their
 * own items, and the wording says so.
 */

(function (S) {

    if (!S.modules.production) S.modules.production = {};

    function M() { return S.modules.production; }

    function readSettings() {
        var fn = M().readSettings;
        return (typeof fn === 'function' ? fn() : null) || M().defaultSettings || {};
    }

    function shownSettings(h) {
        var base = readSettings();
        var buf = h.settings('production') || {};
        var out = {};
        var key;
        for (key in base) out[key] = base[key];
        for (key in buf)  out[key] = buf[key];
        return out;
    }

    function num(v, fallback) {
        return typeof v === 'number' ? v : fallback;
    }

    // Whole numbers 1-5, for the per-pass caps.
    function parseCap(text) {
        var n = S.kernel.ui.settingsParse.whole(text);
        return (n === null || n < 1 || n > 5) ? null : n;
    }

    // The model's snapshot, else its empty status, so a draw never shows a
    // hand-kept copy of the status shape that could drift from the builder.
    function status() {
        var st = null;
        try { st = M().model && M().model.snapshot(); } catch (e1) { st = null; }
        if (st && typeof st === 'object') return st;
        try { st = M().model && M().model.emptyStatus(); } catch (e2) { st = null; }
        return (st && typeof st === 'object') ? st : {};
    }

    function lastRows() {
        try {
            var last = M().lastPass();
            return (last && last.rows) || [];
        } catch (e) { return []; }
    }

    function hhmm(h, ms) {
        return typeof ms === 'number' ? h.clock(new Date(ms)) : '';
    }

    function nextDone(h, st) {
        return typeof st.nextDoneAt === 'number' ? hhmm(h, st.nextDoneAt) : 'none';
    }

    function res(name) {
        try { return S.core.locale.res(name) || name; }
        catch (e) { return name; }
    }

    function openManager() {
        var w = M().window;
        if (w && typeof w.open === 'function') w.open();
    }

    // The same reset the user would press on either breaker: both pause
    // work, and the banner or tile link names no single one.
    function resetBreakers() {
        try { M().orderBreaker.reset('the user'); } catch (e1) { /* absent */ }
        try { M().buffEngine.breaker.reset('the user'); } catch (e2) { /* absent */ }
    }

    // The tile badge uses the red 'paused' kind: the style has no separate bad kind.
    // Which breakers are open: the order breaker and the buff breaker.
    function openBreakers(st) {
        var out = [];
        if (st.orderBreaker && st.orderBreaker.open) out.push({ what: 'orders', snap: st.orderBreaker });
        if (st.buffBreaker && st.buffBreaker.open) out.push({ what: 'buffs', snap: st.buffBreaker });
        return out;
    }

    function summary(h) {
        var st = status();
        return st.standing + ' standing orders · next done ' + nextDone(h, st);
    }

    function side($side, h) {
        h.baseline('production', readSettings());
        var s = shownSettings(h);
        var def = M().defaultSettings || {};

        function flag(path, label) {
            return h.toggle({ ns: 'production', path: path, checked: !!s[path], label: label });
        }
        function cap(path, label) {
            return h.number({
                ns: 'production', path: path, value: num(s[path], def[path]),
                parse: parseCap, width: '50px', label: label
            });
        }

        var $card = h.card({ icon: '⚙', title: 'Production' });
        $card.append(h.field('Auto-production', 'Module on or off. Runs keep producing their own items',
            flag('enabled', 'Auto-production')));
        $card.append(h.field('Delay between actions', null,
            h.number({
                ns: 'production', path: 'actionDelay', value: num(s.actionDelay, def.actionDelay),
                unit: 'ms', label: 'Delay between actions'
            })));
        $card.append(h.field('Orders per pass', 'Each verified send holds the module up to 15 s',
            cap('ordersPerPass', 'Orders per pass')));
        $card.append(h.field('Buffs per pass', null, cap('buffsPerPass', 'Buffs per pass')));
        $card.append(h.field('Standing orders', null, flag('standing', 'Standing orders')));
        $card.append(h.field('Building buffs', 'Mines and masons stay with Mining',
            flag('buffs', 'Building buffs')));
        $card.append(h.field('Bookbinder auto-complete', 'Off by default',
            flag('bookComplete', 'Bookbinder auto-complete')));
        $side.append($card);

        var st = status();
        var open = !!(st.orderBreaker && st.orderBreaker.open);
        var $stats = $('<div>', { 'class': 'steward-card' });
        $stats.append(h.stats([
            { k: 'Standing orders',  v: st.standing, small: 'active' },
            { k: 'Buildings buffed', v: st.buffed,   small: 'of ' + st.buffable },
            { k: 'Order breaker',    $v: h.badge(open ? 'paused' : 'ok', open ? 'open' : 'closed') }
        ]));
        $side.append($stats);
    }

    // " · Bookbinder: <item> done hh:mm" while the Bookbinder holds an entry.
    function bookLine(h) {
        var books = null;
        try { books = M().model.books(); }
        catch (e) { books = null; }
        if (!books || !books.head) return '';
        var rem = books.head.remainingMs;
        return ' · Bookbinder: ' + books.head.item +
            (typeof rem === 'number' ? ' done ' + hhmm(h, Date.now() + rem) : '');
    }

    function render($main, h) {
        h.baseline('production', readSettings());
        var st = status();

        var open = openBreakers(st);
        for (var b = 0; b < open.length; b++) {
            var snap = open[b].snap;
            $main.append(h.banner('Production paused: ' + snap.run + ' ' + open[b].what +
                ' not seen. Opens again ' + hhmm(h, snap.nextProbeAt) + '.',
                { icon: '⚠', $action: h.link('Reset', resetBreakers) }));
        }

        var $now = h.card({ title: 'Production now', meta: typeof st.readAt === 'number' ? 'read ' + hhmm(h, st.readAt) : 'not read yet' });
        $now.append(h.stats([
            { k: 'Queues',    v: st.queues, small: 'of ' + st.types },
            { k: 'Next done', v: nextDone(h, st) },
            { k: 'Demand',    v: st.waiting, small: 'waiting' },
            { k: 'Short',     v: st.shortfall }
        ]));
        $main.append($now);

        var rows = lastRows();
        var shown = 0;
        for (var i = 0; i < rows.length && shown < 3; i++) {
            var r = rows[i];
            if (r.status !== S.DemandStatus.Short || !r.shortfall) continue;
            var missing = num(r.shortfall.need, 0) - num(r.shortfall.have, 0);
            $main.append(h.banner(r.label + ': short of ' + missing + ' ' + res(r.shortfall.name),
                { icon: '⚠' }));
            shown++;
        }

        var $card = h.card({ title: 'Standing orders, queues and demand live in the production manager' });
        $card.append($('<div>', { 'class': 'steward-muted' }).text(
            st.standing + ' standing orders · ' + st.buffed + ' buildings buffed' + bookLine(h)));
        $card.append(h.button('Open production manager…', { onClick: openManager }));
        $main.append($card);
    }

    // " · <item>" for the queue that finishes first; '' when unreadable.
    function nextItem(st) {
        return st.nextItem ? ' · ' + st.nextItem : '';
    }

    function tiles(h) {
        var s = shownSettings(h);
        var st = status();
        var links = [{ label: 'Manager', onClick: openManager }];
        var tile = { title: 'Production', icon: '⚙', links: links };

        if (!s.enabled) {
            tile.badge = { kind: 'off', text: 'Off' };
            tile.lines = ['Auto-production off', 'Runs still produce their own items'];
            return [tile];
        }

        var open = openBreakers(st);
        if (open.length) {
            tile.badge = { kind: 'paused', text: 'Breaker' };
            tile.lines = ['Paused: ' + open[0].snap.run + ' ' + open[0].what + ' not seen',
                          'Opens again ' + hhmm(h, open[0].snap.nextProbeAt)];
            links.push({ label: 'Reset', onClick: resetBreakers });
            return [tile];
        }

        if (st.standing > 0 && st.standingCovered + st.standingHeld >= st.standing) {
            tile.badge = { kind: 'ok', text: 'Idle' };
            tile.lines = [st.standing + ' standing orders covered',
                          'Next done ' + nextDone(h, st) + nextItem(st)];
            return [tile];
        }

        tile.badge = { kind: 'busy', text: 'Running' };
        tile.lines = [st.standing + ' standing orders · next done ' + nextDone(h, st),
                      st.queues + ' queues · demand: ' + st.waiting + ' waiting, ' + st.shortfall + ' short'];
        return [tile];
    }

    M().side    = side;
    M().render  = render;
    M().summary = summary;
    M().tiles   = tiles;

}(Steward));
