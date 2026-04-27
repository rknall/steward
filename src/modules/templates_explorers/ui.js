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

    function renderSection($rows, h) {
        var s = h.settings('templates_explorers');

        $rows.append(h.formRow('Run on Startup', h.toggle({
            checked:  !!s.enabled,
            onChange: function (next) {
                h.update('templates_explorers', { enabled: next });
            }
        })));

        $rows.append(h.formRow('Dispatch delay', h.input({
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
        var $hint = $('<span>').css({ color: '#8a7a55', fontSize: '12px' });
        $hint.append(document.createTextNode(
            n === 0
                ? 'No per-explorer overrides set. Edit settings.json to add some.'
                : n + ' explorer override' + (n === 1 ? '' : 's') + ' configured (edit in settings.json).'
        ));
        $rows.append(h.formRow('Per-explorer overrides', $hint));
    }

    S.modules.templates_explorers.readSettings   = readSettings;
    S.modules.templates_explorers.writeSettings  = writeSettings;
    S.modules.templates_explorers.stripHtml      = stripHtml;
    S.modules.templates_explorers.renderSection  = renderSection;
    S.modules.templates_explorers.summary        = summary;
    S.modules.templates_explorers.showOverrides  = showOverrides;

}(Steward));
