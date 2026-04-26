/*
 * Steward settings store.
 *
 * Adapter over the host TSO client's `settings` object (defined in
 * tso_client/client/files/content/scripts/0-common.js). The host owns:
 *
 *   - the on-disk JSON file at applicationDirectory/<settingsFile>
 *     (where settingsFile is set per profile in the host's index.html so
 *     users running multiple game accounts get separate settings files).
 *   - the in-memory cache.
 *   - the dropbox sync (optional, host-driven).
 *
 * Steward stores under host modules named `'steward.<id>'`:
 *
 *   read('collect')           ↔ settings.read(null, 'steward.collect')
 *   write('collect', obj)     ↔ settings.store(obj, 'steward.collect')
 *
 * Why delegate? Three reasons:
 *   1. Per-profile separation (matches autoTSO and other userscripts).
 *   2. Free dropbox sync — modules under host settings ship with the rest.
 *   3. Single place users inspect settings, instead of two parallel files.
 */

(function (S) {

    var NS_PREFIX = 'steward.';

    function namespaced(moduleId) {
        if (!moduleId) return null;
        return NS_PREFIX + moduleId;
    }

    function hostSettings() {
        try {
            if (typeof settings !== 'undefined' && settings && typeof settings.read === 'function' &&
                typeof settings.store === 'function') {
                return settings;
            }
        } catch (e) { /* fall through */ }
        return null;
    }

    function load() {
        // Host already loaded settings during 0-common.js init. We trust it.
        // This function is kept for API parity with the previous store.
        if (!hostSettings()) {
            S.kernel.warn('settings', 'host `settings` global not present — modules will see empty data');
        }
    }

    function save() {
        // Host's settings.store already persists synchronously; nothing to do.
        return true;
    }

    function flush() {
        return true;
    }

    function read(moduleId) {
        var ns = namespaced(moduleId);
        if (!ns) return null;
        var host = hostSettings();
        if (!host) return null;
        try {
            // settings.read(null, module) returns the whole module object
            // (or null if the module has no entries yet).
            var v = host.read(null, ns);
            return v || null;
        } catch (e) {
            S.kernel.error('settings', 'host read threw for', ns, ':', e);
            return null;
        }
    }

    function write(moduleId, value) {
        var ns = namespaced(moduleId);
        if (!ns) return false;
        var host = hostSettings();
        if (!host) {
            S.kernel.warn('settings', 'host `settings` global not present — write to', ns, 'dropped');
            return false;
        }
        try {
            // settings.store does a deep $.extend then save(). Passing the
            // full module object replaces the namespace cleanly.
            host.store(value, ns);
            return true;
        } catch (e) {
            S.kernel.error('settings', 'host store threw for', ns, ':', e);
            return false;
        }
    }

    function all() {
        // Returns { 'steward.kernel': {...}, 'steward.collect': {...}, ... }
        // built from the host's full settings map. Filter to our namespaces.
        var out = {};
        var host = hostSettings();
        if (!host || !host.settings) return out;
        try {
            var allHost = host.settings;
            var keys = Object.keys(allHost);
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (k.indexOf(NS_PREFIX) === 0) {
                    out[k.substring(NS_PREFIX.length)] = allHost[k];
                }
            }
        } catch (e) {
            S.kernel.warn('settings', 'all() failed:', e);
        }
        return out;
    }

    S.kernel.settings = {
        load:  load,
        save:  save,
        flush: flush,
        read:  read,
        write: write,
        all:   all
    };

}(Steward));
