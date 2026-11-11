/*
 * Check state machine of the updater module.
 *
 * run(opts, done) asks GitHub for the release list once and decides whether
 * a newer version is available:
 *   Idle -> Checking -> Current | Available | Failed
 * and status() reports Installing while install.busy(). opts.manual marks a
 * check the user asked for; done(status()) runs once the check settled (or
 * at once when a check or install is already running).
 *
 * Every run stores lastCheck before the request and again when it settles,
 * so neither a failure nor a reload in the middle of a request makes the
 * boot check retry within REPO.checkMinIntervalMs.
 *
 * A check that was not asked for (the boot check) also:
 *  - notifies once per version, remembered in notifiedVersion, so a reload
 *    never repeats the same alert;
 *  - starts an automatic install only when the user turned it on, both the
 *    running and the target version are plain releases with the target
 *    newer, GitHub published a checksum, the queue is idle and Settings has
 *    no unsaved edits.
 *
 * onBoot() first reports the notice an install left for the next boot (the
 * new version loaded or not, and whether a step-down restore is still
 * pending), clears it, and then runs the boot check when checkOnStart is on
 * and the last check is old enough.
 *
 * No user-facing string lives here: every notice comes from
 * S.modules.updater.text, and a failure stays an S.UpdateFailure code that
 * the group and the menu turn into text. Other updater files are reached
 * through S.modules.updater at call time, because some load after this one.
 * The release list of the last successful check is held by releases.js
 * alone; status() reads it from there.
 */

(function (S) {

    if (!S.modules.updater) S.modules.updater = {};

    // Memory only: a reload starts at Idle again and the boot check (or the
    // stored latest version) fills it in.
    var current = null;     // S.UpdateState, null until first read
    var failure = null;     // S.UpdateFailure of the last failed check
    var latest = null;      // release object of the last successful check

    function U() {
        return S.modules.updater;
    }

    function stateValue() {
        return current || S.UpdateState.Idle;
    }

    function redraw() {
        if (typeof U().redraw !== 'function') return;
        try {
            U().redraw();
        } catch (e) {
            S.kernel.error('updater', 'redraw threw:', e);
        }
    }

    function notify(text) {
        if (typeof text !== 'string' || !text) return;
        S.kernel.ui.notify(text);
    }

    function callDone(done) {
        if (typeof done !== 'function') return;
        try {
            done(status());
        } catch (e) {
            S.kernel.error('updater', 'check callback threw:', e);
        }
    }

    function installBusy() {
        var inst = U().install;
        return !!(inst && typeof inst.busy === 'function' && inst.busy());
    }

    // A build the release list cannot be compared with as a plain release:
    // an unparseable or 0.0.0 version, or a git describe build ahead of its
    // tag. It is shown as such and never updated automatically.
    function isDevBuild(running) {
        var K = S.VersionKind;
        return !running || running.kind === K.Unknown || running.kind === K.Dev;
    }

    function status() {
        var st = U().state();
        var running = S.kernel.semver.running();
        var c = U().releases && typeof U().releases.cached === 'function'
            ? U().releases.cached()
            : null;
        return {
            state:      installBusy() ? S.UpdateState.Installing : stateValue(),
            failure:    failure,
            latest:     latest,
            list:       c && c.list ? c.list : [],
            checkedAt:  typeof st.lastCheck === 'number' ? st.lastCheck : null,
            running:    running,
            latestSeen: latest ? latest.text : (typeof st.latest === 'string' ? st.latest : null),
            devBuild:   isDevBuild(running)
        };
    }

    function setState(next) {
        current = next;
        redraw();
    }

    function autoAllowed(cfg, running, rel) {
        var q = S.kernel.queue;
        return cfg.autoInstall === true
            && S.kernel.semver.autoInstallable(running, rel.version)
            && !!rel.asset.digest
            && q.depth() === 0
            && !q.runningModule()
            && !S.kernel.ui.hasOpenEdits();
    }

    // The boot check's follow-up on an available version: one alert per
    // version, then the gated automatic install.
    function announce(cfg, running, rel) {
        var st = U().state();
        if (st.notifiedVersion !== rel.text) {
            notify(U().text.available(rel.text));
            U().saveState({ notifiedVersion: rel.text });
        }
        if (!autoAllowed(cfg, running, rel)) return;
        S.kernel.log('updater', 'automatic install of', rel.text);
        U().install.run(rel, { auto: true, restore: null }, function (result) {
            if (result && !result.ok) notify(U().text.failure(result.failure));
            redraw();
        });
    }

    function settle(manual, done, fail, fetched) {
        var UP = S.UpdateState;
        var cfg = U().config();
        var running = S.kernel.semver.running();

        if (fail) {
            U().saveState({ lastCheck: U().now() });
            failure = fail;
            S.kernel.warn('updater', 'update check failed:', fail);
            setState(UP.Failed);
            callDone(done);
            return;
        }

        var list = fetched || [];
        var prereleases = U().showPrereleases(cfg, running);
        latest = U().releases.latest(list, prereleases);
        var patch = { lastCheck: U().now() };
        if (latest) patch.latest = latest.text;
        U().saveState(patch);

        // isNewer is false for a null or 0.0.0 running version, so such a
        // build reads Current and status().devBuild marks it.
        var next = latest && S.kernel.semver.isNewer(latest.version, running)
            ? UP.Available
            : UP.Current;
        S.kernel.log('updater', 'update check:', next, 'latest',
            latest ? latest.text : 'none', 'running', U().runningText(running));
        current = next;

        if (!manual && next === UP.Available) {
            try {
                announce(cfg, running, latest);
            } catch (e) {
                S.kernel.error('updater', 'update notice threw:', e);
            }
        }
        redraw();
        callDone(done);
    }

    function run(opts, done) {
        var UP = S.UpdateState;
        var manual = !!(opts && opts.manual);
        if (stateValue() === UP.Checking || installBusy()) {
            callDone(done);
            return;
        }
        failure = null;
        setState(UP.Checking);
        // Stored before the request too, so a reload while it is in flight
        // still counts as a check.
        U().saveState({ lastCheck: U().now() });

        var settled = false;
        function onFetched(fail, fetched) {
            if (settled) return;
            settled = true;
            try {
                settle(manual, done, fail, fetched);
            } catch (e) {
                // Never leave the machine at Checking, which blocks every
                // later run until a reload.
                S.kernel.error('updater', 'update check threw:', e);
                failure = S.UpdateFailure.BadResponse;
                setState(UP.Failed);
                callDone(done);
            }
        }
        try {
            U().releases.fetch(onFetched);
        } catch (e) {
            S.kernel.error('updater', 'release fetch threw:', e);
            onFetched(S.UpdateFailure.BadResponse, null);
        }
    }

    // Reports what the install before the reload left behind, once.
    function reportNotice(notice) {
        var T = U().text;
        var runningText = U().runningText();
        var loaded = typeof notice.to === 'string'
            && S.kernel.semver.compare(runningText, notice.to) === 0;
        var msg = loaded ? T.updated(notice) : T.notLoaded(notice, runningText);
        if (notice.restore && !notice.restored) {
            var extra = T.notRestored(notice);
            if (extra) msg = msg ? msg + ' ' + extra : extra;
        }
        S.kernel.log('updater', 'install notice: from', notice.from, 'to', notice.to,
            loaded ? 'loaded' : 'not loaded, running ' + runningText,
            notice.restore ? (notice.restored ? 'settings restored' : 'settings not restored') : '');
        notify(msg);
    }

    function onBoot() {
        var st = U().state();
        if (st.notice) {
            try {
                if (typeof st.notice === 'object') reportNotice(st.notice);
            } catch (e) {
                S.kernel.error('updater', 'install notice threw:', e);
            }
            // The host store deep-merges, so null is what removes it.
            U().saveState({ notice: null });
        }

        var cfg = U().config();
        var last = typeof st.lastCheck === 'number' ? st.lastCheck : 0;
        if (cfg.checkOnStart && U().now() - last >= U().REPO.checkMinIntervalMs) {
            run({ manual: false });
            return;
        }
        // Idle; status().latestSeen shows the version the last check found.
        current = S.UpdateState.Idle;
    }

    S.modules.updater.check = {
        status: status,
        run:    run,
        onBoot: onBoot
    };

}(Steward));
