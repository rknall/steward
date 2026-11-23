/*
 * Default settings for the economy module.
 *
 * Stored under steward.economy. Shape:
 *
 *   {
 *     enabled:         false,
 *     settingsVersion: 1,
 *     items: {
 *       <ResourceName>: true | false
 *     }
 *   }
 *
 * `enabled` is the module switch. `items` is the selection of the Economy
 * manager grid, keyed by the host's resource name: a selected item (true)
 * is moved from the star menu into the storehouse on its own, one star
 * entry at a time, until the storehouse takes no more. There is no separate
 * transfer switch, pass size or delay: the selection is the automatic
 * transfer, and the module always supplies everything it can.
 *
 * Off is always false, never a deleted key: settings writes deep-merge, so a
 * key once stored is never removed, and a deleted key would read back as
 * its last stored value.
 *
 * `settingsVersion` marks the shape above, so a later change of shape can
 * migrate stored settings once.
 */

(function (S) {

    if (!S.modules.economy) S.modules.economy = {};

    S.modules.economy.defaultSettings = {
        // Off by default: it moves star-menu items the player may want to
        // keep in the star menu.
        enabled:         false,
        settingsVersion: 1,
        items:           {}
    };

}(Steward));
