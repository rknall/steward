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
 *
 * The store also offers the one defaults merge every module reader uses,
 * merged(id, defaults, opts), and the one deep copy of a settings value,
 * copy(v), so no module hand-writes "read stored, fill in the defaults".
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
        var snapshot;
        try {
            // Deep copy first so the host never shares references with the
            // caller, and an unserialisable map fails before anything changes.
            snapshot = copy(map);
        } catch (e) {
            S.kernel.error('settings', 'replaceAll: map is not serialisable:', e);
            return false;
        }
        if (!snapshot || typeof snapshot !== 'object') {
            S.kernel.warn('settings', 'replaceAll: map is not an object, nothing replaced');
            return false;
        }
        var allHost = host.settings;
        var keys = Object.keys(allHost);
        var removed = 0;
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k.indexOf(NS_PREFIX) === 0 &&
                !Object.prototype.hasOwnProperty.call(snapshot, k.substring(NS_PREFIX.length))) {
                delete allHost[k];
                removed++;
            }
        }
        var ids = Object.keys(snapshot);
        for (var j = 0; j < ids.length; j++) {
            allHost[NS_PREFIX + ids[j]] = snapshot[ids[j]];
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

    // Settings are JSON in storage, so a JSON round trip is a full copy.
    // null and primitives come back as they are. Values JSON cannot carry
    // (undefined, functions, NaN, Infinity) are dropped or become null; none
    // of them can come from settings.json. Throws on a cyclic value.
    function copy(v) {
        if (v === null || typeof v !== 'object') return v;
        return JSON.parse(JSON.stringify(v));
    }

    function has(o, k) { return S.kernel.is.has(o, k); }

    // One row map: d is the default map, s the stored one, both as found
    // (a non-object value is walked by for-in exactly as before, so a
    // hand-edited file reads the same as it always did).
    function mergeRows(d, s, mode) {
        var m = {};
        var n, f, row;
        if (mode === 'replace') {
            for (n in d) m[n] = d[n];
            for (n in s) m[n] = s[n];
            return m;
        }
        if (mode === 'fields') {
            for (n in d) {
                row = {};
                var defRow = d[n] || {};
                var storedRow = s[n];
                for (f in defRow) row[f] = defRow[f];
                if (storedRow !== null && typeof storedRow === 'object') {
                    for (f in storedRow) row[f] = storedRow[f];
                }
                m[n] = row;
            }
            for (n in s) {
                if (!has(d, n)) m[n] = s[n];
            }
            return m;
        }
        // { template: T }: every row starts from the template.
        var template = (mode && mode.template) || {};
        var names = [];
        for (n in d) if (has(d, n)) names.push(n);
        for (n in s) if (has(s, n) && !has(d, n)) names.push(n);
        for (var i = 0; i < names.length; i++) {
            row = {};
            var dr = d[names[i]] || {};
            var sr = s[names[i]] || {};
            for (f in template) row[f] = template[f];
            for (f in dr) row[f] = dr[f];
            for (f in sr) row[f] = sr[f];
            m[names[i]] = row;
        }
        return m;
    }

    // A module's settings: its stored object with the defaults filled in,
    // as a fresh copy the caller may change freely. Options:
    //
    //   (none)            every default key, then every stored key over it;
    //                     stored keys the defaults lack are kept, and a
    //                     stored value wins whatever its type.
    //   only: true        default keys only (own keys): the stored value
    //                     when the store has the key, else the default.
    //   typed: true       with only: a stored value wins only when it has
    //                     the default's type, so a hand-edited file cannot
    //                     feed a string where a flag is read.
    //   rows: { key: mode }  the map under `key` merges row by row, after the
    //                     top level (the key keeps its place):
    //     'replace'       a stored row replaces its default row whole.
    //     'fields'        a stored object row fills in over its default row
    //                     field by field; a stored non-object row reads as
    //                     the default row; rows with no default stay as
    //                     stored.
    //     { template: T } every row, default or stored-only, is T, then the
    //                     default row, then the stored row, field by field.
    //
    // The row modes differ on purpose: each keeps what its module has always
    // read for partial, non-object and stored-only rows.
    function merged(moduleId, defaults, opts) {
        // Through the public object at call time, not the local read(), so a
        // replaced S.kernel.settings.read (the test harness store) is honoured.
        var stored = S.kernel.settings.read(moduleId) || {};
        var defs = defaults || {};
        var o = opts || {};
        var out = {};
        var k;
        if (o.only) {
            for (k in defs) {
                if (!has(defs, k)) continue;
                var takeStored = has(stored, k) &&
                    (!o.typed || typeof stored[k] === typeof defs[k]);
                out[k] = takeStored ? stored[k] : defs[k];
            }
        } else {
            for (k in defs) out[k] = defs[k];
            for (k in stored) out[k] = stored[k];
        }
        var rows = o.rows || {};
        for (k in rows) {
            if (!has(rows, k)) continue;
            out[k] = mergeRows(defs[k] || {}, stored[k] || {}, rows[k]);
        }
        return copy(out);
    }

    S.kernel.settings = {
        load:  load,
        save:  save,
        flush: flush,
        read:  read,
        write: write,
        all:   all,
        replaceAll: replaceAll,
        merged: merged,
        copy:  copy
    };

}(Steward));
