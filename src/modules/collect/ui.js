/*
 * Settings UI for the collect module.
 *
 * v0.1 keeps it minimal: a "Collect" submenu under the Steward root with three
 * toggle entries. Clicking a toggle flips the corresponding setting and
 * re-registers the menu entry so the label reflects the new state.
 *
 * A modal-based settings dialog can replace this later — `createModalWindow` /
 * `createSwitch` from the host client are documented in docs/TSO_API.md.
 */

(function (S) {

    if (!S.modules.collect) S.modules.collect = {};

    var MENU_ENTRY_NAME = 'StewardCollectMenu';

    function readSettings() {
        var s = S.kernel.settings.read('collect');
        return s || S.modules.collect.defaultSettings;
    }

    function writeSetting(key, value) {
        var s = readSettings();
        s[key] = value;
        S.kernel.settings.write('collect', s);
    }

    function toggleEntry(label, key, currentValue) {
        return {
            label:    (currentValue ? '✓ ' : '✕ ') + label,
            onSelect: function () { toggle(key); }
        };
    }

    function buildSpec() {
        var s = readSettings();
        return {
            name:  MENU_ENTRY_NAME,
            label: 'Collect',
            items: [
                toggleEntry('Enabled',    'enabled',   !!s.enabled),
                toggleEntry('Pickups',    'pickups',   !!s.pickups),
                toggleEntry('Loot boxes', 'lootBoxes', !!s.lootBoxes)
            ]
        };
    }

    function toggle(key) {
        var s = readSettings();
        s[key] = !s[key];
        S.kernel.settings.write('collect', s);
        S.kernel.log('collect', 'toggled', key, '→', s[key]);

        // If the user just disabled the master switch (or both feature flags
        // are off), drop any pending collect actions immediately. Otherwise
        // they'd keep firing for ~45 s while the queue drained.
        if (key === 'enabled' || (!s.enabled || (!s.pickups && !s.lootBoxes))) {
            if (S.kernel.queue && S.kernel.queue.cancelByModule) {
                S.kernel.queue.cancelByModule('collect');
            }
        }

        renderMenu();
    }

    function renderMenu() {
        if (!S.kernel.ui || !S.kernel.ui.menu) return;
        S.kernel.ui.menu.replaceByName(MENU_ENTRY_NAME, buildSpec());
    }

    S.modules.collect.renderMenu   = renderMenu;
    S.modules.collect.readSettings = readSettings;
    S.modules.collect.writeSetting = writeSetting;

}(Steward));
