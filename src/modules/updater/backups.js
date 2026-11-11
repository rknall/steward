/*
 * Settings backups for the updater module.
 *
 * Every install first writes the current profile's steward.* namespaces to
 * the backup folder (see folder()) under a name built by fileName(), so a later
 * step-down to that version can bring back the settings it ran with. Newer
 * builds may migrate or add keys an older build does not understand, which is
 * why a step-down restores instead of keeping the current settings.
 *
 * File body (JSON, 2-space indent):
 *   { format: 1, kind: 'steward-settings-backup', fromVersion, toVersion,
 *     profile, time, namespaces }
 * `namespaces` has the shape of S.kernel.settings.all(), minus the updater's
 * runtime state namespace (S.modules.updater.STATE_NS): an old lastCheck or
 * pending notice must never come back with a restore.
 *
 * All profiles share one steward/ folder (the host picks the settings file
 * per profile through its `settingsFile` global), so every record carries its
 * profile and list() only returns the current one.
 *
 * Constants (REPO, STATE_NS, now) live in settings.js, which loads after this
 * file; they are read at call time only.
 */

/* global settingsFile */

(function (S) {

    if (!S.modules.updater) S.modules.updater = {};

    var FORMAT = 1;
    var KIND = 'steward-settings-backup';
    var DEFAULT_PROFILE = 'settings.json';

    function U() {
        return S.modules.updater;
    }

    function stateNs() {
        return U().STATE_NS;
    }

    function nowMs() {
        return typeof U().now === 'function' ? U().now() : Date.now();
    }

    function isPlainObject(v) {
        return !!v && typeof v === 'object' && Object.prototype.toString.call(v) !== '[object Array]';
    }

    function pad2(n) {
        return n < 10 ? '0' + n : String(n);
    }

    // Local time, because the user reads the name in a file browser.
    function stamp(ms) {
        var d = new Date(ms);
        return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
               pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    }

    // Keeps the version readable in the file name but never lets it add a
    // path separator or a character Windows rejects.
    function sanitize(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[^0-9A-Za-z.\-]/g, '_');
    }

    // Settings backup file name; n > 1 disambiguates installs in one second.
    function fileName(stampText, fromText, n) {
        return 'settings-' + stampText + '-v' + sanitize(fromText) +
               (n > 1 ? '-' + n : '') + '.json';
    }

    // Display path of the backup folder, e.g. 'steward/backups/'.
    function folder() {
        return S.kernel.files.stewardPath(U().REPO.backupSub) + '/';
    }

    function backupDir() {
        var loc = S.kernel.files.stewardDir(U().REPO.backupSub);
        return loc && loc.dir ? loc.dir : null;
    }

    // Deep copy of the namespaces without the updater's runtime state. JSON
    // round trip, because the host stores plain JSON anyway.
    function copyNamespaces(map) {
        var copy = JSON.parse(JSON.stringify(map || {}));
        if (!isPlainObject(copy)) copy = {};
        delete copy[stateNs()];
        return copy;
    }

    function profile() {
        try {
            if (typeof settingsFile === 'string' && settingsFile !== '') return settingsFile;
        } catch (e) { /* host global missing: the host default applies */ }
        return DEFAULT_PROFILE;
    }

    function exists(path) {
        var i = S.kernel.files.info(path);
        return !!(i && i.exists);
    }

    function create(fromText, toText) {
        var dir = backupDir();
        if (!dir) return { ok: false, message: 'backup folder not available' };

        var time = nowMs();
        var path = null;
        var name = null;
        // Two installs in the same second must not overwrite each other.
        for (var n = 1; n <= 100; n++) {
            name = fileName(stamp(time), fromText, n);
            var candidate = dir.resolvePath(name).nativePath;
            if (!exists(candidate)) { path = candidate; break; }
        }
        if (!path) return { ok: false, message: 'no free backup name for ' + fileName(stamp(time), fromText) };

        var body;
        try {
            body = {
                format:      FORMAT,
                kind:        KIND,
                fromVersion: String(fromText),
                toVersion:   String(toText),
                profile:     profile(),
                time:        time,
                namespaces:  copyNamespaces(S.kernel.settings.all())
            };
        } catch (e) {
            S.kernel.error('updater', 'backup: settings not serialisable:', e);
            return { ok: false, message: 'settings not serialisable: ' + e };
        }

        var res = S.kernel.files.writeText(path, JSON.stringify(body, null, 2));
        if (!res || !res.ok) {
            return { ok: false, message: (res && res.message) || 'write failed for ' + path };
        }
        S.kernel.log('updater', 'settings backup written: ' + res.path);
        return { ok: true, path: res.path, record: toRecord(res.path, name, body) };
    }

    function toRecord(path, name, body) {
        return {
            path:        path,
            name:        name,
            fromVersion: body.fromVersion,
            toVersion:   body.toVersion,
            profile:     body.profile,
            time:        body.time
        };
    }

    // Parsed body of a backup file, or null with the reason in `why`.
    function parseFile(path, why) {
        var r = S.kernel.files.readText(path);
        if (!r || !r.ok) { why.text = (r && r.message) || 'unreadable'; return null; }
        var body;
        try {
            body = JSON.parse(r.text);
        } catch (e) {
            why.text = 'not JSON: ' + e;
            return null;
        }
        if (!isPlainObject(body) || body.kind !== KIND || body.format !== FORMAT) {
            why.text = 'not a settings backup';
            return null;
        }
        if (!isPlainObject(body.namespaces)) { why.text = 'no namespaces'; return null; }
        return body;
    }

    // This profile's backups, newest first. The array also carries `others`,
    // the count of valid backups that belong to other profiles.
    function list() {
        var out = [];
        out.others = 0;
        var dir = backupDir();
        if (!dir) return out;

        var me = profile();
        var files = S.kernel.files.list(dir.nativePath, '.json');
        for (var i = 0; i < files.length; i++) {
            var why = { text: '' };
            var body = parseFile(files[i].path, why);
            if (!body) {
                S.kernel.warn('updater', 'backup skipped: ' + files[i].name + ' (' + why.text + ')');
                continue;
            }
            if (body.profile !== me) { out.others++; continue; }
            out.push(toRecord(files[i].path, files[i].name, {
                fromVersion: String(body.fromVersion),
                toVersion:   String(body.toVersion),
                profile:     body.profile,
                time:        typeof body.time === 'number' ? body.time : 0
            }));
        }
        out.sort(function (a, b) { return b.time - a.time; });
        return out;
    }

    // The backup to restore when installing toText: one written by toText
    // itself, else the one from the closest older version, else null.
    function pick(toText) {
        var sv = S.kernel.semver;
        if (!sv.parse(toText)) return null;
        var records = list();
        var i;
        for (i = 0; i < records.length; i++) {
            if (sv.parse(records[i].fromVersion) && sv.compare(records[i].fromVersion, toText) === 0) {
                return { record: records[i], exact: true };
            }
        }
        // Newest-first order plus a strict `>` keeps the newest on ties.
        var best = null;
        for (i = 0; i < records.length; i++) {
            var from = records[i].fromVersion;
            if (!sv.parse(from) || sv.compare(from, toText) >= 0) continue;
            if (!best || sv.compare(from, best.fromVersion) > 0) best = records[i];
        }
        return best ? { record: best, exact: false } : null;
    }

    function read(path) {
        var why = { text: '' };
        var body = parseFile(path, why);
        if (!body) {
            S.kernel.warn('updater', 'backup read failed for ' + path + ': ' + why.text);
            return { ok: false, message: why.text };
        }
        return { ok: true, namespaces: body.namespaces };
    }

    // Replaces all steward namespaces with the backup in one host save. The
    // current pause flag and updater state are carried over: the restore runs
    // right before a script reload, and the user's pause and the pending
    // install notice must survive it.
    function restore(record, carry) {
        if (!record || typeof record.path !== 'string') return false;
        var r = read(record.path);
        if (!r.ok) return false;
        var map;
        try {
            map = copyNamespaces(r.namespaces);
        } catch (e) {
            S.kernel.error('updater', 'restore: backup not copyable:', e);
            return false;
        }
        carry = carry || {};
        if (!isPlainObject(map.kernel)) map.kernel = {};
        if (typeof carry.paused === 'boolean') map.kernel.paused = carry.paused;
        if (isPlainObject(carry.state)) map[stateNs()] = carry.state;
        var ok = S.kernel.settings.replaceAll(map);
        if (ok) S.kernel.log('updater', 'settings restored from ' + record.path);
        return ok;
    }

    // Deletes this profile's backups beyond the newest `keep` (at least one).
    // keepPaths is one path or an array of paths that are never deleted: the
    // backup of the install in progress and, on a step-down, the record that
    // is restored only later, inside the reload timer.
    function prune(keep, keepPaths) {
        var n = Math.max(1, Math.floor(Number(keep)) || 0);
        var spared = Object.prototype.toString.call(keepPaths) === '[object Array]' ? keepPaths : [keepPaths];
        var records = list();
        var removed = 0;
        for (var i = n; i < records.length; i++) {
            if (spared.indexOf(records[i].path) !== -1) continue;
            if (S.kernel.files.remove(records[i].path)) removed++;
        }
        if (removed) S.kernel.log('updater', 'pruned ' + removed + ' settings backups');
        return removed;
    }

    S.modules.updater.backups = {
        profile:  profile,
        fileName: fileName,
        folder:   folder,
        create:   create,
        list:     list,
        pick:     pick,
        read:     read,
        restore:  restore,
        prune:    prune
    };

}(Steward));
