/*
 * Default settings for the mining module.
 *
 * Stored under steward.mining. Shape:
 *
 *   {
 *     enabled:        false,
 *     actionDelay:    QUEUE_ACTION_GAP_MS (1500),
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
 * The deposit rows are derived from the deposit types
 * (core/deposits/types.js), in their order. A type with a mine
 * (Bronze/Iron/Gold/Coal/Titanium/Salpeter) gets the full shape; a
 * mason-only type (Stone/Marble/Granite) carries only enabled / buff /
 * refill, since the build/upgrade/pause phases are unreachable for it.
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

    // The default row for one deposit type: the full shape where the type
    // has a mine, the mason shape otherwise.
    function defaultRow(info) {
        if (info.mineName) {
            return { enabled: true, build: true, upgrade: false, targetLevel: 3,
                     pause: false, buff: '', refill: '' };
        }
        return { enabled: true, buff: '', refill: '' };
    }

    var deposits = {};
    var types = S.core.deposits.types();
    for (var i = 0; i < types.length; i++) {
        deposits[types[i].name] = defaultRow(types[i]);
    }

    S.modules.mining.defaultSettings = {
        enabled:        false,
        actionDelay:    S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS,
        pauseThreshold: 50,
        buffVersion:    1,
        deposits:       deposits
    };

}(Steward));
