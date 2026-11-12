/*
 * Default settings for the production module.
 *
 * Stored under steward.production. Shape:
 *
 *   {
 *     enabled:       false,
 *     actionDelay:   1500,
 *     ordersPerPass: 2,
 *     buffsPerPass:  2,
 *     standing:      true,
 *     buffs:         true,
 *     bookComplete:  true,
 *     settingsVersion: 2,
 *     buildings: {
 *       <BuildingName>: { item, items, buff, enabled }
 *     }
 *   }
 *
 * `enabled` is the module switch. `standing` gates the automatic-queue
 * orders, `buffs` gates the buff sent with the orders, and `bookComplete`
 * gates collecting the Bookbinder queue. Each gate is still checked per
 * row, so a row that is off never acts even when its gate is on.
 *
 * `buildings` is keyed by building name, like autoTSO's production
 * settings, because the host queue runs at the highest-level building of
 * a name. A missing name means nothing is configured for it.
 *
 *   item     the item to order into an idle queue; '' is off.
 *   items    how many runs go into one order message. The module clamps it
 *            to what the queue type allows, so a stored value is never
 *            trusted as is.
 *   buff     the production buff sent with each automatic-queue order of
 *            the row while the producer has none running; '' is off.
 *   enabled  the row's switch. It gates the order, the buff and, for the
 *            Bookbinder row, the collection. A new row starts off.
 *
 * Off is always false, '' or 0, never a deleted key: settings writes
 * deep-merge, so a key once stored is never removed, and a deleted key would
 * read back as its last stored value. For the same reason the old `amount`
 * and `stack` keys stay on disk. Nothing reads them any more.
 *
 * `settingsVersion` marks the shape above. A stored object without this
 * version (or with an older one) is migrated once at boot. A deep merge
 * alone would keep the old keys and never show the new defaults.
 *
 * `bookComplete` is on by default. Collection follows the Bookbinder row's
 * own switch, so the row decides whether anything is collected.
 */

(function (S) {

    if (!S.modules.production) S.modules.production = {};

    S.modules.production.defaultSettings = {
        enabled:         false,
        actionDelay:     1500,
        ordersPerPass:   2,
        buffsPerPass:    2,
        standing:        true,
        buffs:           true,
        bookComplete:    true,
        settingsVersion: 2,
        buildings:       {}
    };

    // The shape of one buildings entry with everything off.
    S.modules.production.defaultBuilding = { item: '', items: 1, buff: '', enabled: false };

}(Steward));
