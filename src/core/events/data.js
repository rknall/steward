/*
 * Event data tables.
 *
 * Curated event metadata used by core/events.js. Treasure values are per
 * explorer-task index ([Short, Medium, Long, EvenLonger, Prolonged]) — the
 * same shape autoTSO's aEvents.treasureItems[eventCode] uses.
 *
 * v0.1 ships an empty table so pickTask falls back to "always pick Short".
 * Populate as live event data becomes available; the surface in events.js
 * does not change.
 */

(function (S) {

    if (!S.core.events) S.core.events = {};
    if (!S.core.events.data) S.core.events.data = {};

    // {
    //   <eventCode>: {
    //     name: '...',
    //     category: 'treasure' | 'adventure' | ...,
    //     treasureValues: [v0, v1, v2, v3, v4],   // expected items per task
    //     depositModifier: { '<DepositType>': multiplier, ... }
    //   }
    // }
    S.core.events.data.events = {};

}(Steward));
