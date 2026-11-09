/*
 * Default settings for the mining module.
 *
 * Stored under steward.mining. Shape:
 *
 *   {
 *     enabled:        false,
 *     actionDelay:    1500,
 *     pauseThreshold: 50,
 *     buffVersion:    1,
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
 * `buff` and `refill` are strings; '' means off, the default for all
 * nine types. `buff` is the buff definition name the buff phase applies
 * to the type's mine or mason. `refill` is reserved for the refill
 * phase, which is still a stub.
 *
 * `buffVersion` marks that `deposits.<Type>.buff` holds a name picked in
 * the buff UI. Stored settings without it (or with a lower value) predate
 * the buff phase: their buff values are cleared once at boot and the
 * marker is written. A fresh install writes these defaults, so it carries
 * the marker and is never cleared. module.js reads the current value from
 * here.
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
        buffVersion:    1,
        deposits: {
            Stone:       { enabled: true, buff: '', refill: '' },
            BronzeOre:   { enabled: true, build: true, upgrade: false, targetLevel: 3,
                           pause: false, buff: '', refill: '' },
            Marble:      { enabled: true, buff: '', refill: '' },
            IronOre:     { enabled: true, build: true, upgrade: false, targetLevel: 3,
                           pause: false, buff: '', refill: '' },
            GoldOre:     { enabled: true, build: true, upgrade: false, targetLevel: 3,
                           pause: false, buff: '', refill: '' },
            Coal:        { enabled: true, build: true, upgrade: false, targetLevel: 3,
                           pause: false, buff: '', refill: '' },
            Granite:     { enabled: true, buff: '', refill: '' },
            TitaniumOre: { enabled: true, build: true, upgrade: false, targetLevel: 3,
                           pause: false, buff: '', refill: '' },
            Salpeter:    { enabled: true, build: true, upgrade: false, targetLevel: 3,
                           pause: false, buff: '', refill: '' }
        }
    };

}(Steward));
