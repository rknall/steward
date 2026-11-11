/*
 * Live views of the production window: queues, demand, Bookbinder with the
 * on/off buildings, and recent actions.
 *
 * Each view is view($c, h, data): it empties $c and builds its body from
 * data, which the window reads on open and on Refresh. The queues view gets
 * the window's demand rows with its data, so an empty queue names its
 * standing order from the same rows the Demand tab shows. A view never reads
 * the host on a timer and never redraws on its own. Every user or host
 * string goes in with .text() through the helpers.
 *
 * Two controls act at once instead of waiting for a Save, since the window
 * has no settings buffer:
 *   - the Bookbinder auto-complete switch writes only { bookComplete }, the
 *     same key the submenu flips, so the two never overwrite each other;
 *   - Complete now and Resume each start one verified attempt per click and
 *     note the result in the module's recent list. The button is disabled
 *     once clicked, so a second click before the redraw sends nothing.
 *
 * Chip filters are view state kept in memory; picking a chip redraws only
 * that view from the data it was given.
 *
 * Bundle slot: module, loads after module.js (name order); every
 * S.modules.production.* and S.core.production.* reference happens at call
 * time.
 */

(function (S) {
    'use strict';

    if (!S.modules.production) S.modules.production = {};

    var OWNER = 'production';
    var SEP   = ' · ';
    var DASH  = '–';

    var filters = { demand: 'all', recent: 'all' };

    function M() { return S.modules.production; }
    function P() { return S.core.production; }

    function safe(fn, fallback) {
        try {
            var v = fn();
            return v === undefined ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    function bui(name) {
        return safe(function () { return S.core.locale.bui(name) || name; }, name);
    }

    function res(name) {
        return safe(function () { return S.core.locale.res(name) || name; }, name);
    }

    function isNum(n) { return typeof n === 'number' && isFinite(n); }

    function at(h, ms) {
        return isNum(ms) ? h.clock(new Date(ms)) : '';
    }

    function muted(text) {
        return $('<div>', { 'class': 'steward-inline steward-muted' }).text(text);
    }

    function cell(text, cls) {
        return { text: text, cls: cls };
    }

    // ---------------------------------------------------------------
    // Shared wording.
    // ---------------------------------------------------------------

    // An enum key spaced for display: RunNow -> "Run now".
    function spaced(key) {
        var s = String(key).replace(/([a-z])([A-Z])/g, '$1 $2');
        return s.charAt(0) + s.substring(1).toLowerCase();
    }

    function priorityLabel(value) {
        var E = S.ProductionPriority;
        for (var k in E) {
            if (Object.prototype.hasOwnProperty.call(E, k) && E[k] === value) return spaced(k);
        }
        return value === null || value === undefined ? DASH : String(value);
    }

    // Every priority, most urgent first, read from the enum.
    function priorityOrder() {
        var E = S.ProductionPriority;
        var keys = [];
        for (var k in E) if (Object.prototype.hasOwnProperty.call(E, k)) keys.push(k);
        keys.sort(function (a, b) { return E[a] - E[b]; });
        var out = [];
        for (var i = 0; i < keys.length; i++) out.push(spaced(keys[i]));
        return out;
    }

    // { text, cls } of a planner row's status.
    function statusOf(row) {
        var D = S.DemandStatus;
        var st = row ? row.status : null;
        if (st === D.Covered) return { text: 'covered', cls: 'steward-ok' };
        if (st === D.Waiting) return { text: 'waiting for production', cls: 'steward-muted' };
        if (st === D.Order) return { text: 'ordering', cls: 'steward-muted' };
        if (st === D.Deferred) return { text: 'next pass', cls: 'steward-muted' };
        if (st === D.Short) {
            var sf = row.shortfall;
            var what = sf && sf.name ? res(sf.name) : 'resources';
            if (row.reserved) return { text: 'short of ' + what + ' (reserved)', cls: 'steward-bad' };
            var n = sf && isNum(sf.need) ? sf.need - (isNum(sf.have) ? sf.have : 0) : null;
            return { text: 'short of ' + (n !== null && n > 0 ? n + ' ' : '') + what, cls: 'steward-bad' };
        }
        if (st === D.Held) {
            var lb = safe(function () { return M().holdLabel(row); }, null);
            return { text: lb ? 'held by ' + lb : 'held', cls: 'steward-warn' };
        }
        if (st === D.QueueFull) return { text: 'queue full', cls: 'steward-warn' };
        if (st === D.NotOrderable) return { text: 'not orderable', cls: 'steward-bad' };
        return { text: 'unreadable', cls: 'steward-bad' };
    }

    function recentList(data) {
        if (data && data.recent && typeof data.recent.length === 'number') return data.recent;
        return safe(function () { return M().recent(); }, null) || [];
    }

    // ---------------------------------------------------------------
    // Queues.
    // ---------------------------------------------------------------

    // A line is one entry or a run of equal neighbours; its total is
    // amount times the run length. The run length is read by key because
    // the AIR lint rule flags any dotted .repeat access.
    function produced(e, books) {
        if (!books) {
            return isNum(e.produced) ? e.produced + ' of ' + e.total : DASH;
        }
        if (e.finished) return '100 %';
        if (!isNum(e.remainingMs) || !isNum(e.timeMs) || !isNum(e.bonus) || !(e.bonus > 0)) return DASH;
        var total = e.total * e.timeMs / e.bonus;
        if (!(total > 0)) return DASH;
        var pct = Math.round((1 - e.remainingMs / total) * 100);
        return Math.max(0, Math.min(100, pct)) + ' %';
    }

    // Why an empty queue stays empty: the standing row of its type.
    function emptyReason(type, rows) {
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (r && r.owner === OWNER && r.type === type) {
                return ' Standing order ' + res(r.item) + ': ' + statusOf(r).text + '.';
            }
        }
        return ' No standing order.';
    }

    function queueTitle(h, q, now) {
        var parts = [];
        if (q.count > 1) parts.push('×' + q.count);
        if (q.level !== null && q.level !== undefined) parts.push('level ' + q.level);
        var b = q.buff;
        if (b) {
            var until = isNum(b.remainingMs) ? ' until ' + at(h, now + b.remainingMs) : '';
            parts.push('buff ' + (b.name ? res(b.name) : '?') + until);
        } else {
            parts.push('no buff');
        }
        return q.label + (parts.length ? ' ' + parts.join(SEP) : '');
    }

    function queueCard(h, q, now, rows) {
        var cooldown = q.kind === S.ProductionKind.Cooldown;
        var list = q.entries;
        // Without the model's lines there is nothing safe to render, so the
        // queue counts as unreadable rather than being regrouped here.
        var lines = list && q.lines ? q.lines : null;
        var meta = cooldown ? 'cooldown'
            : !list ? 'unreadable'
            : !list.length ? 'empty'
            : list.length + (list.length === 1 ? ' entry' : ' entries') +
                (isNum(q.doneAt) ? SEP + 'done ' + at(h, q.doneAt) : '');
        var $card = h.card({ title: queueTitle(h, q, now), meta: meta });

        if (cooldown) {
            var cd = q.cooldownMs;
            $card.append(muted(!isNum(cd) ? 'cooldown unreadable'
                : cd > 0 ? 'cooldown ' + at(h, now + cd) : 'cooldown over'));
            return $card;
        }
        if (!list || !lines) {
            $card.append(muted('Queue unreadable.'));
            return $card;
        }
        if (!list.length) {
            $card.append(muted('Queue empty.' + emptyReason(q.type, rows)));
            return $card;
        }

        var books = q.kind === S.ProductionKind.Books;
        var rows = [];
        var sum = 0, known = true;
        for (var i = 0; i < lines.length; i++) {
            var e = lines[i] || {};
            if (isNum(e.remainingMs) && known) sum += e.remainingMs;
            else known = false;
            var src = safe(function () { return q.source(e); }, 'Other');
            var n = e['repeat'];
            rows.push([
                res(e.item),
                cell(n > 1 ? n + ' × ' + e.amount : String(e.amount), 'steward-num'),
                cell(produced(e, books), 'steward-num'),
                cell(h.duration(e.remainingMs) || (e.finished ? 'done' : DASH), 'steward-num'),
                cell(known ? at(h, now + sum) : DASH, 'steward-num'),
                src
            ]);
        }
        $card.append(h.table({
            cols: [
                { label: 'Item', width: '28%' },
                { label: 'Amount', cls: 'steward-num', width: '10%' },
                { label: 'Produced', cls: 'steward-num', width: '12%' },
                { label: 'Remaining', cls: 'steward-num', width: '13%' },
                { label: 'Done at', cls: 'steward-num', width: '10%' },
                { label: 'Source', width: '27%' }
            ],
            rows: rows
        }));
        return $card;
    }

    function queues($c, h, data) {
        $c.empty();
        var list = data && data.queues && typeof data.queues.length === 'number' ? data.queues : [];
        var rows = data && data.rows && typeof data.rows.length === 'number' ? data.rows : [];
        if (!list.length) {
            $c.append(h.empty('No production queues', 'No building with a production queue was read on this island.'));
            return $c;
        }
        var now = Date.now();
        var $stack = $('<div>', { 'class': 'steward-stack' });
        for (var i = 0; i < list.length; i++) {
            if (list[i]) $stack.append(queueCard(h, list[i], now, rows));
        }
        $c.append($stack);
        return $c;
    }

    // ---------------------------------------------------------------
    // Demand.
    // ---------------------------------------------------------------

    var DEMAND_CHIPS = [
        { id: 'all',      label: 'All' },
        { id: 'runs',     label: 'Runs' },
        { id: 'standing', label: 'Standing' },
        { id: 'short',    label: 'Short' },
        { id: 'held',     label: 'Held' }
    ];

    function demandMatch(id, r) {
        if (id === 'runs') return r.owner !== OWNER;
        if (id === 'standing') return r.owner === OWNER;
        if (id === 'short') return r.status === S.DemandStatus.Short;
        if (id === 'held') return r.status === S.DemandStatus.Held;
        return true;
    }

    function num(v) {
        return cell(isNum(v) ? String(v) : DASH, 'steward-num');
    }

    // A stock that was read but is unknown shows ?, not the - of a cell where no stock applies.
    function known(v) {
        return cell(isNum(v) ? String(v) : '?', 'steward-num');
    }

    function freeLine(resv) {
        var seen = {};
        var parts = [];
        for (var i = 0; i < resv.length; i++) {
            var r = resv[i];
            if (!r || Object.prototype.hasOwnProperty.call(seen, r.name)) continue;
            seen[r.name] = true;
            parts.push(res(r.name) + ' ' + (isNum(r.free) ? Math.max(0, r.free) : '?'));
        }
        return 'Free for standing orders after reservations: ' + (parts.length ? parts.join(SEP) : 'everything') + '.';
    }

    function demand($c, h, data) {
        $c.empty();
        var rows = data && data.rows ? data.rows : [];
        var resv = data && data.reservations ? data.reservations : [];
        var id = filters.demand;

        $c.append(h.chips(DEMAND_CHIPS, id, function (pick) {
            filters.demand = pick;
            demand($c, h, data);
        }));

        var shown = [];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r || !demandMatch(id, r)) continue;
            var st = statusOf(r);
            shown.push([
                r.label || r.key || '',
                res(r.item),
                num(r.need),
                r.stockUnknown ? cell('?', 'steward-num') : num(r.stock),
                num(r.queued),
                priorityLabel(r.priority),
                cell(st.text, st.cls)
            ]);
        }
        var $ledger = h.card({ title: 'Demand ledger', meta: shown.length + ' of ' + rows.length });
        $ledger.append(h.table({
            cols: [
                { label: 'Owner', width: '24%' },
                { label: 'Item', width: '14%' },
                { label: 'Need', cls: 'steward-num', width: '8%' },
                { label: 'Stock', cls: 'steward-num', width: '8%' },
                { label: 'Queued', cls: 'steward-num', width: '8%' },
                { label: 'Priority', width: '11%' },
                { label: 'Status', width: '27%' }
            ],
            rows: shown,
            emptyText: 'No demand.'
        }));
        $c.append($ledger);

        var rrows = [];
        for (var j = 0; j < resv.length; j++) {
            var v = resv[j];
            if (!v) continue;
            rrows.push([res(v.name), num(v.reserved), known(v.stock), v.forLabel || '', priorityLabel(v.priority)]);
        }
        var $res = h.card({ title: 'Reservations', meta: 'held back from Standing orders' });
        $res.append(h.table({
            cols: [
                { label: 'Resource', width: '22%' },
                { label: 'Reserved', cls: 'steward-num', width: '13%' },
                { label: 'Stock', cls: 'steward-num', width: '13%' },
                { label: 'For', width: '37%' },
                { label: 'Priority', width: '15%' }
            ],
            rows: rrows,
            emptyText: 'Nothing reserved.'
        }));
        $res.append(muted(freeLine(resv)));
        $res.append(muted('Priority order: ' + priorityOrder().join(', ') + '.'));
        $c.append($res);
        return $c;
    }

    // ---------------------------------------------------------------
    // Bookbinder and on/off buildings.
    // ---------------------------------------------------------------

    function lastCompleted(h, data) {
        var list = recentList(data);
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            if (!e || e.kind !== S.ProductionNote.Complete) continue;
            var ok = e.status === S.ActionResult.Verified;
            return $('<span>')
                .append($('<span>').text((e.item ? res(e.item) : bui(e.name)) + ' at ' + at(h, e.at) + ' '))
                .append(h.badge(ok ? 'ok' : 'off', ok ? 'verified' : (e.text || 'failed')));
        }
        return 'none this session';
    }

    function booksCard(h, bk, data) {
        var meta = bk ? 'level ' + (bk.level === null ? '?' : bk.level) + SEP + 'grid ' + (bk.grid === null ? '?' : bk.grid) : '';
        var $card = h.card({ title: 'Bookbinder', meta: meta });
        if (!bk) {
            $card.append(muted('No Bookbinder was read on this island.'));
            return $card;
        }
        var head = bk.head;
        var book = head ? res(head.item) : 'none';
        book += SEP + (bk.standing ? 'standing order keep ' + bk.standing.amount : 'no standing order');
        var progress = DASH;
        if (head) {
            progress = produced(head, true);
            if (isNum(head.remainingMs) && head.remainingMs > 0) progress += SEP + 'done ' + at(h, Date.now() + head.remainingMs);
        }
        var costs = [];
        var lines = bk.info && bk.info.costs ? bk.info.costs : [];
        for (var i = 0; i < lines.length; i++) costs.push(lines[i].amount + ' ' + res(lines[i].name));
        var completion = !head ? DASH
            : bk.finished ? h.badge('ok', 'finished') : h.badge('busy', 'not finished');
        $card.append(h.table({
            cols: [{ label: 'Field', width: '30%' }, { label: 'Value', width: '70%' }],
            rows: [
            ['Current book', book],
            ['Progress', progress],
            ['Costs', costs.length ? costs.join(SEP) : DASH],
            ['Completion', completion],
            ['Last completed', lastCompleted(h, data)]
            ]
        }));

        var s = safe(function () { return M().readSettings(); }, null) || {};
        $card.append(h.field('Bookbinder auto-complete',
            'Off by default. Same setting as the submenu and dashboard switch',
            h.toggle({
                checked: !!s.bookComplete,
                write: function (v) {
                    S.kernel.settings.write('production', { bookComplete: v });
                    S.kernel.log('ui', 'production', 'bookComplete', '→', v);
                }
            })));
        var $btn = h.button('Complete', { size: 'sm', disabled: !bk.finished });
        if (bk.finished) {
            $btn.on('click', function (e) {
                if (e && e.preventDefault) e.preventDefault();
                if ($btn.attr('disabled')) return;
                try {
                    $btn.attr('disabled', 'disabled');
                    M().completeNow(P().QUEUE_BOOKS, bk.head ? bk.head.item : '');
                }
                catch (err) { S.kernel.error('production', 'Complete now threw:', err); }
            });
        }
        $card.append(h.toolRow('Complete now', 'Only when a finished book is waiting. Runs at once', $btn));
        return $card;
    }

    function resume(row, $btn) {
        $btn.attr('disabled', 'disabled');
        var def = P().setActive(row.grid, row.name, true);
        var started = S.core.actions.attempt(def, function (r) {
            M().noteResult(S.ProductionNote.Toggle, row.name, '', r, 'resumed', '');
        });
        if (!started) {
            S.kernel.error('production', 'could not start', def.label);
            M().noteResult(S.ProductionNote.Toggle, row.name, '', null, 'resumed', '');
        }
    }

    function resumeButton(h, row) {
        var $btn = h.button('Resume', { size: 'sm' });
        $btn.on('click', function (e) {
            if (e && e.preventDefault) e.preventDefault();
            if ($btn.attr('disabled')) return;
            try { resume(row, $btn); }
            catch (err) { S.kernel.error('production', 'Resume threw:', err); }
        });
        return $btn;
    }

    function onOffCard(h, rows, counts) {
        var card = { title: 'On/off buildings' };
        if (counts) card.meta = counts.stopped + ' stopped' + SEP + counts.miningOwned + ' mining-owned';
        var $card = h.card(card);
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r) continue;
            var mining = r.mining;
            var state = r.active === false ? h.badge('off', 'off')
                : h.badge('paused', r.state === S.core.buildings.MISSING_INPUT_STATE ? 'stopped: missing input' : 'stopped');
            var action = mining ? $('<span>', { 'class': 'steward-muted' }).text('owned by Mining')
                : r.active === false ? resumeButton(h, r)
                : $('<span>', { 'class': 'steward-muted' }).text('no input');
            out.push([
                r.label || r.name || '',
                r.grid === null || r.grid === undefined ? DASH : 'grid ' + r.grid,
                state,
                mining ? 'Mining' : DASH,
                { $: action, cls: 'steward-num' }
            ]);
        }
        $card.append(h.table({
            cols: [
                { label: 'Building', width: '28%' },
                { label: 'Where', width: '16%' },
                { label: 'State', width: '22%' },
                { label: 'Owner', width: '14%' },
                { label: '', cls: 'steward-num', width: '20%' }
            ],
            rows: out,
            emptyText: 'Every building is producing.'
        }));
        $card.append(muted('Resume runs at once (verified on IsProductionActive). Steward does not ' +
            'turn buildings off here. Mines and masons stay with the Mining module.'));
        return $card;
    }

    function countsOf(data) {
        return data && data.counts ? data.counts : null;
    }

    function books($c, h, data) {
        $c.empty();
        var bk = data ? data.books : null;
        var rows = data && data.onOff ? data.onOff : [];
        $c.append(booksCard(h, bk, data));
        $c.append(onOffCard(h, rows, countsOf(data)));
        return $c;
    }

    // ---------------------------------------------------------------
    // Recent.
    // ---------------------------------------------------------------

    function isFailed(e) {
        return e.status === S.ActionResult.Failed;
    }

    // { text, cls } of a recent entry's result column. A Skip has no
    // status, so the status check comes before the kind.
    function recentResult(e) {
        var R = S.ActionResult;
        if (e.status === R.Failed || e.status === R.Refused) return { text: e.text || '', cls: 'steward-bad' };
        if (e.kind === S.ProductionNote.Skip) return { text: 'skipped', cls: 'steward-muted' };
        return { text: 'verified', cls: 'steward-ok' };
    }

    function recentDetail(e) {
        var R = S.ActionResult;
        var d = e.status === R.Failed || e.status === R.Refused ? '' : (e.detail || '');
        if (e.kind === S.ProductionNote.Skip) d = 'standing order: ' + d;
        var parts = [];
        if (e.item) parts.push(res(e.item));
        if (d) parts.push(d);
        return parts.join(SEP);
    }

    function recentMatch(id, e) {
        if (id === 'orders') return e.kind === S.ProductionNote.Order;
        if (id === 'buffs') return e.kind === S.ProductionNote.Buff;
        if (id === 'books') return e.kind === S.ProductionNote.Complete;
        if (id === 'onoff') return e.kind === S.ProductionNote.Toggle;
        if (id === 'failed') return isFailed(e);
        return true;
    }

    function recent($c, h, data) {
        $c.empty();
        var list = data && typeof data.length === 'number' ? data : [];
        var failed = 0;
        for (var i = 0; i < list.length; i++) if (list[i] && isFailed(list[i])) failed++;
        var id = filters.recent;

        $c.append(h.chips([
            { id: 'all',    label: 'All' },
            { id: 'orders', label: 'Orders' },
            { id: 'buffs',  label: 'Buffs' },
            { id: 'books',  label: 'Bookbinder' },
            { id: 'onoff',  label: 'On/off' },
            { id: 'failed', label: 'Failed ' + failed }
        ], id, function (pick) {
            filters.recent = pick;
            recent($c, h, data);
        }));

        var rows = [];
        for (var j = 0; j < list.length; j++) {
            var e = list[j];
            if (!e || !recentMatch(id, e)) continue;
            var rs = recentResult(e);
            rows.push([
                at(h, e.at),
                e.kind || '',
                bui(e.name),
                recentDetail(e),
                cell(rs.text, rs.cls)
            ]);
        }
        var $card = h.card({ title: 'Recent actions', meta: 'last ' + list.length + SEP + 'log category production' });
        $card.append(h.table({
            cols: [
                { label: 'Time', width: '9%' },
                { label: 'Action', width: '10%' },
                { label: 'Building', width: '18%' },
                { label: 'Detail', width: '45%' },
                { label: 'Result', width: '18%' }
            ],
            rows: rows,
            emptyText: 'Nothing done this session.'
        }));
        $c.append($card);
        return $c;
    }

    S.modules.production.views = {
        queues: queues,
        demand: demand,
        books:  books,
        recent: recent,
        // Exposed for the other production surfaces, so every one uses the
        // same status and priority wording.
        statusOf:      statusOf,
        priorityLabel: priorityLabel,
        priorityOrder: priorityOrder
    };

}(Steward));
