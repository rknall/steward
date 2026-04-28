/*
 * Default settings for the mining module.
 *
 * Stored under steward.mining. Shape:
 *
 *   {
 *     enabled:     false,
 *     actionDelay: 1500,
 *     deposits: {
 *       <Name>: { enabled, build?, upgrade?, targetLevel?, pause?, buff, refill }
 *     }
 *   }
 *
 * Mine-bearing types (Bronze/Iron/Gold/Coal/Titanium/Salpeter) have the
 * full shape. Mason-only types (Stone/Marble/Granite) carry only
 * enabled / buff / refill — the build/upgrade/pause phases are
 * unreachable for them.
 *
 * `buff` and `refill` are strings; '' means off. The shape leaves room
 * for selecting which buff item or refill item to apply once those
 * phases land in v2 (depends on a future core/buffs subsystem).
 *
 * Defaults mirror autoTSO's Deposits.data (user_auto.js:1086-1095):
 * options[1] true (build) and options[3] 3 (target level) for the six
 * mine-bearing types.
 */

(function (S) {

    if (!S.modules.mining) S.modules.mining = {};

    S.modules.mining.defaultSettings = {
        enabled:     false,
        actionDelay: 1500,
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
