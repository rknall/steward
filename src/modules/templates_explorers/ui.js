/*
 * Dashboard surface for the templates_explorers module.
 *
 * Renders inside the Specialists tab as an "Explorers" section. Per-explorer
 * override editing is deferred — for now the override map is still hand-
 * edited in settings.json. The section action dumps current state (overrides,
 * idle/busy counts, pickTask results) to the log so users can see what
 * dispatches will look like before turning the module on.
 */

(function (S) {

    if (!S.modules.templates_explorers) S.modules.templates_explorers = {};

    function readSettings() {
        var stored = S.kernel.settings.read('templates_explorers') || {};
        var defaults = S.modules.templates_explorers.defaultSettings || {};
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        return merged;
    }

    function writeSettings(s) {
        S.kernel.settings.write('templates_explorers', s);
    }

    // Strip <b>...</b> / <font>...</font> wrappers the host uses for display
    // names so users can match against plain strings in settings.json.
    function stripHtml(s) {
        if (typeof s !== 'string') return '';
        return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function notify(text) {
        try { if (typeof showGameAlert === 'function') showGameAlert('Steward: ' + text); }
        catch (e) { /* best effort */ }
    }

    // Section action: dump explorer state + per-explorer pickTask results
    // to the log. Helps users tune overrides before flipping `enabled`.
    function showOverrides() {
        var s = readSettings();
        S.kernel.log('templates_explorers', '--- explorer state ---');
        S.kernel.log('templates_explorers', 'enabled:', !!s.enabled,
                     '  dispatchDelay:', s.dispatchDelay || 5000, 'ms');

        try {
            var liveRaw = S.core.events.liveEventNames();
            S.kernel.log('templates_explorers', 'host events (raw):',
                         liveRaw.length ? liveRaw.join(', ') : '(none)');
            var matched = S.core.events.active();
            if (matched.length === 0) {
                S.kernel.log('templates_explorers',
                    'matched events: (none — pickTask falls back to host explDefTask)');
            } else {
                for (var m = 0; m < matched.length; m++) {
                    var ev = matched[m];
                    var values = S.core.events.treasureValues(ev.code);
                    S.kernel.log('templates_explorers', '  matched:', ev.code,
                                 '— categories:', (ev.categoryList || []).join(',') || '(none)',
                                 '— treasureValues:',
                                 (values && values.length) ? values.join(',') : '(none)');
                }
            }
        } catch (e) {
            S.kernel.error('templates_explorers', 'event dump threw:', e);
        }
        S.kernel.log('templates_explorers',
                     'host explDefTask:', S.kernel.host.explDefTaskGlobal(),
                     ' explDefTaskByType keys:',
                     Object.keys((typeof mainSettings !== 'undefined' && mainSettings &&
                                  mainSettings.explDefTaskByType) || {}).length);

        var c = S.core.specialists;
        var explorers;
        try { explorers = c.explorers(); }
        catch (e) {
            S.kernel.error('templates_explorers', 'failed to list explorers:', e);
            return notify('Could not list explorers — see log.');
        }

        var idle = 0, busy = 0;
        for (var i = 0; i < explorers.length; i++) {
            if (c.status(explorers[i]) === S.SpecialistStatus.Idle) idle++; else busy++;
        }
        S.kernel.log('templates_explorers', 'explorers — total:', explorers.length,
                     '  idle:', idle, '  busy:', busy);

        // pickTask preview per explorer.
        for (var j = 0; j < explorers.length; j++) {
            var spec = explorers[j];
            var name = c.name(spec) || '?';
            var picked = '?';
            try { picked = c.pickTask(spec) || '?'; } catch (e) { picked = 'threw'; }
            var override = s.overrides && s.overrides[stripHtml(name)];
            S.kernel.log('templates_explorers',
                '  [' + (c.status(spec) === S.SpecialistStatus.Idle ? 'idle' : 'busy') + ']',
                stripHtml(name),
                '→ pickTask:', picked,
                override ? ('(override: ' + override + ')') : '');
        }
        notify('Explorer state dumped to log.');
    }

    function summary() {
        var s = readSettings();
        if (!s.enabled) return 'disabled';
        var n = Object.keys(s.overrides || {}).length;
        return n + ' override' + (n === 1 ? '' : 's');
    }

    function renderSection($panel, h) {
        var s = h.settings('templates_explorers');

        $panel.append(h.formRow('Run on Startup', h.toggle({
            checked:  !!s.enabled,
            onChange: function (next) {
                h.update('templates_explorers', { enabled: next });
            }
        })));

        $panel.append(h.formRow('Dispatch delay', h.input({
            type:     'number',
            value:    s.dispatchDelay || 1500,
            width:    '90px',
            onChange: function (val) {
                var n = parseInt(val, 10);
                if (!isNaN(n) && n >= 0) {
                    h.update('templates_explorers', { dispatchDelay: n });
                }
            }
        }), 'ms — pause between sends'));

        // Read-only per-explorer overrides hint. Editing the map directly
        // in the dashboard is deferred (settings.json works for now).
        var n = Object.keys(s.overrides || {}).length;
        var $hint = $('<span>').css({ color: '#a09a85', fontSize: '12px' });
        $hint.append(document.createTextNode(
            n === 0
                ? 'No per-explorer overrides set. Edit settings.json to add some.'
                : n + ' explorer override' + (n === 1 ? '' : 's') + ' configured (edit in settings.json).'
        ));
        $panel.append(h.formRow('Per-explorer overrides', $hint));

        // Per-explorer state table — alphabetical sort, host portrait,
        // localised task labels. Renders directly into the panel as a
        // sequence of BS3 rows (autoTSO style).
        appendExplorerTable($panel, h, s);
    }

    function appendExplorerTable($panel, h, s) {
        if (!S.core.specialists || !S.core.specialists.explorers) return;
        var explorers;
        try { explorers = S.core.specialists.explorers(); }
        catch (e) { return; }
        if (!explorers || !explorers.length) return;

        var c = S.core.specialists;
        var idle = 0, busy = 0;
        for (var x = 0; x < explorers.length; x++) {
            if (c.status(explorers[x]) === S.SpecialistStatus.Idle) idle++;
            else                                                     busy++;
        }

        // Alphabetical by display name (HTML stripped). Stable across renders.
        explorers.sort(function (a, b) {
            var na = stripHtml(c.name(a) || '').toLowerCase();
            var nb = stripHtml(c.name(b) || '').toLowerCase();
            if (na < nb) return -1;
            if (na > nb) return 1;
            return 0;
        });

        var overrides = (s && s.overrides) || {};

        // Sub-header showing totals.
        $panel.append(h.formRow(
            'Per-explorer state',
            $('<span>').text(explorers.length + ' total · ' + idle + ' idle · ' + busy + ' busy')
        ));

        // Table header (tblHeader band).
        $panel.append(h.gridRow(
            [[5, 'Name'], [2, 'Status'], [2, 'Current'], [3, 'Next']],
            { headerCells: true }
        ));

        // One BS3 row per explorer.
        for (var i = 0; i < explorers.length; i++) {
            var spec = explorers[i];
            var rawName = c.name(spec) || '?';
            var name = stripHtml(rawName);
            var st = c.status(spec);
            var isIdle = (st === S.SpecialistStatus.Idle);

            // Portrait: host's getIconID + getImageTag. Falls back to a
            // gray dot if the helpers aren't available (e.g. early boot).
            var portrait = '';
            try {
                if (typeof spec.getIconID === 'function' &&
                    typeof getImageTag === 'function') {
                    var iconId = spec.getIconID();
                    if (iconId) portrait = getImageTag(iconId, '20px') + ' ';
                }
            } catch (e) { /* ignore */ }
            var nameCell = portrait + name;

            // Status with a leading dot (CSS coloured via row class).
            var statusCell = (isIdle ? '○ Idle' : '● Busy');

            // Localised task labels.
            var current = '—';
            if (!isIdle && c.currentTask) {
                var ct = c.currentTask(spec);
                current = ct ? c.taskLabel(ct) : '—';
            }
            var next = '?';
            try {
                var nt = c.pickTask(spec);
                if (nt) next = c.taskLabel(nt);
            } catch (e) { /* keep '?' */ }
            if (overrides[name]) next = next + ' *';

            var rowClass = isIdle ? 'steward-row-idle' : 'steward-row-busy';
            $panel.append(h.gridRow(
                [[5, nameCell], [2, statusCell], [2, current], [3, next]]
            ).addClass(rowClass));
        }
    }

    S.modules.templates_explorers.readSettings   = readSettings;
    S.modules.templates_explorers.writeSettings  = writeSettings;
    S.modules.templates_explorers.stripHtml      = stripHtml;
    S.modules.templates_explorers.renderSection  = renderSection;
    S.modules.templates_explorers.summary        = summary;
    S.modules.templates_explorers.showOverrides  = showOverrides;

}(Steward));
