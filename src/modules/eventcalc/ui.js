/*
 * Dashboard surface for the eventcalc module.
 *
 * Renders inside the Events tab with two cards:
 *   - Explorer event items: the core estimate (best task per explorer,
 *     summed) as items per day and until the item-drop phase ends.
 *   - Refill calculator: one row per event field with the deposit left, its
 *     production per 12 h and until the event shop closes if kept refilled
 *     (buffed value in parentheses while a production buff is active), and
 *     the refill units / items still needed, plus a total row.
 *
 * Route seconds and units per item are saved settings (dashboard buffer, Save
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
               ' ' + S.kernel.ui.helpers.clock(d);
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

    // A production figure with the buffed value in muted parentheses when a
    // buff is active. Text only, so names and numbers from the host stay inert.
    function buffedCell(v, b) {
        var $c = $('<span>').text(textOrDash(v));
        if (b !== null && typeof b !== 'undefined') {
            $c.append($('<span>', { 'class': 'steward-muted' }).text(' (' + b + ')'));
        }
        return { cls: 'steward-num', $: $c };
    }

    // Which phase an event is in. Items drop in the treasure phase; with
    // only the shop variant live the event is cooling down.
    function eventPhase(ev) {
        var cats = ev && ev.categories;
        var inTreasure = !!(cats && cats.treasure);
        var inCooldown = !!(cats && cats.shop && !inTreasure);
        if (inTreasure) return { kind: 'phase', label: 'Treasure phase' };
        if (inCooldown) return { kind: 'busy', label: 'Cooldown phase' };
        var list = (ev && ev.categoryList) || [];
        return { kind: 'off', label: list.length ? list.join(', ') : 'Live' };
    }

    function liveEvents() {
        try { return S.core.events.active() || []; }
        catch (e) { S.kernel.warn('eventcalc', 'events.active threw:', e); }
        return [];
    }

    function liveEvent(code) {
        var list = liveEvents();
        for (var i = 0; i < list.length; i++) {
            if (list[i].code === code) return list[i];
        }
        return null;
    }

    // The amount of the event currency held, or null when it is unknown.
    function heldAmount(code) {
        try {
            if (S.core.events.eventResourceAmount) {
                var n = S.core.events.eventResourceAmount(code);
                return isNum(n) ? n : null;
            }
        } catch (e) { /* unreadable: no figure */ }
        return null;
    }

    function eventResource(code) {
        try {
            if (S.core.events.eventResource) return S.core.events.eventResource(code) || null;
        } catch (e) { /* unreadable: no figure */ }
        return null;
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
    // Estimate card
    // ---------------------------------------------------------------

    function estimateCard(h) {
        var est = safeEstimate();
        if (!est) {
            return h.card({ title: 'Explorer event items' })
                .append(h.empty('No event with explorer items is live.'));
        }
        var res = resName(est.resource);
        var held = heldAmount(est.code);
        var meta = (held === null ? '' : res + ' ' + held + ' held · ') +
                   'items stop ' + formatDate(est.endTime);
        var ev = liveEvent(est.code);
        var phase = ev ? eventPhase(ev) : null;
        // The meta floats right, so a badge placed after it in the markup is
        // still laid out next to the title.
        var $badge = phase
            ? h.badge(phase.kind, phase.label).addClass('steward-card-badge')
            : null;
        var $card = h.card({ icon: '⚑', title: est.name, meta: meta, $tools: $badge });
        $card.append(h.stats([
            { k: 'Explorers counted', v: est.counted, small: 'of ' + est.explorers },
            { k: 'Explorers bring per day', v: Math.round(est.perDay), small: res },
            { k: 'Until items stop', v: textOrDash(est.untilEnd),
              small: est.untilEnd === null ? '' : res },
            { k: 'How it is counted', $v: $('<span>', { 'class': 'steward-muted' }).text(
                'Best task per explorer. Traits that change the loot count are not included.') }
        ]));
        return $card;
    }

    // ---------------------------------------------------------------
    // Refill card
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

    function remainingInputs(h, ev, redraw) {
        var sec = currentRemaining(ev);
        var days = Math.floor(sec / 86400);
        var hours = Math.floor((sec % 86400) / 3600);

        var $ctl = $('<span>');
        $ctl.append(h.input({
            type:     'number',
            value:    days,
            width:    '54px',
            title:    'Days left',
            onChange: function (val) {
                var n = parseNonNegInt(val);
                if (n === null) return;
                var cur = currentRemaining(ev);
                session.remainingSec = n * 86400 + (cur % 86400);
                redraw();
            }
        }));
        $ctl.append($('<span>', { 'class': 'steward-unit' }).text('d'));
        $ctl.append(h.input({
            type:     'number',
            value:    hours,
            width:    '54px',
            title:    'Hours left',
            onChange: function (val) {
                var n = parseNonNegInt(val);
                if (n === null) return;
                var cur = currentRemaining(ev);
                session.remainingSec = Math.floor(cur / 86400) * 86400 + n * 3600 + (cur % 3600);
                redraw();
            }
        }));
        $ctl.append($('<span>', { 'class': 'steward-unit' }).text('h'));
        return $ctl;
    }

    // One labelled control in the inline row above the table.
    function inlineItem(label, $ctl, note) {
        var $i = $('<span>', { 'class': 'steward-inline-item' });
        $i.append($('<span>').text(label + ' '));
        $i.append($ctl);
        if (note) $i.append($('<span>', { 'class': 'steward-muted' }).text(' ' + note));
        return $i;
    }

    // Route and units per item are saved settings, bound to the dashboard
    // buffer; every edit recomputes the table from the buffered values.
    function settingInputs(h, redraw) {
        var parse = S.kernel.ui.settingsParse;
        // The shown values are the baseline, so reverting an edit is no change.
        h.baseline('eventcalc', readSettings(h));
        var $route = h.number({
            ns:       'eventcalc',
            path:     'routeSeconds',
            parse:    parse.whole,
            width:    '54px',
            label:    'Route seconds',
            onChange: redraw
        });
        var $units = h.number({
            ns:       'eventcalc',
            path:     'unitsPerItem',
            parse:    function (text) {
                var n = parse.whole(text);
                return (n === null || n < 1) ? null : n;
            },
            width:    '54px',
            label:    'Units per item',
            onChange: redraw
        });
        return [
            inlineItem('Route', $route, 's one way, field to storehouse'),
            inlineItem('Units per item', $units, null)
        ];
    }

    function depositCell(h, row, redraw) {
        var overridden = Object.prototype.hasOwnProperty.call(session.overrides, row.key);
        var $cell = $('<span>');
        $cell.append(h.input({
            type:     'number',
            value:    isNum(row.deposit) ? row.deposit : 0,
            width:    '54px',
            title:    'Deposit',
            onChange: function (val) {
                var n = parseNonNegInt(val);
                if (n === null) return;
                session.overrides[row.key] = n;
                redraw();
            }
        }));
        var tag = overridden ? 'edited' : (row.source === 'game' ? 'game' : 'manual');
        $cell.append($('<span>', { 'class': 'steward-muted' }).text(' ' + tag));
        return { $: $cell };
    }

    function refillCard(h, redraw) {
        var api = refillApi();
        var ev = null;
        try { ev = api ? api.depositEvent() : null; }
        catch (e) { S.kernel.warn('eventcalc', 'depositEvent threw:', e); }

        var $card = h.card({
            title: 'Refill calculator',
            meta:  'Route and units per item apply on Save; deposits and time left are for this session'
        });
        if (!ev) {
            return $card.append(h.empty('No event with refillable fields is live.'));
        }

        if (!session.snapshot) session.snapshot = api.rows(ev.code);
        var snap = session.snapshot || { source: 'manual', rows: [] };
        var s = readSettings(h);

        var $inline = $('<div>', { 'class': 'steward-inline' });
        $inline.append(inlineItem('Time left', remainingInputs(h, ev, redraw),
            'until ' + formatDate(ev.endTime)));
        var inputs = settingInputs(h, redraw);
        for (var n = 0; n < inputs.length; n++) $inline.append(inputs[n]);
        $card.append($inline);

        if (snap.source === 'manual') {
            $card.append($('<div>', { 'class': 'steward-muted steward-note' })
                .text('Field data not readable here (home island only); values are editable.'));
        }

        var result = api.compute(rowsWithOverrides(snap.rows || []),
            currentRemaining(ev), s.routeSeconds, s.unitsPerItem);

        var rows = [];
        for (var i = 0; i < result.rows.length; i++) {
            var row = result.rows[i];
            var label = fieldLabel(row);
            rows.push([
                { text: label, title: label },
                depositCell(h, row, redraw),
                buffedCell(row.rate12h, row.rate12hBuffed),
                buffedCell(row.untilEnd, row.untilEndBuffed),
                textOrDash(row.units),
                textOrDash(row.items)
            ]);
        }
        $card.append(h.table({
            fill: true,
            cols: [
                { label: 'Field',     width: '32%' },
                { label: 'Deposit',   width: '16%' },
                { label: 'Per 12 h',  width: '13%', cls: 'steward-num' },
                { label: 'Until end', width: '13%', cls: 'steward-num' },
                { label: 'Refill',    width: '13%', cls: 'steward-num' },
                { label: 'Items',     width: '13%', cls: 'steward-num' }
            ],
            rows: rows,
            foot: [
                'Total',
                String(result.totalDeposit),
                buffedCell(result.totalRate12h, result.totalRate12hBuffed),
                buffedCell(result.totalUntilEnd, result.totalUntilEndBuffed),
                String(result.totalUnits),
                String(result.totalItems)
            ]
        }));

        var $bottom = $('<div>', { 'class': 'steward-card-foot' });
        $bottom.append($('<span>', { 'class': 'steward-muted' }).text(
            resName(ev.resource) + '; (…) = with the active production buff. ' +
            'Refill in deposit units. '));
        $bottom.append(h.button('Reset to game values', {
            size: 'sm',
            onClick: function () {
                resetSession();
                redraw();
            }
        }));
        $bottom.append(document.createTextNode(' '));
        $bottom.append(h.button('Empty deposits', {
            size: 'sm',
            onClick: function () {
                var list = snap.rows || [];
                for (var r = 0; r < list.length; r++) session.overrides[list[r].key] = 0;
                redraw();
            }
        }));
        $card.append($bottom);
        return $card;
    }

    function renderSection($panel, h) {
        var $wrap = $('<div>', { 'class': 'steward-stack' });
        $panel.append($wrap);

        function draw() {
            $wrap.append(estimateCard(h));
            $wrap.append(refillCard(h, redraw));
        }
        function redraw() {
            $wrap.empty();
            draw();
            h.fit();
        }
        draw();
    }

    // One Overview tile per live event.
    function tiles() {
        var out = [];
        var list = liveEvents();
        var est = list.length ? safeEstimate() : null;
        for (var i = 0; i < list.length; i++) {
            var ev = list[i];
            var held = heldAmount(ev.code);
            var res = resName(eventResource(ev.code));
            var lines = [eventPhase(ev).label +
                (held === null ? '' : ' · ' + (res ? res + ' ' : '') + held + ' held')];
            if (est && est.code === ev.code) {
                lines.push('Explorers bring about ' + Math.round(est.perDay) + ' a day until ' +
                    formatDate(est.endTime));
            }
            out.push({
                title: ev.name,
                icon:  '⚑',
                lines: lines,
                badge: { kind: 'ok', text: 'Live' },
                links: [{ label: 'Calculator', tab: 'events' }]
            });
        }
        return out;
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
    S.modules.eventcalc.tiles             = tiles;
    S.modules.eventcalc.eventPhase        = eventPhase;
    S.modules.eventcalc.showEstimateAlert = showEstimateAlert;

}(Steward));
