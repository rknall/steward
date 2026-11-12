/*
 * Dashboard surface for the geologists module.
 *
 * Renders the Geologists tab in the split layout: the settings column
 * (`side`) holds the module switch, the send delay and the per-deposit
 * table (search on/off, how many are on the map, the Max to keep), the
 * main column (`render`) the live geologist list with filter chips. Next
 * to each Search toggle a `default` / `override` word opens the kind
 * override editor of that deposit: a row of chips, one per geologist kind,
 * ticking the kinds that alone may search it. The per-geologist name
 * override map is still hand-edited in settings.json. The "Show ranking in
 * log" link dumps a per-deposit ranking plus idle/busy/wanted state at
 * once, filtered the way the dispatcher filters, so users can preview
 * routing before they switch the module on.
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

    // ---------------------------------------------------------------
    // Geologist kinds (host GetType numbers).
    // ---------------------------------------------------------------

    // Owned geologists grouped by kind: `order` lists the kinds by the name
    // order of their first geologist, `byKind` holds that geologist's name
    // as the label and how many of the kind are owned. A geologist whose
    // kind cannot be read belongs to no group.
    function indexGeos(geos) {
        var c = S.core.specialists;
        var out = { ok: true, order: [], byKind: {} };
        var list = (geos || []).slice();
        list.sort(c.compareByName);
        for (var i = 0; i < list.length; i++) {
            var k = null, nm = '';
            try { k = c.kind(list[i]); nm = c.name(list[i]) || ''; }
            catch (e) { k = null; }
            if (k === null) continue;
            var key = String(k);
            if (!out.byKind[key]) {
                out.byKind[key] = { label: nm, count: 0 };
                out.order.push(k);
            }
            out.byKind[key].count++;
        }
        return out;
    }

    // One read of the geologists per deposits draw; `ok` is false when the
    // list could not be read.
    function kindIndex() {
        var c = S.core.specialists;
        var geos;
        try { geos = (c && c.geologists) ? (c.geologists() || []) : []; }
        catch (e) {
            S.kernel.warn('geologists', 'could not list geologists:', e);
            return { ok: false, order: [], byKind: {} };
        }
        return indexGeos(geos);
    }

    // The label of a kind everywhere it is shown: an owned geologist's
    // name, else the host's label of the kind, else its number.
    function kindName(index, k) {
        var e = index.byKind[String(k)];
        if (e && e.label) return e.label;
        var lbl = '';
        try { lbl = S.core.specialists.kindLabel(k); }
        catch (err) { lbl = ''; }
        return lbl || ('Kind ' + k);
    }

    function kindNames(index, ks) {
        var names = [];
        for (var i = 0; i < ks.length; i++) names.push(kindName(index, ks[i]));
        return names.join(', ');
    }

    function kindsText(index, row) {
        var ks = S.modules.geologists.rowKinds(row);
        return ks.length ? 'only ' + kindNames(index, ks) : 'default';
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
        // The dispatcher's own rule, so the log ranks only geologists the
        // dispatcher could send to each type.
        var rule = S.modules.geologists.kindRule(s.deposits || {}, types);
        var index = indexGeos(allGeos);
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
            S.kernel.log('geologists', '  kinds: ' + kindsText(index, cfg));

            if (!c.rankGeologistsForDeposit) continue;
            var ranked = c.rankGeologistsForDeposit(info.name, {
                from:     S.modules.geologists.eligibleForDeposit(allGeos, info.name, s.overrides || {}, rule),
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
    // the row is always stored whole, and an existing kind list is kept
    // through enabled and max edits.
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
        if (Object.prototype.hasOwnProperty.call(partial, 'kinds')) {
            // The buffer counts only the leaves it holds, so a cleared list
            // whose saved row has one stays as [] to be saved; without a
            // saved list the key goes, and tick then untick is no change.
            var ks = S.modules.geologists.rowKinds({ kinds: partial.kinds });
            var saved = (readSettings().deposits || {})[depositName];
            var savedHasKinds = !!saved && Object.prototype.hasOwnProperty.call(saved, 'kinds');
            if (ks.length) next.kinds = ks;
            else if (savedHasKinds) next.kinds = [];
            else delete next.kinds;
        }
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
        $card.append(h.field('Remove depleted deposits', 'Frees the grid for new searches', h.toggle({
            ns:      'geologists',
            path:    'removeDepleted',
            checked: !!shown(h, 'removeDepleted'),
            label:   'Remove depleted deposits'
        })));
        $card.append(h.field('Delay between sends', null, h.number({
            ns:    'geologists',
            path:  'dispatchDelay',
            value: delayOf(h),
            unit:  'ms',
            label: 'Delay between sends'
        })));
        $side.append($card);

        // An editor pick redraws only the deposits card, inside its own
        // holder so the first card stays. The dashboard sizes the fill
        // after the first draw, h.fit() after each later one.
        editing = null;
        var $holder = $('<div>');
        $side.append($holder);
        var drawn = false;
        function redraw() {
            $holder.empty().append(depositsCard(h, redraw));
            if (drawn) h.fit();
            drawn = true;
        }
        redraw();
    }

    // The deposit whose kind override editor is open, or null. One at a
    // time; a fresh draw of the tab starts with none open.
    var editing = null;

    function depositsCard(h, redraw) {
        var index = kindIndex();
        // A card without a head: the sub head names it.
        var $deps = $('<div>', { 'class': 'steward-card' });
        $deps.append(h.subHead('DEPOSITS TO SEARCH', 'keep up to Max on the map'));
        $deps.append(h.table({
            cols: [
                { label: 'Deposit', width: '26%' },
                { label: 'Search',  width: '34%' },
                { label: 'On map',  width: '20%', cls: 'steward-num' },
                { label: 'Max',     width: '20%', cls: 'steward-num' }
            ],
            rows:      depositRows(h, index, redraw),
            fill:      true,
            emptyText: 'Deposit types are not available yet.'
        }));
        return $deps;
    }

    function depositRows(h, index, redraw) {
        var types = depositTypes();
        var rows = [];
        for (var i = 0; i < types.length; i++) {
            var name = types[i].name;
            rows.push(depositTableRow(h, name, index, redraw));
            if (editing === name) rows.push({ span: editorPanel(h, name, index, redraw) });
        }
        return rows;
    }

    // `default` or `override` after the Search toggle; a click opens or
    // closes the editor of this deposit and closes any other.
    function overrideWord(h, depositName, row, index, redraw) {
        var ks = S.modules.geologists.rowKinds(row);
        function onClick() {
            editing = (editing === depositName) ? null : depositName;
            redraw();
        }
        var $a;
        if (ks.length) {
            $a = h.link('override', onClick, {
                title: 'override: only ' + kindNames(index, ks) + ' may search ' + resName(depositName)
            });
        } else {
            $a = h.link('default', onClick);
            $a.addClass('steward-muted');
        }
        if (h.isChanged('geologists', 'deposits.' + depositName + '.kinds')) $a.addClass('steward-dirty');
        return $a;
    }

    // Chips of the owned kinds with their counts, then each listed kind
    // nobody owns as ×0, so it can still be unticked.
    function kindItems(index, ks) {
        var listed = {};
        var i;
        for (i = 0; i < ks.length; i++) listed[String(ks[i])] = true;
        var items = [];
        for (i = 0; i < index.order.length; i++) {
            var k = index.order[i];
            items.push({
                id:     k,
                label:  kindName(index, k) + ' ×' + index.byKind[String(k)].count,
                active: listed[String(k)] === true
            });
        }
        for (i = 0; i < ks.length; i++) {
            if (index.byKind[String(ks[i])]) continue;
            items.push({ id: ks[i], label: kindName(index, ks[i]) + ' ×0', active: true });
        }
        return items;
    }

    function countsText(index, ks, depositName) {
        if (!ks.length) return 'No kind ticked: ' + resName(depositName) + ' searches as default.';
        var m = 0;
        for (var i = 0; i < ks.length; i++) {
            var e = index.byKind[String(ks[i])];
            if (e) m += e.count;
        }
        return ks.length + ' kind' + (ks.length === 1 ? '' : 's') + ' ticked · ' +
            m + ' geologist' + (m === 1 ? '' : 's') +
            '. A kind covers every geologist of that kind, now and later.';
    }

    // Adds the kind when it is not listed, removes it when it is.
    function flipKind(ks, k) {
        var next = [];
        var had = false;
        for (var i = 0; i < ks.length; i++) {
            if (ks[i] === k) had = true;
            else next.push(ks[i]);
        }
        if (!had) next.push(k);
        return next;
    }

    // The full-width editor row under a deposit. Picks go to the buffer and
    // apply on Save, like the other controls of this column.
    function editorPanel(h, depositName, index, redraw) {
        var ks = S.modules.geologists.rowKinds(depositRow(h, depositName));
        var $p = $('<div>');
        $p.append(h.subHead('OVERRIDE: ONLY THESE SEARCH ' + resName(depositName).toUpperCase(),
            h.link('Back to default', function () {
                updateDeposit(h, depositName, { kinds: [] });
                editing = null;
                redraw();
            })));
        var $note = $('<div>', { 'class': 'steward-note' });
        if (!index.ok) {
            $note.append($('<span>', { 'class': 'steward-muted' }).text('Geologists could not be read.'));
        } else {
            $note.append(h.chips(kindItems(index, ks), null, function (k) {
                updateDeposit(h, depositName, { kinds: flipKind(ks, k) });
                redraw();
            }));
            $note.append($('<span>', { 'class': 'steward-muted' }).text(countsText(index, ks, depositName)));
        }
        $p.append($note);
        return $p;
    }

    function markUnder($n, onMap, max) {
        var under = (onMap !== null && onMap < max);
        $n.toggleClass('steward-under', under);
        if (under) $n.attr('title', 'below max: a geologist will be sent');
        else       $n.removeAttr('title');
    }

    function depositTableRow(h, depositName, index, redraw) {
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

        var $searchCell = $('<span>').append($search).append(' ')
            .append(overrideWord(h, depositName, row, index, redraw));

        return [
            { text: label, title: depositName },
            $searchCell,
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
