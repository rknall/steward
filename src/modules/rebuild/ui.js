/*
 * Dashboard surface for the rebuild module.
 *
 * Renders on the Economy Advisor's Rebuild tab: a settings column with the
 * switch and the well and field type, and one card listing every well, field
 * and depleted shell on the home island with what is left in it. It never
 * sends anything and writes nothing: the plan in module.js decides and
 * queues. Every queue fact comes from S.core.construction.capacity() and
 * freeSlots(), and the rows from the module's own scan(), so the view and
 * the plan read the same rules.
 *
 * Away from the home island nothing is listed, since the building list then
 * holds another zone's shells. A read that is not settled shows as
 * "reading..." and the dashboard redraws it by itself.
 */

(function (S) {

    if (!S.modules.rebuild) S.modules.rebuild = {};

    var R = S.kernel.read;

    function mod() {
        return S.modules.rebuild;
    }

    // Everything one surface draw reads, so a draw sees one consistent state.
    // rows and amounts stay null when the island is not listable: away from
    // home, or a building list that gave nothing.
    function view() {
        var m = mod();
        var v = {
            s:       m.readSettings(),
            home:    S.core.zone.isHome(),
            usable:  S.core.ledger.usable(),
            entries: S.core.ledger.snapshot('rebuild'),
            brk:     S.core.ledger.breaker('rebuild'),
            cap:     S.core.construction.capacity(),
            list:    S.core.buildings.listRead(),
            rows:    null,
            amounts: null
        };
        if (v.home && R.has(v.list)) {
            v.rows = m.scan(v.list.value, v.s).sort(function (a, b) { return a.grid - b.grid; });
            v.amounts = {
                well:  S.core.deposits.amountsRead(m.wellDeposit),
                field: S.core.deposits.amountsRead(m.fieldDeposit)
            };
        }
        return v;
    }

    function summaryText(s) {
        var m = mod();
        return m.targetOf('well', s).label + ' · ' + m.targetOf('field', s).label;
    }

    function summary(h) {
        return summaryText(h.settings('rebuild'));
    }

    function options(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) out.push({ label: list[i].label, value: list[i].name });
        return out;
    }

    // Settings column. The baseline is the merged settings the card shows, so
    // a key the stored object lacks does not count as a change.
    function renderSide($side, h) {
        var m = mod();
        h.baseline('rebuild', m.readSettings());

        var $card = h.card({ icon: '↻', title: 'Rebuild wells and fields', meta: 'settings' });
        $card.append(h.field('Rebuild on the home island',
            'Spends resources and a build slot per rebuild; off by default',
            h.toggle({ ns: 'rebuild', path: 'enabled', label: 'Rebuild on the home island' })));
        $card.append(h.field('Well type', 'What an exhausted well is rebuilt as',
            h.dropdown(options(m.wells), { ns: 'rebuild', path: 'wellType' })));
        $card.append(h.field('Field type', 'What an exhausted field is rebuilt as',
            h.dropdown(options(m.fields), { ns: 'rebuild', path: 'fieldType' })));
        $side.append($card);
    }

    // The deposit amount of a row: "amount / maximum" where the game gives a
    // maximum, the bare amount without one. A shell is the depleted deposit
    // itself, so it reads 0 when the game gives none; a live building with no
    // reading stays unknown.
    function amountCell(h, v, row) {
        var a = v.amounts[row.kind];
        var d = R.isOk(a) ? a.value[row.grid] : null;
        if (d && d.amount !== null) {
            return d.max !== null ? d.amount + ' / ' + d.max : String(d.amount);
        }
        return row.shell ? '0' : h.unknown();
    }

    function shellLabel(row) {
        if (!row.shell) return row.entry.label;
        return row.kind === 'well' ? 'Exhausted well' : 'Exhausted field';
    }

    function tableRows(h, v) {
        var out = [];
        for (var i = 0; i < v.rows.length; i++) {
            var row = v.rows[i];
            out.push([String(row.grid), shellLabel(row), row.target.label, amountCell(h, v, row)]);
        }
        return out;
    }

    function banners($main, h, v) {
        var m = mod();
        if (v.brk && v.brk.isOpen()) {
            $main.append(h.banner('Rebuilding paused: ' + v.brk.snapshot().run + ' ' + m.BREAKER.missText +
                '. One probe every ' + S.kernel.text.minText(v.brk.COOLDOWN_MS) +
                '; reloading scripts resets it.', { icon: '⏸' }));
        }
        for (var i = 0; i < v.entries.length; i++) {
            var e = v.entries[i];
            if (e.state !== 'stale') continue;
            $main.append(h.banner('Grid ' + m.gridOfKey(e.key) + ': the rebuild was sent ' +
                S.kernel.text.minText(e.ageMs) + ' ago and the shell was never seen on its grid. ' +
                'Check it in the game; Steward does not clear this for you.', { icon: '⚠' }));
        }
    }

    function listCard(h, v) {
        var $card = h.card({
            icon: '↻', title: 'Wells and fields',
            meta: v.rows.length + ' on the home island'
        });
        if (!v.rows.length) {
            $card.append(h.empty('No wells or fields on the home island'));
        } else {
            $card.append(h.table({
                cols: [
                    { label: 'Grid',        width: '14%' },
                    { label: 'Shell',       width: '32%' },
                    { label: 'Rebuild as',  width: '32%' },
                    { label: 'Amount',      width: '22%', cls: 'steward-num' }
                ],
                rows: tableRows(h, v)
            }));
        }
        $card.append($('<div>', { 'class': 'steward-muted steward-note' }).text(
            'Amount is what is left in the shell. Where the game gives a maximum it reads ' +
            'amount / maximum; an amount can be above the maximum when you added to it yourself.'));
        // Only a build queue that read as full: an unread one is not "full".
        if (R.isOk(v.cap) && !(S.core.construction.freeSlots(v.cap.value) > 0)) {
            $card.append($('<div>', { 'class': 'steward-muted steward-note' }).text('(Waiting for rebuild...)'));
        }
        return $card;
    }

    // Main column; the first state that applies is the only content.
    function render($main, h) {
        var v = view();
        if (!v.s.enabled) {
            $main.append(h.empty('Rebuilding is off', 'Switch it on to list the wells and fields of the home island.'));
            return;
        }
        if (!v.usable) {
            $main.append(h.banner('Nothing is sent: there is no writable steward folder, or the send ledger could not be read.',
                { icon: '⚠' }));
            $main.append(h.empty('No rebuilds while the ledger is unusable',
                'Fix the steward folder; the list returns on its own.'));
            return;
        }
        if (!v.home) {
            $main.append(h.banner('Rebuilds run on the home island only', { icon: 'ⓘ' }));
            $main.append(h.empty('Away from the home island', 'Nothing is listed or queued here.'));
            return;
        }
        if (v.rows === null) {
            $main.append(h.reading('Waiting for the building list and the build queue to read.'));
            return;
        }
        banners($main, h, v);
        $main.append(listCard(h, v));
    }

    // Shell rows the plan would rebuild now, and the entries still waiting
    // for their grid to show the rebuild.
    function readyCount(rows) {
        var n = 0;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].shell && rows[i].why === null) n++;
        }
        return n;
    }

    function waitingCount(entries) {
        var n = 0;
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].state === 'sent' || entries[i].state === 'unseen') n++;
        }
        return n;
    }

    function tiles(h) {
        var s = h.settings('rebuild');
        var v = view();
        var text = summaryText(s);
        var lines;
        if (!s.enabled) {
            lines = ['Off', text];
        } else if (v.brk && v.brk.isOpen()) {
            lines = ['Paused by the breaker', text];
        } else if (v.rows === null) {
            lines = [h.READING, text];
        } else {
            var n = readyCount(v.rows);
            var w = waitingCount(v.entries);
            var first = n === 0 ? 'No exhausted wells or fields' : n + ' exhausted';
            if (n > 0 && w > 0) first += ' · ' + w + ' waiting on its grid';
            lines = [first, text];
        }
        return [{ title: 'Rebuild wells and fields', icon: '↻', lines: lines }];
    }

    S.modules.rebuild.side    = renderSide;
    S.modules.rebuild.render  = render;
    S.modules.rebuild.summary = summary;
    S.modules.rebuild.tiles   = tiles;

}(Steward));
