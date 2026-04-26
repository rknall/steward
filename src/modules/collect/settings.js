/*
 * Default settings for the collect module.
 *
 * Settings live in <applicationStorageDirectory>/steward/settings.json under
 * the `collect` key. The module's boot() seeds these defaults on first run.
 */

(function (S) {

    if (!S.modules.collect) S.modules.collect = {};

    S.modules.collect.defaultSettings = {
        // Master switch — when false, the module never enqueues anything.
        enabled:    true,

        // Mystery boxes / quest collectibles / harvested deposits etc.
        pickups:    true,

        // Special time-limited buildings whose ready cooldown surfaces as
        // the absence of a 'BuiBonus_*_Timer' / 'BuiBonus_*_Timer_Loop' quest.
        lootBoxes:  true,

        // Cooldown between full plan() runs to avoid hammering the queue
        // when the home zone is busy.
        cooldownMs: 30000
    };

    // Time-limited collectible buildings and the resource (or quest tag) that
    // identifies their ready-cooldown quest. Mirrors autoTSO's lootables list
    // (autoTSO/user_auto.js:5055-5073).
    S.modules.collect.LOOTABLES = {
        FlyingHouse:        'FlyingHouse',
        GiftChristmasTree:  'GiftChristmasTree',
        GiftGhostShip:      'GhostLantern',
        BalloonMarket_mini: 'BalloonMarket_mini'
    };

}(Steward));
