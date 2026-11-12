/*
 * Dashboard surface for the collect module.
 *
 * Renders on the Buildings tab: a settings column and a card listing what
 * sits on the zone. Below it a card with the gem pits on the home island and
 * their output per 12 h (S.core.events.refill.rates12h, buffs included; only
 * when a pit is placed), and a card with the mayor's house items: the held
 * resources without a storehouse category (S.core.resources.uncategorized),
 * less the ones another steward view already shows (only when the list can
 * be read). The Discover button is a one-shot probe that walks the
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

    function buiName(building) {
        try { return S.core.locale.bui(building); }
        catch (e) { return building; }
    }

    // Gem pit rows with their rate per 12 h, or null when none is readable:
    // off the home island, a failing host read or no pit placed.
    function gemPits() {
        var R = S.core.events && S.core.events.refill;
        if (!R || typeof R.rates12h !== 'function') return null;
        var res = null;
        try { res = R.rates12h([S.Building.GemPit]); }
        catch (e) { res = null; }
        return (res && res.rows.length) ? res : null;
    }

    // A rate with the buffed rate in muted parentheses while a buff is active.
    // Text only, so numbers from the host stay inert.
    function rateCell(v, b) {
        var $c = $('<span>').text((v === null || typeof v === 'undefined') ? '—' : String(v));
        if (b !== null && typeof b !== 'undefined') {
            $c.append($('<span>', { 'class': 'steward-muted' }).text(' (' + b + ')'));
        }
        return { cls: 'steward-num', $: $c };
    }

    function pitsText(n) {
        return n + ' gem pit' + (n === 1 ? '' : 's');
    }

    function gemPitCard(h, res) {
        var $card = h.card({ icon: '◆', title: 'Gem pits', meta: pitsText(res.rows.length) });
        var rows = [];
        for (var i = 0; i < res.rows.length; i++) {
            var row = res.rows[i];
            var label = buiName(row.building) + ' (grid ' + row.grid + ')';
            rows.push([{ text: label, title: label }, rateCell(row.rate12h, row.rate12hBuffed)]);
        }
        $card.append(h.table({
            cols: [
                { label: 'Gem pit',  width: '70%' },
                { label: 'Per 12 h', width: '30%', cls: 'steward-num' }
            ],
            rows: rows,
            foot: ['Total', rateCell(res.totalRate12h, res.totalRate12hBuffed)]
        }));
        $card.append($('<div>', { 'class': 'steward-muted steward-note' }).text(
            '(…) = with the active production buff. Work time only, without the walk to the storehouse.'));
        return $card;
    }

    // Resources another steward view already shows: the population
    // (adventures, production) and the event resources the Events tab lists
    // (S.core.events.heldResources rows tied to a known event). Read at call
    // time, so no list is kept here.
    function shownElsewhere() {
        var out = {};
        try { out[S.core.resources.POPULATION] = true; }
        catch (e) { /* no population name: nothing to leave out */ }
        try {
            var held = S.core.events.heldResources();
            var rows = (held && held.rows) || [];
            for (var i = 0; i < rows.length; i++) {
                if (rows[i] && rows[i].code) out[rows[i].resource] = true;
            }
        } catch (e2) { /* no event resources readable */ }
        return out;
    }

    // Mayor's house items not shown elsewhere, or null when unreadable.
    function mayorItems() {
        var all = null;
        try { all = S.core.resources.uncategorized(); }
        catch (e) { all = null; }
        if (!all) return null;
        var skip = shownElsewhere();
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (!Object.prototype.hasOwnProperty.call(skip, all[i].name)) out.push(all[i]);
        }
        return out;
    }

    function itemsText(n) {
        return n + ' item' + (n === 1 ? '' : 's');
    }

    function mayorCard(h, items) {
        var $card = h.card({ icon: '⌂', title: "Mayor's house", meta: itemsText(items.length) });
        if (!items.length) {
            return $card.append(h.empty("No items in the mayor's house."));
        }
        var rows = [];
        for (var i = 0; i < items.length; i++) {
            rows.push([{ text: items[i].label, title: items[i].name }, String(items[i].amount)]);
        }
        $card.append(h.table({
            cols: [{ label: 'Item', width: '70%' }, { label: 'Amount', width: '30%', cls: 'steward-num' }],
            rows: rows
        }));
        return $card;
    }

    // Main column: what sits on the zone, plus the one-shot log probe, then
    // the gem pits (when placed) and the mayor's house items.
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

        var pits = gemPits();
        if (pits) $main.append(gemPitCard(h, pits));
        var items = mayorItems();
        if (items) $main.append(mayorCard(h, items));
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
    S.modules.collect.gemPits       = gemPits;
    S.modules.collect.mayorItems    = mayorItems;

}(Steward));
