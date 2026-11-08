/*
 * Settings view ("Steward settings").
 *
 * A side nav on the left and one group at a time on the right:
 *
 *   - General: the kernel's own settings. Logging and Scheduler are cards
 *     of fields bound to the `logger` and `scheduler` namespaces, and About
 *     shows the build and the data folder.
 *   - One group per `misc` module, nav text = its section heading. These
 *     modules have no game area of their own, so they live here instead of
 *     getting a dashboard tab. A module whose buttons act at once
 *     (`runsNow`) is listed under "RUNS AT ONCE", gets the full width and
 *     replaces the footer's idle note, since Save does nothing for it.
 *
 * Every field writes into the shell's settings buffer, so Save and Close
 * work as on the dashboard. The logger and the scheduler show values that
 * may not be stored (the logger's effective config, the running tick), so
 * those are recorded as the baseline: switching a value back counts as no
 * change.
 *
 * A nav click redraws only the main column and moves the active mark; the
 * change dots are toggled in place by chrome(). Nothing in the nav is
 * rebuilt while the screen is open, because a redraw at blur time would
 * swallow the click that caused the blur.
 *
 * Bundle place: after 92_ui_dashboard.js. It only registers the view at
 * load; the shell looks it up when Settings opens.
 */

(function (S) {
    'use strict';

    if (!S.kernel.ui.views) S.kernel.ui.views = {};

    var GENERAL = 'general';

    // Elements of the open screen, rebuilt on every render.
    var refs = { groups: [], items: {}, $main: null };

    function screen() { return S.kernel.ui.screen; }

    // ---------------------------------------------------------------
    // Groups
    // ---------------------------------------------------------------

    // General first, then the misc modules that use Save, then those that
    // act at once. `ns` lists the namespaces whose changes mark the group.
    function groupList() {
        var mods = S.kernel.registry.byTab('misc');
        var saved = [];
        var now = [];
        for (var i = 0; i < mods.length; i++) {
            var sec = mods[i].ui.section;
            var g = { id: mods[i].id, label: sec.heading || sec.title, ns: [mods[i].id],
                      mod: mods[i], runsNow: sec.runsNow === true };
            if (g.runsNow) now.push(g);
            else saved.push(g);
        }
        return [{ id: GENERAL, label: 'General', ns: ['logger', 'scheduler'], mod: null, runsNow: false }]
            .concat(saved, now);
    }

    function findGroup(list, id) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return list[i];
        }
        return null;
    }

    function activeGroup() {
        var st = screen().state();
        return findGroup(refs.groups, st ? st.group : null);
    }

    // ---------------------------------------------------------------
    // General group
    // ---------------------------------------------------------------

    // The buffered value when the user already edited it, else the value in
    // effect; the buffer only holds what is stored or edited.
    function shown(h, ns, key, inEffect) {
        var v = h.get(ns, key);
        return typeof v === 'undefined' ? inEffect : v;
    }

    function loggerToggle(h, key, label, inEffect) {
        return h.toggle({ ns: 'logger', path: key, checked: !!shown(h, 'logger', key, inEffect), label: label });
    }

    // The steward folder is the parent of its logs folder. stewardDir needs
    // a sub folder, and the logger has already created this one.
    function dataFolder() {
        try {
            var files = S.kernel.files;
            if (!files || typeof files.stewardDir !== 'function') return null;
            var r = files.stewardDir('logs');
            var parent = r && r.dir ? r.dir.parent : null;
            return (parent && parent.nativePath) ? parent.nativePath : null;
        } catch (e) {
            return null;
        }
    }

    function renderGeneral($main, h) {
        var sc = screen();
        var parse = S.kernel.ui.settingsParse;
        var show = S.kernel.ui.settingsShow;
        var cfg = S.kernel.log.effective();
        var tick = S.kernel.scheduler.state.tickIntervalMs;
        sc.baseline('logger', cfg);
        sc.baseline('scheduler', { tickInterval: tick });

        var $log = h.card({ icon: '✎', title: sc.nsName('logger') });
        $log.append(h.field('Write the log to a file', 'steward/logs/console.log',
            loggerToggle(h, 'fileEnabled', 'Write the log to a file', cfg.fileEnabled)));
        $log.append(h.field('Include debug lines', 'Much more detail, for bug reports',
            loggerToggle(h, 'debugEnabled', 'Include debug lines', cfg.debugEnabled)));
        $log.append(h.field('Start a new file every day', null,
            loggerToggle(h, 'rotateDaily', 'Start a new file every day', cfg.rotateDaily)));
        $log.append(h.field('Start a new file at', '0 turns this off', h.number({
            ns: 'logger', path: 'maxFileSizeKB', value: shown(h, 'logger', 'maxFileSizeKB', cfg.maxFileSizeKB),
            parse: parse.sizeKB, show: show.mb, unit: 'MB', label: 'Start a new file at'
        })));
        $log.append(h.field('Old files to keep', '0 keeps none', h.number({
            ns: 'logger', path: 'keepRotated', value: shown(h, 'logger', 'keepRotated', cfg.keepRotated),
            parse: parse.whole, unit: 'files', label: 'Old files to keep'
        })));
        $main.append($log);

        // `tickInterval` in ms is the key scheduler.configure reads.
        var $sched = h.card({ icon: '⏱', title: sc.nsName('scheduler') });
        $sched.append(h.field('Check for work every',
            'At least ' + show.seconds(S.kernel.TIMEOUTS.TICK_INTERVAL_MIN_MS) + ' s. Lower is faster but busier.',
            h.number({
                ns: 'scheduler', path: 'tickInterval', value: shown(h, 'scheduler', 'tickInterval', tick),
                parse: parse.tickMs, show: show.seconds, unit: 's', label: 'Check for work every'
            })));
        $main.append($sched);

        var dir = dataFolder();
        var $about = h.card({ title: 'About', meta: 'Build ' + sc.buildLabel() });
        $about.append(h.field('Data folder',
            dir === null ? 'No writable steward folder' : dir + ' · logs, dumps, adventure templates', null));
        $main.append($about);
    }

    // ---------------------------------------------------------------
    // Main column and nav
    // ---------------------------------------------------------------

    function renderMain() {
        var $main = refs.$main;
        var g = activeGroup();
        if (!$main || !g) return;
        var h = S.kernel.ui.helpers;
        $main.empty();
        $main.toggleClass('steward-narrow', !g.runsNow);
        if (!g.mod) {
            renderGeneral($main, h);
            return;
        }
        try {
            g.mod.ui.section.render($main, h);
        } catch (e) {
            S.kernel.error('ui', 'render threw for ' + g.mod.id + ':', e);
            $main.empty();
            $main.append(h.empty('Render failed', 'See the log.'));
        }
    }

    function markActive() {
        var g = activeGroup();
        for (var id in refs.items) {
            if (!Object.prototype.hasOwnProperty.call(refs.items, id)) continue;
            refs.items[id].$item.toggleClass('active', !!g && g.id === id);
        }
    }

    function select(id) {
        var st = screen().state();
        if (!st || !findGroup(refs.groups, id)) return;
        st.group = id;
        markActive();
        renderMain();
        // The footer's idle note depends on the group.
        screen().refreshChrome();
    }

    function navItem(g) {
        var $dot = $('<span>', { 'class': 'steward-snav-dot' }).text('•').css({ display: 'none' });
        var $item = $('<a>', { href: '#', 'class': 'steward-snav-item' })
            .append($('<span>').text(g.label))
            .append($dot);
        $item.on('click', function (e) {
            e.preventDefault();
            try { select(g.id); }
            catch (err) { S.kernel.error('ui', 'settings nav threw:', err); }
        });
        refs.items[g.id] = { $item: $item, $dot: $dot, ns: g.ns };
        return $item;
    }

    function renderNav($nav) {
        var grpShown = false;
        for (var i = 0; i < refs.groups.length; i++) {
            var g = refs.groups[i];
            if (g.runsNow && !grpShown) {
                $nav.append($('<div>', { 'class': 'steward-snav-grp' }).text('RUNS AT ONCE'));
                grpShown = true;
            }
            $nav.append(navItem(g));
        }
    }

    // ---------------------------------------------------------------
    // View hooks
    // ---------------------------------------------------------------

    function render() {
        var sc = screen();
        // The group is settled first so the footer note follows it even
        // when there is no body to draw into.
        refs = { groups: groupList(), items: {}, $main: null };
        var st = sc.state();
        if (st && !findGroup(refs.groups, st.group)) st.group = GENERAL;

        var modal = sc.modal();
        if (!modal) return;
        var $body = modal.Body();
        if (!$body || !$body.length) return;
        $body.empty();

        var $panel = $('<div>', { 'class': 'steward-panel steward-set' });
        if (sc.compact()) $panel.addClass('steward-compact');
        var height = sc.panelHeight('settings');
        if (height !== null) $panel.css({ height: height + 'px' });

        var $cols = $('<div>', { 'class': 'steward-cols' });
        var $nav = $('<div>', { 'class': 'steward-snav' });
        refs.$main = $('<div>', { 'class': 'steward-main' });
        renderNav($nav);
        $cols.append($nav).append(refs.$main);
        $panel.append($cols);
        $body.append($panel);

        markActive();
        renderMain();
        chrome();
    }

    // Change dots, toggled on the existing nav items.
    function chrome() {
        var byNs = screen().changes().byNs;
        for (var id in refs.items) {
            if (!Object.prototype.hasOwnProperty.call(refs.items, id)) continue;
            var it = refs.items[id];
            var on = false;
            for (var i = 0; i < it.ns.length; i++) {
                if (byNs[it.ns[i]] > 0) on = true;
            }
            it.$dot.css({ display: on ? '' : 'none' });
        }
    }

    function idleNote() {
        var g = activeGroup();
        if (g && g.runsNow) return g.label + ' don\'t use Save.';
        return undefined;
    }

    S.kernel.ui.views.settings = {
        render:   render,
        chrome:   chrome,
        idleNote: idleNote
    };

}(Steward));
