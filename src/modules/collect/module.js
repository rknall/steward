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

    // Module-private state. Persists across ticks but not across reboots.
    var state = {
        lastUnmatchedSig: null
    };

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

    // Build the effective pattern list for the current tick.
    //
    // Active events contribute two strings to the pattern set, both via
    // substring match:
    //   1. the event base code (Easter, XMAS, Valentine, HW, …)
    //   2. the event RESOURCE name (StripedEggs, ChristmasResource,
    //      ValentinesFlower, …) — confirmed empirically: Easter's
    //      collectible is named 'BuildingStripedEggs' (not 'BuildingEaster*').
    //      The building name carries the resource, not the event code.
    //
    // Both are included because (a) future events might use either pattern,
    // (b) one might catch generic decorations the other misses, and the
    // host's getBuildingIsCollectible filter narrows the result to actual
    // collectibles regardless.
    function effectivePatterns(s) {
        var pats = (s.namePatterns || []).slice();
        try {
            if (S.core.events && typeof S.core.events.active === 'function') {
                var ev = S.core.events.active();
                for (var i = 0; i < ev.length; i++) {
                    if (ev[i].code && pats.indexOf(ev[i].code) === -1) pats.push(ev[i].code);
                    if (typeof S.core.events.eventResource === 'function') {
                        var res = S.core.events.eventResource(ev[i].code);
                        if (res && pats.indexOf(res) === -1) pats.push(res);
                    }
                }
            }
        } catch (e) { /* fall through with the configured list */ }
        return pats;
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
        var patterns = effectivePatterns(s);
        var bld = S.core.buildings;
        bld.invalidate();
        var src = bld.list();
        var enqueued = 0;
        var collectibleCount = 0;     // host says "this is a collectible"
        var unmatchedSamples = [];    // up to MAX_SAMPLES distinct names for the warning
        var seenUnmatched = {};
        var MAX_SAMPLES = 8;

        for (var i = 0; i < src.length; i++) {
            if (!bld.isCollectible(src[i])) continue;
            collectibleCount++;
            var name = bld.name(src[i]);
            if (!nameMatchesAny(name, patterns)) {
                if (!seenUnmatched[name] && unmatchedSamples.length < MAX_SAMPLES) {
                    seenUnmatched[name] = true;
                    unmatchedSamples.push(name);
                }
                continue;
            }
            S.kernel.queue.add('collect', [bld.grid(src[i])]);
            enqueued++;
        }
        if (enqueued > 0) {
            S.kernel.log('collect', 'enqueued', enqueued, 'collectible(s) of',
                         collectibleCount, 'host-flagged (patterns:', patterns.join(',') + ')');
        } else if (collectibleCount > 0) {
            // Collectibles exist but none match. Logging at log-level only
            // ONCE per distinct unmatched-set so a stale-state map doesn't
            // spam the log every tick. Subsequent ticks log at debug.
            var sig = patterns.join('|') + '|' + unmatchedSamples.join(',');
            var firstTime = (state.lastUnmatchedSig !== sig);
            state.lastUnmatchedSig = sig;
            var msg = ['host has', collectibleCount,
                       'collectible(s) on map but none match patterns:',
                       patterns.join(',') || '(empty)',
                       '— unmatched samples:',
                       unmatchedSamples.length ? unmatchedSamples.join(', ') : '(none)'];
            if (firstTime) S.kernel.log.apply(null, ['collect'].concat(msg));
            else            S.kernel.debug.apply(null, ['collect'].concat(msg));
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
                S.kernel.debug('collect', 'collecting', name, 'at', grid);
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

    }

    S.kernel.register({
        id:       'collect',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        // Render / summary are wrapped in closures so they resolve
        // S.modules.collect.* at call time. ui.js loads AFTER module.js
        // (alphabetical concat order), so a direct reference here would
        // be undefined and validateUi would reject the spec.
        ui: {
            tab: 'buildings',
            section: {
                id:    'collect_pickups',
                title: 'Collect Pickups',
                icon:  '★',
                render: function ($body, h) {
                    if (S.modules.collect.renderSection) {
                        return S.modules.collect.renderSection($body, h);
                    }
                },
                summary: function () {
                    return S.modules.collect.summary ? S.modules.collect.summary() : '';
                },
                action: {
                    label:   'Discover collectibles (log)',
                    onClick: function () {
                        if (S.modules.collect.discover) S.modules.collect.discover();
                    }
                }
            }
        }
    });

}(Steward));
