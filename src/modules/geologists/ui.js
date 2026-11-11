/*
 * Dashboard surface for the geologists module.
 *
 * Renders the Geologists tab in the split layout: the settings column
 * (`side`) holds the module switch, the send delay and the per-deposit
 * table (search on/off, how many are on the map, the Max to keep), the
 * main column (`render`) the live geologist list with filter chips. The
 * per-geologist override map is still hand-edited in settings.json. The
 * "Show ranking in log" link dumps a per-deposit ranking plus idle/busy/
 * wanted state at once, so users can preview routing before they switch
 * the module on.
 *
 * Shown values come from the buffer, falling back to readSettings(), which
 * merges the defaults: the stored settings may lack a deposit row the
 * module still searches with its default.
 */

(function (S) {
    'use strict';

    if (!S.modules.geologists) S.modules.geologists = {};

    function readSettings() {
        var stored = S.kernel.settings.read('geologists') || {};
        var defaults = S.modules.geologists.defaultSettings || {};
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        // Deep-merge nested deposits map so partial user edits don't
        // wipe defaults for deposit types the user hasn't touched.
        var depMerged = {};
        var defaultDeps = defaults.deposits || {};
        var storedDeps  = stored.deposits  || {};
        for (key in defaultDeps) depMerged[key] = defaultDeps[key];
        for (key in storedDeps)  depMerged[key] = storedDeps[key];
        merged.deposits = depMerged;
        return merged;
    }

    function writeSettings(s) {
        S.kernel.settings.write('geologists', s);
    }

    function notify(text) {
        try { if (typeof showGameAlert === 'function') showGameAlert('Steward: ' + text); }
        catch (e) { /* best effort */ }
    }

    function fmtFactor(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '?';
        return (Math.round(n * 100) / 100).toFixed(2);
    }


    // Live state link: dump per-deposit ranking + state. Helps users
    // tune `deposits.*.max` and overrides before flipping `enabled`.
    function showRanking() {
        var s = readSettings();
        var c = S.core.specialists;
        var d = S.core.deposits;
        S.kernel.log('geologists', '--- geologist state ---');
        S.kernel.log('geologists', 'enabled:', !!s.enabled,
                     '  dispatchDelay:', s.dispatchDelay, 'ms');

        var allGeos;
        try { allGeos = c.geologists() || []; }
        catch (e) {
            S.kernel.error('geologists', 'failed to list geologists:', e);
            return notify('Could not list geologists — see log.');
        }
        var idle = 0, busy = 0;
        for (var i = 0; i < allGeos.length; i++) {
            if (c.status(allGeos[i]) === S.SpecialistStatus.Idle) idle++; else busy++;
        }
        S.kernel.log('geologists', 'geologists — total:', allGeos.length,
                     '  idle:', idle, '  busy:', busy);

        if (!d || !d.types) {
            S.kernel.warn('geologists', 'core.deposits.types unavailable');
            return notify('Geologist state dumped — core.deposits not ready.');
        }

        var types = d.types();
        S.kernel.log('geologists', '--- per-deposit ranking (capacity / time) ---');
        for (var t = 0; t < types.length; t++) {
            var info = types[t];
            var cfg = (s.deposits || {})[info.name] || {};
            var enabled = !!cfg.enabled;
            var max = (typeof cfg.max === 'number') ? cfg.max : 0;

            var onMap = 0;
            try { onMap = d.byType(info.name).length; }
            catch (e) { /* skip */ }

            // Count busy geos on this deposit.
            var onTask = S.modules.geologists.busyOnDeposit(allGeos, info.index);
            var wanted = enabled ? Math.max(0, max - onMap - onTask) : 0;

            S.kernel.log('geologists',
                '  ' + info.name +
                '  cfg: enabled=' + enabled + ' max=' + max +
                '  on map=' + onMap + '  on task=' + onTask +
                '  wanted=' + wanted);

            if (!c.rankGeologistsForDeposit) continue;
            var ranked = c.rankGeologistsForDeposit(info.name, {
                from:     allGeos,
                idleOnly: false
            });
            var topN = Math.min(5, ranked.length);
            for (var r = 0; r < topN; r++) {
                var row = ranked[r];
                if (row.capacityFactor <= 1 && row.timeFactor >= 1) break;  // out of "interesting" picks
                var nm = c.name(row.geo) || '?';
                var st = c.status(row.geo);
                var stTag = (st === S.SpecialistStatus.Idle) ? '[idle]' : '[busy]';
                S.kernel.log('geologists',
                    '    ' + stTag +
                    ' cap×' + fmtFactor(row.capacityFactor) +
                    '  time×' + fmtFactor(row.timeFactor) +
                    '  ' + nm);
            }
        }
        notify('Geologist ranking dumped to log.');
    }

    // ---------------------------------------------------------------
    // Shown values: buffer first, merged defaults second.
    // ---------------------------------------------------------------

    // The buffered value at `path`, or the merged-defaults one when the
    // buffer has none.
    function shown(h, path) {
        var v = h.get('geologists', path);
        if (typeof v !== 'undefined') return v;
        var o = readSettings();
        var keys = String(path).split('.');
        for (var i = 0; i < keys.length; i++) {
            if (o === null || typeof o !== 'object') return undefined;
            o = o[keys[i]];
        }
        return o;
    }

    function delayOf(h) {
        var d = shown(h, 'dispatchDelay');
        return (typeof d === 'number') ? d : S.modules.geologists.defaultSettings.dispatchDelay;
    }

    // The row the dispatcher would use for a deposit: the buffered one,
    // else the merged-defaults one, else an empty row.
    function depositRow(h, depositName) {
        var deps = h.get('geologists', 'deposits');
        if (deps && typeof deps === 'object' && deps[depositName] &&
            typeof deps[depositName] === 'object') {
            return deps[depositName];
        }
        var merged = readSettings().deposits || {};
        if (merged[depositName] && typeof merged[depositName] === 'object') {
            return merged[depositName];
        }
        return { enabled: false, max: 0 };
    }

    function rowMax(row) {
        return (typeof row.max === 'number') ? row.max : 0;
    }

    function depositTypes() {
        var d = S.core.deposits;
        if (!d || typeof d.types !== 'function') return [];
        try { return d.types() || []; }
        catch (e) { return []; }
    }

    // Live count on the home zone; null when it cannot be read, so an
    // unknown count is never shown or counted as zero.
    function onMapCount(depositName) {
        try { return S.core.deposits.byType(depositName).length; }
        catch (e) { return null; }
    }

    function resName(depositName) {
        try { return S.core.locale.res(depositName) || depositName; }
        catch (e) { return depositName; }
    }

    // Merge a partial change into settings.deposits[name]. h.update does a
    // shallow merge at the top level, so it gets the full `deposits` object.
    // Earlier buffered rows are kept, so edits before Save layer on each
    // other. A row the buffer lacks starts from the one the dispatcher uses
    // now (stored or default), so switching Search never stores max 0 and
    // the row is always stored whole.
    function updateDeposit(h, depositName, partial) {
        var s = h.settings('geologists');
        var deposits = {};
        var k;
        for (k in (s.deposits || {})) deposits[k] = s.deposits[k];
        var current = depositRow(h, depositName);
        var next = {};
        for (k in current) next[k] = current[k];
        if (typeof next.enabled === 'undefined') next.enabled = false;
        if (typeof next.max === 'undefined') next.max = 0;
        if (typeof partial.enabled !== 'undefined') next.enabled = partial.enabled;
        if (typeof partial.max !== 'undefined')     next.max = partial.max;
        deposits[depositName] = next;
        h.update('geologists', { deposits: deposits });
    }

    // ---------------------------------------------------------------
    // Settings column.
    // ---------------------------------------------------------------
    function side($side, h) {
        h.baseline('geologists', readSettings());

        var $card = h.card({ icon: '⛏', title: 'Geologists', meta: 'settings' });
        $card.append(h.field('Send geologists', 'Module on or off', h.toggle({
            ns:      'geologists',
            path:    'enabled',
            checked: !!shown(h, 'enabled'),
            label:   'Send geologists'
        })));
        $card.append(h.field('Delay between sends', null, h.number({
            ns:    'geologists',
            path:  'dispatchDelay',
            value: delayOf(h),
            unit:  'ms',
            label: 'Delay between sends'
        })));
        $side.append($card);

        // A card without a head: the sub head names it.
        var $deps = $('<div>', { 'class': 'steward-card' });
        $deps.append(h.subHead('DEPOSITS TO SEARCH', 'keep up to Max on the map'));
        $deps.append(h.table({
            cols: [
                { label: 'Deposit', width: '40%' },
                { label: 'Search',  width: '20%', cls: 'steward-c' },
                { label: 'On map',  width: '18%', cls: 'steward-num' },
                { label: 'Max',     width: '22%', cls: 'steward-num' }
            ],
            rows:      depositRows(h),
            fill:      true,
            emptyText: 'Deposit types are not available yet.'
        }));
        $side.append($deps);
    }

    function depositRows(h) {
        var types = depositTypes();
        var rows = [];
        for (var i = 0; i < types.length; i++) {
            rows.push(depositTableRow(h, types[i].name));
        }
        return rows;
    }

    function markUnder($n, onMap, max) {
        var under = (onMap !== null && onMap < max);
        $n.toggleClass('steward-under', under);
        if (under) $n.attr('title', 'below max: a geologist will be sent');
        else       $n.removeAttr('title');
    }

    function depositTableRow(h, depositName) {
        var row = depositRow(h, depositName);
        var label = resName(depositName);
        var onMap = onMapCount(depositName);
        var base = 'deposits.' + depositName + '.';

        var $onMap = $('<span>').text(onMap === null ? '?' : String(onMap));
        markUnder($onMap, onMap, rowMax(row));

        var $search = h.toggle({
            ns:      'geologists',
            path:    base + 'enabled',
            checked: !!row.enabled,
            label:   'Search ' + label,
            write:   function (next) { updateDeposit(h, depositName, { enabled: next }); }
        });
        var $max = h.number({
            ns:       'geologists',
            path:     base + 'max',
            value:    rowMax(row),
            width:    '50px',
            label:    label + ' max',
            write:    function (next) { updateDeposit(h, depositName, { max: next }); },
            onChange: function (next) { markUnder($onMap, onMap, next); }
        });

        return [
            { text: label, title: depositName },
            $search,
            { $: $onMap },
            $max
        ];
    }

    // ---------------------------------------------------------------
    // Live state.
    // ---------------------------------------------------------------

    // Filter of the live list, kept for the session.
    var filter = 'all';

    var EMPTY_TEXT = {
        all:   'No geologists on this island.',
        busy:  'No geologist is busy right now.',
        idle:  'No geologist is idle right now.',
        trait: 'No geologist has a trait.'
    };

    function typeByIndex(types, index) {
        for (var i = 0; i < types.length; i++) {
            if (types[i].index === index) return types[i];
        }
        return null;
    }

    // Best deposit by capacity factor (time factor breaks ties); `trait`
    // is false for a geologist no deposit gives a bonus.
    function bestDeposit(c, spec, types) {
        var best = { name: null, cap: 1, time: 1 };
        if (typeof c.geologistScoreFor !== 'function') return best;
        for (var t = 0; t < types.length; t++) {
            var score = null;
            try { score = c.geologistScoreFor(spec, types[t].name); }
            catch (e) { score = null; }
            if (!score) continue;
            if (score.capacityFactor > best.cap ||
                (score.capacityFactor === best.cap && score.timeFactor < best.time)) {
                best.cap  = score.capacityFactor;
                best.time = score.timeFactor;
                best.name = types[t].name;
            }
        }
        best.trait = !!best.name && (best.cap > 1 || best.time < 1);
        return best;
    }

    // Deposit a busy geologist is searching, as a deposit name, or null.
    function searching(spec, types) {
        var sub = S.core.specialists.searchingIndex(spec);
        if (sub === null) return null;
        var info = typeByIndex(types, sub);
        return info ? info.name : String(sub);
    }

    // Reads every geologist once per draw; `ok` is false when the list
    // could not be read.
    function snapshot() {
        var c = S.core.specialists;
        var out = { ok: true, list: [], busy: 0, idle: 0, trait: 0 };
        var geos;
        try { geos = (c && c.geologists) ? (c.geologists() || []) : []; }
        catch (e) {
            S.kernel.warn('geologists', 'could not list geologists:', e);
            out.ok = false;
            return out;
        }
        var types = depositTypes();
        geos = geos.slice();
        geos.sort(c.compareByName);
        for (var i = 0; i < geos.length; i++) {
            var spec = geos[i];
            var isIdle = false;
            try { isIdle = (c.status(spec) === S.SpecialistStatus.Idle); }
            catch (e) { isIdle = false; }
            var best = bestDeposit(c, spec, types);
            var g = {
                spec:  spec,
                name:  c.name(spec) || '?',
                idle:  isIdle,
                best:  best,
                task:  isIdle ? null : searching(spec, types)
            };
            if (isIdle) out.idle++; else out.busy++;
            if (best.trait) out.trait++;
            out.list.push(g);
        }
        return out;
    }

    function shows(g) {
        if (filter === 'busy')  return !g.idle;
        if (filter === 'idle')  return g.idle;
        if (filter === 'trait') return g.best.trait;
        return true;
    }

    function bestCell(g) {
        if (!g.best.trait) return { text: 'no trait', cls: 'steward-muted' };
        var label = resName(g.best.name);
        var detail = ' · amount ×' + fmtFactor(g.best.cap) + ' · time ×' + fmtFactor(g.best.time);
        var $c = $('<span>').text(label)
            .append($('<span>', { 'class': 'steward-muted' }).text(detail));
        return { $: $c, title: label + detail };
    }

    function liveMeta(snap) {
        var n = snap.list.length;
        var head = n + ' geologist' + (n === 1 ? '' : 's');
        return snap.busy ? head + ' · ' + snap.busy + ' busy' : head + ' · all idle';
    }

    function liveCard(h, redraw, pass) {
        var snap = snapshot();
        var $tools = $('<span>')
            .append(h.now())
            .append(' ')
            .append(h.link('Show ranking in log', showRanking, {
                title: 'Runs at once, no Save needed'
            }));
        var $card = h.card({
            title:  'Live state',
            meta:   snap.ok ? liveMeta(snap) : 'not readable',
            $tools: $tools
        });
        if (!snap.ok) {
            $card.append(h.empty('Geologists could not be read', 'See the log.'));
            return $card;
        }

        $card.append(h.chips([
            { id: 'all',   label: 'All ' + snap.list.length },
            { id: 'busy',  label: 'Busy ' + snap.busy },
            { id: 'idle',  label: 'Idle ' + snap.idle },
            { id: 'trait', label: 'With a trait ' + snap.trait }
        ], filter, function (id) {
            filter = id;
            redraw();
        }));

        var rows = [];
        for (var i = 0; i < snap.list.length; i++) {
            var g = snap.list[i];
            if (!shows(g)) continue;
            rows.push([
                {
                    html:  S.core.specialists.portraitTag(g.spec, null, pass) + '<span>' + h.escape(g.name) + '</span>',
                    title: g.name,
                    cls:   'steward-who'
                },
                h.statusBadge(g.idle, g.idle ? null : S.core.specialists.orders.remaining(g.spec)),
                bestCell(g),
                g.task ? { text: resName(g.task), title: g.task } : { text: '—', cls: 'steward-muted' }
            ]);
        }
        $card.append(h.table({
            cols: [
                { label: 'Geologist',    width: '36%' },
                { label: 'Status',       width: '15%' },
                { label: 'Best deposit', width: '34%' },
                { label: 'Searching',    width: '15%' }
            ],
            rows:      rows,
            fill:      true,
            emptyText: EMPTY_TEXT[filter] || EMPTY_TEXT.all
        }));
        return $card;
    }

    function render($main, h) {
        // A chip pick redraws only this card, inside its own holder so the
        // rest of the column stays. The dashboard sizes the fill after the
        // first draw, h.fit() after each later one.
        var $holder = $('<div>');
        $main.append($holder);
        var drawn = false;
        function redraw() {
            // A portrait the host had not decoded yet is asked for once more a second later.
            var pass = {};
            $holder.empty().append(liveCard(h, redraw, pass));
            if (drawn) h.fit();
            drawn = true;
            if (pass.portraitMissed) h.redrawOnce($holder, redraw, S.kernel.TIMEOUTS.PORTRAIT_RETRY_MS);
        }
        redraw();
    }

    // ---------------------------------------------------------------
    // Compact strip and Overview tile.
    // ---------------------------------------------------------------

    // Deposit rows the dispatcher searches, and how many of them have
    // fewer on the map than their Max.
    function depositCounts(h) {
        var types = depositTypes();
        var out = { searched: 0, below: 0 };
        for (var i = 0; i < types.length; i++) {
            var row = depositRow(h, types[i].name);
            if (!row.enabled) continue;
            out.searched++;
            var onMap = onMapCount(types[i].name);
            if (onMap !== null && onMap < rowMax(row)) out.below++;
        }
        return out;
    }

    function summary(h) {
        var n = depositCounts(h).searched;
        return delayOf(h) + ' ms · ' + n + ' deposit type' + (n === 1 ? '' : 's');
    }

    function tiles(h) {
        var snap = snapshot();
        var first;
        if (!snap.ok) {
            first = 'Geologists could not be read';
        } else {
            var n = snap.list.length;
            first = n + ' geologist' + (n === 1 ? '' : 's');
            first += snap.busy
                ? ' · ' + snap.busy + ' busy · ' + snap.idle + ' idle'
                : ' · all idle';
        }
        var dc = depositCounts(h);
        return [{
            title: 'Geologists',
            icon:  '⛏',
            lines: [
                first,
                dc.searched + ' deposit type' + (dc.searched === 1 ? '' : 's') +
                    ' searched, ' + dc.below + ' below max'
            ]
        }];
    }

    S.modules.geologists.readSettings  = readSettings;
    S.modules.geologists.writeSettings = writeSettings;
    S.modules.geologists.updateDeposit = updateDeposit;
    S.modules.geologists.side          = side;
    S.modules.geologists.render        = render;
    S.modules.geologists.summary       = summary;
    S.modules.geologists.tiles         = tiles;
    S.modules.geologists.showRanking   = showRanking;

}(Steward));
