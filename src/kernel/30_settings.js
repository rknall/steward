/*
 * Steward settings store.
 *
 * Single JSON file at <applicationStorageDirectory>/steward/settings.json.
 * Per-module namespaces — modules read/write under their own id and never
 * touch other modules' data.
 *
 * In-memory cache populated on load(); writes update cache + flush to disk.
 */

(function (S) {

    var data = {};                  // { moduleId: { ... }, ... }
    var loaded = false;
    var saveTimer = null;

    function fileRef() {
        if (typeof air === 'undefined' || !air.File) return null;
        try {
            var dir = air.File.applicationStorageDirectory.resolvePath('steward');
            if (!dir.exists) dir.createDirectory();
            return dir.resolvePath('settings.json');
        } catch (e) {
            S.kernel.error('settings', 'failed to resolve settings dir:', e);
            return null;
        }
    }

    function load() {
        loaded = true;
        var f = fileRef();
        if (!f || !f.exists) return;
        try {
            var stream = new air.FileStream();
            stream.open(f, air.FileMode.READ);
            var content = stream.readUTFBytes(f.size);
            stream.close();
            if (content && content.length > 0) {
                var parsed = JSON.parse(content);
                if (parsed && typeof parsed === 'object') data = parsed;
            }
        } catch (e) {
            S.kernel.error('settings', 'failed to read settings.json:', e);
        }
    }

    function save() {
        var f = fileRef();
        if (!f) return false;
        try {
            var stream = new air.FileStream();
            stream.open(f, air.FileMode.WRITE);
            stream.writeUTFBytes(JSON.stringify(data, null, 2));
            stream.close();
            return true;
        } catch (e) {
            S.kernel.error('settings', 'failed to write settings.json:', e);
            return false;
        }
    }

    function scheduleSave() {
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
            saveTimer = null;
            save();
        }, S.kernel.TIMEOUTS.SETTINGS_SAVE_DEBOUNCE_MS);
    }

    function read(moduleId) {
        if (!loaded) load();
        if (!moduleId) return null;
        return data[moduleId] || null;
    }

    function write(moduleId, value) {
        if (!loaded) load();
        if (!moduleId) return false;
        data[moduleId] = value;
        scheduleSave();
        return true;
    }

    function all() {
        if (!loaded) load();
        return data;
    }

    function flush() {
        if (saveTimer !== null) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        return save();
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
