/*
 * UI for the templates_explorers module.
 *
 * Adds "Steward → Explorer Templates" with:
 *   - Enabled toggle (master switch)
 *   - "Show current overrides" — dumps overrides + idle/busy counts to log
 *   - "Set <task> as default for all idle" — quick bulk-assignment that
 *     writes the chosen task into mainSettings.explDefTask via
 *     settings.store. Writes Steward's own override map only when the
 *     user wants per-explorer customization (done by editing settings.json
 *     directly for v0.4 — a per-explorer dropdown UI lands later).
 */

(function (S) {

    if (!S.modules.templates_explorers) S.modules.templates_explorers = {};

    var MENU_ENTRY_NAME = 'StewardExplorerTemplatesMenu';

    // Shallow merge stored values over defaults so old settings shapes
    // (or missing keys after a release update) get filled with sensible
    // defaults rather than silently disabling the module or stalling
    // dispatch.
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

    function toggle(key) {
        var s = readSettings();
        s[key] = !s[key];
        writeSettings(s);
        S.kernel.log('templates_explorers', 'toggled', key, '→', s[key]);
        if (key === 'enabled' && !s.enabled) {
            // Drop any pending dispatches when the user turns us off.
            if (S.kernel.queue && S.kernel.queue.cancelByModule) {
                S.kernel.queue.cancelByModule('templates_explorers');
            }
        }
        renderMenu();
    }

    function showOverrides() {
        var s = readSettings();
        S.kernel.log('templates_explorers', '--- explorer state ---');
        S.kernel.log('templates_explorers', 'enabled:', !!s.enabled,
                     '  dispatchDelay:', s.dispatchDelay || 5000, 'ms');

        // Active events affect pickTask precedence. Log them so users can
        // see why a given recommendation came out the way it did.
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

        // Pick precedence preview: for each explorer, log what pickTask
        // would return so the user can see what's about to be dispatched.
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

    // The host wraps spec names in <b>...</b> / <font>...</font> for display.
    // Strip when comparing against settings keys so users can write plain
    // names in settings.json.
    function stripHtml(s) {
        if (typeof s !== 'string') return '';
        return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function buildSpec() {
        var s = readSettings();
        return {
            name:  MENU_ENTRY_NAME,
            label: 'Explorer Templates',
            items: [
                {
                    label:    (s.enabled ? '✓ ' : '✕ ') + 'Enabled',
                    onSelect: function () { toggle('enabled'); }
                },
                { type: 'separator' },
                {
                    label:    'Show current overrides + state',
                    onSelect: showOverrides
                }
            ]
        };
    }

    function renderMenu() {
        if (!S.kernel.ui || !S.kernel.ui.menu) return;
        S.kernel.ui.menu.replaceByName(MENU_ENTRY_NAME, buildSpec());
    }

    function notify(text) {
        try { if (typeof showGameAlert === 'function') showGameAlert('Steward: ' + text); }
        catch (e) { /* best effort */ }
    }

    S.modules.templates_explorers.renderMenu    = renderMenu;
    S.modules.templates_explorers.readSettings  = readSettings;
    S.modules.templates_explorers.writeSettings = writeSettings;
    S.modules.templates_explorers.stripHtml     = stripHtml;

}(Steward));
