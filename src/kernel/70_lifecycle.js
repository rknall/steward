/*
 * Lifecycle.
 *
 * Steward.kernel.lifecycle.boot() runs once after the bundle finishes loading.
 * Sequence:
 *   1. Load settings from disk
 *   2. Configure logger from settings
 *   3. Run each registered module's boot() hook
 *   4. Initialize UI shell
 *   5. Start the scheduler
 *
 * Boot is auto-scheduled at the end of this file via a deferred setTimeout —
 * by the time the timer fires, every other source file in the bundle (kernel,
 * core, modules) has finished its IIFE and registered itself.
 */

(function (S) {

    var booted = false;

    function applyLoggerSettings() {
        var s = S.kernel.settings.read('logger');
        if (s) S.kernel.log.configure(s);
    }

    function applySchedulerSettings() {
        var s = S.kernel.settings.read('scheduler');
        if (s && S.kernel.scheduler.configure) S.kernel.scheduler.configure(s);
    }

    function readPausedFlag() {
        var s = S.kernel.settings.read('kernel');
        return !!(s && s.paused);
    }

    function runModuleBoots() {
        var mods = S.kernel.registry.list();
        for (var i = 0; i < mods.length; i++) {
            var m = mods[i];
            if (!m.boot) continue;
            try {
                m.boot();
                S.kernel.log('lifecycle', 'boot hook ran for', m.id);
            } catch (e) {
                S.kernel.error('lifecycle', m.id, 'boot threw:', e);
            }
        }
    }

    function boot() {
        if (booted) return;
        booted = true;

        S.kernel.log('lifecycle', 'boot starting');
        try { S.kernel.settings.load(); } catch (e) {
            S.kernel.error('lifecycle', 'settings.load threw:', e);
        }

        applyLoggerSettings();
        applySchedulerSettings();

        runModuleBoots();

        // Honour persisted master-pause state. Seed the UI's flag *before*
        // ui.init() so the menu's pause toggle renders with the right label,
        // then conditionally start the scheduler.
        var startPaused = readPausedFlag();
        if (startPaused && S.kernel.ui && typeof S.kernel.ui.seedPaused === 'function') {
            S.kernel.ui.seedPaused(true);
        }

        try {
            if (S.kernel.ui && S.kernel.ui.init) S.kernel.ui.init();
        } catch (e) {
            S.kernel.error('lifecycle', 'ui.init threw:', e);
        }

        if (startPaused) {
            S.kernel.log('lifecycle', 'boot honouring persisted pause — scheduler not started');
        } else {
            try {
                S.kernel.scheduler.start();
            } catch (e) {
                S.kernel.error('lifecycle', 'scheduler.start threw:', e);
            }
        }

        S.kernel.log('lifecycle', 'boot complete — modules:', S.kernel.registry.count(),
                     '— state:', startPaused ? 'paused' : 'active');
    }

    function shutdown() {
        try { S.kernel.scheduler.stop(); } catch (e) { /* ignore */ }
        try { S.kernel.settings.flush(); } catch (e) { /* ignore */ }
        S.kernel.log('lifecycle', 'shutdown complete');
    }

    S.kernel.lifecycle = {
        boot:     boot,
        shutdown: shutdown,
        booted:   function () { return booted; }
    };

    // Defer boot until the bundle finishes loading. setTimeout(0) would fire
    // after the current synchronous run completes; we use a small extra delay
    // to give the host client time to finish its own init.
    setTimeout(boot, S.kernel.TIMEOUTS.BOOT_DEFER_MS);

}(Steward));
