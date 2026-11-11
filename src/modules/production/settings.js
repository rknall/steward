/*
 * Default settings for the production module.
 *
 * Stored under steward.production. Shape:
 *
 *   {
 *     enabled:      false,
 *     actionDelay:  1500,
 *     ordersPerPass: 2,
 *     buffsPerPass:  2,
 *     standing:     true,
 *     buffs:        true,
 *     bookComplete: false,
 *     buildings: {
 *       <BuildingName>: { item, amount, stack, buff }
 *     }
 *   }
 *
 * `buildings` is keyed by building name, like autoTSO's production
 * settings, because the host queue runs at the highest-level building of
 * a name. A missing name means nothing is configured for it.
 *
 *   item    the item to keep queued; '' is off.
 *   amount  how many items to keep queued (in progress or waiting), in
 *           items. autoTSO's amount is a 0/1 flag ("keep one in
 *           progress"); here it is a count. 0 is off.
 *   stack   items per order message; 0 means the profile default: 25 for
 *           a stackable queue (units, buffs), 1 for every other one.
 *   buff    the production buff to keep on the producer; '' is off.
 *
 * Off is always '' or 0, never a deleted key: settings writes deep-merge,
 * so a key once stored is never removed, and a deleted key would read back
 * as its last stored value.
 *
 * `bookComplete` is off by default, because what message 141 does to the
 * Bookbinder queue is not confirmed live.
 */

(function (S) {

    if (!S.modules.production) S.modules.production = {};

    S.modules.production.defaultSettings = {
        enabled:       false,
        actionDelay:   1500,
        ordersPerPass: 2,
        buffsPerPass:  2,
        standing:      true,
        buffs:         true,
        bookComplete:  false,
        buildings:     {}
    };

    // The shape of one buildings entry with everything off.
    S.modules.production.defaultBuilding = { item: '', amount: 0, stack: 0, buff: '' };

}(Steward));
