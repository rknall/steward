/*
 * Event data tables.
 *
 * Mirrors autoTSO/user_auto.js:4407-4424 (aEvents.treasureItems and the
 * resource-by-event map). Treasure values are per explorer-task index:
 *   [Short, Medium, Long, EvenLonger, Prolonged]
 *
 * The host emits live event names like "XMASContent2025", "Valentine_Shop",
 * "HWContent_2024" — base codes (XMAS, Valentine, …) match by substring
 * (autoTSO line 4421). One base event may have multiple sub-events
 * distinguished by '_Content' / '_Shop' suffixes; we treat them as one
 * Steward event whose categories are inferred from which sub-events are
 * currently live.
 *
 * Update this file when a new event ships in TSO. The structure is small
 * and stable — the harder part (skill-aware duration math) lives in
 * core/specialists.pickTask.
 */

(function (S) {

    if (!S.core.events)      S.core.events      = {};
    if (!S.core.events.data) S.core.events.data = {};

    // Base events. Keyed by the substring autoTSO matches against host event
    // names (game.gi.mEventManager.GetActiveEventNames()).
    //
    // - treasureValues[]: items per task — [Short, Medium, Long, EvenLonger, Prolonged].
    // - resource: the currency the event drops; used by UI to display gain.
    //   Anniversary has a level-dependent resource (Candles ≥54, CakeDough <54);
    //   resolved at query time, not stored here.
    // - depositInfo: for events that surface as harvest deposits (Valentine
    //   flower farms, HW pumpkin fields). Building name + harvest-time
    //   constant — used to compute "deposits needed for the rest of the event"
    //   (autoTSO/user_auto.js:4494-4522). Steward's calculator lands later;
    //   we capture the data now so it's there.
    S.core.events.data.events = {
        XMAS: {
            name:           'Christmas',
            treasureValues: [2.2, 4.6, 9.2, 18.4, 27.2],
            resource:       'ChristmasResource'
        },
        Valentine: {
            name:           'Valentine',
            treasureValues: [1.3, 2.6, 3.9, 6.5, 9.1],
            resource:       'ValentinesFlower',
            depositInfo: {
                buildings: ['FlowerFarm']
            }
        },
        Easter: {
            name:           'Easter',
            treasureValues: [2.6, 3.9, 5.9, 8.8, 11.7],
            resource:       'StripedEggs'
        },
        Soccer: {
            name:           'Soccer',
            treasureValues: [1.95, 2.95, 3.95, 5.95, 7.95],
            resource:       'EMEventResource'
        },
        Anniversary: {
            name:           'Anniversary',
            treasureValues: [1.5, 2.5, 3.5, 5, 6.5],
            // Resource depends on player level — see eventResource() in events.js.
            resourceLowLevel:  'CakeDough',
            resourceHighLevel: 'Candles',
            resourceLevelThreshold: 54,
            // autoTSO line 4462: low-level players get 3× treasure value.
            lowLevelMultiplier: 3,
            lowLevelThreshold:  50
        },
        HW: {
            name:           'Halloween',
            treasureValues: [2.6, 3.9, 6.5, 11.8, 15.6],
            resource:       'HalloweenResource',
            depositInfo: {
                buildings: ['pumpkinfield_01', 'pumpkinfield_02', 'pumpkinfield_03'],
                depositsPerRefill: 3
            }
        }
    };

    // Adventure / treasure modifier events that affect deposit-search yields
    // are captured here when they exist. autoTSO has none of these in
    // treasureItems-shaped form right now; populate as TSO ships them.
    if (!S.core.events.data.depositModifiers) S.core.events.data.depositModifiers = {};

}(Steward));
