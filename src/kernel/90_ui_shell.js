/*
 * In-game UI shell.
 *
 * Builds a top-level "Steward" entry in the host client's native menu bar
 * (window.nativeWindow.menu, populated with air.NativeMenuItem instances).
 * Modules can attach entries via Steward.kernel.ui.menu.add({...}).
 *
 * The host menu may not be available on first paint; init() retries up to
 * UI_INIT_MAX_ATTEMPTS times at UI_INIT_RETRY_MS intervals before giving up.
 */

(function (S) {

    var menuEntries = [];                  // [{ label, name, enabled, onSelect, items, type }]
    var statusText = 'Steward online';
    var statusItem = null;
    var initAttempts = 0;
    var initialized = false;

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

    function makeNativeItem(spec) {
        if (spec.type === 'separator') {
            try { return new air.NativeMenuItem('', true); }
            catch (e) { return null; }
        }
        var item = new air.NativeMenuItem(spec.label || '');
        if (spec.name) item.name = spec.name;
        item.enabled = spec.enabled === false ? false : true;
        if (typeof spec.onSelect === 'function') {
            try {
                item.addEventListener(air.Event.SELECT, spec.onSelect);
            } catch (e) {
                S.kernel.warn('ui', 'addEventListener failed for', spec.label, ':', e);
            }
        }
        if (spec.items && spec.items.length) {
            try {
                var sub = new air.NativeMenu();
                for (var i = 0; i < spec.items.length; i++) {
                    var subItem = makeNativeItem(spec.items[i]);
                    if (subItem) sub.addItem(subItem);
                }
                item.submenu = sub;
            } catch (e) {
                S.kernel.warn('ui', 'submenu build failed for', spec.label, ':', e);
            }
        }
        return item;
    }

    function rebuild() {
        if (!nativeMenuAvailable()) return false;
        try {
            var rootMenu = window.nativeWindow.menu;
            removeIfPresent(rootMenu, 'StewardRoot');
            removeIfPresent(rootMenu, 'StewardStatus');

            var root = new air.NativeMenuItem('~Steward~');
            root.name = 'StewardRoot';

            var sub = new air.NativeMenu();

            // Status (disabled, just text).
            statusItem = new air.NativeMenuItem(statusText);
            statusItem.name = 'StewardStatus';
            statusItem.enabled = false;
            sub.addItem(statusItem);
            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* separator may not be supported */ }

            for (var i = 0; i < menuEntries.length; i++) {
                var native = makeNativeItem(menuEntries[i]);
                if (native) sub.addItem(native);
            }

            root.submenu = sub;
            rootMenu.addItem(root);
            return true;
        } catch (e) {
            S.kernel.error('ui', 'rebuild failed:', e);
            return false;
        }
    }

    function init() {
        if (initialized) {
            rebuild();
            return;
        }
        if (!nativeMenuAvailable()) {
            initAttempts++;
            if (initAttempts >= S.kernel.TIMEOUTS.UI_INIT_MAX_ATTEMPTS) {
                S.kernel.warn('ui', 'native menu unavailable after', initAttempts, 'attempts — giving up');
                return;
            }
            setTimeout(init, S.kernel.TIMEOUTS.UI_INIT_RETRY_MS);
            return;
        }
        initialized = rebuild();
        if (initialized) {
            S.kernel.log('ui', 'menu initialized with', menuEntries.length, 'entries');
        }
    }

    function add(spec) {
        if (!spec || !spec.label) {
            S.kernel.warn('ui', 'menu.add: spec missing label');
            return false;
        }
        menuEntries.push(spec);
        if (initialized) rebuild();
        return true;
    }

    function setStatus(text) {
        statusText = text || '';
        if (statusItem) {
            try { statusItem.label = statusText; }
            catch (e) { /* item invalidated — rebuild will pick it up next time */ }
        }
    }

    S.kernel.ui = {
        init:      init,
        menu:      { add: add, rebuild: rebuild },
        status:    { set: setStatus, get: function () { return statusText; } }
    };

    // The shell auto-installs a default status updater so even with zero
    // modules the menu shows "Steward online — N modules" once a tick has run.
    var statusUpdater = setInterval(function () {
        try {
            var n = S.kernel.registry.count();
            setStatus('Steward online — ' + n + ' module' + (n === 1 ? '' : 's'));
        } catch (e) { /* ignore */ }
    }, 5000);

    S.kernel.ui.stopStatusUpdater = function () {
        if (statusUpdater) {
            clearInterval(statusUpdater);
            statusUpdater = null;
        }
    };

}(Steward));
