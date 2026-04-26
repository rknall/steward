/*
 * In-game UI shell.
 *
 * Builds a top-level "Steward" entry in the host client's native menu bar
 * (window.nativeWindow.menu, populated with air.NativeMenuItem instances).
 * Modules can attach entries via Steward.kernel.ui.menu.add({...}).
 *
 * The first item under the Steward submenu is a clickable Active/Paused
 * toggle that controls the master scheduler. Pause persists across client
 * restarts via the 'kernel' settings namespace.
 *
 * The host menu may not be available on first paint; init() retries up to
 * UI_INIT_MAX_ATTEMPTS times at UI_INIT_RETRY_MS intervals before giving up.
 */

(function (S) {

    var menuEntries = [];                  // [{ label, name, enabled, onSelect, items, type }]
    var statusText = 'Steward online';
    var statusItem = null;
    var pauseItem = null;
    var initAttempts = 0;
    var initialized = false;
    var paused = false;

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

    function pauseLabel() {
        return paused ? 'Steward: ✕ Paused' : 'Steward: ✓ Active';
    }

    function statusLabel() {
        var n = 0;
        try { n = S.kernel.registry.count(); } catch (e) { /* ignore */ }
        var moduleSuffix = n + ' module' + (n === 1 ? '' : 's');
        if (paused) return 'Paused — ' + moduleSuffix;
        return 'Active — ' + moduleSuffix;
    }

    function attachContainer() {
        // Adaptive placement (Q4 in P5_PLAN.md):
        //   - mainSettings.menuStyle === 'grouped'  → top-level next to host groups
        //   - otherwise (linear/flat layout)        → nest under the host's "Tools" submenu
        var rootMenu = window.nativeWindow.menu;
        var style = (S.kernel.host && S.kernel.host.menuStyle) ? S.kernel.host.menuStyle() : 'grouped';
        if (style === 'grouped') return { container: rootMenu, mode: 'top-level' };
        try {
            var toolsItem = rootMenu.getItemByName ? rootMenu.getItemByName('Tools') : null;
            if (toolsItem && toolsItem.submenu) {
                return { container: toolsItem.submenu, mode: 'tools' };
            }
        } catch (e) { /* fall through */ }
        // Tools submenu not found — fall back to top-level.
        return { container: rootMenu, mode: 'top-level' };
    }

    function rebuild() {
        if (!nativeMenuAvailable()) return false;
        try {
            var attach = attachContainer();
            var container = attach.container;
            removeIfPresent(container, 'StewardRoot');
            removeIfPresent(container, 'StewardStatus');
            // If mode flipped between rebuilds, also clean up the *other* container
            // so we don't leave orphan entries behind.
            if (attach.mode === 'tools') removeIfPresent(window.nativeWindow.menu, 'StewardRoot');

            var root = new air.NativeMenuItem('~Steward~');
            root.name = 'StewardRoot';

            var sub = new air.NativeMenu();

            // Pause/resume toggle (clickable, first entry).
            pauseItem = new air.NativeMenuItem(pauseLabel());
            pauseItem.name = 'StewardPause';
            pauseItem.enabled = true;
            try { pauseItem.addEventListener(air.Event.SELECT, togglePause); }
            catch (e) { S.kernel.warn('ui', 'pause toggle wiring failed:', e); }
            sub.addItem(pauseItem);

            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* separator */ }

            // Status (disabled, just text).
            statusItem = new air.NativeMenuItem(statusText || statusLabel());
            statusItem.name = 'StewardStatus';
            statusItem.enabled = false;
            sub.addItem(statusItem);
            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* separator */ }

            for (var i = 0; i < menuEntries.length; i++) {
                var native = makeNativeItem(menuEntries[i]);
                if (native) sub.addItem(native);
            }

            root.submenu = sub;
            container.addItem(root);
            S.kernel.debug('ui', 'menu rebuilt — mode:', attach.mode);
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

    function removeByName(targetName) {
        if (!targetName) return false;
        var changed = false;
        for (var i = menuEntries.length - 1; i >= 0; i--) {
            if (menuEntries[i] && menuEntries[i].name === targetName) {
                menuEntries.splice(i, 1);
                changed = true;
            }
        }
        if (changed && initialized) rebuild();
        return changed;
    }

    function replaceByName(targetName, spec) {
        removeByName(targetName);
        return add(spec);
    }

    function setStatus(text) {
        statusText = text || '';
        if (statusItem) {
            try { statusItem.label = statusText; }
            catch (e) { /* item invalidated — rebuild will pick it up next time */ }
        }
    }

    function refreshStatus() {
        try {
            setStatus(statusLabel());
            if (pauseItem) {
                try { pauseItem.label = pauseLabel(); }
                catch (e) { /* invalidated; next rebuild will fix */ }
            }
        } catch (e) { /* ignore */ }
    }

    function persistPaused() {
        try {
            var s = S.kernel.settings.read('kernel') || {};
            s.paused = paused;
            S.kernel.settings.write('kernel', s);
        } catch (e) {
            S.kernel.warn('ui', 'failed to persist paused state:', e);
        }
    }

    function applyPause() {
        try {
            if (paused) {
                if (S.kernel.scheduler && S.kernel.scheduler.stop) S.kernel.scheduler.stop();
                if (S.kernel.queue && S.kernel.queue.reset) S.kernel.queue.reset();
            } else {
                if (S.kernel.scheduler && S.kernel.scheduler.start) S.kernel.scheduler.start();
            }
        } catch (e) {
            S.kernel.error('ui', 'applyPause threw:', e);
        }
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

    S.kernel.ui = {
        init:      init,
        menu:      {
            add:           add,
            removeByName:  removeByName,
            replaceByName: replaceByName,
            rebuild:       rebuild
        },
        status:    {
            set:     setStatus,
            get:     function () { return statusText; },
            refresh: refreshStatus
        },
        // Master pause control (also surfaced in the in-menu toggle).
        pause:     function () { setPaused(true); },
        resume:    function () { setPaused(false); },
        toggle:    togglePause,
        isPaused:  isPaused,
        // Lifecycle uses this to seed initial state from settings without
        // triggering a scheduler start (which lifecycle does itself).
        seedPaused: function (value) {
            paused = value === true;
            refreshStatus();
        }
    };

    // The shell auto-installs a default status updater so the menu reflects
    // module count and pause state without anyone explicitly poking it.
    var statusUpdater = setInterval(refreshStatus, S.kernel.TIMEOUTS.STATUS_UPDATE_MS);

    S.kernel.ui.stopStatusUpdater = function () {
        if (statusUpdater) {
            clearInterval(statusUpdater);
            statusUpdater = null;
        }
    };

}(Steward));
