/*
 * User-facing strings of the updater module.
 *
 * This is the only home of the updater's wording: the group, the menu, the
 * confirm box and the game alerts all call S.modules.updater.text at call
 * time, so a wording change happens here and nowhere else. Every function is
 * pure (no IO, no state, no DOM) and returns plain text. Remote strings (tag,
 * release name, file names) are inserted as they are; ui.js escapes them when
 * it renders into HTML, and confirm() and notify show text.
 *
 * Failure, step and state lines are read from the enums at call time, so a
 * value missing here gives a generic line instead of an empty string. Facts
 * about the repository (slug, asset, bundle path, backup folder, check
 * interval) are derived from REPO and the backups module at call time.
 *
 * It also owns the group's status labels (badge, checked line, status field
 * names, automatic-install lines); layout strings (card titles, field labels,
 * column heads) stay in ui.js.
 */

(function (S) {

    if (!S.modules.updater) S.modules.updater = {};

    function U() {
        return S.modules.updater;
    }

    // Versions are kept without the leading "v" in state; the text adds it.
    function v(text) {
        return 'v' + text;
    }

    function pad2(n) {
        return n < 10 ? '0' + n : String(n);
    }

    // Local date, the way a person reads it next to a release; '' for a
    // missing or non-positive time.
    function dateText(ms) {
        if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
        var d = new Date(ms);
        return String(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    function dateTimeText(ms) {
        var day = dateText(ms);
        if (day === '') return '';
        return day + ' ' + S.kernel.ui.helpers.clock(new Date(ms));
    }

    // The check interval as a phrase: "an hour", "every 3 hours", "a minute",
    // "every 20 minutes".
    function every() {
        var minutes = Math.max(1, Math.round(U().REPO.checkMinIntervalMs / 60000));
        if (minutes % 60 === 0) {
            var hours = minutes / 60;
            return hours === 1 ? 'an hour' : 'every ' + hours + ' hours';
        }
        return minutes === 1 ? 'a minute' : 'every ' + minutes + ' minutes';
    }

    function failureTable() {
        var F = S.UpdateFailure;
        var R = U().REPO;
        var t = {};
        t[F.Unsupported]     = 'Updates are not available in this client.';
        t[F.Network]         = 'GitHub could not be reached. Check the connection and try again.';
        t[F.RateLimited]     = 'GitHub\'s hourly request limit is reached. Try again later.';
        t[F.BadResponse]     = 'GitHub sent an answer Steward could not read.';
        t[F.ForeignUrl]      = 'Refused a download address outside github.com/' + R.slug + '.';
        t[F.NoAsset]         = 'The release has no ' + R.asset + ' file.';
        t[F.SizeMismatch]    = 'Download rejected: its size does not match the release.';
        t[F.DigestMismatch]  = 'Download rejected: its SHA-256 checksum does not match the one GitHub lists.';
        t[F.VersionMismatch] = 'Download rejected: the file is not the version the release names.';
        t[F.NoDigest]        = 'This release has no checksum, so it cannot be installed automatically.';
        t[F.Busy]            = 'An update check or install is already running.';
        t[F.OpenEdits]       = 'Save or close open edits in Settings first, then try again.';
        t[F.AutoBlocked]     = 'Automatic install was blocked for this version. Install it yourself from Settings > Updates.';
        t[F.BundleMissing]   = R.bundlePath + ' was not found. Copy Steward there once by hand, then update.';
        t[F.BackupFailed]    = 'The settings backup could not be written, so nothing was changed.';
        t[F.WriteFailed]     = 'The new Steward file could not be written. The old one is unchanged.';
        t[F.RestoreFailed]   = 'The settings were not restored. The new Steward is installed; the backup file stays in ' + U().backups.folder() + '.';
        return t;
    }

    function failure(code) {
        var table = failureTable();
        if (typeof code === 'string' && table.hasOwnProperty(code)) return table[code];
        return 'The update failed (' + String(code) + ').';
    }

    // The first sentence of a failure line, for the one-line menu status.
    function shortFailure(code) {
        var line = failure(code);
        var cut = line.indexOf('. ');
        if (cut !== -1) line = line.slice(0, cut);
        return line.replace(/\.$/, '');
    }

    // to is the version being installed; only the download line names it.
    function step(which, to) {
        var I = S.InstallStep;
        var target = to ? v(to) : 'the update';
        if (which === I.Download) return 'Downloading ' + target + '…';
        if (which === I.Verify)   return 'Verifying size, checksum and version…';
        if (which === I.Backup)   return 'Saving a settings backup…';
        if (which === I.Write)    return 'Writing the new Steward file…';
        if (which === I.Reload) {
            var seconds = Math.max(1, Math.round(U().REPO.reloadDelayMs / 1000));
            return 'Reloading scripts in ' + seconds + (seconds === 1 ? ' second' : ' seconds') + '…';
        }
        return 'Working on the update (' + String(which) + ')…';
    }

    // The running version's text; '' without a status.
    function runningText(status) {
        return status ? U().runningText(status.running) : '';
    }

    // The group's status line.
    function state(status) {
        var K = S.UpdateState;
        var s = status && status.state;
        var running = runningText(status);
        if (s === K.Checking) return 'Checking github.com/' + U().REPO.slug + ' for releases…';
        if (s === K.Installing) return 'Installing an update…';
        if (s === K.Failed) return failure(status.failure);
        if (s === K.Available && status.latest) {
            var when = dateText(status.latest.published);
            return 'Version ' + v(status.latest.text) + ' is available' +
                   (when ? ' (released ' + when + ')' : '') + '.';
        }
        if (s === K.Current || s === K.Available) {
            if (status.devBuild) {
                return 'Development build ' + running + '.' +
                       (status.latestSeen ? ' Latest release is ' + v(status.latestSeen) + '.' : '') +
                       ' A development build is never updated automatically.';
            }
            return 'Steward ' + v(running) + ' is up to date.';
        }
        return 'Not checked yet. Steward checks GitHub (' + U().REPO.slug + ') when the client starts, at most ' +
               'once ' + every() + '.';
    }

    // The short line under the section name.
    function summary(status) {
        var K = S.UpdateState;
        var s = status && status.state;
        if (s === K.Checking) return 'Checking…';
        if (s === K.Installing) return 'Installing…';
        if (s === K.Failed) return 'Check failed';
        if (s === K.Available && status.latest) return v(status.latest.text) + ' available';
        if (s === K.Current || s === K.Available) return status.devBuild ? 'Development build' : 'Up to date';
        return 'Not checked yet';
    }

    function available(ver) {
        return 'Steward ' + v(ver) + ' is available. Open ~Steward~ > Updates to install it.';
    }

    function installing(to) {
        return 'Installing Steward ' + v(to) + '. The scripts reload in a moment.';
    }

    function restartNeeded(to) {
        return 'Steward ' + v(to) + ' is installed. This client cannot reload scripts: restart it to load the new version. ' +
               'The scheduler stays stopped until then.';
    }

    function updated(notice) {
        var head = notice.auto
            ? 'Steward updated itself from ' + v(notice.from) + ' to ' + v(notice.to) + ' (automatic install).'
            : 'Steward was updated from ' + v(notice.from) + ' to ' + v(notice.to) + '.';
        if (!notice.backup) return head;
        return head + ' Your settings were saved first: ' + notice.backup + '.';
    }

    function notLoaded(notice, running) {
        return 'Steward ' + v(notice.to) + ' was installed, but ' + v(running) +
               ' is still running: the new file did not load. Restart the client.';
    }

    function notRestored(notice) {
        return 'Steward ' + v(notice.to) + ' is running, but the settings were not restored. Restore ' +
               notice.restore + ' from ' + U().backups.folder() + ' by hand.';
    }

    // The answer to a check the user asked for.
    function checkResult(status) {
        var K = S.UpdateState;
        if (status && status.state === K.Failed) return 'Update check failed: ' + failure(status.failure);
        if (status && status.state === K.Available && status.latest) return available(status.latest.text);
        return state(status);
    }

    function menuStatus(status) {
        var K = S.UpdateState;
        var s = status && status.state;
        if (s === K.Checking) return 'Checking for updates…';
        if (s === K.Installing) return 'Installing an update…';
        if (s === K.Failed) return 'Last check failed: ' + shortFailure(status.failure);
        if (s === K.Available && status.latest) return 'Update available: ' + v(status.latest.text);
        if (s === K.Current || s === K.Available) {
            if (status.devBuild) return 'Development build ' + runningText(status);
            return 'Steward ' + v(runningText(status)) + ' is up to date';
        }
        return 'Not checked for updates yet';
    }

    function menuCheck() {
        return 'Check for updates now';
    }

    function menuOpen(status) {
        if (status && status.state === S.UpdateState.Available && status.latest) {
            return 'Install ' + v(status.latest.text) + '…';
        }
        return 'Updates…';
    }

    // pick is a backups.pick() result or null. ctx = { running, profile,
    // beforeUpdater, noDigest }. A step-down is told from an upgrade by the
    // versions, so a null pick still reads right for both.
    function confirm(rel, pick, ctx) {
        var down = !!(S.kernel.semver.parse(ctx.running) &&
                      S.kernel.semver.compare(rel.text, ctx.running) < 0);
        var lines = [(down ? 'Go back to Steward ' : 'Install Steward ') + v(rel.text) + '?', ''];

        if (ctx.beforeUpdater) {
            lines.push('WARNING: ' + v(rel.text) + ' predates the updater. Afterwards Steward cannot update itself; ' +
                       'you must copy the file into userscripts by hand.');
            lines.push('');
        }
        if (ctx.noDigest) {
            lines.push('GitHub gives no SHA-256 checksum for this release, so the download is checked by size and version only.');
            lines.push('');
        }

        lines.push('This replaces ' + v(ctx.running) + ' and reloads the scripts.');
        lines.push('All profiles share this file ' + U().REPO.bundlePath + ', so the version changes for every profile.');
        lines.push('');
        lines.push('Before installing, the settings of profile ' + ctx.profile + ' are saved to ' +
                   U().backups.folder() + U().backups.fileName('<date and time>', ctx.running) + '.');

        if (!down) {
            lines.push('Nothing is restored: your settings stay as they are.');
        } else if (!pick) {
            lines.push('No settings backup exists for ' + v(rel.text) + ' or older, so the current settings are kept.');
        } else if (pick.exact) {
            lines.push('Then the settings are restored from the backup taken when you left ' + v(rel.text) +
                       ': ' + pick.record.name + '.');
        } else {
            lines.push('No backup exists for ' + v(rel.text) + '. The newest older one, for ' +
                       v(pick.record.fromVersion) + ' (' + pick.record.name + '), is restored.');
        }
        return lines.join('\n');
    }

    // The group's state badge label; the kind (colour) stays with ui.js.
    // installFailed is the memory of a manual install that failed.
    function badge(status, installFailed) {
        var K = S.UpdateState;
        if (installFailed && status.state !== K.Installing) return 'Failed';
        switch (status.state) {
            case K.Checking:   return 'Checking';
            case K.Installing: return 'Installing';
            case K.Available:  return 'Update available';
            case K.Failed:     return 'Check failed';
            case K.Current:
                return status.devBuild ? 'Development build' : 'Up to date';
            default:
                return status.devBuild ? 'Development build' : 'Idle';
        }
    }

    function checkedMeta(status) {
        var K = S.UpdateState;
        if (status.state === K.Checking) return 'Checking';
        if (typeof status.checkedAt !== 'number' || isNaN(status.checkedAt)) return 'Never checked';
        return (status.state === K.Failed ? 'Last check ' : 'Checked ') + dateTimeText(status.checkedAt);
    }

    function runningField(status) {
        return 'Running: Steward ' + (status.running ? v(status.running.text) : 'of unknown version');
    }

    function installingField(to) {
        return to ? 'Installing ' + v(to) : 'Installing an update';
    }

    function installFailedField(ver) {
        return 'Install of ' + v(ver) + ' failed';
    }

    function autoInstallName(on) {
        return on ? 'Automatic install is on' : 'Automatic install is off';
    }

    function autoInstallHelp(on) {
        return on
            ? 'A newer release is installed without asking when Steward is idle and ' +
              'the release has a checksum. A settings backup is made first.'
            : 'Steward notifies you and installs only after you confirm.';
    }

    function checkOnStartHelp() {
        return 'At most one check ' + every() + ', whatever you set.';
    }

    U().text = {
        failure:       failure,
        step:          step,
        state:         state,
        summary:       summary,
        available:     available,
        installing:    installing,
        restartNeeded: restartNeeded,
        updated:       updated,
        notLoaded:     notLoaded,
        notRestored:   notRestored,
        checkResult:   checkResult,
        menuStatus:    menuStatus,
        menuCheck:     menuCheck,
        menuOpen:      menuOpen,
        confirm:       confirm,
        v:                 v,
        date:              dateText,
        dateTime:          dateTimeText,
        badge:             badge,
        checkedMeta:       checkedMeta,
        runningField:      runningField,
        installingField:   installingField,
        installFailedField: installFailedField,
        autoInstallName:   autoInstallName,
        autoInstallHelp:   autoInstallHelp,
        checkOnStartHelp:  checkOnStartHelp
    };

}(Steward));
