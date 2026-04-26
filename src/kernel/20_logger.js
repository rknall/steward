/*
 * Steward logger.
 *
 * One entry point: Steward.kernel.log(category, ...values). Writes to:
 *   1. The host JS console (air.Introspector.Console if present, or debug()).
 *   2. A rotating file under <applicationStorageDirectory>/steward/logs/console.log
 *      when settings.fileEnabled is true.
 *
 * The logger boots in a "console only, all categories enabled" mode. Once
 * Steward.kernel.settings.load() runs, configure() picks up persisted prefs.
 *
 * Failures inside the logger never throw — kernel-tick code must be able to
 * call this from anywhere without a try/catch.
 */

(function (S) {

    var LEVEL = {
        LOG:   'LOG',
        WARN:  'WARN',
        ERROR: 'ERROR'
    };

    var state = {
        enabled:        true,
        fileEnabled:    false,    // off until settings load + storage dir resolved
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

    function ensureLogFile() {
        if (state.logFile) return state.logFile;
        if (typeof air === 'undefined' || !air.File) return null;
        try {
            var dir = air.File.applicationStorageDirectory.resolvePath('steward/logs');
            if (!dir.exists) dir.createDirectory();
            state.logDir  = dir;
            state.logFile = dir.resolvePath('console.log');
            return state.logFile;
        } catch (e) {
            state.fileEnabled = false;
            return null;
        }
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
        if (!shouldEmit(category)) return;
        var line = format(level, category, joinArgs(args, 1));
        emitToConsole(level, line);
        emitToFile(line);
    }

    function log()   { emit(LEVEL.LOG,   arguments); }
    function warn()  { emit(LEVEL.WARN,  arguments); }
    function error() { emit(LEVEL.ERROR, arguments); }

    log.isEnabled = function (category) {
        return shouldEmit(category);
    };

    log.configure = function (cfg) {
        if (!cfg) return;
        if (typeof cfg.enabled === 'boolean')        state.enabled       = cfg.enabled;
        if (typeof cfg.fileEnabled === 'boolean')    state.fileEnabled   = cfg.fileEnabled;
        if (typeof cfg.maxFileSizeKB === 'number')   state.maxFileSizeKB = cfg.maxFileSizeKB;
        if (typeof cfg.keepRotated === 'number')     state.keepRotated   = cfg.keepRotated;
        if (cfg.categories && typeof cfg.categories === 'object') state.categories = cfg.categories;
    };

    S.kernel.log   = log;
    S.kernel.warn  = warn;
    S.kernel.error = error;

}(Steward));
