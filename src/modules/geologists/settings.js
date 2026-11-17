/*
 * Default settings for the geologists module.
 *
 * Stored under steward.geologists. Shape:
 *
 *   {
 *     enabled:       false,
 *     dispatchDelay: QUEUE_ACTION_GAP_MS (1500),
 *     removeDepleted: false,
 *     deposits:      { <Name>: { enabled: bool, max: int, kinds: [GetType] }, ... },
 *     overrides:     { '<geologist name>': ['Stone', 'Marble'] }
 *   }
 *
 * `removeDepleted` lets the module destroy depleted deposit buildings of
 * the managed types on the home island, so their grid frees up for new
 * searches. Deposits that still hold ore are never touched.
 *
 * The default `deposits` map has one row per deposit type, under the names
 * and in the order of core/deposits/types.js, so the type list is not
 * written twice. Per-deposit `max` defaults mirror autoTSO's Deposits.data
 * (user_auto.js 1086-1095) — values shipped against the live host. Adjust
 * per-zone or per-playstyle in the dashboard.
 *
 * `overrides` is keyed by the cleaned display name (HTML stripped) and
 * pins the named geologist to a deposit-name list — the routing
 * algorithm only considers that geo for those deposits, never others.
 * Same shape pattern as the explorers module's per-name overrides.
 *
 * `kinds` on a deposit row lists the geologist kinds (host GetType
 * numbers, never labels, so it holds across locales) allowed to search
 * that type. Absent or empty means default: any geologist whose kind is
 * not reserved. A kind listed for any type is reserved for the types
 * that list it and stays idle otherwise. A name in `overrides` still
 * applies on top: a geologist must pass both. The dashboard stores
 * `kinds: []` when a saved list is cleared, which means the same as an
 * absent key.
 */

(function (S) {

    if (!S.modules.geologists) S.modules.geologists = {};

    // How many deposits of each type to keep on the map by default, keyed
    // by deposit name. The keys and their order come from
    // core/deposits/types.js; this table holds only the per-type numbers.
    var DEFAULT_MAX = {
        Stone:        8,
        BronzeOre:    6,
        Marble:      10,
        IronOre:     19,
        GoldOre:      9,
        Coal:         6,
        Granite:      6,
        TitaniumOre:  4,
        Salpeter:     4
    };

    function defaultDeposits() {
        var out = {};
        var types = S.core.deposits.types();
        for (var i = 0; i < types.length; i++) {
            out[types[i].name] = { enabled: true, max: DEFAULT_MAX[types[i].name] };
        }
        return out;
    }

    S.modules.geologists.defaultSettings = {
        enabled:       false,
        dispatchDelay: S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS,
        removeDepleted: false,

        deposits: defaultDeposits(),

        overrides: {
            // 'Stone Geologist Foo': ['Stone'],
            // 'Bewitching Geologist': ['IronOre', 'TitaniumOre']
        }
    };

}(Steward));
