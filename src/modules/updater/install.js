/*
 * Install flow for the updater module.
 *
 * run(rel, opts, done) replaces userscripts/user_steward.js with the asset of
 * the release `rel` (as releases.parse returns it) and reloads the scripts.
 * opts = { auto: bool, restore: backup record or null }; done(result) gets
 * { ok, failure, version }, where failure is null or an S.UpdateFailure value.
 * No message is built here: callers turn failure into text through
 * S.modules.updater.text, and the only notices this file sends come from
 * that table too.
 *
 * Steps, in order; any failure before the reload ends the run in finish():
 *  1. Guards: busy, open Settings edits, the bundle file must exist, and an
 *     automatic install needs a checksum and a pair autoInstallable accepts.
 *  2. Download (net.getBytes, the release asset URL only).
 *  3. Verify: size, SHA-256 when GitHub published a digest, and the banner
 *     version line build.js writes, so a renamed or truncated asset is never
 *     installed.
 *  4. Quiesce: the scheduler is stopped and the queue reset, so no module
 *     writes settings while they are backed up. ui.pause is never called,
 *     because that would persist a pause the user did not ask for.
 *  5. Backup of every steward.* namespace of this profile.
 *  6. Write: the old bundle is copied to user_steward.js.backup, then the new
 *     bytes replace the bundle (atomic, so a failed write keeps the old one).
 *  7. A notice in the updater state, which the next boot reports.
 *  8. Reload, after REPO.reloadDelayMs so the "installing" notice is seen.
 *
 * Nothing is written into userscripts/ before step 6.
 *
 * A step-down restore runs inside the reload timer, synchronously right before
 * reloadScripts(): the scheduler is stopped since step 4, the dashboard is
 * closed, and the new bundle's teardown never writes settings, so nothing can
 * write between the restore and the reload. The current pause flag and the
 * updater state (with the notice marked restored) are carried into it.
 *
 * Every other updater file is reached through S.modules.updater at call time,
 * because this file loads before settings.js, net.js and texts.js.
 */

/* global reloadScripts */

(function (S) {

    if (!S.modules.updater) S.modules.updater = {};

    // Bytes read for the banner check; the banner is the bundle's first lines.
    var BANNER_HEAD_BYTES = 512;
    var BANNER_LINE = /\n \* Steward v(\S+)\r?\n/;

    // busy stays set from the guards until finish(), or on success until this
    // instance is replaced by the reload (see reloadLater).
    // target is the release text of the run that owns busy, so the UI can name
    // the version being installed; it follows busy's lifetime.
    var busy = false;
    var target = null;
    var current = null;
    var lastResult = null;

    function U() {
        return S.modules.updater;
    }

    function redraw() {
        if (typeof U().redraw !== 'function') return;
        try {
            U().redraw();
        } catch (e) {
            S.kernel.error('updater', 'redraw threw:', e);
        }
    }

    function setStep(step) {
        current = step;
        redraw();
    }

    function nowMs() {
        return typeof U().now === 'function' ? U().now() : Date.now();
    }

    // Native path of a path under the client install directory, or null.
    function nativeOf(relPath) {
        var f = S.kernel.files.appFile(relPath, 'updater');
        return f && f.nativePath ? f.nativePath : null;
    }

    function callDone(done, result) {
        if (typeof done !== 'function') return;
        try {
            done(result);
        } catch (e) {
            S.kernel.error('updater', 'install callback threw:', e);
        }
    }

    // Null when the bytes are the release; otherwise the failure.
    function verify(rel, bytes) {
        var F = S.UpdateFailure;
        var sv = S.kernel.semver;
        if (!bytes || bytes.length !== rel.asset.size) {
            S.kernel.warn('updater', 'size mismatch: got', bytes ? bytes.length : 0,
                'expected', rel.asset.size);
            return F.SizeMismatch;
        }
        if (rel.asset.digest) {
            var sum = S.kernel.sha256.bytes(bytes);
            if (sum !== rel.asset.digest) {
                S.kernel.warn('updater', 'checksum mismatch: got', sum, 'expected', rel.asset.digest);
                return F.DigestMismatch;
            }
        }
        var head;
        try {
            bytes.position = 0;
            head = bytes.readUTFBytes(Math.min(BANNER_HEAD_BYTES, bytes.length));
        } catch (e) {
            S.kernel.warn('updater', 'banner not readable:', e);
            head = '';
        }
        bytes.position = 0;
        var m = BANNER_LINE.exec(head);
        var found = m ? m[1] : null;
        if (!found || !sv.parse(found) || !sv.parse(rel.text) || sv.compare(found, rel.text) !== 0) {
            S.kernel.warn('updater', 'banner version', found, 'does not match release', rel.text);
            return F.VersionMismatch;
        }
        return null;
    }

    function run(rel, opts, done) {
        var F = S.UpdateFailure;
        var REPO = U().REPO;
        opts = opts || {};
        var auto = opts.auto === true;
        var restoreRecord = opts.restore || null;
        var quiesced = false;
        var wasRunning = false;
        var scheduled = false;
        var answered = false;

        // Ends a run that did not reach the reload: the scheduler comes back
        // only when it was running before, so a user's pause stays a pause.
        function finish(failure) {
            if (quiesced && wasRunning) {
                try {
                    S.kernel.scheduler.start();
                } catch (e) {
                    S.kernel.error('updater', 'scheduler restart threw:', e);
                }
            }
            busy = false;
            target = null;
            current = null;
            lastResult = { ok: false, failure: failure, version: rel && rel.text ? rel.text : null };
            S.kernel.warn('updater', 'install failed:', failure);
            redraw();
            callDone(done, lastResult);
        }

        if (busy) {
            // Not finish(): the run in progress owns busy and the scheduler.
            callDone(done, { ok: false, failure: F.Busy, version: rel && rel.text ? rel.text : null });
            return;
        }
        busy = true;
        target = rel && rel.text ? rel.text : null;

        if (S.kernel.ui.hasOpenEdits()) { finish(F.OpenEdits); return; }
        var bundle = nativeOf(REPO.bundlePath);
        var bundleInfo = bundle ? S.kernel.files.info(bundle) : null;
        if (!bundleInfo || !bundleInfo.exists) { finish(F.BundleMissing); return; }
        if (auto && !rel.asset.digest) { finish(F.NoDigest); return; }
        if (auto && !S.kernel.semver.autoInstallable(S.kernel.semver.running(), rel.version)) {
            finish(F.AutoBlocked);
            return;
        }

        S.kernel.log('updater', 'install', rel.text, auto ? '(automatic)' : '(manual)');
        setStep(S.InstallStep.Download);
        U().net.getBytes(rel.asset.url, function (failure, bytes) {
            if (failure) { finish(failure); return; }
            try {
                installBytes(bytes);
            } catch (e) {
                // An unexpected throw must not leave busy set and the
                // scheduler stopped. Once the bundle is written the install
                // stands, so a throw from then on is only logged.
                S.kernel.error('updater', 'install threw at', current, ':', e);
                if (current === S.InstallStep.Reload) {
                    if (!scheduled) reloadLater(rel, restoreRecord);
                    scheduled = true;
                    // The caller still learns that the install stands.
                    if (!answered) {
                        answered = true;
                        lastResult = { ok: true, failure: null, version: rel.text };
                        callDone(done, lastResult);
                    }
                    return;
                }
                if (current === S.InstallStep.Backup) finish(F.BackupFailed);
                else if (current === S.InstallStep.Write) finish(F.WriteFailed);
                else finish(F.BadResponse);
            }
        });

        function installBytes(bytes) {
            setStep(S.InstallStep.Verify);
            var bad = verify(rel, bytes);
            if (bad) { finish(bad); return; }

            wasRunning = !S.kernel.ui.isPaused();
            S.kernel.scheduler.stop();
            S.kernel.queue.reset();
            quiesced = true;

            setStep(S.InstallStep.Backup);
            var from = U().runningText();
            var backup = U().backups.create(from, rel.text);
            if (!backup || !backup.ok) {
                S.kernel.warn('updater', 'settings backup failed:', backup && backup.message);
                finish(F.BackupFailed);
                return;
            }
            // The restore record is read only inside the reload timer, so the
            // prune must spare it as well as the backup just written.
            var keepPaths = [backup.path];
            if (restoreRecord && restoreRecord.path) keepPaths.push(restoreRecord.path);
            U().backups.prune(U().config().keepBackups, keepPaths);

            setStep(S.InstallStep.Write);
            var bundleBackup = nativeOf(REPO.bundleBackupPath);
            if (!bundleBackup) { finish(F.WriteFailed); return; }
            var old = S.kernel.files.readBytes(bundle);
            if (!old || !old.ok) { finish(F.WriteFailed); return; }
            var saved = S.kernel.files.writeBytes(bundleBackup, old.bytes);
            if (!saved || !saved.ok) { finish(F.WriteFailed); return; }
            var written = S.kernel.files.writeBytes(bundle, bytes);
            if (!written || !written.ok) { finish(F.WriteFailed); return; }
            S.kernel.log('updater', 'bundle replaced with', rel.text, '(old one kept as',
                saved.path + ')');
            // From here on the new bundle is on disk, so the run only moves
            // forward to the reload.
            setStep(S.InstallStep.Reload);

            // restored turns true only inside the reload timer, so every path
            // that skips the restore leaves it false for the next boot to report.
            U().saveState({ notice: {
                from:     from,
                to:       rel.text,
                time:     nowMs(),
                auto:     auto,
                backup:   backup.record ? backup.record.name : null,
                restore:  restoreRecord ? restoreRecord.name : null,
                restored: false
            } });

            // The guard made sure there are no edits to keep.
            S.kernel.ui.closeDashboard(false);
            S.kernel.ui.notify(U().text.installing(rel.text));
            lastResult = { ok: true, failure: null, version: rel.text };
            scheduled = true;
            reloadLater(rel, restoreRecord);
            answered = true;
            callDone(done, lastResult);
        }
    }

    // busy is not cleared here: a check or a second install between now and
    // the reload would start on a stopped scheduler and a replaced bundle.
    // When reloadScripts is missing the instance keeps running the old code
    // until a client restart, so it stays busy for the same reason.
    function reloadLater(rel, restoreRecord) {
        var owner = S.kernel.lifecycle;
        setTimeout(function () {
            // Another reload replaced this instance; the stored notice keeps
            // restored: false and the next boot reports it.
            if (S.kernel.lifecycle !== owner) return;

            if (restoreRecord) restoreNow(restoreRecord);

            if (typeof reloadScripts === 'function') {
                try {
                    reloadScripts();
                    return;
                } catch (e) {
                    S.kernel.error('updater', 'reloadScripts threw:', e);
                }
            } else {
                S.kernel.warn('updater', 'reloadScripts not available: a client restart loads', rel.text);
            }
            S.kernel.ui.notify(U().text.restartNeeded(rel.text));
        }, U().REPO.reloadDelayMs);
    }

    // Brings back the settings the target version ran with. A failure leaves
    // the stored notice at restored: false; the new bundle stays installed.
    function restoreNow(record) {
        var state = U().state();
        var notice = {};
        var key;
        if (state.notice && typeof state.notice === 'object') {
            for (key in state.notice) {
                if (state.notice.hasOwnProperty(key)) notice[key] = state.notice[key];
            }
        }
        notice.restored = true;
        state.notice = notice;
        var ok = false;
        // The in-memory flag is the user's pause: scheduler.stop() during the
        // install does not change it, and the persisted copy may lag behind it.
        try {
            ok = U().backups.restore(record, { paused: S.kernel.ui.isPaused(), state: state });
        } catch (e) {
            S.kernel.error('updater', 'restore threw:', e);
            ok = false;
        }
        if (!ok) S.kernel.error('updater', 'settings restore failed from', record.path);
    }

    S.modules.updater.install = {
        run:    run,
        busy:   function () { return busy; },
        target: function () { return target; },
        step:   function () { return current; },
        last:   function () { return lastResult; }
    };

}(Steward));
