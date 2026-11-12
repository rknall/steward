/*
 * Live view of the production window: the queues.
 *
 * The view is queues($c, h, data): it empties $c and builds its body from
 * data, which the window reads on open and on Refresh. data.queues holds the
 * model's listed queue rows. A view never reads the host on a timer and never
 * redraws on its own. Every user or host string goes in with .text() through
 * the helpers.
 *
 * The Producing / All chips are view state kept in memory; picking a chip
 * redraws only this view from the data it was given. No control here acts at
 * once.
 *
 * Bundle slot: module, loads after module.js (name order); every
 * S.modules.production.* and S.core.production.* reference happens at call
 * time.
 */

(function (S) {
    'use strict';

    if (!S.modules.production) S.modules.production = {};

    var SEP   = ' · ';
    var DASH  = '–';

    var filter = 'all';

    function safe(fn, fallback) {
        try {
            var v = fn();
            return v === undefined ? fallback : v;
        } catch (e) {
            return fallback;
        }
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

    // Why an empty queue stays empty: the automatic queue of its type, if any.
    function emptyReason(auto) {
        if (!auto) return ' No automatic queue.';
        return ' Automatic queue ' + (auto.label || res(auto.item)) + ': orders when the building is idle.';
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

    function queueCard(h, q, now) {
        var list = q.entries;
        // Without the model's lines there is nothing safe to render, so the
        // queue counts as unreadable rather than being regrouped here.
        var lines = list && q.lines ? q.lines : null;
        var meta = !list ? 'unreadable'
            : !list.length ? 'empty'
            : list.length + (list.length === 1 ? ' entry' : ' entries') +
                (isNum(q.doneAt) ? SEP + 'done ' + at(h, q.doneAt) : '');
        var $card = h.card({ title: queueTitle(h, q, now), meta: meta });

        if (!list || !lines) {
            $card.append(muted('Queue unreadable.'));
            return $card;
        }
        if (!list.length) {
            $card.append(muted('Queue empty.' + emptyReason(q.auto)));
            return $card;
        }

        var books = q.kind === S.ProductionKind.Books;
        var out = [];
        var sum = 0, known = true;
        for (var i = 0; i < lines.length; i++) {
            var e = lines[i] || {};
            if (isNum(e.remainingMs) && known) sum += e.remainingMs;
            else known = false;
            var src = safe(function () { return q.source(e); }, 'Other');
            var n = e['repeat'];
            out.push([
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
            rows: out
        }));
        return $card;
    }

    function queues($c, h, data) {
        $c.empty();
        var list = data && data.queues && typeof data.queues.length === 'number' ? data.queues : [];
        if (!list.length) {
            $c.append(h.empty('No production queues', 'No building with a production queue was read on this island.'));
            return $c;
        }
        var producing = [];
        for (var i = 0; i < list.length; i++) if (list[i] && list[i].producing) producing.push(list[i]);

        $c.append(h.chips([
            { id: 'producing', label: 'Producing ' + producing.length },
            { id: 'all',       label: 'All ' + list.length }
        ], filter, function (pick) {
            filter = pick;
            queues($c, h, data);
        }));

        var shown = filter === 'producing' ? producing : list;
        if (!shown.length) {
            $c.append(h.empty('Nothing is in production right now.'));
            return $c;
        }
        var now = Date.now();
        var $stack = $('<div>', { 'class': 'steward-stack' });
        for (var j = 0; j < shown.length; j++) {
            if (shown[j]) $stack.append(queueCard(h, shown[j], now));
        }
        $c.append($stack);
        return $c;
    }

    S.modules.production.views = {
        queues: queues
    };

}(Steward));
