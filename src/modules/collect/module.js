/*
 * Collect module.
 *
 * Walks the current zone for "pure collectibles" (Easter eggs, footballs,
 * quest collectibles, event drops) and enqueues a SelectBuilding action for
 * each. Honoured by the kernel's modal guard (waits while the user has a
 * window open) and the busy contract (plan() will not be called again until
 * the previous cycle's actions have all completed).
 *
 * Detection: a building is considered a pure collectible iff
 *   1. CollectionsManager.getBuildingIsCollectible(name) === true   (host API), AND
 *   2. its name matches one of settings.namePatterns (substring match)
 *
 * Without the name-pattern filter, the host API matches terrain rocks,
 * depleted mines, charcoal piles and other map-clutter — which is what the
 * F4 "pickup all" shortcut sweeps when the user explicitly invokes it. We
 * gate it tighter so the periodic scheduler tick stays useful.
 *
 * Use Steward → Collect → "Discover collectibles" to log every candidate on
 * the current map and tune the pattern list.
 */

(function (S) {

    function readSettings() {
        return (S.modules.collect && S.modules.collect.readSettings)
            ? S.modules.collect.readSettings()
            : S.modules.collect.defaultSettings;
    }

    function nameMatchesAny(n, patterns) {
        if (!n || !patterns || !patterns.length) return false;
        for (var i = 0; i < patterns.length; i++) {
            if (typeof patterns[i] !== 'string' || !patterns[i].length) continue;
            if (n.indexOf(patterns[i]) > -1) return true;
        }
        return false;
    }

    function isPureCollectible(b, patterns) {
        if (!b) return false;
        var bld = S.core.buildings;
        if (!bld.isCollectible(b)) return false;
        return nameMatchesAny(bld.name(b), patterns);
    }

    function isReady(ctx) {
        var s = readSettings();
        if (!s || !s.enabled) return false;
        if (!ctx.zone || !ctx.zone.isHome) return false;
        if (!s.namePatterns || !s.namePatterns.length) return false;
        return true;
    }

    function plan() {
        var s = readSettings();
        var bld = S.core.buildings;
        bld.invalidate();
        var src = bld.list();
        var enqueued = 0;
        for (var i = 0; i < src.length; i++) {
            if (!isPureCollectible(src[i], s.namePatterns)) continue;
            S.kernel.queue.add('collect', [bld.grid(src[i])]);
            enqueued++;
        }
        if (enqueued > 0) {
            S.kernel.log('collect', 'enqueued', enqueued, 'collectible(s)');
        }
        // No cooldown — the scheduler's busy contract handles re-entry: plan()
        // will not be called again until every action above has executed.
        // When the queue is empty (no collectibles on map), plan() is cheap to
        // re-run on the next tick.
    }

    function boot() {
        // Seed defaults on first run.
        if (!S.kernel.settings.read('collect')) {
            S.kernel.settings.write('collect', S.modules.collect.defaultSettings);
        }

        // Register the queue action that performs the actual collect.
        S.kernel.queue.action('collect', function (params) {
            var grid = params[0];
            var bld = S.core.buildings;
            try {
                var building = bld.byGrid(grid);
                if (!building) {
                    // Building already collected (or zone changed). Quietly drop.
                    return;
                }
                if (typeof game !== 'undefined' && game.gi && typeof game.gi.SelectBuilding === 'function') {
                    game.gi.SelectBuilding(building);
                }
                var name = bld.name(building);
                S.kernel.log('collect', 'collecting', name, 'at', grid);
                if (typeof globalFlash !== 'undefined' && globalFlash && globalFlash.gui &&
                    typeof globalFlash.gui.UpdateGuiOnZoneLoad === 'function') {
                    globalFlash.gui.UpdateGuiOnZoneLoad();
                }
            } catch (e) {
                S.kernel.error('collect', 'collect action threw:', e);
            }
            // The collected building disappears or changes state; refresh so
            // the next plan() (after the queue empties) sees the new world.
            bld.invalidate();
        });

        // Render the in-game menu entry.
        if (S.modules.collect.renderMenu) S.modules.collect.renderMenu();
    }

    S.kernel.register({
        id:       'collect',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan
    });

}(Steward));
