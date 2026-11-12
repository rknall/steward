/*
 * In-game UI shell.
 *
 * Three surfaces:
 *
 *   1. Native menu — pause toggle, status, "Open Dashboard…", module
 *      submenus declared via the register spec's `menu` field (read-only
 *      tools such as the event calculator), quick toggles, then
 *      "Settings…". The dashboard and the Settings modal are the
 *      configuration surfaces. Module submenus are built at init; a
 *      module may rebuild its own inner submenu on a user action, and
 *      label functions refresh in place.
 *      A module may also declare a `barMenu`: one more root item right
 *      after ~Steward~, built the same way but refreshed when it opens
 *      instead of on the status tick. An entry may stay out of the bar
 *      (its `visible` function) and be moved in and out with showBarMenu.
 *      Module and bar menu items may nest one submenu level deeper; a
 *      nested submenu is built once with its parent and refreshed with it.
 *
 *   2. Dashboard modal ("Steward") — a header with the running state and a
 *      one-line summary, a tab bar (Overview, then one tab per registry tab
 *      that has modules) and one panel. The Overview shows the automation
 *      switch and one tile per module; a module tab shows each module as a
 *      settings column beside its main column, stacked in a short window.
 *      The view lives in 92_ui_dashboard.js.
 *
 *   3. Settings modal ("Steward settings") — a side nav with one group at a
 *      time: General (logging, scheduler, about), then the `misc` modules.
 *      The view lives in 93_ui_settings.js.
 *
 *   This file owns what both screens share: the open sequence, the settings
 *   buffer and its change count, the footer (Save, a change note, Close),
 *   the host modal show and hide helpers every steward window uses, and
 *   S.kernel.ui.screen, the read surface the views use. A view is an
 *   object in S.kernel.ui.views with render() and optional chrome() and
 *   idleNote(); it is looked up when a screen opens, so this file never
 *   needs the later ones at load time. The stylesheet comes from
 *   89_ui_style.js through S.kernel.ui.ensureStyle.
 *
 * Settings buffer (explicit Save semantics):
 *   - Opening either screen starts one empty buffer; each namespace is a
 *     deep copy of its stored value on first use, next to a second copy
 *     that holds the original.
 *   - Modules render via helpers.settings(id) which proxies the buffer.
 *   - The change count compares the buffer with the original leaf by leaf,
 *     so a value set back counts as no change.
 *   - Save → writes the namespaces with changes and applies them through
 *     lifecycle.applySettings. Close → discards.
 */

(function (S) {

    // -----------------------------------------------------------------
    // State
    // -----------------------------------------------------------------

    var statusText = 'Steward online';
    var statusItem = null;
    var pauseItem = null;
    var toggleItems = {};
    var initAttempts = 0;
    var initialized = false;
    var paused = false;
    // Set once a script reload has replaced this bundle; blocks a pending
    // init retry from building a second menu for the dead instance.
    var disposed = false;

    // Last label string written per native item ('status', 'pause',
    // 'toggle:<id>'). AIR leaks native objects on every label write, so an
    // unchanged text is never rewritten. Kept in JS because NativeMenuItem is
    // sealed (no expando) and reading item.label back crosses the AIR bridge.
    var lastLabels = {};
    // The same per slot for the enabled flag of items with a live `enabled`
    // function, for the same reason.
    var lastEnabled = {};

    // Module submenus: the ~Steward~ entry item per module id, so one
    // module's inner submenu can be swapped without touching the rest, and
    // per module id the items whose label or enabled flag is a function, as
    // [{ slot, item, fn, enabledFn }], refreshed in place on the status tick.
    var moduleEntries = {};
    var moduleLabels = {};

    // Bar menus: the root entry item and the same records per module id.
    // Their records are kept apart from moduleLabels so the status tick
    // never reads or writes them.
    var BAR_PREFIX = 'StewardBarMenu_';
    var barEntries = {};
    var barLabels = {};
    var barContainer = null;   // where the entries live, for showBarMenu
    var barShown = {};         // id -> whether the entry is in the bar now

    // The one open screen. `buffer` holds the edited copies per namespace,
    // `original` what they started from (plus the shown values a view
    // declared through baseline). `saveBtn` and `$note` are the footer
    // elements, kept so the chrome can be updated without rebuilding them.
    var active = {
        modal:     null,
        view:      null,
        viewState: {},
        winH:      null,
        buffer:    {},
        original:  {},
        editing:   false,
        saveBtn:   null,
        $note:     null
    };

    // Per id a function that answers whether a window outside the screens
    // (such as the template editor) holds unsaved edits.
    var editGuards = {};

    var DASHBOARD_MODAL_ID = S.kernel.ui.DASHBOARD_MODAL_ID;

    // A second id, not the dashboard's: the host's create() is a no-op for a
    // live id and removes a closed modal asynchronously, so one id reused
    // with another title and layout would race.
    var SETTINGS_MODAL_ID = 'StewardSettings';

    // -----------------------------------------------------------------
    // Native menu plumbing
    // -----------------------------------------------------------------

    function nativeMenuAvailable() {
        try {
            return typeof window !== 'undefined' &&
                   window.nativeWindow &&
                   window.nativeWindow.menu &&
                   typeof air !== 'undefined' &&
                   air.NativeMenuItem;
        } catch (e) { return false; }
    }

    function removeIfPresent(menu, name) {
        try {
            var existing = menu.getItemByName ? menu.getItemByName(name) : null;
            if (existing) menu.removeItem(existing);
        } catch (e) { /* ignore */ }
    }

    function pauseLabel() { return paused ? 'Steward: ✕ Paused' : 'Steward: ✓ Active'; }

    // Writes `text` to the item's label only when it differs from the last
    // string written to that slot. The cache is updated before the write so
    // an invalidated item that throws is not retried on every status tick.
    function writeLabel(slot, item, text) {
        if (!item || lastLabels[slot] === text) return;
        lastLabels[slot] = text;
        try { item.label = text; } catch (e) { /* invalidated */ }
    }

    // The enabled-flag twin of writeLabel.
    function writeEnabled(slot, item, on) {
        if (!item || lastEnabled[slot] === on) return;
        lastEnabled[slot] = on;
        try { item.enabled = on; } catch (e) { /* invalidated */ }
    }

    // Quick-toggle label, or null when the module has no `enabled` flag (no
    // toggle entry exists for it). Shared by the build and the in-place refresh.
    function toggleLabel(mod) {
        if (!hasEnabledFlag(mod.id)) return null;
        return (isModuleEnabled(mod.id) ? '✓ ' : '✕ ') + mod.ui.section.title;
    }

    // A queue held this long by a visible dialog usually means a dialog the
    // user cannot see (the game layer may cover it), so the status says so;
    // the regular status refresh keeps the minutes current.
    function heldSuffix() {
        try {
            var q = S.kernel.queue;
            if (!q || typeof q.deferral !== 'function') return '';
            var d = q.deferral();
            if (!d || typeof d.ms !== 'number') return '';
            if (d.ms < S.kernel.TIMEOUTS.QUEUE_MODAL_STALE_MS) return '';
            return ' — queue held ' + Math.floor(d.ms / 60000) + ' min';
        } catch (e) {
            return '';
        }
    }

    function statusLabel() {
        var n = 0;
        try { n = S.kernel.registry.count(); } catch (e) { /* ignore */ }
        return (paused ? 'Paused' : 'Active') + ' — ' + n + ' module' + (n === 1 ? '' : 's')
            + heldSuffix();
    }

    // Adaptive placement: the host's `mainSettings.menuStyle` decides whether
    // we land at the menu-bar root ("grouped") or nested in Tools (anything
    // else). See HOST_INTEGRATION.md.
    function attachContainer() {
        var rootMenu = window.nativeWindow.menu;
        var style = (S.kernel.host && S.kernel.host.menuStyle) ? S.kernel.host.menuStyle() : 'grouped';
        if (style === 'grouped') return { container: rootMenu, mode: 'top-level' };
        try {
            var toolsItem = rootMenu.getItemByName ? rootMenu.getItemByName('Tools') : null;
            if (toolsItem && toolsItem.submenu) {
                return { container: toolsItem.submenu, mode: 'tools' };
            }
        } catch (e) { /* fall through */ }
        return { container: rootMenu, mode: 'top-level' };
    }

    function rebuildNativeMenu() {
        if (!nativeMenuAvailable()) return false;
        try {
            // Fresh items carry their constructor labels; the cache restarts
            // from those so the next tick does not rewrite identical text.
            lastLabels = {};
            lastEnabled = {};
            moduleEntries = {};
            moduleLabels = {};
            barEntries = {};
            barLabels = {};
            barShown = {};
            var attach = attachContainer();
            var container = attach.container;
            removeIfPresent(container, 'StewardRoot');
            removeBarMenus(container);
            // If mode flipped between rebuilds, also clean the *other* container
            // so we don't leave orphan entries behind.
            if (attach.mode === 'tools') {
                removeIfPresent(window.nativeWindow.menu, 'StewardRoot');
                removeBarMenus(window.nativeWindow.menu);
            }

            var root = new air.NativeMenuItem('~Steward~');
            root.name = 'StewardRoot';
            var sub = new air.NativeMenu();

            var pLabel = pauseLabel();
            pauseItem = new air.NativeMenuItem(pLabel);
            lastLabels.pause = pLabel;
            pauseItem.name = 'StewardPause';
            pauseItem.enabled = true;
            try { pauseItem.addEventListener(air.Event.SELECT, togglePause); }
            catch (e) { /* ignore */ }
            sub.addItem(pauseItem);

            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* sep */ }

            var sLabel = statusText || statusLabel();
            statusItem = new air.NativeMenuItem(sLabel);
            lastLabels.status = sLabel;
            statusItem.name = 'StewardStatus';
            statusItem.enabled = false;
            sub.addItem(statusItem);

            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* sep */ }

            var openItem = new air.NativeMenuItem('Open Dashboard…');
            openItem.name = 'StewardOpenDashboard';
            openItem.enabled = true;
            try { openItem.addEventListener(air.Event.SELECT, function () { openDashboard(); }); }
            catch (e) { /* ignore */ }
            sub.addItem(openItem);

            appendModuleMenus(sub);

            // Per-module quick-toggles. Each enabled-aware module surfaces a
            // single entry showing its current state — clicking flips
            // settings.<id>.enabled and updates the entry's label. autoTSO has the
            // equivalent under "Start/Stop X Auto".
            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* sep */ }
            toggleItems = {};
            appendModuleQuickToggles(sub);

            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* sep */ }

            var settingsItem = new air.NativeMenuItem('Settings…');
            settingsItem.name = 'StewardOpenSettings';
            settingsItem.enabled = true;
            try { settingsItem.addEventListener(air.Event.SELECT, function () { openSettings(); }); }
            catch (e) { /* ignore */ }
            sub.addItem(settingsItem);

            root.submenu = sub;
            container.addItem(root);
            appendBarMenus(container);
            S.kernel.debug('ui', 'menu rebuilt — mode:', attach.mode);
            return true;
        } catch (e) {
            S.kernel.error('ui', 'rebuildNativeMenu failed:', e);
            return false;
        }
    }

    // Rebuilding the native menu leaks native menus in AIR, so after init
    // only the labels of the existing items change, and only when the text
    // differs (unchanged labels are skipped). Also re-syncs labels after an
    // `enabled` flip made outside the menu (dashboard Save, console write).
    function refreshToggleLabels() {
        if (!initialized) return;
        try {
            var mods = S.kernel.registry.withUi();
            for (var i = 0; i < mods.length; i++) {
                var item = toggleItems[mods[i].id];
                if (!item) continue;
                var label = toggleLabel(mods[i]);
                if (label === null) continue;
                writeLabel('toggle:' + mods[i].id, item, label);
            }
        } catch (e) {
            S.kernel.error('ui', 'refreshToggleLabels threw:', e);
        }
    }

    // Surface a quick-toggle for every dashboard-aware module that has an
    // `enabled` settings flag. Click the entry to flip it without opening
    // the modal. Mirrors autoTSO's "Start/Stop X Auto" entries. Modules
    // that don't expose `enabled` (e.g. diagnostics — read-only probes)
    // are skipped automatically.
    function appendModuleQuickToggles(sub) {
        try {
            var mods = S.kernel.registry.withUi();
            for (var i = 0; i < mods.length; i++) {
                appendOneToggle(sub, mods[i]);
            }
        } catch (e) {
            S.kernel.error('ui', 'appendModuleQuickToggles threw:', e);
        }
    }

    // One submenu per module that declares a `menu` in its register spec,
    // built at init. An actionable item stays enabled (the module reports
    // "nothing to show" itself) unless its `enabled` is a function; after
    // init only label and enabled functions change, in place, unless the
    // module rebuilds its own submenu on a user action.
    function appendModuleMenus(sub) {
        try {
            if (!S.kernel.registry || typeof S.kernel.registry.withMenu !== 'function') return;
            var mods = S.kernel.registry.withMenu();
            for (var i = 0; i < mods.length; i++) {
                appendOneModuleMenu(sub, mods[i]);
            }
        } catch (e) {
            S.kernel.error('ui', 'appendModuleMenus threw:', e);
        }
    }

    function appendOneModuleMenu(sub, mod) {
        var entry = new air.NativeMenuItem(mod.menu.title);
        entry.name = 'StewardModuleMenu_' + mod.id;
        entry.submenu = buildModuleInner(mod, mod.menu, mod.id, moduleLabels);
        moduleEntries[mod.id] = entry;
        sub.addItem(entry);
    }

    function barModules() {
        if (!S.kernel.registry || typeof S.kernel.registry.withBarMenu !== 'function') return [];
        return S.kernel.registry.withBarMenu();
    }

    function removeBarMenus(menu) {
        var mods = barModules();
        for (var i = 0; i < mods.length; i++) {
            removeIfPresent(menu, BAR_PREFIX + mods[i].id);
        }
    }

    // One root item per module that declares a `barMenu`, after ~Steward~.
    // Each is guarded on its own: a bad bar menu must never fail the
    // ~Steward~ build, which has already been added at this point.
    function appendBarMenus(container) {
        barContainer = container;
        var mods = barModules();
        for (var i = 0; i < mods.length; i++) {
            try {
                var entry = new air.NativeMenuItem(mods[i].barMenu.title);
                entry.name = BAR_PREFIX + mods[i].id;
                entry.submenu = buildBarInner(mods[i]);
                barEntries[mods[i].id] = entry;
                if (barVisible(mods[i])) {
                    container.addItem(entry);
                    barShown[mods[i].id] = true;
                } else {
                    barShown[mods[i].id] = false;
                }
            } catch (e) {
                S.kernel.error('ui', mods[i].id, 'bar menu failed:', e);
            }
        }
    }

    // A module without a `visible` function is always in the bar. A throwing
    // one counts as shown so its controls stay reachable.
    function barVisible(mod) {
        if (!mod.barMenu.visible) return true;
        try {
            return mod.barMenu.visible() === true;
        } catch (e) {
            S.kernel.error('ui', mod.id, 'bar menu visible failed:', e);
            return true;
        }
    }

    // Puts an entry right after ~Steward~ so the bar order stays the same
    // however often it is hidden and shown. Falls back to the end of the bar
    // when this host lacks the positional calls.
    function placeBarEntry(entry) {
        var root = barContainer.getItemByName ? barContainer.getItemByName('StewardRoot') : null;
        if (root && barContainer.addItemAt && barContainer.getItemIndex) {
            try {
                barContainer.addItemAt(entry, barContainer.getItemIndex(root) + 1);
                return;
            } catch (e) {
                S.kernel.warn('ui', 'bar menu addItemAt failed, appending:', e);
            }
        } else {
            S.kernel.warn('ui', 'bar menu position unavailable, appending');
        }
        barContainer.addItem(entry);
    }

    // Moves a built entry in or out of the bar. Moving creates no native
    // object, unlike a rebuild, so this may run from plan(). True only when
    // it moved the item.
    function showBarMenu(id, on) {
        if (!initialized || disposed || !barContainer) return false;
        var entry = barEntries[id];
        if (!entry) return false;
        var want = on === true;
        if (barShown[id] === want) return false;
        try {
            if (want) placeBarEntry(entry);
            else barContainer.removeItem(entry);
            barShown[id] = want;
            return true;
        } catch (e) {
            S.kernel.error('ui', id, 'bar menu show failed:', e);
            return false;
        }
    }

    function buildBarInner(mod) {
        var inner = buildModuleInner(mod, mod.barMenu, mod.id + '#bar', barLabels);
        addOpenRefresh(mod, inner);
        return inner;
    }

    // Refreshes a bar menu's records when it opens. Neither open event is
    // proven to fire in this host, so both are registered; the second pass
    // writes nothing because writes happen only on change. A host without
    // either keeps the state of the last build. An open menu shows the state
    // at opening, which is safe because every command guards itself.
    function addOpenRefresh(mod, inner) {
        function onOpen() {
            if (disposed) return;
            try {
                var current = S.kernel.registry.get(mod.id);
                var recs = barLabels[mod.id];
                if (current && recs) refreshRecords(current, recs);
            } catch (e) {
                S.kernel.error('ui', mod.id, 'bar menu refresh threw:', e);
            }
        }
        var types = [air.Event.PREPARING, air.Event.DISPLAYING];
        for (var i = 0; i < types.length; i++) {
            if (typeof types[i] === 'undefined') continue;
            try { inner.addEventListener(types[i], onOpen); }
            catch (e) { /* ignore */ }
        }
    }

    // The menu's item list: a static array was normalised at register
    // time; an `items` function is evaluated now and its result goes
    // through the same registry normalisation.
    function moduleMenuItems(mod, menu) {
        var items = menu.items;
        if (typeof items !== 'function') return items;
        var raw;
        try { raw = items(); }
        catch (e) {
            S.kernel.error('ui', mod.id, 'menu items threw:', e);
            raw = [];
        }
        return S.kernel.registry.menuItems(mod.id, raw);
    }

    // Text of a label function. A throwing one must not break the menu
    // build or the status tick, so it yields an empty label.
    function labelText(mod, fn, pass) {
        try { return String(fn(pass)); }
        catch (e) {
            S.kernel.error('ui', mod.id, 'menu label threw:', e);
            return '';
        }
    }

    // Value of an enabled function. A throwing one must not break the menu
    // build or a refresh; the item goes disabled, the safe side for a control.
    function enabledValue(mod, fn, pass) {
        try { return fn(pass) === true; }
        catch (e) {
            S.kernel.error('ui', mod.id, 'menu enabled threw:', e);
            return false;
        }
    }

    function addModuleSelect(mod, item, onSelect) {
        try {
            item.addEventListener(air.Event.SELECT, function () {
                try { onSelect(); }
                catch (e) { S.kernel.error('ui', mod.id, 'menu item threw:', e); }
            });
        } catch (e) { /* ignore */ }
    }

    function dropSlots(cache, prefix) {
        var stale = [];
        var slot;
        for (slot in cache) {
            if (cache.hasOwnProperty(slot) && slot.indexOf(prefix) === 0) stale.push(slot);
        }
        for (var n = 0; n < stale.length; n++) delete cache[stale[n]];
    }

    // Adds the normalised `items` to `inner`, naming each slot `prefix + k`.
    // A submenu item gets its own NativeMenu filled the same way under the
    // slot prefix `prefix + k + '.'`, so its slots stay unique and fall under
    // the menu prefix that a rebuild drops. Records of every level go to the
    // one `records` list and share the one `pass`, so the refresh that covers
    // the top menu covers the nested items too and no nested menu needs its
    // own open listener.
    function fillInner(mod, items, prefix, inner, records, pass) {
        for (var k = 0; k < items.length; k++) {
            var spec = items[k];
            if (spec.separator) {
                try { inner.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* sep */ }
                continue;
            }
            var isFn = typeof spec.label === 'function';
            var text = isFn ? labelText(mod, spec.label, pass) : spec.label;
            var item;
            if (Array.isArray(spec.items)) {
                // An entry must be enabled to open, and AIR does not fire
                // SELECT reliably on an item with a submenu, so it gets
                // neither an enabled function nor a select listener.
                item = new air.NativeMenuItem(text);
                item.enabled = true;
                var sub = new air.NativeMenu();
                fillInner(mod, spec.items, prefix + k + '.', sub, records, pass);
                item.submenu = sub;
                if (isFn) {
                    lastLabels[prefix + k] = text;
                    records.push({ slot: prefix + k, item: item, fn: spec.label, enabledFn: null });
                }
                inner.addItem(item);
                continue;
            }
            var liveOn = typeof spec.enabled === 'function';
            var on = liveOn ? enabledValue(mod, spec.enabled, pass) : spec.enabled !== false;
            item = new air.NativeMenuItem(text);
            item.enabled = on;
            if (spec.onSelect) addModuleSelect(mod, item, spec.onSelect);
            if (isFn) lastLabels[prefix + k] = text;
            if (liveOn) lastEnabled[prefix + k] = on;
            if (isFn || liveOn) {
                records.push({
                    slot:      prefix + k,
                    item:      item,
                    fn:        isFn ? spec.label : null,
                    enabledFn: liveOn ? spec.enabled : null
                });
            }
            inner.addItem(item);
        }
    }

    // Builds an inner NativeMenu from `menu`. `key` names its slots (the ':'
    // after it keeps a module's submenu and bar menu slots disjoint) and
    // `store` receives its records. Its slots, nested ones included, are
    // dropped from both caches first and then seeded with the constructor
    // values, so the new items are not rewritten on the next refresh and no
    // stale value from the previous items suppresses a needed write.
    function buildModuleInner(mod, menu, key, store) {
        var prefix = 'mod:' + key + ':';
        dropSlots(lastLabels, prefix);
        dropSlots(lastEnabled, prefix);

        var records = [];
        var items = moduleMenuItems(mod, menu);
        var inner = new air.NativeMenu();
        fillInner(mod, items, prefix, inner, records, {});
        store[mod.id] = records;
        return inner;
    }

    // Rebuilds a submenu when its item set changed and assigns it to the
    // existing entry. Each rebuild leaks native objects in AIR, so modules
    // call this on a user action only, never on a timer.
    function swapSubmenu(what, id, entry, build) {
        try {
            entry.submenu = build();
            S.kernel.debug('ui', what, 'rebuilt:', id);
            return true;
        } catch (e) {
            S.kernel.error('ui', what, 'rebuild failed:', id, e);
            return false;
        }
    }

    function refreshModuleMenu(id) {
        if (!initialized || disposed) return false;
        var mod = S.kernel.registry.get(id);
        var entry = moduleEntries[id];
        if (!mod || !mod.menu || !entry) return false;
        return swapSubmenu('module menu', id, entry, function () {
            return buildModuleInner(mod, mod.menu, mod.id, moduleLabels);
        });
    }

    function refreshBarMenu(id) {
        if (!initialized || disposed) return false;
        var mod = S.kernel.registry.get(id);
        var entry = barEntries[id];
        if (!mod || !mod.barMenu || !entry) return false;
        return swapSubmenu('bar menu', id, entry, function () {
            return buildBarInner(mod);
        });
    }

    // Re-evaluates a module's records and writes only what changed. One
    // fresh `pass` per refresh lets its functions share an expensive read.
    function refreshRecords(mod, recs) {
        var pass = {};
        for (var i = 0; i < recs.length; i++) {
            var rec = recs[i];
            if (rec.fn) writeLabel(rec.slot, rec.item, labelText(mod, rec.fn, pass));
            if (rec.enabledFn) writeEnabled(rec.slot, rec.item, enabledValue(mod, rec.enabledFn, pass));
        }
    }

    function refreshModuleLabels() {
        if (!initialized) return;
        try {
            for (var id in moduleLabels) {
                if (!moduleLabels.hasOwnProperty(id)) continue;
                var mod = S.kernel.registry.get(id);
                if (!mod) continue;
                refreshRecords(mod, moduleLabels[id]);
            }
        } catch (e) {
            S.kernel.error('ui', 'refreshModuleLabels threw:', e);
        }
    }

    function appendOneToggle(sub, mod) {
        var label = toggleLabel(mod);
        if (label === null) return;
        var item = new air.NativeMenuItem(label);
        item.name = 'StewardModuleToggle_' + mod.id;
        item.enabled = true;
        try {
            item.addEventListener(air.Event.SELECT, function () {
                toggleModuleEnabled(mod.id);
            });
        } catch (e) { /* ignore */ }
        toggleItems[mod.id] = item;
        lastLabels['toggle:' + mod.id] = label;
        sub.addItem(item);
    }

    function toggleModuleEnabled(moduleId) {
        try {
            var s = S.kernel.settings.read(moduleId) || {};
            s.enabled = !s.enabled;
            S.kernel.settings.write(moduleId, s);
            S.kernel.log('ui', 'quick-toggle', moduleId, '→', s.enabled);
            // Cancel pending queue work the moment the user disables a module —
            // matches the buffered-Save flow's behaviour for the same flip.
            if (!s.enabled && S.kernel.queue && S.kernel.queue.cancelByModule) {
                S.kernel.queue.cancelByModule(moduleId);
            }
            refreshToggleLabels();
        } catch (e) {
            S.kernel.error('ui', 'toggleModuleEnabled threw:', e);
        }
    }

    function init() {
        if (disposed) return;
        if (initialized) { rebuildNativeMenu(); return; }
        if (!nativeMenuAvailable()) {
            initAttempts++;
            if (initAttempts >= S.kernel.TIMEOUTS.UI_INIT_MAX_ATTEMPTS) {
                S.kernel.warn('ui', 'native menu unavailable after', initAttempts, 'attempts — giving up');
                return;
            }
            setTimeout(init, S.kernel.TIMEOUTS.UI_INIT_RETRY_MS);
            return;
        }
        initialized = rebuildNativeMenu();
        if (initialized) S.kernel.log('ui', 'menu initialized');
    }

    // -----------------------------------------------------------------
    // Pause control
    // -----------------------------------------------------------------

    function persistPaused() {
        try {
            var s = S.kernel.settings.read('kernel') || {};
            s.paused = paused;
            S.kernel.settings.write('kernel', s);
        } catch (e) { S.kernel.warn('ui', 'failed to persist paused state:', e); }
    }

    function applyPause() {
        try {
            if (paused) {
                if (S.kernel.scheduler && S.kernel.scheduler.stop) S.kernel.scheduler.stop();
                if (S.kernel.queue && S.kernel.queue.reset) S.kernel.queue.reset();
            } else {
                if (S.kernel.scheduler && S.kernel.scheduler.start) S.kernel.scheduler.start();
            }
        } catch (e) { S.kernel.error('ui', 'applyPause threw:', e); }
    }

    function setPaused(value, opts) {
        var next = value === true;
        if (next === paused) return;
        paused = next;
        opts = opts || {};
        S.kernel.log('ui', paused ? 'paused' : 'resumed');
        applyPause();
        if (opts.persist !== false) persistPaused();
        refreshStatus();
    }

    function togglePause() { setPaused(!paused); }
    function isPaused() { return paused; }

    function setStatus(text) {
        statusText = text || '';
        writeLabel('status', statusItem, statusText);
    }

    function refreshStatus() {
        try {
            setStatus(statusLabel());
            writeLabel('pause', pauseItem, pauseLabel());
            refreshToggleLabels();
            refreshModuleLabels();
        } catch (e) { /* ignore */ }
    }

    function isModuleEnabled(moduleId) {
        var s = S.kernel.settings.read(moduleId);
        return !!(s && s.enabled);
    }

    // Whether the stored settings carry an `enabled` key: only such a module
    // gets a quick toggle, an enabled switch and an on/off state.
    function hasEnabledFlag(moduleId) {
        var s = S.kernel.settings.read(moduleId);
        return !!s && typeof s.enabled !== 'undefined';
    }

    // Surface a transient message to the user via the host's alert system.
    // Best-effort — silently no-ops if the host isn't ready (e.g., very
    // early boot).
    function notify(text) {
        try {
            if (typeof showGameAlert === 'function') {
                showGameAlert('Steward: ' + text);
            }
        } catch (e) { /* best effort */ }
    }

    // -----------------------------------------------------------------
    // Settings buffer and change counting
    // -----------------------------------------------------------------

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' &&
               Object.prototype.toString.call(v) === '[object Object]';
    }

    // Settings are JSON in storage, so a JSON round trip is a full copy.
    function deepCopy(v) {
        if (v === null || typeof v !== 'object') return v;
        return JSON.parse(JSON.stringify(v));
    }

    function hasOwn(o, k) {
        return Object.prototype.hasOwnProperty.call(o, k);
    }

    function bufferedSettings(ns) {
        if (!hasOwn(active.buffer, ns)) {
            var stored = S.kernel.settings.read(ns);
            var snap = isPlainObject(stored) ? deepCopy(stored) : {};
            active.buffer[ns] = snap;
            active.original[ns] = deepCopy(snap);
        }
        return active.buffer[ns];
    }

    // Adds to `target` every path of `shown` it lacks; existing values are
    // never overwritten.
    function fillMissing(target, shown) {
        for (var k in shown) {
            if (!hasOwn(shown, k)) continue;
            if (!hasOwn(target, k)) {
                target[k] = deepCopy(shown[k]);
            } else if (isPlainObject(target[k]) && isPlainObject(shown[k])) {
                fillMissing(target[k], shown[k]);
            }
        }
    }

    // Records the values a view shows for paths the stored value lacks
    // (defaults merged in by a module, the logger's effective config), so an
    // edit back to the shown value counts as no change. The buffer itself is
    // not touched: Save still writes only what was edited.
    function baseline(ns, shown) {
        bufferedSettings(ns);
        if (isPlainObject(shown)) fillMissing(active.original[ns], shown);
    }

    function leafDiffers(b, o) {
        if (b === o) return false;
        if ((b !== null && typeof b === 'object') || (o !== null && typeof o === 'object')) {
            try { return JSON.stringify(b) !== JSON.stringify(o); } catch (e) { return true; }
        }
        return true;
    }

    // Leaves of `buf` that differ from the same path in `orig`. Only the
    // buffer's leaves are walked: a path never edited is never a change.
    function countDiff(buf, orig) {
        var n = 0;
        for (var k in buf) {
            if (!hasOwn(buf, k)) continue;
            var o = (isPlainObject(orig) && hasOwn(orig, k)) ? orig[k] : undefined;
            if (isPlainObject(buf[k])) n += countDiff(buf[k], isPlainObject(o) ? o : {});
            else if (leafDiffers(buf[k], o)) n++;
        }
        return n;
    }

    // The name a namespace has on screen: the kernel ones are fixed, a
    // module uses its section heading.
    function nsName(ns) {
        if (ns === 'logger') return 'Logging';
        if (ns === 'scheduler') return 'Scheduler';
        var mod = null;
        try { mod = S.kernel.registry.get(ns); } catch (e) { mod = null; }
        if (mod && mod.ui && mod.ui.section) {
            return mod.ui.section.heading || mod.ui.section.title || ns;
        }
        return ns;
    }

    function changes() {
        var out = { count: 0, names: [], byNs: {} };
        for (var ns in active.buffer) {
            if (!hasOwn(active.buffer, ns)) continue;
            var n = countDiff(active.buffer[ns], active.original[ns]);
            if (n > 0) {
                out.byNs[ns] = n;
                out.count += n;
                out.names.push(nsName(ns));
            }
        }
        return out;
    }

    function walkPath(root, parts) {
        var v = root;
        for (var i = 0; i < parts.length; i++) {
            if (!isPlainObject(v) || !hasOwn(v, parts[i])) return undefined;
            v = v[parts[i]];
        }
        return v;
    }

    // Whether the buffered value at a dotted path differs from the original.
    function isChanged(ns, path) {
        if (!hasOwn(active.buffer, ns)) return false;
        var parts = String(path).split('.');
        var b = walkPath(active.buffer[ns], parts);
        if (typeof b === 'undefined') return false;
        var o = walkPath(active.original[ns], parts);
        if (isPlainObject(b)) return countDiff(b, isPlainObject(o) ? o : {}) > 0;
        return leafDiffers(b, o);
    }

    function hasDirty() {
        return changes().count > 0;
    }

    // Typing alone enables Save: a bound input commits on blur, and a disabled
    // button would swallow the very click whose blur commits the value.
    function canSave() {
        return hasDirty() || active.editing === true;
    }

    function markDirty() {
        refreshChrome();
    }

    // An input is being typed into but has not committed yet; the flag only
    // enables Save so the committing click reaches it, it never counts as a
    // change.
    function markEditing() {
        active.editing = true;
        refreshChrome();
    }

    function resetBuffer() {
        active.buffer = {};
        active.original = {};
        active.editing = false;
    }

    function flushBuffers() {
        var byNs = changes().byNs;
        for (var ns in active.buffer) {
            if (!hasOwn(active.buffer, ns) || !(byNs[ns] > 0)) continue;
            try {
                S.kernel.settings.write(ns, active.buffer[ns]);
                S.kernel.log('ui', 'saved settings for', ns);
                var apply = S.kernel.lifecycle.applySettings[ns];
                if (typeof apply === 'function') apply();
            } catch (e) {
                S.kernel.error('ui', 'failed to save', ns, ':', e);
            }
        }
    }

    // -----------------------------------------------------------------
    // Edit guards
    // -----------------------------------------------------------------

    // A second call with the same id replaces the guard; a non-function
    // removes it.
    function addEditGuard(id, fn) {
        if (typeof fn === 'function') editGuards[id] = fn;
        else delete editGuards[id];
    }

    // The native menu stays clickable behind a modal, and opening a screen
    // drops the buffer. A window counts while it is shown: one closed by the
    // header X, a zone load or Close (fading included) holds nothing to lose,
    // and the first two skip closeDashboard and leave stale changes behind.
    // A guard that throws counts as no edits, so a broken window never locks
    // the screens.
    function hasOpenEdits() {
        if (hasDirty() && active.modal && isModalShown(active.modal)) return true;
        for (var id in editGuards) {
            if (!hasOwn(editGuards, id)) continue;
            try {
                if (editGuards[id]()) return true;
            } catch (e) {
                S.kernel.error('ui', 'edit guard threw for', id, ':', e);
            }
        }
        return false;
    }

    // -----------------------------------------------------------------
    // Screen lifecycle
    // -----------------------------------------------------------------

    // The window height read once per open. The test rig and an early boot
    // may have no window or a $ without height(); any failure means unknown,
    // which is treated as a full-size window.
    function measureWindowHeight() {
        try {
            if (typeof window === 'undefined' || typeof $ !== 'function') return null;
            var $w = $(window);
            if (!$w || typeof $w.height !== 'function') return null;
            var n = $w.height();
            return (typeof n === 'number' && isFinite(n) && n > 0) ? n : null;
        } catch (e) {
            return null;
        }
    }

    function compact() {
        var layout = S.kernel.ui.layout;
        if (typeof active.winH !== 'number' || !layout) return false;
        return typeof layout.compactMaxHeight === 'number' && active.winH <= layout.compactMaxHeight;
    }

    // Panel height for a short window, or null when the stylesheet's height
    // applies. `kind` is 'dashboard' or 'settings'.
    function panelHeight(kind) {
        if (!compact()) return null;
        var layout = S.kernel.ui.layout;
        var chrome = layout.chrome ? layout.chrome[kind] : undefined;
        if (typeof chrome !== 'number') return null;
        return Math.max(layout.minPanel, active.winH - chrome);
    }

    // The one open sequence: the refusal and the buffer reset live here so a
    // second screen cannot drift from the first.
    function openScreen(modalId, title, label, viewName, viewState) {
        if (typeof Modal === 'undefined') {
            S.kernel.error('ui', 'host Modal class unavailable — cannot open ' + label.toLowerCase());
            return;
        }
        if (hasOpenEdits()) { notify('Save or close the open window first'); return; }
        if (typeof S.kernel.ui.ensureStyle === 'function') S.kernel.ui.ensureStyle(modalId);
        resetBuffer();
        active.saveBtn = null;
        active.$note = null;
        active.viewState = viewState || {};
        active.winH = measureWindowHeight();
        active.view = (S.kernel.ui.views && S.kernel.ui.views[viewName]) || null;
        if (!active.view || typeof active.view.render !== 'function') {
            active.view = null;
            S.kernel.error('ui', 'no ' + viewName + ' view — cannot open ' + label.toLowerCase());
            return;
        }
        try {
            active.modal = new Modal(modalId, title, true);
            active.modal.create();
            active.view.render();
            renderFooter();
            showModal(active.modal);
        } catch (e) {
            S.kernel.error('ui', 'open' + label + ' threw:', e);
        }
    }

    // The view picks its own default tab or group for a null one.
    function openDashboard(tab) {
        openScreen(DASHBOARD_MODAL_ID, 'Steward', 'Dashboard', 'dashboard', { tab: tab || null });
    }

    function openSettings(group) {
        openScreen(SETTINGS_MODAL_ID, 'Steward settings', 'Settings', 'settings', { group: group || null });
    }

    // Saves or discards the buffer and drops the footer handles; the modal
    // itself is left to the caller.
    function settleBuffer(commit) {
        if (hasDirty()) {
            if (commit) {
                flushBuffers();
                notify('Configuration saved');
            } else {
                notify('Changes discarded');
            }
        }
        resetBuffer();
        active.saveBtn = null;
        active.$note = null;
    }

    function closeDashboard(commit) {
        settleBuffer(commit);
        var m = active.modal;
        active.modal = null;
        hideModal(m);
    }

    // For a window that replaces the dashboard: the buffer is discarded so the
    // next open re-reads settings, but the modal is not hidden. The host's
    // show of the next window hides the dashboard itself; a hide here would be
    // a second hide event during the fade.
    function releaseDashboard() {
        settleBuffer(false);
        active.modal = null;
    }

    // -----------------------------------------------------------------
    // Host modals
    // -----------------------------------------------------------------

    // Every host show or hide event swaps the game and HTML stage layers.
    // Bootstrap 3 fires the event before it checks whether the modal is
    // shown, so a hide on a modal that is already hiding still swaps. A
    // fading modal stays :visible, so the host's Modal.show would hide it a
    // second time. An even count leaves the HTML layer behind the game until
    // the client restarts. Steward therefore hides only a modal that is really
    // shown, and settles fading dialogs before it shows another one. Nothing
    // here depends on the fade duration.

    // Bootstrap's constructor sets isShown to null, so only true counts.
    // Without a Bootstrap instance, class 'in' marks a shown modal: Bootstrap
    // removes it at hide, before the fade.
    function elementShown($el) {
        try {
            if (!$el || !$el.length) return false;
            var bs = $el.data('bs.modal');
            if (bs) return bs.isShown === true;
            return $el.is(':visible') && $el.hasClass('in');
        } catch (e) {
            return false;
        }
    }

    function isModalShown(modal) {
        try {
            if (typeof $ === 'undefined') return false;
            if (!modal || typeof modal.id !== 'string') return false;
            return elementShown($(modal.id));
        } catch (e) {
            return false;
        }
    }

    // The hide itself is logged by the watcher bound in showModal, which also
    // sees the hides the host starts.
    function hideModal(modal) {
        try {
            if (!isModalShown(modal)) {
                S.kernel.debug('ui', 'hide skipped, not shown: ' + modalRawId(modal));
                return false;
            }
            modal.hide();
            return true;
        } catch (e) {
            return false;
        }
    }

    // Hidden elements no longer match the host's ':visible' selector, so its
    // show does not hide them again. Bootstrap's own end-of-fade handler still
    // runs on them, so the host still removes them. The modal being shown is
    // skipped: hiding it would let its pending end-of-fade handler remove it.
    // Returns how many dialogs it settled.
    function settleFading(keepRawId) {
        var n = 0;
        try {
            if (typeof $ === 'undefined') return 0;
            $(S.kernel.HOST_DIALOG_SELECTOR).each(function (i, el) {
                var $el = $(el);
                if (keepRawId && $el.attr('id') === keepRawId) return;
                if (!$el.is(':visible')) return;
                if (elementShown($el)) return;
                $el.css('display', 'none');
                n++;
            });
        } catch (e) { /* the show goes ahead regardless */ }
        return n;
    }

    function modalRawId(modal) {
        if (!modal) return '?';
        if (typeof modal.rawId === 'string') return modal.rawId;
        return typeof modal.id === 'string' ? modal.id.replace(/^#/, '') : '?';
    }

    // One hide.bs.modal watcher per element logs every hide of a steward
    // window, the host's header X and its own Modal.show included, since all
    // of them go through that event. Bootstrap fires it before it checks
    // isShown, so the handler still sees the state before the hide: a hide
    // while not shown is the second stage swap that leaves the game layer on
    // top. The data flag keeps it to one handler, because the host creates a
    // new element on each open of a closable modal while a persistent element
    // keeps its flag; so there is no namespace and no off(). It only reads.
    function watchHides(modal, rawId) {
        try {
            if (typeof $ === 'undefined' || typeof modal.id !== 'string') return;
            var $el = $(modal.id);
            if (!$el.length || $el.data('stewardHideWatch')) return;
            $el.data('stewardHideWatch', true);
            $el.on('hide.bs.modal', function () {
                try {
                    if (elementShown($el)) {
                        S.kernel.log('ui', 'window hidden: ' + rawId);
                    } else {
                        S.kernel.warn('ui', 'second hide of ' + rawId + ' while it closes: the game may '
                            + 'now cover steward windows; restart the client if the game stops reacting');
                    }
                } catch (e) { /* the hide goes ahead regardless */ }
            });
        } catch (e) { /* a missing watcher only costs the log line */ }
    }

    function showModal(modal) {
        if (!modal || typeof modal.show !== 'function') return false;
        var keep = modalRawId(modal);
        var settled = settleFading(keep);
        if (settled > 0) {
            S.kernel.debug('ui', 'settled ' + settled + ' closing dialog(s) before showing ' + keep);
        }
        try {
            modal.show();
        } catch (e) {
            S.kernel.error('ui', 'modal show threw:', e);
            return false;
        }
        watchHides(modal, keep);
        try {
            if (isModalShown(modal)) S.kernel.log('ui', 'window shown: ' + keep);
            else S.kernel.log('ui', 'window show had no effect: ' + keep + ' (still closing)');
        } catch (e) { /* the window is open either way */ }
        return true;
    }

    // -----------------------------------------------------------------
    // Footer and chrome
    // -----------------------------------------------------------------

    // Built once per open. A Save click first blurs an input whose change
    // event commits and refreshes the chrome; a footer rebuilt at that moment
    // would swallow the click, so later updates only change the elements.
    function renderFooter() {
        var $footer = active.modal.Footer ? active.modal.Footer() : null;
        if (!$footer || !$footer.length) return;
        var h = S.kernel.ui.helpers;
        $footer.empty();
        active.saveBtn = h.button('Save', { onClick: function () { closeDashboard(true); } });
        active.$note = $('<span>');
        var $closeBtn = h.button('Close', { onClick: function () { closeDashboard(false); } });
        $closeBtn.addClass('steward-foot-right');
        $footer.append(active.saveBtn).append(active.$note).append($closeBtn);
        updateFooter();
    }

    function idleNote() {
        var view = active.view;
        if (view && typeof view.idleNote === 'function') {
            var text = null;
            try { text = view.idleNote(); } catch (e) {
                S.kernel.error('ui', 'idleNote threw:', e);
            }
            if (typeof text === 'string') return text;
        }
        return 'No changes. Settings apply when you press Save.';
    }

    function updateFooter() {
        if (!active.saveBtn || !active.$note) return;
        var c = changes();
        active.saveBtn.prop('disabled', !(c.count > 0 || active.editing === true));
        if (c.count > 0) {
            active.saveBtn.addClass('steward-primary');
            active.$note.removeClass('steward-foot-note').addClass('steward-foot-dirty')
                .text(c.count + ' unsaved change' + (c.count === 1 ? '' : 's') + ' · ' + c.names.join(', '));
        } else {
            active.saveBtn.removeClass('steward-primary');
            active.$note.removeClass('steward-foot-dirty').addClass('steward-foot-note')
                .text(idleNote());
        }
    }

    function refreshChrome() {
        updateFooter();
        var view = active.view;
        if (active.modal && view && typeof view.chrome === 'function') {
            try { view.chrome(); } catch (e) {
                S.kernel.error('ui', 'chrome threw:', e);
            }
        }
    }

    // What the views read; everything else on the screen goes through the
    // helpers.
    var screenApi = {
        modal:           function () { return active.modal; },
        state:           function () { return active.viewState; },
        refreshChrome:   refreshChrome,
        changes:         changes,
        isChanged:       isChanged,
        baseline:        baseline,
        nsName:          nsName,
        compact:         compact,
        panelHeight:     panelHeight,
        isModuleEnabled: isModuleEnabled,
        hasEnabledFlag:  hasEnabledFlag,
        buildLabel:      S.kernel.buildLabel
    };

    // -----------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------

    if (!S.kernel.ui) S.kernel.ui = {};
    S.kernel.ui.init             = init;
    S.kernel.ui.status           = {
        set:     setStatus,
        get:     function () { return statusText; },
        refresh: refreshStatus
    };
    S.kernel.ui.pause            = function () { setPaused(true); };
    S.kernel.ui.resume           = function () { setPaused(false); };
    S.kernel.ui.toggle           = togglePause;
    S.kernel.ui.isPaused         = isPaused;
    S.kernel.ui.refreshModuleMenu = refreshModuleMenu;
    S.kernel.ui.refreshBarMenu   = refreshBarMenu;
    S.kernel.ui.showBarMenu      = showBarMenu;
    S.kernel.ui.notify           = notify;
    S.kernel.ui.seedPaused       = function (v) { paused = v === true; refreshStatus(); };

    S.kernel.ui.openDashboard    = openDashboard;
    S.kernel.ui.openSettings     = openSettings;
    S.kernel.ui.closeDashboard   = closeDashboard;
    S.kernel.ui.releaseDashboard = releaseDashboard;
    S.kernel.ui.isModalShown     = isModalShown;
    S.kernel.ui.hideModal        = hideModal;
    S.kernel.ui.showModal        = showModal;
    S.kernel.ui.bufferedSettings = bufferedSettings;
    S.kernel.ui.markDirty        = markDirty;
    S.kernel.ui.markEditing      = markEditing;
    S.kernel.ui.canSave          = canSave;
    S.kernel.ui.hasOpenEdits     = hasOpenEdits;
    S.kernel.ui.addEditGuard     = addEditGuard;
    S.kernel.ui.screen           = screenApi;

    var statusUpdater = setInterval(refreshStatus, S.kernel.TIMEOUTS.STATUS_UPDATE_MS);

    function stopStatusUpdater() {
        if (statusUpdater) { clearInterval(statusUpdater); statusUpdater = null; }
    }

    // Called by lifecycle shutdown when a script reload replaces this bundle:
    // stops the status interval and keeps a pending init retry from building
    // a menu for this dead instance.
    function dispose() {
        disposed = true;
        stopStatusUpdater();
    }

    S.kernel.ui.stopStatusUpdater = stopStatusUpdater;
    S.kernel.ui.dispose           = dispose;

}(Steward));
