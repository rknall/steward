/*
 * Default settings for the geologists module.
 *
 * Stored under steward.geologists. Shape:
 *
 *   {
 *     enabled:       false,
 *     dispatchDelay: 1500,
 *     deposits:      { <Name>: { enabled: bool, max: int }, ... },
 *     overrides:     { '<geologist name>': ['Stone', 'Marble'] }
 *   }
 *
 * Per-deposit `max` defaults mirror autoTSO's Deposits.data (user_auto.js
 * 1086-1095) — values shipped against the live host. Adjust per-zone
 * or per-playstyle in the dashboard.
 *
 * `overrides` is keyed by the cleaned display name (HTML stripped) and
 * pins the named geologist to a deposit-name list — the routing
 * algorithm only considers that geo for those deposits, never others.
 * Same shape pattern as the explorers module's per-name overrides.
 */

(function (S) {

    if (!S.modules.geologists) S.modules.geologists = {};

    S.modules.geologists.defaultSettings = {
        enabled:       false,
        dispatchDelay: 1500,

        deposits: {
            Stone:       { enabled: true, max:  8 },
            BronzeOre:   { enabled: true, max:  6 },
            Marble:      { enabled: true, max: 10 },
            IronOre:     { enabled: true, max: 19 },
            GoldOre:     { enabled: true, max:  9 },
            Coal:        { enabled: true, max:  6 },
            Granite:     { enabled: true, max:  6 },
            TitaniumOre: { enabled: true, max:  4 },
            Salpeter:    { enabled: true, max:  4 }
        },

        overrides: {
            // 'Stone Geologist Foo': ['Stone'],
            // 'Bewitching Geologist': ['IronOre', 'TitaniumOre']
        }
    };

}(Steward));
