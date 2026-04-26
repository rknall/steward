/*
 * Default settings for the collect module.
 *
 * Settings live in host's settings.json under 'steward.collect'.
 * The module's boot() seeds these defaults on first run.
 */

(function (S) {

    if (!S.modules.collect) S.modules.collect = {};

    S.modules.collect.defaultSettings = {
        // Master switch — when false the module never enqueues anything.
        enabled: true,

        // A building is considered a "pure collectible" if BOTH of:
        //   1. game.def('Collections::CollectionsManager').getBuildingIsCollectible(name) === true
        //      (the host's broad "is harvestable" check — true for collectibles AND
        //      terrain/mines/charcoal piles)
        //   2. its name matches one of these patterns (substring match)
        //
        // The default 'Collectible' substring catches Easter eggs, footballs,
        // quest-driven DummyBuildingCollectible_* items, etc. Add more
        // patterns when an event ships pickup items that don't carry the
        // 'Collectible' name (e.g. 'Starfall' for the Starfall event).
        //
        // Use the "Discover collectibles" menu item to log every candidate
        // on the current map; pick patterns from that output.
        namePatterns: ['Collectible', 'Starfall']
    };

}(Steward));
