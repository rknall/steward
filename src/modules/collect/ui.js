/*
 * Dashboard surface for the collect module.
 *
 * Renders on the Buildings tab: a settings column and a card listing what
 * sits on the zone. The Discover button is a one-shot probe that walks the
 * current zone and logs every candidate plus how it matched against the
 * user's patterns, useful for tuning the pattern list.
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
            // The same expanded list plan() clicks with, active events included.
            var ps = S.core.pickups.patterns(s.namePatterns || []);
            bld.invalidate();
            var src = bld.list();
            var matched = 0;
            var unmatched = 0;

            S.kernel.log('collect:discover', '--- discovery start ---',
                         'patterns:', ps.join(','));

            for (var i = 0; i < src.length; i++) {
                var b = src[i];
                if (!bld.isCollectible(b)) continue;
                var n = bld.name(b);
                var hits = [];
                for (var k = 0; k < ps.length; k++) {
                    if (S.core.pickups.matches(n, [ps[k]])) hits.push(ps[k]);
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

    // Compact strip text. Reads the buffer so an unsaved toggle shows at once.
    function summary(h) {
        var s = h.settings('collect');
        return s.adventureZones === true ? 'also on adventures' : 'home island only';
    }

    // Settings column. The baseline is the merged settings the card shows, so
    // a key the stored object lacks does not count as a change.
    function renderSide($side, h) {
        h.baseline('collect', readSettings());

        var $card = h.card({ icon: '★', title: 'Collect pickups', meta: 'settings' });
        $card.append(h.field('Collect on the home island', 'Module on or off', h.toggle({
            ns: 'collect', path: 'enabled', label: 'Collect on the home island'
        })));
        $card.append(h.field('Also on adventure maps',
            'Clicks quest objects and collectibles while a run is on the map',
            h.toggle({ ns: 'collect', path: 'adventureZones', label: 'Also on adventure maps' })));
        $side.append($card);
    }

    // Collectibles currently on the zone; a failing host read counts as none.
    function collectibleGroups(fresh) {
        if (!S.core.buildings || !S.core.buildings.collectiblesByName) return [];
        try {
            // A fresh snapshot so the list reflects what is on the ground now.
            if (fresh) S.core.buildings.invalidate();
            return S.core.buildings.collectiblesByName();
        } catch (e) {
            return [];
        }
    }

    function typesText(n) {
        return n + ' collectible type' + (n === 1 ? '' : 's');
    }

    // Main column: what sits on the zone, plus the one-shot log probe.
    function render($main, h) {
        var groups = collectibleGroups(true);

        var $card = h.card({ icon: '★', title: 'On this zone', meta: typesText(groups.length) });
        if (!groups.length) {
            $card.append(h.empty('Nothing to collect here right now.',
                'New pickups show up here as soon as the zone has some.'));
        } else {
            var rows = [];
            for (var i = 0; i < groups.length; i++) {
                rows.push([groups[i].name, groups[i].count + ' on zone']);
            }
            $card.append(h.table({
                cols: [{ label: 'Collectible', width: '70%' }, { label: 'On zone', width: '30%' }],
                rows: rows
            }));
        }

        $card.append(h.field('List the collectibles on this zone',
            'Writes each one and the patterns it matches to the log. Runs at once, no Save needed.',
            $('<span>').append(h.now()).append(h.button('Discover', { size: 'sm', onClick: discover })),
            { wide: true }));
        $main.append($card);
    }

    function tiles(h) {
        var s = h.settings('collect');
        var n = collectibleGroups(false).length;
        return [{
            title: 'Collect pickups',
            icon: '★',
            lines: [
                n === 0 ? 'Nothing collectible on this zone' : typesText(n) + ' on this zone',
                s.adventureZones === true ? 'Also picks up on adventures' : 'Home island only'
            ]
        }];
    }

    S.modules.collect.readSettings  = readSettings;
    S.modules.collect.discover      = discover;
    S.modules.collect.side          = renderSide;
    S.modules.collect.render        = render;
    S.modules.collect.summary       = summary;
    S.modules.collect.tiles         = tiles;

}(Steward));
