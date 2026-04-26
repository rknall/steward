/*
 * Collect module.
 *
 * Steward's first end-to-end automation. Walks the home zone for ready
 * collectibles (mystery boxes, harvested deposits, etc.) and special
 * time-limited buildings (FlyingHouse, GiftChristmasTree, …), enqueueing a
 * collect action for each ready target.
 *
 * Mirrors autoTSO's aBuildings.collectibles.{check,collect,lootables}
 * (autoTSO/user_auto.js:5022-5108) but routed through the Steward kernel.
 */

(function (S) {

    var state = {
        cooldownUntil: 0,
        lastQueued:    0
    };

    function readSettings() {
        return (S.modules.collect && S.modules.collect.readSettings)
            ? S.modules.collect.readSettings()
            : S.modules.collect.defaultSettings;
    }

    // --- Collectible detection (autoTSO/user_auto.js:5022-5054) ---

    function isReadyCollectible(b) {
        if (!b) return false;
        var bld = S.core.buildings;
        // Always-collectible (mystery boxes etc.)
        if (bld.isCollectible(b)) return true;
        // Selectable, attackable foreign building with no army left
        if (bld.isAttackable(b) && bld.isMine(b) === false && !bld.hasArmy(b)) {
            try {
                if (b.mIsSelectable) return true;
            } catch (e) { /* ignore */ }
        }
        return false;
    }

    function collectPickups() {
        var src = S.core.buildings.list();
        var enqueued = 0;
        for (var i = 0; i < src.length; i++) {
            var b = src[i];
            if (!isReadyCollectible(b)) continue;
            S.kernel.queue.add('collect', [S.core.buildings.grid(b), false]);
            enqueued++;
        }
        return enqueued;
    }

    // --- Lootables list (autoTSO/user_auto.js:5055-5073) ---

    function questExists(name) {
        try {
            if (typeof game === 'undefined' || !game.quests) return false;
            if (typeof game.quests.getQuest !== 'function') return false;
            return !!game.quests.getQuest(name);
        } catch (e) { return false; }
    }

    function collectLootables() {
        var lootables = (S.modules.collect && S.modules.collect.LOOTABLES) || {};
        var enqueued = 0;
        var keys = Object.keys(lootables);
        for (var i = 0; i < keys.length; i++) {
            var buildingName = keys[i];
            var questTag = lootables[buildingName];
            var matches = S.core.buildings.byName(buildingName);
            if (!matches.length) continue;

            // Quest 'BuiBonus_<tag>_Timer_Loop' or 'BuiBonus_<tag>_Timer'
            // exists while the building is on cooldown — absence implies ready.
            var q1 = 'BuiBonus_' + questTag + '_Timer_Loop';
            var q2 = 'BuiBonus_' + questTag + '_Timer';
            if (questExists(q1) || questExists(q2)) continue;

            for (var j = 0; j < matches.length; j++) {
                S.kernel.queue.add('collect', [S.core.buildings.grid(matches[j]), true]);
                enqueued++;
            }
        }
        return enqueued;
    }

    // --- Module spec ---

    function isReady(ctx) {
        var s = readSettings();
        if (!s || !s.enabled) return false;
        if (!ctx.zone || !ctx.zone.isHome) return false;
        if (ctx.now < state.cooldownUntil) return false;
        if (!s.pickups && !s.lootBoxes) return false;
        return true;
    }

    function plan(ctx) {
        var s = readSettings();
        var total = 0;

        // Refresh the buildings snapshot at the top of plan to catch zone
        // changes since the last tick (per CORE_USAGE.md cache contract).
        S.core.buildings.invalidate();

        if (s.pickups)    total += collectPickups();
        if (s.lootBoxes)  total += collectLootables();

        if (total > 0) {
            S.kernel.log('collect', 'queued', total, 'collect actions');
            state.lastQueued = total;
        }

        var cd = typeof s.cooldownMs === 'number' ? s.cooldownMs : 30000;
        state.cooldownUntil = ctx.now + cd;
    }

    function boot() {
        // Seed defaults on first run.
        if (!S.kernel.settings.read('collect')) {
            S.kernel.settings.write('collect', S.modules.collect.defaultSettings);
        }

        // Register the queue action that performs the actual collect.
        S.kernel.queue.action('collect', function (params) {
            var grid = params[0];
            var isLootBox = !!params[1];
            try {
                var building = S.core.buildings.byGrid(grid);
                if (!building) {
                    S.kernel.warn('collect', 'building at grid', grid, 'not found (already collected?)');
                    return;
                }
                if (typeof game !== 'undefined' && game.gi && typeof game.gi.SelectBuilding === 'function') {
                    game.gi.SelectBuilding(building);
                }
                var name = S.core.buildings.name(building);
                S.kernel.log('collect', 'collecting', isLootBox ? 'loot box' : 'pickup', name, 'at', grid);
                // Refresh the host UI so the building's state updates.
                if (typeof globalFlash !== 'undefined' && globalFlash && globalFlash.gui &&
                    typeof globalFlash.gui.UpdateGuiOnZoneLoad === 'function') {
                    globalFlash.gui.UpdateGuiOnZoneLoad();
                }
            } catch (e) {
                S.kernel.error('collect', 'collect action threw:', e);
            }
            // Buildings disappear or change state on collect — invalidate the cache
            // so the next plan() sees the new world.
            S.core.buildings.invalidate();
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
