/*
 * Dashboard view ("Steward" modal).
 *
 * Layout, top to bottom:
 *   - header extras beside the modal title: a Running/Paused badge and a
 *     one-line summary (modules on, queue depth, build);
 *   - a tab bar: Overview always, then one tab per registry tab that has
 *     modules, in TAB_ORDER. A tab carries a dot when one of its modules has
 *     an enabled flag (lit while one is on and steward is not paused), a
 *     change mark while one of its modules has unsaved changes, and on
 *     Events the number of live events;
 *   - one panel with the active tab.
 *
 * The Overview holds the automation switch, which pauses at once (it is
 * the master pause, not a setting), the queue, tick and build, then one
 * tile per module that declares `tiles`. Tile switches are ordinary
 * buffered settings and wait for Save like every other control.
 *
 * A module tab shows each module as a settings column (`side`) beside its
 * main column (`render`). In a short window (screen.compact()) the panel
 * gets an explicit height and scrolls, and the settings column folds into
 * a one-line strip with the module's summary and a "Show settings" link.
 *
 * Fill areas (`.steward-fill`, the scrolling body of a fill table) take
 * the height left in the panel. AIR's WebKit has neither flex nor calc(),
 * so fit() measures after each tab render, and once more when the modal
 * has been shown, since the first render happens while it is still
 * hidden; a module that redraws part of its tab calls h.fit() to size
 * them again. Measuring never throws: an
 * element that cannot be measured keeps its stylesheet height.
 *
 * A tab draw is one read pass (S.kernel.hostRead.pass): the parts of one draw
 * (strip, side, main, tiles) share core reads and a module's memoized status.
 * Handlers attached during the draw run later, outside the pass.
 *
 * Chrome (header text, tab marks) is updated in place by chrome(), never
 * rebuilt: a Save click first blurs an input whose change refreshes the
 * chrome, and an element replaced at that moment would swallow the click.
 *
 * Bundle place: after 91_ui_helpers.js, whose helpers it renders with at
 * call time; it registers S.kernel.ui.views.dashboard at load, and the
 * shell looks the view up only when the dashboard opens.
 */

(function (S) {
    'use strict';

    if (!S.kernel.ui) S.kernel.ui = {};
    if (!S.kernel.ui.views) S.kernel.ui.views = {};

    // The tab order shown in the bar. `overview` is built here; every other
    // id is a registry tab (40_registry.js). `misc` has no tab: its modules
    // are groups on the Settings screen. Ids stay stable so module specs do
    // not track renames; only the labels are the user's.
    var TAB_ORDER = [
        { id: 'overview',    label: 'Overview' },
        { id: 'specialists', label: 'Explorers' },
        { id: 'geologists',  label: 'Geologists' },
        { id: 'mining',      label: 'Mining' },
        { id: 'buildings',   label: 'Collect' },
        { id: 'events',      label: 'Events' },
        { id: 'production',  label: 'Production' }
    ];

    // Elements of the open dashboard that chrome() and activate() update.
    // Rebuilt on every render, dropped with the modal.
    var dom = { $body: null, $panel: null, $badge: null, $sum: null, tabs: {} };

    // -----------------------------------------------------------------
    // Small reads
    // -----------------------------------------------------------------

    function screen() { return S.kernel.ui.screen; }
    function helpers() { return S.kernel.ui.helpers; }

    function state() {
        var st = screen().state();
        return st || {};
    }

    function isPaused() {
        return typeof S.kernel.ui.isPaused === 'function' && S.kernel.ui.isPaused() === true;
    }

    function queueDepth() {
        try { return S.kernel.queue.depth(); } catch (e) { return 0; }
    }

    function activeEvents() {
        try {
            if (S.core && S.core.events && typeof S.core.events.active === 'function') {
                return S.core.events.active() || [];
            }
        } catch (e) { /* no events readable */ }
        return [];
    }

    function tabMods(tabId) {
        return tabId === 'overview' ? [] : S.kernel.registry.byTab(tabId);
    }

    function isShown(tabId) {
        if (tabId === 'overview') return true;
        for (var i = 0; i < TAB_ORDER.length; i++) {
            if (TAB_ORDER[i].id === tabId) return tabMods(tabId).length > 0;
        }
        return false;
    }

    function modulesOn() {
        var sc = screen();
        var mods = S.kernel.registry.withUi();
        var n = 0;
        for (var i = 0; i < mods.length; i++) {
            if (sc.hasEnabledFlag(mods[i].id) && sc.isModuleEnabled(mods[i].id)) n++;
        }
        return n;
    }

    // -----------------------------------------------------------------
    // Header extras and tab bar
    // -----------------------------------------------------------------

    // The host's Title() is preferred; the header holds the extras so they
    // sit on the title line. Nothing is added when no title is found.
    function findTitle($body) {
        var modal = screen().modal();
        try {
            var $t = (modal && typeof modal.Title === 'function') ? modal.Title() : null;
            if ($t && $t.jquery && $t.length) return $t;
        } catch (e) { /* fall back to the markup */ }
        if (typeof $body.closest !== 'function') return null;
        var $c = $body.closest('.modal-content');
        if (!$c || !$c.length) return null;
        var $found = $('.modal-title', $c);
        return ($found && $found.length) ? $found : null;
    }

    function renderHeader($body) {
        var $title = findTitle($body);
        if (!$title) return;
        var $head = $title.parent();
        if (!$head || !$head.length) return;
        $('.steward-head-extra', $head).remove();
        dom.$badge = $('<span>');
        dom.$sum = $('<span>', { 'class': 'steward-head-sum' });
        $head.append($('<span>', { 'class': 'steward-head-extra' })
            .append(dom.$badge).append(dom.$sum));
        updateHeader();
    }

    function updateHeader() {
        if (!dom.$badge || !dom.$sum) return;
        var paused = isPaused();
        dom.$badge.attr('class', 'steward-badge ' + (paused ? 'steward-b-paused' : 'steward-b-ok'))
            .text(paused ? 'Paused' : 'Running');
        dom.$sum.text(modulesOn() + ' modules on · queue ' + queueDepth() + ' · ' +
            screen().buildLabel());
    }

    function hasFlagged(mods) {
        for (var i = 0; i < mods.length; i++) {
            if (screen().hasEnabledFlag(mods[i].id)) return true;
        }
        return false;
    }

    function anyOn(mods) {
        for (var i = 0; i < mods.length; i++) {
            var id = mods[i].id;
            if (screen().hasEnabledFlag(id) && screen().isModuleEnabled(id)) return true;
        }
        return false;
    }

    function hasChanges(mods, byNs) {
        for (var i = 0; i < mods.length; i++) {
            if (byNs[mods[i].id] > 0) return true;
        }
        return false;
    }

    function renderTabs($body) {
        var $tabs = $('<div>', { 'class': 'steward-tabs' });
        dom.tabs = {};
        for (var i = 0; i < TAB_ORDER.length; i++) {
            if (!isShown(TAB_ORDER[i].id)) continue;
            (function (tab) {
                var mods = tabMods(tab.id);
                var $a = $('<a>', { href: '#', 'class': 'steward-tab', 'data-tab': tab.id }).text(tab.label);
                var rec = { $a: $a, $dot: null, $chg: null };
                if (hasFlagged(mods)) {
                    rec.$dot = $('<span>', { 'class': 'steward-tab-dot' });
                    $a.append(rec.$dot);
                }
                if (mods.length) {
                    rec.$chg = $('<span>', { 'class': 'steward-tab-chg', title: 'unsaved change' })
                        .text('•').css('display', 'none');
                    $a.append(rec.$chg);
                }
                if (tab.id === 'events') {
                    var n = activeEvents().length;
                    if (n > 0) $a.append($('<span>', { 'class': 'steward-tab-cnt' }).text(String(n)));
                }
                $a.on('click', function (e) {
                    e.preventDefault();
                    activate(tab.id);
                });
                dom.tabs[tab.id] = rec;
                $tabs.append($a);
            }(TAB_ORDER[i]));
        }
        $body.append($tabs);
        updateTabMarks();
    }

    function updateTabMarks() {
        var byNs = screen().changes().byNs || {};
        var paused = isPaused();
        for (var id in dom.tabs) {
            if (!dom.tabs.hasOwnProperty(id)) continue;
            var rec = dom.tabs[id];
            var mods = tabMods(id);
            if (rec.$dot) rec.$dot.toggleClass('steward-live', !paused && anyOn(mods));
            if (rec.$chg) rec.$chg.css('display', hasChanges(mods, byNs) ? '' : 'none');
        }
    }

    // -----------------------------------------------------------------
    // Render and tab switching
    // -----------------------------------------------------------------

    function render() {
        var modal = screen().modal();
        if (!modal) return;
        var $body = modal.Body();
        if (!$body || !$body.length) return;
        $body.empty();
        dom = { $body: $body, $panel: null, $badge: null, $sum: null, tabs: {} };

        renderHeader($body);
        renderTabs($body);

        var $panel = $('<div>', { 'class': 'steward-panel' });
        if (screen().compact()) {
            $panel.addClass('steward-compact');
            var ph = screen().panelHeight('dashboard');
            if (typeof ph === 'number') $panel.css('height', ph + 'px');
        }
        $body.append($panel);
        dom.$panel = $panel;

        activate(state().tab);
        fitWhenShown(modal, $body);
    }

    // The shell renders before Modal.show(), so the fit() above measures a
    // hidden modal: offsets read as zero and every fill gets roughly the
    // whole panel. Bootstrap fires shown.bs.modal once the modal is visible
    // (after the fade), so the fills are sized again then, once. The
    // namespace lets a re-render drop a handler still waiting from the last
    // one. An already visible modal measured correctly and needs nothing.
    function modalElement(modal, $body) {
        if (typeof $body.closest === 'function') {
            var $m = $body.closest('.modal');
            if ($m && $m.length) return $m;
        }
        if (modal && typeof modal.id === 'string' && modal.id) {
            var $byId = $(modal.id);
            if ($byId && $byId.length) return $byId;
        }
        return null;
    }

    function fitWhenShown(modal, $body) {
        try {
            var $m = modalElement(modal, $body);
            if (!$m || typeof $m.on !== 'function' || typeof $m.off !== 'function') return;
            if (typeof $m.is === 'function' && $m.is(':visible')) return;
            $m.off('shown.bs.modal.stewardfit');
            $m.on('shown.bs.modal.stewardfit', function () {
                $m.off('shown.bs.modal.stewardfit');
                fit();
            });
        } catch (e) {
            S.kernel.debug('ui', 'fill sizing on show skipped:', e && e.message ? e.message : e);
        }
    }

    function activate(tabId) {
        if (!dom.$panel) return;
        if (!tabId || !isShown(tabId)) tabId = 'overview';
        var st = state();
        st.tab = tabId;
        st.expanded = false;
        for (var id in dom.tabs) {
            if (dom.tabs.hasOwnProperty(id)) dom.tabs[id].$a.toggleClass('active', id === tabId);
        }
        drawTab();
    }

    function drawTab() {
        var tabId = state().tab;
        dom.$panel.empty();
        // One pass per draw: the strip, side, main column and tiles of a tab
        // share core reads, so a status never differs between two parts.
        // Handlers attached here run later, outside the pass.
        S.kernel.hostRead.pass(function () {
            if (tabId === 'overview') renderOverview(dom.$panel);
            else renderModuleTab(dom.$panel, tabId);
        });
        fit();
    }

    function chrome() {
        updateHeader();
        updateTabMarks();
    }

    // -----------------------------------------------------------------
    // Overview
    // -----------------------------------------------------------------

    function automationValue(h) {
        var running = !isPaused();
        var $v = $('<span>');
        $v.append(h.toggle({
            checked:  running,
            label:    'Automation',
            onChange: function (on) {
                if (on) S.kernel.ui.resume();
                else S.kernel.ui.pause();
                if (state().tab === 'overview') drawTab();
                chrome();
            }
        }));
        $v.append($('<span>').text(running ? ' Running ' : ' Paused '));
        $v.append($('<span>', { 'class': 'steward-muted' }).text(running
            ? 'switch off to pause everything'
            : 'nothing is sent until you switch it on'));
        return $v;
    }

    function tickSeconds() {
        var ms = S.kernel.scheduler && S.kernel.scheduler.state
            ? S.kernel.scheduler.state.tickIntervalMs : null;
        if (typeof ms !== 'number') return '?';
        return String(S.kernel.ui.settingsShow.seconds(ms));
    }

    // Tab rank for tile order: the bar's order, with `misc` modules placed
    // just before Events; anything else last.
    function tileRanks() {
        var order = [];
        for (var i = 0; i < TAB_ORDER.length; i++) {
            if (TAB_ORDER[i].id === 'overview') continue;
            if (TAB_ORDER[i].id === 'events') order.push('misc');
            order.push(TAB_ORDER[i].id);
        }
        if (order.indexOf('misc') < 0) order.push('misc');
        return order;
    }

    function tileModules() {
        var mods = S.kernel.registry.withUi();
        var order = tileRanks();
        var out = [];
        var r, i;
        for (r = 0; r < order.length; r++) {
            for (i = 0; i < mods.length; i++) {
                if (mods[i].ui.tab === order[r] && typeof mods[i].ui.section.tiles === 'function') {
                    out.push(mods[i]);
                }
            }
        }
        for (i = 0; i < mods.length; i++) {
            if (order.indexOf(mods[i].ui.tab) < 0 && typeof mods[i].ui.section.tiles === 'function') {
                out.push(mods[i]);
            }
        }
        return out;
    }

    function tileBadge(h, mod, tile) {
        if (tile.badge && typeof tile.badge === 'object') return h.badge(tile.badge.kind, tile.badge.text);
        if (!screen().hasEnabledFlag(mod.id)) return null;
        if (isPaused()) return h.badge('paused', 'Paused');
        if (h.get(mod.id, 'enabled')) return h.badge('ok', 'On');
        return h.badge('off', 'Off');
    }

    function tileLinks(h, mod, tile) {
        var links = tile.links;
        if (!links) {
            links = isShown(mod.ui.tab) && mod.ui.tab !== 'misc' ? [{ label: 'Open', tab: mod.ui.tab }] : [];
        }
        var out = [];
        for (var i = 0; i < links.length; i++) {
            (function (ln) {
                if (!ln) return;
                out.push(h.link(ln.label, function () {
                    if (ln.tab) {
                        activate(ln.tab);
                    } else if (typeof ln.onClick === 'function') {
                        try { ln.onClick(); }
                        catch (e) { S.kernel.error('ui', 'tile link threw for', mod.id, ':', e); }
                    }
                }));
            }(links[i]));
        }
        return out;
    }

    function renderTile(h, mod, tile) {
        var sec = mod.ui.section;
        var $t = $('<div>', { 'class': 'steward-tile' });

        // The switch floats right, so it goes before the title text.
        var $h = $('<div>', { 'class': 'steward-tile-h' });
        if (tile.toggle !== false && screen().hasEnabledFlag(mod.id)) {
            $h.append(h.toggle({
                ns:       mod.id,
                path:     'enabled',
                label:    (tile.title || sec.heading) + ' on or off',
                onChange: function () { if (state().tab === 'overview') drawTab(); }
            }));
        }
        var icon = tile.icon || sec.icon;
        if (icon) $h.append($('<span>', { 'class': 'steward-icon' }).text(icon));
        $h.append($('<span>').text(tile.title || sec.heading || sec.title));
        $t.append($h);

        var lines = tile.lines || [];
        for (var i = 0; i < lines.length; i++) {
            var $l = $('<div>', { 'class': 'steward-tile-line' });
            if (i >= 1) $l.addClass('steward-muted');
            if (lines[i] && lines[i].jquery) $l.append(lines[i]);
            else $l.text(lines[i] === null || lines[i] === undefined ? '' : String(lines[i]));
            $t.append($l);
        }

        var $foot = $('<div>', { 'class': 'steward-tile-foot' });
        var $badge = tileBadge(h, mod, tile);
        if ($badge) $foot.append($badge);
        var links = tileLinks(h, mod, tile);
        for (var k = 0; k < links.length; k++) $foot.append(links[k]);
        $t.append($foot);
        return $t;
    }

    function renderOverview($panel) {
        var h = helpers();
        var $stack = $('<div>', { 'class': 'steward-stack' });

        $stack.append($('<div>', { 'class': 'steward-card' }).append(h.stats([
            { k: 'Automation', $v: automationValue(h) },
            { k: 'Queue', v: queueDepth(), small: 'actions waiting' },
            { k: 'Scheduler', v: tickSeconds() + ' s', small: 'tick' },
            { k: 'Build', v: screen().buildLabel() }
        ])));

        var mods = tileModules();
        var $tiles = [];
        for (var i = 0; i < mods.length; i++) {
            var list = null;
            try {
                list = mods[i].ui.section.tiles(h);
            } catch (e) {
                S.kernel.error('ui', 'tiles threw for', mods[i].id, ':', e);
                continue;
            }
            if (!list || typeof list.length !== 'number') continue;
            for (var k = 0; k < list.length; k++) {
                if (!list[k]) continue;
                try {
                    $tiles.push(renderTile(h, mods[i], list[k]));
                } catch (e2) {
                    S.kernel.error('ui', 'tiles threw for', mods[i].id, ':', e2);
                }
            }
        }
        if ($tiles.length) $stack.append(h.grid(screen().compact() ? 2 : 3, $tiles));
        $panel.append($stack);
    }

    // -----------------------------------------------------------------
    // Module tabs
    // -----------------------------------------------------------------

    function runPart(mod, fn, $target, h) {
        try {
            fn($target, h);
        } catch (e) {
            S.kernel.error('ui', 'render threw for', mod.id, ':', e);
            $target.append(h.empty('Render failed', 'See the log.'));
        }
    }

    function stripText(mod, h) {
        var sec = mod.ui.section;
        if (typeof sec.summary !== 'function') return '';
        try {
            var s = sec.summary(h);
            return (s === null || s === undefined) ? '' : String(s);
        } catch (e) {
            S.kernel.error('ui', 'render threw for', mod.id, ':', e);
            return '';
        }
    }

    function strip(mod, h, expanded) {
        var sec = mod.ui.section;
        var $s = $('<div>', { 'class': 'steward-strip' });
        $s.append($('<span>').text(sec.heading || sec.title));
        if (screen().hasEnabledFlag(mod.id)) {
            $s.append(h.toggle({ ns: mod.id, path: 'enabled', label: (sec.heading || sec.title) + ' on or off' }));
        }
        $s.append($('<span>', { 'class': 'steward-strip-sum' }).text(stripText(mod, h)));
        var $lnk = $('<button>', { type: 'button', 'class': 'steward-strip-link' })
            .text(expanded ? 'Hide settings' : 'Show settings');
        $lnk.on('click', function (e) {
            e.preventDefault();
            state().expanded = !expanded;
            drawTab();
        });
        $s.append($lnk);
        return $('<div>', { 'class': 'steward-card' }).append($s);
    }

    function renderModule($panel, mod, h) {
        var sec = mod.ui.section;
        if (typeof sec.side !== 'function') {
            runPart(mod, sec.render, $panel, h);
            return;
        }
        var $side = $('<div>', { 'class': 'steward-side' });
        if (sec.wide) $side.addClass('steward-wide');
        var $main = $('<div>', { 'class': 'steward-main' });

        if (!screen().compact()) {
            runPart(mod, sec.side, $side, h);
            runPart(mod, sec.render, $main, h);
            $panel.append($('<div>', { 'class': 'steward-cols' }).append($side).append($main));
            return;
        }
        var expanded = state().expanded === true;
        var $stack = $('<div>', { 'class': 'steward-stack' });
        $stack.append(strip(mod, h, expanded));
        if (expanded) {
            runPart(mod, sec.side, $side, h);
            $stack.append($side);
        }
        runPart(mod, sec.render, $main, h);
        $stack.append($main);
        $panel.append($stack);
    }

    function renderModuleTab($panel, tabId) {
        var h = helpers();
        var mods = tabMods(tabId);
        for (var i = 0; i < mods.length; i++) renderModule($panel, mods[i], h);
    }

    // -----------------------------------------------------------------
    // Fill heights
    // -----------------------------------------------------------------

    function bottomOf($el) { return $el.offset().top + $el.outerHeight(); }

    // Each fill takes what is left between its top and the panel's inner
    // bottom, less whatever its card shows below it. Fills start at zero
    // so the card's own height is measured without them.
    function sizeFills($panel) {
        if (!$panel || !$panel.length) return;
        if (typeof $panel.offset !== 'function' || typeof $panel.outerHeight !== 'function') return;
        var $fills = $('.steward-fill', $panel);
        if (!$fills || !$fills.length) return;
        try {
            var pad = parseFloat($panel.css('padding-bottom'));
            var innerBottom = bottomOf($panel) - (isFinite(pad) ? pad : 0);
            $fills.each(function () {
                var $f = $(this);
                $f.css('height', '0px');
                var $card = $f.closest('.steward-card');
                var below = ($card && $card.length) ? bottomOf($card) - bottomOf($f) : 0;
                var top = $f.offset().top;
                var hgt = Math.max(80, Math.floor(innerBottom - top - below - 2));
                if (!isFinite(hgt)) throw new Error('no size for a fill area');
                $f.css('height', hgt + 'px');
            });
        } catch (e) {
            try { $fills.css('height', ''); } catch (e2) { /* stays as is */ }
            S.kernel.debug('ui', 'fill sizing skipped:', e && e.message ? e.message : e);
        }
    }

    // A scrolling compact panel keeps its fills at the stylesheet height.
    function fit() {
        if (!dom.$panel || !screen() || !screen().modal()) return;
        if (screen().compact()) return;
        sizeFills(dom.$panel);
    }

    // -----------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------

    S.kernel.ui.TAB_ORDER = TAB_ORDER;
    S.kernel.ui.views.dashboard = {
        render:    render,
        chrome:    chrome,
        fit:       fit,
        sizeFills: sizeFills
    };

}(Steward));
