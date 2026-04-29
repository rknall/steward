/*
 * Default settings for the mining module.
 *
 * Stored under steward.mining. Shape:
 *
 *   {
 *     enabled:        false,
 *     actionDelay:    1500,
 *     pauseThreshold: 50,
 *     deposits: {
 *       <Name>: { enabled, build?, upgrade?, targetLevel?, pause?, buff, refill }
 *     }
 *   }
 *
 * `pauseThreshold` is global: when a deposit type has `pause: true`,
 * tryPause only pauses producing mines once their deposit's remaining
 * amount drops below this threshold. Resume direction (pause: false →
 * setProduction(active)) is unconditional and ignores the threshold.
 *
 * Mine-bearing types (Bronze/Iron/Gold/Coal/Titanium/Salpeter) have the
 * full shape. Mason-only types (Stone/Marble/Granite) carry only
 * enabled / buff / refill — the build/upgrade/pause phases are
 * unreachable for them.
 *
 * `buff` is a string ('' = off, otherwise a buff name selected via UI
 * dropdown). `refill` is a boolean (auto-detect the matching specific
 * refill item — TitaniumRefill, SalpeterRefill, etc. — by deposit type
 * via core/buffs.forDeposit; we explicitly avoid the generic deposit
 * refiller).
 *
 * Defaults mirror autoTSO's Deposits.data (user_auto.js:1086-1095):
 * options[1] true (build) and options[3] 3 (target level) for the six
 * mine-bearing types.
 */

(function (S) {

    if (!S.modules.mining) S.modules.mining = {};

    S.modules.mining.defaultSettings = {
        enabled:        false,
        actionDelay:    1500,
        pauseThreshold: 50,
        deposits: {
            Stone:       { enabled: true, buff: '', refill: false },
            BronzeOre:   { enabled: true, build: true, upgrade: false, targetLevel: 3,
                           pause: false, buff: '', refill: false },
            Marble:      { enabled: true, buff: '', refill: false },
            IronOre:     { enabled: true, build: true, upgrade: false, targetLevel: 3,
                           pause: false, buff: '', refill: false },
            GoldOre:     { enabled: true, build: true, upgrade: false, targetLevel: 3,
                           pause: false, buff: '', refill: false },
            Coal:        { enabled: true, build: true, upgrade: false, targetLevel: 3,
                           pause: false, buff: '', refill: false },
            Granite:     { enabled: true, buff: '', refill: false },
            TitaniumOre: { enabled: true, build: true, upgrade: false, targetLevel: 3,
                           pause: false, buff: '', refill: false },
            Salpeter:    { enabled: true, build: true, upgrade: false, targetLevel: 3,
                           pause: false, buff: '', refill: false }
        }
    };

}(Steward));
