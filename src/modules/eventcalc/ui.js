/*
 * Dashboard surface for the eventcalc module.
 *
 * Renders inside the Events tab, top to bottom:
 *   - Explorer event items (only while an event is live): the core estimate
 *     (best task per explorer, summed) as items per day and until the
 *     item-drop phase ends.
 *   - Refill calculator: one row per event field with the amount it holds,
 *     its production per 12 h, the buffed rate in its own column while some
 *     field is buffed, and the refills still needed until the event shop
 *     closes, plus a total row.
 *   - Event resources held (held.js), whether or not an event is live.
 *
 * The card has no controls: the time left is the shop close the event
 * reports, and route seconds and units per item are the saved settings.
 * Fields read from the island show their amount as text; template rows
 * (fields not readable here) take it as an input. Those edits and the field
 * snapshot live in a module-level session that every dashboard draw of the
 * tab clears (opening the dashboard, switching to the tab, an Overview
 * link), so they last only across the card's own redraws.
 *
 * All game reads go through S.core.*; nothing here touches `game`.
 */

(function (S) {

    if (!S.modules.eventcalc) S.modules.eventcalc = {};

    var session = { overrides: {}, snapshot: null };

    function resetSession() {
        session = { overrides: {}, snapshot: null };
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

    // Counted to the shop close the event reports; the card has no time
    // control, so every draw uses the host's figure.
    function remainingOf(ev) {
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

    // A figure as text, or a muted dash when there is none.
    function numOrDash(v) {
        if (v === null || typeof v === 'undefined') {
            return { $: $('<span>', { 'class': 'steward-muted' }).text('—') };
        }
        return String(v);
    }

    // A field read from the island shows its amount as text. Template rows
    // (fields not readable here) take the amount as an input instead, so the
    // calculator still works away from home.
    function amountCell(h, row, redraw) {
        if (row.source === 'game') return numOrDash(row.deposit);
        var overridden = Object.prototype.hasOwnProperty.call(session.overrides, row.key);
        var $cell = $('<span>');
        $cell.append(h.input({
            type:     'number',
            value:    isNum(row.deposit) ? row.deposit : 0,
            width:    '54px',
            title:    'Amount',
            onChange: function (val) {
                var n = parseNonNegInt(val);
                if (n === null) return;
                session.overrides[row.key] = n;
                redraw();
            }
        }));
        $cell.append($('<span>', { 'class': 'steward-muted' })
            .text(overridden ? ' edited' : ' manual'));
        return { $: $cell };
    }

    function refillCard(h, redraw) {
        var api = refillApi();
        var ev = null;
        try { ev = api ? api.depositEvent() : null; }
        catch (e) { S.kernel.warn('eventcalc', 'depositEvent threw:', e); }

        var $card = h.card({ title: 'Refill calculator' });
        if (!ev) {
            return $card.append(h.empty('No event with refillable fields is live.'));
        }

        if (!session.snapshot) session.snapshot = api.rows(ev.code);
        var snap = session.snapshot || { source: 'manual', rows: [] };
        var s = readSettings(h);

        if (snap.source === 'manual') {
            $card.append($('<div>', { 'class': 'steward-muted steward-note' })
                .text('Field data not readable here (home island only); values are editable.'));
        }

        var result = api.compute(rowsWithOverrides(snap.rows || []),
            remainingOf(ev), s.routeSeconds, s.unitsPerItem);
        // The buffed column exists only while some field is buffed; compute
        // leaves the buffed total null otherwise.
        var buffed = isNum(result.totalRate12hBuffed);

        var w = buffed ? '15%' : '18%';
        var cols = [{ label: 'Field', width: buffed ? '40%' : '46%' }];
        cols.push({ label: 'Amount',   width: w, cls: 'steward-num' });
        cols.push({ label: 'Per 12 h', width: w, cls: 'steward-num' });
        if (buffed) cols.push({ label: 'Buffed 12 h', width: w, cls: 'steward-num' });
        cols.push({ label: 'Refills needed', width: w, cls: 'steward-num' });

        // Refills needed is what is still missing at the shop close: the
        // cycles the field runs until then less the deposit it holds now.
        var rows = [];
        for (var i = 0; i < result.rows.length; i++) {
            var row = result.rows[i];
            var label = fieldLabel(row);
            var cells = [
                { text: label, title: label },
                amountCell(h, row, redraw),
                numOrDash(row.rate12h)
            ];
            if (buffed) cells.push(numOrDash(row.rate12hBuffed));
            cells.push(numOrDash(row.units));
            rows.push(cells);
        }
        var foot = ['Total', String(result.totalDeposit), String(result.totalRate12h)];
        if (buffed) foot.push(String(result.totalRate12hBuffed));
        foot.push(String(result.totalUnits));

        $card.append(h.table({ cols: cols, rows: rows, foot: foot }));
        return $card;
    }

    // A short window makes the panel itself scroll. Otherwise the panel has a
    // fixed height, so the tab's cards go into one scrolling area and the
    // cards below the calculator stay reachable.
    function panelScrolls() {
        try {
            var sc = S.kernel.ui.screen;
            return !!(sc && typeof sc.compact === 'function' && sc.compact());
        } catch (e) { return false; }
    }

    function renderSection($panel, h) {
        var $wrap = $('<div>', { 'class': 'steward-stack' });
        if (panelScrolls()) {
            $panel.append($wrap);
        } else {
            $panel.append($('<div>', { 'class': 'steward-fill' }).append($wrap));
        }

        function draw() {
            // Without a live event there is nothing to estimate, so the tab
            // shows the calculator's empty state and the held resources.
            if (liveEvents().length) $wrap.append(estimateCard(h));
            $wrap.append(refillCard(h, redraw));
            if (S.modules.eventcalc.heldCard) {
                try { $wrap.append(S.modules.eventcalc.heldCard(h)); }
                catch (e) { S.kernel.warn('eventcalc', 'heldCard threw:', e); }
            }
        }
        function redraw() {
            $wrap.empty();
            draw();
            h.fit();
        }
        draw();
    }

    // One Overview tile per live event, plus the held-resources tile when
    // that hook has one to show.
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
        if (S.modules.eventcalc.heldTile) {
            var tile = null;
            try { tile = S.modules.eventcalc.heldTile(); }
            catch (e) { S.kernel.warn('eventcalc', 'heldTile threw:', e); }
            if (tile) out.push(tile);
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
