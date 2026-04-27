/*
 * Steward logger.
 *
 * One entry point: Steward.kernel.log(category, ...values). Writes to:
 *   1. The host JS console (air.Introspector.Console if present, or debug()).
 *   2. A rotating file at <client install>/steward/logs/console.log
 *      (next to the AIR client binaries — predictable / easy to find).
 *
 * Path resolution: AIR's `applicationDirectory.resolvePath(...)` returns a
 * File classified as read-only application content; writing to it raises
 * `SecurityError: fileWriteResource`. We round-trip through `.nativePath`
 * and `new air.File(path)` to drop the classification — the same trick
 * autoTSO uses (user_auto.js:163) and the host's own user-script manager
 * (0-manager.js:131). Confirmed on the live AIR runtime via probe at
 * _temp/diagnostics/user_steward_pathprobe.js. Falls back to
 * applicationStorageDirectory and then documentsDirectory if the
 * round-trip somehow fails (read-only install layout, etc.).
 *
 * The logger boots in a "console only, all categories enabled" mode. Once
 * Steward.kernel.settings.load() runs, configure() picks up persisted prefs.
 *
 * Failures inside the logger never throw — kernel-tick code must be able to
 * call this from anywhere without a try/catch.
 */

(function (S) {

    var LEVEL = {
        DEBUG: 'DEBUG',
        LOG:   'LOG',
        WARN:  'WARN',
        ERROR: 'ERROR'
    };

    var state = {
        enabled:        true,
        debugEnabled:   false,    // DEBUG-level lines are dropped unless this is true
        fileEnabled:    true,     // write to disk by default; configure() can flip off
        categories:     {},       // {} means "all enabled"
        maxFileSizeKB:  S.kernel.LIMITS.LOG_FILE_MAX_KB_DEFAULT,
        keepRotated:    S.kernel.LIMITS.LOG_KEEP_ROTATED_DEFAULT,
        logDir:         null,
        logFile:        null,
        consoleSink:    null
    };

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    function timestamp() {
        var d = new Date();
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
               ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    function joinArgs(args, fromIdx) {
        var parts = [];
        for (var i = fromIdx; i < args.length; i++) {
            var a = args[i];
            if (a === null) { parts.push('null'); continue; }
            if (a === undefined) { parts.push('undefined'); continue; }
            if (typeof a === 'object') {
                try { parts.push(JSON.stringify(a)); }
                catch (e) { parts.push('[unstringifiable]'); }
            } else {
                parts.push(String(a));
            }
        }
        return parts.join(' ');
    }

    function format(level, category, message) {
        return '[' + level + '] [' + timestamp() + '] [' + category + '] ' + message;
    }

    function emitToConsole(level, line) {
        try {
            if (!state.consoleSink) {
                if (typeof air !== 'undefined' && air.Introspector && air.Introspector.Console) {
                    state.consoleSink = air.Introspector.Console;
                } else if (typeof debug === 'function') {
                    state.consoleSink = { log: debug, warn: debug, error: debug };
                } else {
                    state.consoleSink = false;
                }
            }
            if (!state.consoleSink) return;
            if (level === LEVEL.ERROR && state.consoleSink.error) state.consoleSink.error(line);
            else if (level === LEVEL.WARN && state.consoleSink.warn) state.consoleSink.warn(line);
            else if (state.consoleSink.log) state.consoleSink.log(line);
        } catch (e) { /* never propagate */ }
    }

    // air.File.createDirectory() does NOT recurse on Adobe AIR — calling
    // it on a/b/c when a/ doesn't exist throws. We walk down the path so
    // each segment is created on demand. Also surfaces the failure point
    // explicitly to the console sink (file logging is the failure target,
    // so we can't rely on emitToFile here).
    function createDirectoryRecursive(dir) {
        if (!dir) return false;
        if (dir.exists) return true;
        try {
            var parent = dir.parent;
            if (parent && !parent.exists) {
                if (!createDirectoryRecursive(parent)) return false;
            }
            dir.createDirectory();
            return dir.exists;
        } catch (e) {
            emitToConsole(LEVEL.ERROR,
                '[ERROR] [' + timestamp() + '] [logger] createDirectory failed for ' +
                (dir && dir.nativePath ? dir.nativePath : '?') + ': ' + e);
            return false;
        }
    }

    // Round-trip a relative path under applicationDirectory through
    // .nativePath so the resulting File is unclassified by AIR (writable
    // instead of read-only application content). Returns null on any
    // failure.
    function applicationDirRoundTrip(relPath) {
        try {
            var resolved = air.File.applicationDirectory.resolvePath(relPath);
            if (!resolved || !resolved.nativePath) return null;
            return new air.File(resolved.nativePath);
        } catch (e) {
            emitToConsole(LEVEL.WARN,
                '[WARN] [' + timestamp() + '] [logger] round-trip resolve threw for ' +
                relPath + ': ' + e);
            return null;
        }
    }

    function ensureLogFile() {
        if (state.logFile) return state.logFile;
        if (typeof air === 'undefined' || !air.File) return null;

        // Primary: <client install>/steward/logs/console.log via the
        // round-trip trick. Predictable location next to the client
        // binaries. autoTSO writes its own log this way; the host's
        // user-script manager uses the identical pattern when saving
        // remote scripts to disk.
        try {
            var primaryFile = applicationDirRoundTrip('steward/logs/console.log');
            if (primaryFile) {
                var primaryDir = primaryFile.parent;
                if (createDirectoryRecursive(primaryDir)) {
                    state.logDir  = primaryDir;
                    state.logFile = primaryFile;
                    emitToConsole(LEVEL.LOG,
                        '[LOG] [' + timestamp() + '] [logger] writing to ' +
                        state.logFile.nativePath);
                    return state.logFile;
                }
            }
        } catch (e) {
            emitToConsole(LEVEL.WARN,
                '[WARN] [' + timestamp() + '] [logger] applicationDirectory round-trip failed: ' + e);
        }

        // Fallback 1: per-app storage. Buried in AppData but always writable.
        try {
            var dir = air.File.applicationStorageDirectory.resolvePath('steward/logs');
            if (createDirectoryRecursive(dir)) {
                state.logDir  = dir;
                state.logFile = dir.resolvePath('console.log');
                emitToConsole(LEVEL.WARN,
                    '[WARN] [' + timestamp() + '] [logger] applicationDirectory unavailable, using applicationStorageDirectory ' +
                    state.logFile.nativePath);
                return state.logFile;
            }
        } catch (e) {
            emitToConsole(LEVEL.ERROR,
                '[ERROR] [' + timestamp() + '] [logger] storage dir resolve threw: ' + e);
        }

        // Fallback 2: user documents. Last-ditch — both above must have
        // failed for this to fire. Should never happen on a healthy AIR
        // runtime.
        try {
            var alt = air.File.documentsDirectory.resolvePath('steward/logs');
            if (createDirectoryRecursive(alt)) {
                state.logDir  = alt;
                state.logFile = alt.resolvePath('console.log');
                emitToConsole(LEVEL.WARN,
                    '[WARN] [' + timestamp() + '] [logger] storage dir unavailable, using documents fallback ' +
                    state.logFile.nativePath);
                return state.logFile;
            }
        } catch (e) {
            emitToConsole(LEVEL.ERROR,
                '[ERROR] [' + timestamp() + '] [logger] documents fallback threw: ' + e);
        }

        emitToConsole(LEVEL.ERROR,
            '[ERROR] [' + timestamp() + '] [logger] no writable log location — file output disabled');
        state.fileEnabled = false;
        return null;
    }

    function rotateIfNeeded() {
        try {
            var maxBytes = state.maxFileSizeKB * 1024;
            if (maxBytes <= 0) return;
            var f = ensureLogFile();
            if (!f || !f.exists || f.size < maxBytes) return;

            // Drop the oldest, then shift each rotated file up by one suffix.
            for (var i = state.keepRotated; i >= 1; i--) {
                var older = state.logDir.resolvePath('console.log.' + i);
                if (i === state.keepRotated) {
                    if (older.exists) older.deleteFile();
                } else {
                    if (older.exists) {
                        var renamed = state.logDir.resolvePath('console.log.' + (i + 1));
                        if (renamed.exists) renamed.deleteFile();
                        older.moveTo(renamed, true);
                    }
                }
            }
            // Move current to .1
            var dotOne = state.logDir.resolvePath('console.log.1');
            if (dotOne.exists) dotOne.deleteFile();
            f.moveTo(dotOne, true);
            // Recreate fresh file by clearing the cached reference
            state.logFile = null;
        } catch (e) { /* swallow */ }
    }

    function emitToFile(line) {
        if (!state.fileEnabled) return;
        try {
            rotateIfNeeded();
            var f = ensureLogFile();
            if (!f) return;
            var stream = new air.FileStream();
            stream.open(f, air.FileMode.APPEND);
            stream.writeUTFBytes(line + '\n');
            stream.close();
        } catch (e) { /* swallow */ }
    }

    function shouldEmit(category) {
        if (!state.enabled) return false;
        if (!category) return true;
        if (state.categories[category] === false) return false;
        return true;
    }

    function emit(level, args) {
        var category = args[0] || 'kernel';
        // DEBUG-level is gated by an explicit master switch — these messages
        // are dropped silently when debugEnabled is false (default).
        if (level === LEVEL.DEBUG && !state.debugEnabled) return;
        if (!shouldEmit(category)) return;
        var line = format(level, category, joinArgs(args, 1));
        emitToConsole(level, line);
        emitToFile(line);
    }

    function debug() { emit(LEVEL.DEBUG, arguments); }
    function log()   { emit(LEVEL.LOG,   arguments); }
    function warn()  { emit(LEVEL.WARN,  arguments); }
    function error() { emit(LEVEL.ERROR, arguments); }

    log.isEnabled = function (category) {
        return shouldEmit(category);
    };

    debug.isEnabled = function (category) {
        return state.debugEnabled && shouldEmit(category);
    };

    log.configure = function (cfg) {
        if (!cfg) return;
        if (typeof cfg.enabled === 'boolean')        state.enabled       = cfg.enabled;
        if (typeof cfg.debugEnabled === 'boolean')   state.debugEnabled  = cfg.debugEnabled;
        if (typeof cfg.fileEnabled === 'boolean')    state.fileEnabled   = cfg.fileEnabled;
        if (typeof cfg.maxFileSizeKB === 'number')   state.maxFileSizeKB = cfg.maxFileSizeKB;
        if (typeof cfg.keepRotated === 'number')     state.keepRotated   = cfg.keepRotated;
        if (cfg.categories && typeof cfg.categories === 'object') state.categories = cfg.categories;
    };

    S.kernel.debug = debug;
    S.kernel.log   = log;
    S.kernel.warn  = warn;
    S.kernel.error = error;

}(Steward));
