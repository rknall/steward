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

    // Section.render — appends rows to the panel. Settings are buffered so
    // the user can Save / Close. Pattern config (settings.namePatterns) is
    // intentionally not user-facing here — it's an advanced knob editable in
    // settings.json. The dashboard surfaces what matters at a glance: the
    // master toggle and the collectibles currently sitting on the zone.
    function renderSection($panel, h) {
        var s = h.settings('collect');

        $panel.append(h.formRow('Run on Startup', h.toggle({
            checked:  !!s.enabled,
            onChange: function (next) { h.update('collect', { enabled: next }); }
        })));

        appendCollectiblesList($panel, h);
        appendInventoryList($panel, h);
    }

    function appendCollectiblesList($panel, h) {
        if (!S.core.buildings || !S.core.buildings.collectiblesByName) return;

        // Force a fresh snapshot so the list reflects what's actually on the
        // ground at the moment the dashboard is opened. invalidate() is a
        // no-op when the cache is already empty.
        try { S.core.buildings.invalidate(); }
        catch (e) { /* ignore */ }

        var groups;
        try { groups = S.core.buildings.collectiblesByName(); }
        catch (e) { groups = []; }

        // Sub-header.
        $panel.append(h.gridRow(
            [[8, 'Collectibles on zone'], [4, groups.length + ' types']],
            { headerCells: true }
        ));

        if (!groups.length) {
            $panel.append(h.formRow(
                $('<em>').css({ color: '#a09a85' }).text('Nothing collectible on this zone right now.'),
                ''
            ));
            return;
        }

        for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            $panel.append(h.gridRow([
                [8, g.name],
                [4, g.count + ' on zone']
            ]));
        }
    }

    // Inventory of curated "collection items" (Leather, Banner, Cauldron, …)
    // that live in the host's resource inventory but are normally hidden
    // (storehouse event tab during events; mayor's house crafting menu).
    // We render them here so the user can see counts at any time.
    //
    // Read settings via readSettings() rather than h.settings('collect') so
    // existing users without `inventory` in their persisted settings still
    // see the default tracked list. The buffer would otherwise return an
    // undefined `inventory` field and the section would be empty.
    function appendInventoryList($panel, h) {
        if (!S.core.resources) return;

        var s = readSettings();
        var items = (s.inventory && s.inventory.items) || [];
        if (!items.length) return;

        // Force a fresh inventory read so amounts reflect the moment the
        // dashboard is opened.
        try { S.core.resources.invalidate(); }
        catch (e) { /* ignore */ }

        var entries = [];
        for (var i = 0; i < items.length; i++) {
            var nm = items[i];
            if (!nm) continue;
            entries.push({
                internal:    nm,
                displayName: S.core.resources.displayName(nm),
                amount:      S.core.resources.amount(nm)
            });
        }
        entries.sort(function (a, b) {
            var ak = (a.displayName || '').toLowerCase();
            var bk = (b.displayName || '').toLowerCase();
            if (ak < bk) return -1;
            if (ak > bk) return 1;
            return 0;
        });

        $panel.append(h.gridRow(
            [[8, 'Tracked items'], [4, entries.length + ' tracked']],
            { headerCells: true }
        ));

        for (var j = 0; j < entries.length; j++) {
            var e = entries[j];
            $panel.append(h.gridRow([
                [8, e.displayName],
                [4, String(e.amount)]
            ]));
        }
    }

    S.modules.collect.readSettings  = readSettings;
    S.modules.collect.discover      = discover;
    S.modules.collect.renderSection = renderSection;
    S.modules.collect.summary       = summary;

}(Steward));
