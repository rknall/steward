/*
 * Dashboard surface for the collect module.
 *
 * Renders inside the Buildings tab as a "Collect Pickups" section. The
 * section's action link is a one-shot "Discover collectibles" probe that
 * walks the current zone and logs every candidate plus how it matched
 * against the user's patterns — useful for tuning the pattern list.
 */

(function (S) {

    if (!S.modules.collect) S.modules.collect = {};

    function readSettings() {
        var stored = S.kernel.settings.read('collect') || {};
        var defaults = S.modules.collect.defaultSettings || {};
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        return merged;
    }

    // Walk every building on the current zone and log whether the host's
    // CollectionsManager flagged it collectible plus pattern matches. Output
    // goes through the standard logger (category 'collect:discover') so it
    // lands in <appStorage>/steward/logs/console.log.
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

    // Section.summary — shown on the Status tab.
    function summary() {
        var s = readSettings();
        if (!s.enabled) return 'disabled';
        var n = (s.namePatterns || []).length;
        return n + ' pattern' + (n === 1 ? '' : 's');
    }

    // Section.render — populates the section-rows container. `h` is
    // S.kernel.ui.helpers; settings are buffered so the user can Save / Close.
    function renderSection($rows, h) {
        var s = h.settings('collect');

        $rows.append(h.formRow('Run on Startup', h.toggle({
            checked:  !!s.enabled,
            onChange: function (next) { h.update('collect', { enabled: next }); }
        })));

        $rows.append(h.formRow('Name patterns', h.input({
            type:     'text',
            value:    (s.namePatterns || []).join(', '),
            width:    '320px',
            onChange: function (val) {
                var parts = String(val || '').split(',');
                var clean = [];
                for (var i = 0; i < parts.length; i++) {
                    var p = parts[i].replace(/^\s+|\s+$/g, '');
                    if (p) clean.push(p);
                }
                h.update('collect', { namePatterns: clean });
            }
        })));

        // Read-only help row — explains that active-event resources auto-extend
        // the pattern set so the user doesn't need to add Easter / XMAS / etc.
        var $help = $('<span>').css({ color: '#8a7a55', fontSize: '12px' });
        $help.append(document.createTextNode('Active-event resources auto-extend this list'));
        try {
            if (S.core.events && S.core.events.active) {
                var ev = S.core.events.active();
                var names = [];
                for (var i = 0; i < ev.length; i++) {
                    if (ev[i].code) names.push(ev[i].code);
                    if (S.core.events.eventResource) {
                        var r = S.core.events.eventResource(ev[i].code);
                        if (r) names.push(r);
                    }
                }
                if (names.length) {
                    $help.append(document.createTextNode(' · currently: '));
                    $help.append($('<code>').text(names.join(', ')));
                }
            }
        } catch (e) { /* ignore — the help line is decorative */ }
        $rows.append(h.formRow('', $help));
    }

    S.modules.collect.readSettings  = readSettings;
    S.modules.collect.discover      = discover;
    S.modules.collect.renderSection = renderSection;
    S.modules.collect.summary       = summary;

}(Steward));
