/*
 * Settings, constants and runtime state for the updater module.
 *
 * User settings live in host's settings.json under 'steward.updater'.
 * boot() writes the defaults on first run and adds any key the stored
 * settings lack, keeping every stored value.
 *
 * Runtime state (last check time, last seen release, notify-once marker and
 * the post-reload notice) lives under 'steward.updaterState', apart from the
 * user settings, so the Settings screen's edit buffer never holds or saves it.
 */

(function (S) {

    if (!S.modules.updater) S.modules.updater = {};

    S.modules.updater.defaultSettings = {
        // Look for a new release once when the client starts (rate-limited
        // by REPO.checkMinIntervalMs, so reloads do not hit the API).
        checkOnStart: true,

        // Install a newer plain release without asking. Off by default: an
        // install replaces the bundle every profile loads.
        autoInstall: false,

        // Offer test releases (GitHub prereleases) in the version list and
        // as the latest version.
        showPrereleases: false,

        // Settings backup files kept per profile in steward/backups/.
        keepBackups: 20
    };

    // Every place that talks to GitHub, names a file or waits for the network
    // reads these, so the release whitelist exists once.
    // The slug is the release whitelist and the repo name the texts show.
    var SLUG = 'rknall/steward';
    var API_PREFIX = 'https://api.github.com/repos/' + SLUG + '/';

    S.modules.updater.REPO = {
        slug:               SLUG,
        api:                API_PREFIX + 'releases?per_page=30',
        apiPrefix:          API_PREFIX,
        downloadPrefix:     'https://github.com/' + SLUG + '/releases/download/',
        asset:              'user_steward.js',
        bundlePath:         'userscripts/user_steward.js',
        // Must not end in .js: the host injects every *.js in userscripts/.
        bundleBackupPath:   'userscripts/user_steward.js.backup',
        backupSub:          'backups',
        checkMinIntervalMs: 3600000,
        apiTimeoutMs:       15000,
        downloadTimeoutMs:  60000,
        reloadDelayMs:      1500,
        bodyMaxChars:       20000,
        // The first release that carries this module; installing anything
        // older removes the updater itself.
        firstUpdaterVersion: '0.12.0'
    };

    // Settings namespace of the runtime state: { lastCheck, latest,
    // notifiedVersion, notice }.
    S.modules.updater.STATE_NS = 'updaterState';

    // Stored values win when they have the default's type, so a hand-edited
    // or corrupted settings.json cannot feed a string where a flag is read.
    function config() {
        var defaults = S.modules.updater.defaultSettings;
        var stored = S.kernel.settings.read('updater') || {};
        var out = {};
        for (var key in defaults) {
            if (!defaults.hasOwnProperty(key)) continue;
            out[key] = (stored.hasOwnProperty(key) && typeof stored[key] === typeof defaults[key])
                ? stored[key]
                : defaults[key];
        }
        return out;
    }

    // A shallow copy, so callers never mutate the host's settings buffer.
    function state() {
        var stored = S.kernel.settings.read(S.modules.updater.STATE_NS);
        var out = {};
        if (!stored || typeof stored !== 'object') return out;
        for (var key in stored) {
            if (stored.hasOwnProperty(key)) out[key] = stored[key];
        }
        return out;
    }

    // Merges `patch` into the stored state. The host store deep-merges, so a
    // value is cleared by writing null, never by leaving the key out.
    function saveState(patch) {
        var cur = state();
        for (var key in patch) {
            if (patch.hasOwnProperty(key)) cur[key] = patch[key];
        }
        return S.kernel.settings.write(S.modules.updater.STATE_NS, cur);
    }

    // Seeds every default key the stored settings lack. A stored value always
    // wins; nothing is written when no key was missing.
    function seed() {
        var defaults = S.modules.updater.defaultSettings;
        var stored = S.kernel.settings.read('updater');
        if (!stored || typeof stored !== 'object') {
            S.kernel.settings.write('updater', config());
            return;
        }
        var merged = {};
        var missing = false;
        var key;
        for (key in stored) {
            if (stored.hasOwnProperty(key)) merged[key] = stored[key];
        }
        for (key in defaults) {
            if (defaults.hasOwnProperty(key) && !stored.hasOwnProperty(key)) {
                merged[key] = defaults[key];
                missing = true;
            }
        }
        if (missing) S.kernel.settings.write('updater', merged);
    }

    // A test build always sees test releases, so it can move to the next one.
    // This is the only copy of the rule.
    function showPrereleases(cfg, running) {
        return (cfg && cfg.showPrereleases === true) ||
            !!(running && running.kind === S.VersionKind.Prerelease);
    }

    // The version text a log line, a notice or a backup name uses; an
    // unparseable build shows its raw VERSION.
    function runningText(running) {
        var r = running === undefined ? S.kernel.semver.running() : running;
        return r && r.text ? r.text : String(S.kernel.VERSION);
    }

    function predatesUpdater(text) {
        return S.kernel.semver.compare(text, S.modules.updater.REPO.firstUpdaterVersion) < 0;
    }

    S.modules.updater.config    = config;
    S.modules.updater.showPrereleases = showPrereleases;
    S.modules.updater.runningText     = runningText;
    S.modules.updater.predatesUpdater = predatesUpdater;
    S.modules.updater.state     = state;
    S.modules.updater.saveState = saveState;
    S.modules.updater.seed      = seed;
    // Read through the module object at call time so tests can replace it.
    S.modules.updater.now = function () { return Date.now(); };

}(Steward));
