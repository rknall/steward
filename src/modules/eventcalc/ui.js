/*
 * Dashboard surface for the eventcalc module.
 *
 * Renders inside the Events tab with two parts:
 *   - Explorer event items: the core estimate (best task per explorer,
 *     summed) as items per day and until the item-drop phase ends.
 *   - Refill calculator: one row per event field with its production time,
 *     the deposit left, and the units / refill items still needed to keep
 *     it producing until the event shop closes, plus a total row.
 *
 * Route seconds and units per item are settings (dashboard buffer, Save
 * persists). The remaining time and per-field deposit edits describe the
 * current moment, so they live in a module-level session that the
 * "Event calculator…" menu entry and the reset button clear.
 *
 * All game reads go through S.core.*; nothing here touches `game`.
 */

(function (S) {

    if (!S.modules.eventcalc) S.modules.eventcalc = {};

    var session = { overrides: {}, remainingSec: null, snapshot: null };

    function resetSession() {
        session = { overrides: {}, remainingSec: null, snapshot: null };
    }

    function isNum(n) {
        return typeof n === 'number' && !isNaN(n);
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function formatDate(ms) {
        if (!isNum(ms)) return '—';
        var d = new Date(ms);
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
               ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    function resName(resource) {
        if (!resource) return '';
        try { return S.core.locale.res(resource); }
        catch (e) { return resource; }
    }

    function buiName(building) {
        try { return S.core.locale.bui(building); }
        catch (e) { return building; }
    }

    function textOrDash(v) {
        return (v === null || typeof v === 'undefined') ? '—' : String(v);
    }

    // gridRow renders strings as HTML, so names from the host go in as text.
    function textCell(v) {
        return $('<span>').text(textOrDash(v));
    }

    function readSettings(h) {
        var defaults = S.modules.eventcalc.defaultSettings || {};
        var stored = h.settings('eventcalc') || {};
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        return merged;
    }

    function safeEstimate() {
        try {
            if (S.core.specialists && S.core.specialists.estimateEventItems) {
                return S.core.specialists.estimateEventItems();
            }
        } catch (e) {
            S.kernel.warn('eventcalc', 'estimateEventItems threw:', e);
        }
        return null;
    }

    function refillApi() {
        return (S.core.events && S.core.events.refill) || null;
    }

    // ---------------------------------------------------------------
    // Estimate part
    // ---------------------------------------------------------------

    function drawEstimate($wrap, h) {
        $wrap.append(h.headerRow('Explorer event items'));
        var est = safeEstimate();
        if (!est) {
            $wrap.append(h.formRow(
                $('<em>').text('No event with explorer items is live.'), ''));
            return;
        }
        var res = resName(est.resource);
        $wrap.append(h.formRow('Explorers counted',
            est.counted + ' of ' + est.explorers));
        $wrap.append(h.formRow('Per day',
            Math.round(est.perDay) + ' ' + res));
        $wrap.append(h.formRow('Until items stop (' + formatDate(est.endTime) + ')',
            textOrDash(est.untilEnd) + (est.untilEnd === null ? '' : ' ' + res)));
        $wrap.append(h.indentRow(
            'approx.: best task per explorer; loot-count traits not included'));
    }

    // ---------------------------------------------------------------
    // Refill part
    // ---------------------------------------------------------------

    function currentRemaining(ev) {
        if (isNum(session.remainingSec)) return session.remainingSec;
        return isNum(ev.remainingSec) ? ev.remainingSec : 0;
    }

    function parseNonNegInt(val) {
        var n = parseInt(val, 10);
        return (isNaN(n) || n < 0) ? null : n;
    }

    function rowsWithOverrides(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var src = list[i];
            var copy = {};
            for (var k in src) {
                if (Object.prototype.hasOwnProperty.call(src, k)) copy[k] = src[k];
            }
            if (Object.prototype.hasOwnProperty.call(session.overrides, src.key)) {
                copy.deposit = session.overrides[src.key];
            }
            out.push(copy);
        }
        return out;
    }

    function fieldLabel(row) {
        var label = buiName(row.building);
        if (row.grid !== null && typeof row.grid !== 'undefined') {
            label += ' (grid ' + row.grid + ')';
        } else {
            var hash = String(row.key).lastIndexOf('#');
            if (hash !== -1) label += ' #' + String(row.key).substring(hash + 1);
        }
        return label;
    }

    function drawRemainingInputs($wrap, h, ev, redraw) {
        var sec = currentRemaining(ev);
        var days = Math.floor(sec / 86400);
        var hours = Math.floor((sec % 86400) / 3600);

        var $ctl = $('<span>');
        $ctl.append(h.input({
            type:     'number',
            value:    days,
            width:    '60px',
            onChange: function (val) {
                var n = parseNonNegInt(val);
                if (n === null) return;
                var cur = currentRemaining(ev);
                session.remainingSec = n * 86400 + (cur % 86400);
                redraw();
            }
        }));
        $ctl.append(document.createTextNode(' d '));
        $ctl.append(h.input({
            type:     'number',
            value:    hours,
            width:    '60px',
            onChange: function (val) {
                var n = parseNonNegInt(val);
                if (n === null) return;
                var cur = currentRemaining(ev);
                session.remainingSec = Math.floor(cur / 86400) * 86400 + n * 3600 + (cur % 3600);
                redraw();
            }
        }));
        $ctl.append(document.createTextNode(' h'));
        $wrap.append(h.formRow('Remaining time', $ctl,
            'until ' + formatDate(ev.endTime) + ' — this session only'));
    }

    function drawSettingInputs($wrap, h, s, redraw) {
        $wrap.append(h.formRow('Route', h.input({
            type:     'number',
            value:    s.routeSeconds,
            width:    '60px',
            onChange: function (val) {
                var n = parseNonNegInt(val);
                if (n === null) return;
                h.update('eventcalc', { routeSeconds: n });
                redraw();
            }
        }), 's one way between field and storehouse'));

        $wrap.append(h.formRow('Units per item', h.input({
            type:     'number',
            value:    s.unitsPerItem,
            width:    '60px',
            onChange: function (val) {
                var n = parseNonNegInt(val);
                if (n === null || n < 1) return;
                h.update('eventcalc', { unitsPerItem: n });
                redraw();
            }
        }), 'deposit units one refill item adds'));
    }

    function depositCell(h, row, redraw) {
        var $cell = $('<span>');
        $cell.append(h.input({
            type:     'number',
            value:    isNum(row.deposit) ? row.deposit : 0,
            width:    '60px',
            onChange: function (val) {
                var n = parseNonNegInt(val);
                if (n === null) return;
                session.overrides[row.key] = n;
                redraw();
            }
        }));
        $cell.append($('<span>', { 'class': 'steward-row-help' })
            .text(row.source === 'game' ? '(game)' : '(manual)'));
        return $cell;
    }

    function drawRefill($wrap, h, s, redraw) {
        var api = refillApi();
        var ev = null;
        try { ev = api ? api.depositEvent() : null; }
        catch (e) { S.kernel.warn('eventcalc', 'depositEvent threw:', e); }

        $wrap.append(h.headerRow('Refill calculator' + (ev ? ' — ' + ev.name : '')));
        if (!ev) {
            $wrap.append(h.formRow(
                $('<em>').text('No event with refillable fields is live.'), ''));
            return;
        }

        if (!session.snapshot) session.snapshot = api.rows(ev.code);
        var snap = session.snapshot || { source: 'manual', rows: [] };

        drawRemainingInputs($wrap, h, ev, redraw);
        drawSettingInputs($wrap, h, s, redraw);

        if (snap.source === 'manual') {
            $wrap.append(h.indentRow(
                'Field data not readable here (home island only); values are editable.'));
        }

        var result = api.compute(rowsWithOverrides(snap.rows || []),
            currentRemaining(ev), s.routeSeconds, s.unitsPerItem);

        $wrap.append(h.gridRow(
            [[4, 'Field'], [2, 'Production s'], [2, 'Deposit left'],
             [2, 'Units'], [2, 'Items']],
            { headerCells: true }
        ));
        for (var i = 0; i < result.rows.length; i++) {
            var row = result.rows[i];
            $wrap.append(h.gridRow(
                [[4, textCell(fieldLabel(row))],
                 [2, textCell(row.workTime)],
                 [2, depositCell(h, row, redraw)],
                 [2, textCell(row.units)],
                 [2, textCell(row.items)]]
            ));
        }
        $wrap.append(h.gridRow(
            [[4, $('<strong>').text('Total')],
             [2, ''],
             [2, ''],
             [2, $('<strong>').text(String(result.totalUnits))],
             [2, $('<strong>').text(String(result.totalItems))]]
        ));

        var $btns = $('<span>');
        $btns.append(h.button('Reset to game values', {
            size: 'sm',
            onClick: function () {
                resetSession();
                redraw();
            }
        }));
        $btns.append(document.createTextNode(' '));
        $btns.append(h.button('Empty deposits', {
            size: 'sm',
            onClick: function () {
                var list = snap.rows || [];
                for (var r = 0; r < list.length; r++) session.overrides[list[r].key] = 0;
                redraw();
            }
        }));
        $wrap.append(h.formRow('', $btns));
    }

    function renderSection($panel, h) {
        var $wrap = $('<div>', { 'class': 'steward-eventcalc' });
        $panel.append($wrap);

        function draw() {
            var s = readSettings(h);
            drawEstimate($wrap, h);
            drawRefill($wrap, h, s, redraw);
        }
        function redraw() {
            $wrap.empty();
            draw();
        }
        draw();
    }

    // ---------------------------------------------------------------
    // Native-menu alert
    // ---------------------------------------------------------------

    function estimateText() {
        var est = safeEstimate();
        if (!est) return 'no event with explorer items is live';
        var res = resName(est.resource);
        var text = est.name + ': ≈ ' + Math.round(est.perDay) + ' ' + res + '/day';
        if (est.untilEnd !== null && typeof est.untilEnd !== 'undefined') {
            text += ', ≈ ' + est.untilEnd + ' until ' + formatDate(est.endTime);
        }
        text += ' (' + est.counted + ' explorers, best task each)';
        return text;
    }

    function showEstimateAlert() {
        var text = estimateText();
        try {
            if (typeof showGameAlert === 'function') showGameAlert('Steward: ' + text);
        } catch (e) { /* best effort */ }
    }

    S.modules.eventcalc.resetSession      = resetSession;
    S.modules.eventcalc.renderSection     = renderSection;
    S.modules.eventcalc.showEstimateAlert = showEstimateAlert;

}(Steward));
