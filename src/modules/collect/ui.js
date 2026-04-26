/*
 * Settings UI for the collect module.
 *
 * Three menu items under "Steward → Collect":
 *   - Enabled toggle (master switch)
 *   - Patterns: <comma-separated list>  (read-only label, edit via settings.json)
 *   - Discover collectibles             (one-shot scan that logs candidates)
 *
 * The patterns list is intentionally read-only in the menu — typing into
 * native menu items is awkward; the list lives in steward.collect.namePatterns
 * in the host settings file.
 */

(function (S) {

    if (!S.modules.collect) S.modules.collect = {};

    var MENU_ENTRY_NAME = 'StewardCollectMenu';

    function readSettings() {
        var s = S.kernel.settings.read('collect');
        return s || S.modules.collect.defaultSettings;
    }

    function patternsLabel(s) {
        var ps = (s.namePatterns && s.namePatterns.length) ? s.namePatterns : [];
        if (!ps.length) return 'Patterns: (none — module disabled effectively)';
        return 'Patterns: ' + ps.join(', ');
    }

    function buildSpec() {
        var s = readSettings();
        return {
            name:  MENU_ENTRY_NAME,
            label: 'Collect',
            items: [
                {
                    label:    (s.enabled ? '✓ ' : '✕ ') + 'Enabled',
                    onSelect: function () { toggle('enabled'); }
                },
                {
                    label:    patternsLabel(s),
                    enabled:  false                         // info-only
                },
                { type: 'separator' },
                {
                    label:    'Discover collectibles (log)',
                    onSelect: discover
                }
            ]
        };
    }

    function toggle(key) {
        var s = readSettings();
        s[key] = !s[key];
        S.kernel.settings.write('collect', s);
        S.kernel.log('collect', 'toggled', key, '→', s[key]);

        // If the user disabled the module, drop any pending collect actions
        // immediately. Per the busy contract this also unblocks plan() once
        // the user re-enables (no orphan actions hanging around).
        if (key === 'enabled' && !s.enabled) {
            if (S.kernel.queue && S.kernel.queue.cancelByModule) {
                S.kernel.queue.cancelByModule('collect');
            }
        }

        renderMenu();
    }

    // One-shot: walk every building on the current zone and log whether the
    // host's CollectionsManager flagged it collectible, plus whether each of
    // the user's configured patterns matches. Output goes through the
    // standard logger (category 'collect:discover') so it lands in
    // <appStorage>/steward/logs/console.log.
    function discover() {
        try {
            var s = readSettings();
            var bld = S.core.buildings;
            bld.invalidate();
            var src = bld.list();
            var matched = 0;
            var unmatched = 0;

            S.kernel.log('collect:discover', '--- discovery start ---',
                         'patterns:', (s.namePatterns || []).join(','));

            for (var i = 0; i < src.length; i++) {
                var b = src[i];
                if (!bld.isCollectible(b)) continue;
                var n = bld.name(b);
                var hits = [];
                var ps = s.namePatterns || [];
                for (var k = 0; k < ps.length; k++) {
                    if (n && n.indexOf(ps[k]) > -1) hits.push(ps[k]);
                }
                if (hits.length) matched++; else unmatched++;
                S.kernel.log('collect:discover',
                    (hits.length ? '✓' : '·'),
                    n, 'grid=' + bld.grid(b),
                    'matches:', hits.length ? hits.join(',') : '(none)');
            }

            S.kernel.log('collect:discover',
                '--- discovery end --- matched:', matched,
                'unmatched:', unmatched, 'total scanned:', matched + unmatched);

            try {
                if (typeof showGameAlert === 'function') {
                    showGameAlert('Steward: discovered ' + matched + ' matching, ' +
                                  unmatched + ' unmatched. See console.');
                }
            } catch (e) { /* alert is best-effort */ }
        } catch (e) {
            S.kernel.error('collect:discover', 'threw:', e);
        }
    }

    function renderMenu() {
        if (!S.kernel.ui || !S.kernel.ui.menu) return;
        S.kernel.ui.menu.replaceByName(MENU_ENTRY_NAME, buildSpec());
    }

    S.modules.collect.renderMenu   = renderMenu;
    S.modules.collect.readSettings = readSettings;
    S.modules.collect.discover     = discover;

}(Steward));
