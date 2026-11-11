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
 *   replaceAll({ id: obj })   ↔ host.settings['steward.<id>'] = obj, then save()
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
            // settings.store does a deep $.extend then save(). It merges into
            // the stored namespace and never removes keys, so a key dropped
            // from `value` survives on disk. Use replaceAll to replace.
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

    function replaceAll(map) {
        // Replaces every steward namespace with `map` (same shape as all()):
        // namespaces absent from `map` are removed, the rest are assigned
        // whole. This bypasses settings.store on purpose, because its deep
        // merge cannot drop keys, so a restored snapshot would keep stale ones.
        var host = hostSettings();
        if (!host || !host.settings || typeof host.settings !== 'object' ||
            typeof host.save !== 'function') {
            S.kernel.warn('settings', 'replaceAll: host settings or save() not present, nothing replaced');
            return false;
        }
        var copy;
        try {
            // Deep copy first so the host never shares references with the
            // caller, and an unserialisable map fails before anything changes.
            copy = JSON.parse(JSON.stringify(map));
        } catch (e) {
            S.kernel.error('settings', 'replaceAll: map is not serialisable:', e);
            return false;
        }
        if (!copy || typeof copy !== 'object') {
            S.kernel.warn('settings', 'replaceAll: map is not an object, nothing replaced');
            return false;
        }
        var allHost = host.settings;
        var keys = Object.keys(allHost);
        var removed = 0;
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k.indexOf(NS_PREFIX) === 0 &&
                !Object.prototype.hasOwnProperty.call(copy, k.substring(NS_PREFIX.length))) {
                delete allHost[k];
                removed++;
            }
        }
        var ids = Object.keys(copy);
        for (var j = 0; j < ids.length; j++) {
            allHost[NS_PREFIX + ids[j]] = copy[ids[j]];
        }
        try {
            host.save();
        } catch (e2) {
            S.kernel.error('settings', 'replaceAll: host save threw:', e2);
            return false;
        }
        S.kernel.log('settings', 'replaced ' + ids.length + ' namespaces, removed ' + removed);
        return true;
    }

    S.kernel.settings = {
        load:  load,
        save:  save,
        flush: flush,
        read:  read,
        write: write,
        all:   all,
        replaceAll: replaceAll
    };

}(Steward));
