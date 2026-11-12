/*
 * Settings group of the updater module.
 *
 * Draws the "Updates" group of the Settings screen as four cards plus the
 * available-release card:
 *   - status: running version, check state, Check now, the automatic-install
 *     line and, while it applies, the install step or the last install failure;
 *   - release: the newer version with Install and its release notes;
 *   - options: the saved toggles (buffered, applied with Save);
 *   - versions: every listed release with its Install button and the settings
 *     backup a step-down would restore;
 *   - backups: this profile's settings backup files.
 *
 * Buttons act at once, so they carry the "runs now" mark. Every status,
 * step and failure line comes from S.modules.updater.text, the only home of
 * the updater's wording. Layout strings (card titles, field labels, help
 * texts) stay here. Release names, tags, bodies and file names
 * come from outside and are only ever set as element text, never as HTML.
 *
 * check.js and install.js call redraw() on every state change; it repaints
 * only while this group is the visible one.
 */

(function (S) {

    if (!S.modules.updater) S.modules.updater = {};

    var GROUP_ID = 'updater';

    // Release notes longer than this start collapsed.
    var NOTES_INLINE_MAX = 600;

    // The last render target, so redraw() can repaint in place.
    var lastMain = null;
    var lastHelpers = null;

    // Memory only: how the last manual install of this session ended. Cleared
    // when a new check or install starts.
    var installFail = null;

    // null = default by length; true/false = the user's choice.
    var notesOpen = null;

    function U() {
        return S.modules.updater;
    }

    // Table cells show '-' where the date is unknown.
    function day(ms) {
        return U().text.date(ms) || '-';
    }

    function dateTime(ms) {
        return U().text.dateTime(ms) || '-';
    }

    function ask(text) {
        return typeof confirm === 'function' && confirm(text) === true;
    }

    function plain(text) {
        return $('<span>').text(text);
    }

    // ---------------------------------------------------------------
    // Status card
    // ---------------------------------------------------------------

    // Badge kind (colour) of the check state; the label is the text module's.
    function stateBadge(h, status) {
        var St = S.UpdateState;
        var label = U().text.badge(status, !!installFail);
        if (installFail && status.state !== St.Installing) return h.badge('paused', label);
        switch (status.state) {
            case St.Checking:
            case St.Installing:
            case St.Available:  return h.badge('busy', label);
            case St.Failed:     return h.badge('paused', label);
            default:
                return h.badge(status.devBuild ? 'off' : (status.state === St.Current ? 'ok' : 'off'), label);
        }
    }

    function runCheck() {
        installFail = null;
        U().check.run({ manual: true }, function () { redraw(); });
    }

    function statusCard(h, status, cfg) {
        var St = S.UpdateState;
        var busy = status.state === St.Installing;
        var $card = h.card({
            title: 'Updates',
            meta: busy ? h.badge('busy', U().text.badge(status, false)) : U().text.checkedMeta(status)
        });

        var $check = h.button('Check now', {
            size: 'sm',
            disabled: busy || status.state === St.Checking,
            onClick: runCheck
        });
        var $ctl = $('<span>');
        if (busy) {
            $ctl.append($check);
        } else {
            $ctl.append(stateBadge(h, status)).append(' ').append($check).append(' ').append(h.now());
        }

        var T = U().text;
        var name = T.runningField(status);
        var help;
        if (busy) {
            var step = U().install.step();
            name = T.installingField(U().install.target());
            help = step ? T.step(step, U().install.target()) : '';
        } else if (installFail) {
            name = T.installFailedField(installFail.version);
            help = U().text.failure(installFail.failure);
        } else {
            help = U().text.state(status);
        }
        var $field = h.field(name, help, $ctl, { wide: true });
        if (installFail && !busy) $field.children('.steward-field-lbl').children('.steward-field-help').addClass('steward-bad');
        $card.append($field);

        if (!busy) {
            $card.append(h.field(
                T.autoInstallName(cfg.autoInstall),
                T.autoInstallHelp(cfg.autoInstall),
                null));
        }
        return $card;
    }

    // ---------------------------------------------------------------
    // Install
    // ---------------------------------------------------------------

    // The backup a step-down installs, or null for an upgrade or a re-install.
    function pickFor(rel, status) {
        var run = status.running;
        if (!run || S.kernel.semver.compare(rel.text, run) >= 0) return null;
        return U().backups.pick(rel.text);
    }

    function startInstall(rel) {
        var status = U().check.status();
        if (status.state === S.UpdateState.Installing) return;
        var pick = pickFor(rel, status);
        var text = U().text.confirm(rel, pick, {
            running:       U().runningText(status.running),
            profile:       U().backups.profile(),
            beforeUpdater: U().predatesUpdater(rel.text),
            noDigest:      !rel.asset.digest
        });
        if (!ask(text)) return;

        installFail = null;
        U().install.run(rel, { auto: false, restore: pick ? pick.record : null }, function (result) {
            if (result && !result.ok) {
                installFail = { version: rel.text, failure: result.failure };
                S.kernel.ui.notify(U().text.failure(result.failure));
            }
            redraw();
        });
    }

    // ---------------------------------------------------------------
    // Release card (the newer version)
    // ---------------------------------------------------------------

    function releaseCard(h, status) {
        var rel = status.latest;
        var St = S.UpdateState;
        if (status.state !== St.Available || !rel) return null;

        var kind = rel.prerelease ? 'Test release' : 'Release';
        var $card = h.card({
            title: U().text.v(rel.text) + ' (' + kind + ')',
            meta: day(rel.published)
        });
        var $install = h.button('Install ' + U().text.v(rel.text), {
            primary: true,
            onClick: function () { startInstall(rel); }
        });
        $card.append(h.field(rel.name, rel.asset.digest ? '' : 'GitHub lists no checksum for this file.',
            $('<span>').append($install).append(' ').append(h.now()), { wide: true }));

        var body = rel.body || '';
        var open = notesOpen === null ? body.length <= NOTES_INLINE_MAX : notesOpen;
        var $toggle = h.link(open ? 'Hide release notes' : 'Show release notes', function () {
            notesOpen = !open;
            redraw();
        });
        $card.append(h.field('Release notes', open ? 'Shown below.' : 'Hidden.', $toggle));
        if (open) {
            $card.append($('<div>', { 'class': 'steward-notes' })
                .css({ 'white-space': 'pre-wrap', padding: '8px 12px 12px' })
                .text(body || 'The release has no notes.'));
        }
        return $card;
    }

    // ---------------------------------------------------------------
    // Options card
    // ---------------------------------------------------------------

    // The old-releases toggle label; the Versions empty state quotes it, so both
    // read it from here.
    function oldReleasesLabel() {
        return 'Show versions before ' + U().REPO.firstUpdaterVersion;
    }

    function optionsCard(h) {
        var $card = h.card({ title: 'Update options' });
        $card.append(h.field('Check for updates when the client starts',
            U().text.checkOnStartHelp(),
            h.toggle({ ns: 'updater', path: 'checkOnStart', label: 'Check for updates when the client starts' })));
        $card.append(h.field('Install updates automatically',
            'Releases only; a settings backup is made first.',
            h.toggle({ ns: 'updater', path: 'autoInstall', label: 'Install updates automatically' })));
        $card.append(h.field('Show test releases',
            'Adds alpha and beta releases to the Versions list and to update checks.',
            h.toggle({ ns: 'updater', path: 'showPrereleases', label: 'Show test releases' })));
        var oldLabel = oldReleasesLabel();
        $card.append(h.field(oldLabel,
            'They have no updater: after installing one, Steward cannot update itself.',
            h.toggle({ ns: 'updater', path: 'showOldReleases', label: oldLabel })));
        $card.append(h.field('Settings backups to keep',
            'Older backups of this profile are deleted after each install.',
            h.number({
                ns: 'updater', path: 'keepBackups', width: '54px', unit: 'files',
                label: 'Settings backups to keep',
                parse: function (text) {
                    var n = S.kernel.ui.settingsParse.whole(text);
                    return (n === null || n < 1) ? null : n;
                }
            })));
        return $card;
    }

    // ---------------------------------------------------------------
    // Versions card
    // ---------------------------------------------------------------

    function backupCell(pick) {
        if (!pick) return $('<span>', { 'class': 'steward-muted' }).text('none, settings kept');
        var name = pick.record.name;
        return plain(pick.exact ? name : U().text.v(pick.record.fromVersion) + ' (older): ' + name);
    }

    function versionRow(h, rel, status) {
        var sv = S.kernel.semver;
        var cmp = status.running ? sv.compare(rel.text, status.running) : 1;
        var busy = status.state === S.UpdateState.Installing;

        var $ver = $('<span>');
        $ver.append(cmp === 0 ? $('<b>').text(U().text.v(rel.text)) : plain(U().text.v(rel.text)));
        if (U().predatesUpdater(rel.text)) {
            $ver.append(' ').append(h.badge('paused', 'No updater'));
        }

        var $action;
        if (cmp === 0) {
            $action = h.badge('off', 'Running');
        } else {
            $action = $('<span>').append(h.button('Install', {
                size: 'sm',
                primary: cmp > 0 ? status.latest === rel : true,
                disabled: busy,
                onClick: function () { startInstall(rel); }
            })).append(' ').append(h.now());
        }

        var $backup = cmp < 0
            ? backupCell(U().backups.pick(rel.text))
            : $('<span>', { 'class': 'steward-muted' }).text('-');

        return {
            row: [
                { $: $ver },
                day(rel.published),
                { $: rel.prerelease ? h.badge('busy', 'Test') : h.badge('ok', 'Release') },
                { $: $backup },
                { $: $action }
            ],
            cmp: cmp
        };
    }

    // Releases before the first updater are hidden unless the user opted in; the
    // running row always stays so an unusual old build still shows where it is.
    // hiddenOld counts only what the age rule removed, so the empty state can name it.
    function visibleReleases(status, cfg) {
        var showTests = U().showPrereleases(cfg, status.running);
        var showOld = U().showOldReleases(cfg);
        var out = [];
        var hiddenOld = 0;
        for (var i = 0; i < status.list.length; i++) {
            var rel = status.list[i];
            if (rel.prerelease && !showTests) continue;
            var isRunning = !!status.running && S.kernel.semver.compare(rel.text, status.running) === 0;
            if (!showOld &&!isRunning && U().predatesUpdater(rel.text)) {
                hiddenOld++;
                continue;
            }
            out.push(rel);
        }
        return { list: out, hiddenOld: hiddenOld };
    }

    function versionsCard(h, status, cfg) {
        var $card = h.card({ title: 'Versions', meta: 'Settings backups are per profile' });
        var visible = visibleReleases(status, cfg);
        var releases = visible.list;
        if (!releases.length) {
            if (visible.hiddenOld > 0) {
                var first = U().REPO.firstUpdaterVersion;
                $card.append(h.empty('No versions listed', 'Versions before ' + first +
                    ' are hidden. Turn on "' + oldReleasesLabel() +
                    '" in Update options to list them.'));
            } else {
                $card.append(h.empty('No versions listed',
                    'Use Check now to load the release list from GitHub.'));
            }
            return $card;
        }
        var rows = [];
        var stepDown = false;
        var upgrade = false;
        var beforeUpdater = null;
        for (var i = 0; i < releases.length; i++) {
            var r = versionRow(h, releases[i], status);
            rows.push(r.row);
            if (r.cmp < 0) stepDown = true;
            if (r.cmp > 0) upgrade = true;
            if (!beforeUpdater && U().predatesUpdater(releases[i].text)) {
                beforeUpdater = releases[i].text;
            }
        }
        $card.append(h.table({
            cols: [
                { label: 'Version', width: '150px' },
                { label: 'Date', width: '90px' },
                { label: 'Kind', width: '80px' },
                { label: 'Settings backup restored' },
                { label: '', width: '130px' }
            ],
            rows: rows
        }));

        var $wrap = $('<div>');
        if (upgrade) {
            $wrap.append($('<div>', { 'class': 'steward-note steward-muted' }).css('padding-top', '8px')
                .text('Upgrading keeps your current settings. They are saved to a backup file in ' +
                      U().backups.folder() + ' first.'));
        }
        if (stepDown) {
            $wrap.append($('<div>', { 'class': 'steward-note steward-muted' }).css('padding-top', '8px')
                .text('Stepping down restores the settings saved when you left that version. ' +
                      'Without one, the newest older backup is used, and without any the ' +
                      'current settings are kept.'));
        }
        if (beforeUpdater) {
            $wrap.append(h.banner('Versions marked "No updater" predate the updater. After ' +
                'installing one, Steward cannot update itself: copy the file into userscripts by ' +
                'hand to move forward.'));
        }
        return $('<div>').append($card).append($wrap);
    }

    // ---------------------------------------------------------------
    // Backups card
    // ---------------------------------------------------------------

    function backupsCard(h, cfg) {
        var backups = U().backups;
        var list = backups.list();
        var $card = h.card({ title: 'Settings backups', meta: 'Profile: ' + backups.profile() });
        if (list.length) {
            var rows = [];
            for (var i = 0; i < list.length; i++) {
                rows.push([
                    dateTime(list[i].time),
                    U().text.v(list[i].fromVersion) + ' → ' + U().text.v(list[i].toVersion),
                    list[i].name
                ]);
            }
            $card.append(h.table({
                cols: [
                    { label: 'Date', width: '150px' },
                    { label: 'From → to', width: '170px' },
                    { label: 'File in ' + U().backups.folder() }
                ],
                rows: rows
            }));
        } else if (list.others > 0) {
            $card.append(h.empty('No settings backups for this profile',
                'A backup is written before every install.'));
        } else {
            $card.append(h.empty('No settings backups yet', 'A backup is written before every install.'));
        }
        if (!list.length && list.others > 0) {
            $card.append($('<div>', { 'class': 'steward-note steward-muted' }).css('padding-top', '8px')
                .text(list.others + ' backups belong to other profiles and are not listed or restored here.'));
        }
        $card.append($('<div>', { 'class': 'steward-note steward-muted' }).css('padding-top', '8px')
            .text('Newest first. The last ' + cfg.keepBackups + ' per profile are kept. ' +
                  'A backup holds all Steward settings, never the updater\'s own state.'));
        return $card;
    }

    // ---------------------------------------------------------------
    // Section entry points
    // ---------------------------------------------------------------

    function renderSection($main, h) {
        lastMain = $main;
        lastHelpers = h;
        var cfg = U().config();
        h.baseline('updater', cfg);
        var status = U().check.status();

        $main.append(statusCard(h, status, cfg));
        var $release = releaseCard(h, status);
        if ($release) $main.append($release);
        $main.append(optionsCard(h));
        $main.append(versionsCard(h, status, cfg));
        $main.append(backupsCard(h, cfg));
        $main.append($('<div>', { 'class': 'steward-note steward-muted' }).css('padding-top', '8px')
            .text('Profile: ' + U().backups.profile() + '. Option changes apply with Save.'));
    }

    function stillShown() {
        if (!lastMain || !lastMain.length || typeof document === 'undefined') return false;
        if (!$.contains(document.documentElement, lastMain[0])) return false;
        var screen = S.kernel.ui && S.kernel.ui.screen;
        var st = screen && typeof screen.state === 'function' ? screen.state() : null;
        return !!st && st.group === GROUP_ID;
    }

    function redraw() {
        if (!stillShown()) return;
        var $main = lastMain;
        var h = lastHelpers;
        $main.empty();
        try {
            renderSection($main, h);
        } catch (e) {
            S.kernel.error('updater', 'redraw failed:', e);
        }
    }

    function summary() {
        return U().text.summary(U().check.status());
    }

    S.modules.updater.renderSection = renderSection;
    S.modules.updater.summary       = summary;
    S.modules.updater.redraw        = redraw;

}(Steward));
