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
        //   2. its name matches one of these patterns (substring match) OR
        //      one of the active-event base codes (auto-derived in plan()).
        //
        // The default 'Collectible' substring catches DummyBuildingCollectible_*
        // quest items and similar. Active events automatically extend the list:
        // when Easter is live, names containing 'Easter' are picked up
        // (EasterEgg2024, etc.); same for XMAS, Valentine, HW, Soccer,
        // Anniversary. No user action needed for new events as long as
        // Steward.core.events.data has the base code.
        //
        // Use "Discover collectibles" to log candidates if something is
        // still missed.
        //
        // Note: 'Starfall' is intentionally NOT listed — that family lives
        // in a separate module (planned).
        namePatterns: ['Collectible'],

        // Inventory items to surface on the Collections & Buildings tab.
        // These are item-resources that live in the player's resource
        // inventory but are normally hidden — only visible in the
        // storehouse's event tab during events or when crafting at the
        // mayor's house. Use the host's internal `name_string` (NOT the
        // localized label).
        //
        // The internal names follow TSO's `Collectible*` convention for
        // drop-style items. Find more via the Diagnostics tab's "Log all
        // resources" probe — it dumps every resource with internal name,
        // localized label, and current amount.
        //
        // Add seasonal items (e.g. CollectibleChristmasCandy,
        // CollectiblePlainEgg) here when the event is live; names not in
        // the host's resource map simply render as 0.
        inventory: {
            items: [
                'CollectibleFurs',           // Leather
                'CollectibleScarecrow',      // Scarecrow
                'CollectibleWineBarrel',     // Barrel
                'CollectibleHerbs',          // Herbs
                'CollectibleAdamantium',     // Adamantium Ore
                'CollectibleFoodCart',       // Food Cart
                'CollectibleBanner',         // Banner
                'CollectibleGrainSacks',     // Grain Sacks
                'CollectibleBronzeCauldron', // Bronze Cauldron
                'CollectibleKettle'          // Kettle
            ]
        }
    };

}(Steward));
