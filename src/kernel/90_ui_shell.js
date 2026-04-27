/*
 * In-game UI shell.
 *
 * Two surfaces:
 *
 *   1. Native menu — minimal: master pause toggle + "Open Dashboard…"
 *      entry. Modules don't decorate it any more; the dashboard is the
 *      single configuration surface.
 *
 *   2. Dashboard modal — autoTSO-mirror layout:
 *        ┌──────────────────────────────────┐
 *        │ Title bar                        │
 *        ├──────────────────────────────────┤
 *        │ [tab] [tab] [tab] [tab] [tab]    │
 *        ├──────────────────────────────────┤
 *        │ ╔══ section band ═══════════╗    │
 *        │ │  rows… (label | control)  │    │
 *        │ ╚═══════════════════════════╝    │
 *        │ ╔══ section band ═══════════╗    │
 *        │ ╚═══════════════════════════╝    │
 *        ├──────────────────────────────────┤
 *        │ Save                       Close │
 *        └──────────────────────────────────┘
 *      Tabs: Status | Specialists | Quests | Buildings | Tools | Misc
 *      (Mail/Trades is intentionally deferred until those modules ship.)
 *
 * Settings buffer (explicit Save semantics):
 *   - Modal opens → buffer snapshot of each module's settings.
 *   - Modules render via helpers.settings(id) which proxies the buffer.
 *   - Save → flushes dirty modules. Close → discards.
 */

(function (S) {

    // -----------------------------------------------------------------
    // State
    // -----------------------------------------------------------------

    var statusText = 'Steward online';
    var statusItem = null;
    var pauseItem = null;
    var initAttempts = 0;
    var initialized = false;
    var paused = false;

    var dashboard = {
        modal:     null,
        modalId:   'StewardDashboard',
        activeTab: null,
        buffer:    {},
        dirty:     {},
        saveBtn:   null
    };

    // The tab order shown in the bar — must match what the registry
    // accepts (see 40_registry.js). Status is built-in; the rest are
    // module-populated. Mail/Trades is omitted (deferred to a later phase).
    // Internal `id` strings stay stable so module ui specs (and the registry's
    // TABS set) don't have to track renames. Only the user-visible `label`
    // changes here.
    var TAB_ORDER = [
        { id: 'status',      label: 'Status' },
        { id: 'specialists', label: 'Explorers' },
        { id: 'quests',      label: 'Quests' },
        { id: 'buildings',   label: 'Collections & Buildings' },
        { id: 'tools',       label: 'Tools' },
        { id: 'misc',        label: 'Misc' }
    ];

    // -----------------------------------------------------------------
    // Native menu plumbing
    // -----------------------------------------------------------------

    function nativeMenuAvailable() {
        try {
            return typeof window !== 'undefined' &&
                   window.nativeWindow &&
                   window.nativeWindow.menu &&
                   typeof air !== 'undefined' &&
                   air.NativeMenuItem;
        } catch (e) { return false; }
    }

    function removeIfPresent(menu, name) {
        try {
            var existing = menu.getItemByName ? menu.getItemByName(name) : null;
            if (existing) menu.removeItem(existing);
        } catch (e) { /* ignore */ }
    }

    function pauseLabel() { return paused ? 'Steward: ✕ Paused' : 'Steward: ✓ Active'; }

    function statusLabel() {
        var n = 0;
        try { n = S.kernel.registry.count(); } catch (e) { /* ignore */ }
        return (paused ? 'Paused' : 'Active') + ' — ' + n + ' module' + (n === 1 ? '' : 's');
    }

    // Adaptive placement: the host's `mainSettings.menuStyle` decides whether
    // we land at the menu-bar root ("grouped") or nested in Tools (anything
    // else). See HOST_INTEGRATION.md.
    function attachContainer() {
        var rootMenu = window.nativeWindow.menu;
        var style = (S.kernel.host && S.kernel.host.menuStyle) ? S.kernel.host.menuStyle() : 'grouped';
        if (style === 'grouped') return { container: rootMenu, mode: 'top-level' };
        try {
            var toolsItem = rootMenu.getItemByName ? rootMenu.getItemByName('Tools') : null;
            if (toolsItem && toolsItem.submenu) {
                return { container: toolsItem.submenu, mode: 'tools' };
            }
        } catch (e) { /* fall through */ }
        return { container: rootMenu, mode: 'top-level' };
    }

    function rebuildNativeMenu() {
        if (!nativeMenuAvailable()) return false;
        try {
            var attach = attachContainer();
            var container = attach.container;
            removeIfPresent(container, 'StewardRoot');
            // If mode flipped between rebuilds, also clean the *other* container
            // so we don't leave orphan entries behind.
            if (attach.mode === 'tools') {
                removeIfPresent(window.nativeWindow.menu, 'StewardRoot');
            }

            var root = new air.NativeMenuItem('~Steward~');
            root.name = 'StewardRoot';
            var sub = new air.NativeMenu();

            pauseItem = new air.NativeMenuItem(pauseLabel());
            pauseItem.name = 'StewardPause';
            pauseItem.enabled = true;
            try { pauseItem.addEventListener(air.Event.SELECT, togglePause); }
            catch (e) { /* ignore */ }
            sub.addItem(pauseItem);

            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* sep */ }

            statusItem = new air.NativeMenuItem(statusText || statusLabel());
            statusItem.name = 'StewardStatus';
            statusItem.enabled = false;
            sub.addItem(statusItem);

            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* sep */ }

            var openItem = new air.NativeMenuItem('Open Dashboard…');
            openItem.name = 'StewardOpenDashboard';
            openItem.enabled = true;
            try { openItem.addEventListener(air.Event.SELECT, function () { openDashboard(); }); }
            catch (e) { /* ignore */ }
            sub.addItem(openItem);

            // Per-module quick-toggles. Each enabled-aware module surfaces a
            // single entry showing its current state — clicking flips
            // settings.<id>.enabled and refreshes the menu. autoTSO has the
            // equivalent under "Start/Stop X Auto".
            try { sub.addItem(new air.NativeMenuItem('', true)); } catch (e) { /* sep */ }
            appendModuleQuickToggles(sub);

            root.submenu = sub;
            container.addItem(root);
            S.kernel.debug('ui', 'menu rebuilt — mode:', attach.mode);
            return true;
        } catch (e) {
            S.kernel.error('ui', 'rebuildNativeMenu failed:', e);
            return false;
        }
    }

    function refreshNativeMenu() { if (initialized) rebuildNativeMenu(); }

    // Surface a quick-toggle for every dashboard-aware module that has an
    // `enabled` settings flag. Click the entry to flip it without opening
    // the modal. Mirrors autoTSO's "Start/Stop X Auto" entries. Modules
    // that don't expose `enabled` (e.g. diagnostics — read-only probes)
    // are skipped automatically.
    function appendModuleQuickToggles(sub) {
        try {
            var mods = S.kernel.registry.withUi();
            for (var i = 0; i < mods.length; i++) {
                appendOneToggle(sub, mods[i]);
            }
        } catch (e) {
            S.kernel.error('ui', 'appendModuleQuickToggles threw:', e);
        }
    }

    function appendOneToggle(sub, mod) {
        var s = S.kernel.settings.read(mod.id);
        if (!s || typeof s.enabled === 'undefined') return;
        var label = (s.enabled ? '✓ ' : '✕ ') + mod.ui.section.title;
        var item = new air.NativeMenuItem(label);
        item.name = 'StewardModuleToggle_' + mod.id;
        item.enabled = true;
        try {
            item.addEventListener(air.Event.SELECT, function () {
                toggleModuleEnabled(mod.id);
            });
        } catch (e) { /* ignore */ }
        sub.addItem(item);
    }

    function toggleModuleEnabled(moduleId) {
        try {
            var s = S.kernel.settings.read(moduleId) || {};
            s.enabled = !s.enabled;
            S.kernel.settings.write(moduleId, s);
            S.kernel.log('ui', 'quick-toggle', moduleId, '→', s.enabled);
            // Cancel pending queue work the moment the user disables a module —
            // matches the buffered-Save flow's behaviour for the same flip.
            if (!s.enabled && S.kernel.queue && S.kernel.queue.cancelByModule) {
                S.kernel.queue.cancelByModule(moduleId);
            }
            refreshNativeMenu();
        } catch (e) {
            S.kernel.error('ui', 'toggleModuleEnabled threw:', e);
        }
    }

    function init() {
        if (initialized) { rebuildNativeMenu(); return; }
        if (!nativeMenuAvailable()) {
            initAttempts++;
            if (initAttempts >= S.kernel.TIMEOUTS.UI_INIT_MAX_ATTEMPTS) {
                S.kernel.warn('ui', 'native menu unavailable after', initAttempts, 'attempts — giving up');
                return;
            }
            setTimeout(init, S.kernel.TIMEOUTS.UI_INIT_RETRY_MS);
            return;
        }
        initialized = rebuildNativeMenu();
        if (initialized) S.kernel.log('ui', 'menu initialized');
    }

    // -----------------------------------------------------------------
    // Pause control
    // -----------------------------------------------------------------

    function persistPaused() {
        try {
            var s = S.kernel.settings.read('kernel') || {};
            s.paused = paused;
            S.kernel.settings.write('kernel', s);
        } catch (e) { S.kernel.warn('ui', 'failed to persist paused state:', e); }
    }

    function applyPause() {
        try {
            if (paused) {
                if (S.kernel.scheduler && S.kernel.scheduler.stop) S.kernel.scheduler.stop();
                if (S.kernel.queue && S.kernel.queue.reset) S.kernel.queue.reset();
            } else {
                if (S.kernel.scheduler && S.kernel.scheduler.start) S.kernel.scheduler.start();
            }
        } catch (e) { S.kernel.error('ui', 'applyPause threw:', e); }
    }

    function setPaused(value, opts) {
        var next = value === true;
        if (next === paused) return;
        paused = next;
        opts = opts || {};
        S.kernel.log('ui', paused ? 'paused' : 'resumed');
        applyPause();
        if (opts.persist !== false) persistPaused();
        refreshStatus();
    }

    function togglePause() { setPaused(!paused); }
    function isPaused() { return paused; }

    function setStatus(text) {
        statusText = text || '';
        if (statusItem) {
            try { statusItem.label = statusText; } catch (e) { /* invalidated */ }
        }
    }

    function refreshStatus() {
        try {
            setStatus(statusLabel());
            if (pauseItem) {
                try { pauseItem.label = pauseLabel(); } catch (e) { /* invalidated */ }
            }
            refreshNativeMenu();
        } catch (e) { /* ignore */ }
    }

    function isModuleEnabled(moduleId) {
        var s = S.kernel.settings.read(moduleId);
        return !!(s && s.enabled);
    }

    // Surface a transient message to the user via the host's alert system.
    // Best-effort — silently no-ops if the host isn't ready (e.g., very
    // early boot).
    function notify(text) {
        try {
            if (typeof showGameAlert === 'function') {
                showGameAlert('Steward: ' + text);
            }
        } catch (e) { /* best effort */ }
    }

    // -----------------------------------------------------------------
    // Dashboard modal — autoTSO-mirror layout
    // -----------------------------------------------------------------

    // Inject the scoped stylesheet on first dashboard open. The host's
    // bootstrap.min.css forces .modal-body { height:60% } and a parchment
    // background image; both need overriding with !important.
    function ensureDashboardStyle() {
        if (document.getElementById('steward-dashboard-style')) return;
        var css = [
            // ---- modal frame ----
            // The host paints the wood chrome on .modal-header / .modal-body /
            // .modal-footer (window_top.png + window_middle.png + window_bottom.png).
            // We DON'T override those — autoTSO uses exactly the same chrome
            // and looks great. We only override layout (padding, height) and
            // our colour palette.
            '#StewardDashboard .modal-dialog{width:1000px;max-width:96%;}',
            '#StewardDashboard .modal-content{color:#e8e1cf;}',

            // ---- title bar (keep wood background) ----
            '#StewardDashboard .modal-header{padding:14px 22px 12px !important;' +
                'border-bottom:1px solid rgba(0,0,0,.3);}',
            // Pure white + a soft dark text-shadow so the title pops off the
            // wood regardless of how the host renders window_top.png.
            '#StewardDashboard .modal-header .modal-title,' +
                '#StewardDashboard .modal-header h4{color:#fff;font-size:20px;' +
                'font-weight:600;letter-spacing:.3px;margin:0;' +
                'text-shadow:0 1px 2px rgba(0,0,0,.6);}',
            '#StewardDashboard .modal-header .close{color:#f8f1d9;opacity:.85;' +
                'text-shadow:none;font-size:24px;line-height:1;}',
            '#StewardDashboard .modal-header .close:hover{color:#fff;opacity:1;}',

            // ---- body (keep wood background, override host .modal-body { height:60%; padding:15px }) ----
            '#StewardDashboard .modal-body{padding:0 !important;height:auto !important;' +
                'overflow:visible;color:#e8e1cf;}',

            // ---- tab bar ----
            '#StewardDashboard .steward-tabs{display:block;padding:12px 20px 0;' +
                'border-bottom:1px solid rgba(0,0,0,.3);}',
            '#StewardDashboard .steward-tabs:after{content:"";display:block;clear:both;height:0;}',
            '#StewardDashboard .steward-tab{float:left;padding:9px 22px;color:#5dade2;' +
                'text-decoration:none;font-size:15px;font-weight:500;cursor:pointer;' +
                'border-radius:6px 6px 0 0;margin-right:4px;}',
            '#StewardDashboard .steward-tab:hover{background:rgba(93,173,226,.12);' +
                'color:#5dade2;text-decoration:none;}',
            '#StewardDashboard .steward-tab.active{background:#3d8fc6;color:#fff;}',
            '#StewardDashboard .steward-tab.active:hover{background:#3d8fc6;color:#fff;}',

            // ---- panel (per-tab content) ----
            '#StewardDashboard .steward-panel{padding:16px 22px 20px;height:480px;' +
                'overflow-y:auto;}',

            // ---- section header / form rows ----
            // Sections render as a flat sequence of BS3 rows on the panel.
            // The header row uses cells with the host's `tblHeader` class
            // (parchment + black text + 23px height — defined in
            // bootstrap.min.css). Form rows are plain BS3 .row with col-*
            // cells from gridRow().
            //
            // tblHeader rounded corners are applied to the first / last cell
            // of each header (matches utils.createTableRow output).
            '#StewardDashboard .steward-row{margin:0;padding:6px 0;font-size:13px;' +
                'color:#e8e1cf;border-bottom:1px solid rgba(0,0,0,.15);}',
            '#StewardDashboard .steward-row:last-child{border-bottom:none;}',
            '#StewardDashboard .steward-row-disabled{background:rgba(120,40,30,.25);}',
            '#StewardDashboard .steward-row-ctl{text-align:right;}',
            '#StewardDashboard .steward-row-help{color:#a09a85;font-size:11px;' +
                'margin-left:8px;}',
            '#StewardDashboard .steward-row-hint{color:#b8b0a3;font-size:12px;' +
                'padding-left:18px;}',

            '#StewardDashboard .tblHeader{padding-top:3px !important;' +
                'padding-bottom:3px !important;line-height:23px;' +
                'font-weight:600;}',
            '#StewardDashboard .steward-tbl-first{border-radius:10px 0 0 10px;}',
            '#StewardDashboard .steward-tbl-last{border-radius:0 10px 10px 0;}',
            '#StewardDashboard .steward-section-title{font-size:14px;color:#000;}',
            '#StewardDashboard .steward-section-icon{display:inline-block;' +
                'margin-right:4px;}',
            '#StewardDashboard .steward-section-action{color:#2c5fb5;' +
                'text-decoration:none;font-size:13px;font-weight:500;' +
                'float:right;line-height:23px;}',
            '#StewardDashboard .steward-section-action:hover{text-decoration:underline;' +
                'color:#2c5fb5;}',

            // Pad the row that follows a tblHeader so the table doesn't feel
            // crammed against the band.
            '#StewardDashboard .row.steward-row{padding-left:14px;padding-right:14px;}',

            // Idle/busy variants of a per-explorer row — different accent
            // colour without changing the underlying row layout.
            '#StewardDashboard .row.steward-row-idle{color:#cfe6ce;}',
            '#StewardDashboard .row.steward-row-busy{color:#d8c89c;}',

            // ---- input / dropdown ----
            '#StewardDashboard .steward-input,' +
                '#StewardDashboard .steward-dropdown{background:linear-gradient(180deg,#f5e8c8 0%,#e0c898 100%);' +
                'color:#2a2418;border:1px solid #5a4a30;border-radius:3px;' +
                'padding:5px 10px;font-size:13px;font-family:inherit;' +
                'box-shadow:0 1px 0 rgba(255,255,255,.3) inset;line-height:normal;}',
            '#StewardDashboard .steward-dropdown{padding-right:24px;cursor:pointer;}',

            // ---- button ----
            '#StewardDashboard .steward-btn{background:linear-gradient(180deg,#f5e8c8 0%,#e0c898 100%);' +
                'color:#2a2418;border:1px solid #5a4a30;padding:6px 22px;' +
                'border-radius:4px;font-size:13px;font-weight:500;font-family:inherit;' +
                'cursor:pointer;line-height:normal;' +
                'box-shadow:0 1px 0 rgba(255,255,255,.4) inset,0 1px 2px rgba(0,0,0,.3);}',
            '#StewardDashboard .steward-btn:hover{background:linear-gradient(180deg,#faedd2,#e8d2a8);}',
            '#StewardDashboard .steward-btn-sm{padding:3px 12px;font-size:12px;}',

            // ---- decorative bits ----
            '#StewardDashboard .steward-help-i{display:inline-block;width:18px;height:18px;' +
                'border-radius:50%;background:#5dade2;color:#fff;font-style:italic;' +
                'font-size:11px;font-weight:600;line-height:18px;text-align:center;' +
                'margin-left:6px;cursor:help;vertical-align:middle;}',
            '#StewardDashboard .steward-new-badge{display:inline-block;' +
                'background:linear-gradient(180deg,#e34a3c,#b8362a);color:#fff;' +
                'font-size:9px;font-weight:700;padding:2px 6px;border-radius:8px;' +
                'letter-spacing:.5px;border:1px solid #5a1a14;margin-left:6px;' +
                'vertical-align:middle;}',
            '#StewardDashboard code{background:rgba(255,255,255,.06);color:#d8d0bd;' +
                'padding:1px 5px;border-radius:2px;font-size:11px;}',
            '#StewardDashboard strong{color:#f5e9c4;}',

            // ---- footer (keep wood background) ----
            '#StewardDashboard .modal-footer{padding:12px 22px !important;' +
                'border-top:1px solid rgba(0,0,0,.4);text-align:left;margin:0;}',
            '#StewardDashboard .modal-footer:after{content:"";display:block;clear:both;height:0;}',
            '#StewardDashboard .modal-footer .steward-btn{margin:0;}',
            '#StewardDashboard .modal-footer .steward-btn-save{float:left;}',
            '#StewardDashboard .modal-footer .steward-btn-close{float:right;}',
            '#StewardDashboard .modal-footer .steward-btn[disabled]{opacity:.5;cursor:default;}'
        ].join('');
        var $style = $('<style>', { type: 'text/css', id: 'steward-dashboard-style' });
        if ($style[0].styleSheet) $style[0].styleSheet.cssText = css;
        else                       $style[0].appendChild(document.createTextNode(css));
        $('head').append($style);
    }

    function openDashboard(initialTabId) {
        if (typeof Modal === 'undefined') {
            S.kernel.error('ui', 'host Modal class unavailable — cannot open dashboard');
            return;
        }
        ensureDashboardStyle();
        dashboard.buffer = {};
        dashboard.dirty = {};
        dashboard.activeTab = initialTabId || 'specialists';
        try {
            dashboard.modal = new Modal(dashboard.modalId, 'Steward — Auto Settings', true);
            dashboard.modal.create();
            renderDashboard();
            dashboard.modal.show();
        } catch (e) {
            S.kernel.error('ui', 'openDashboard threw:', e);
        }
    }

    function closeDashboard(commit) {
        if (commit && hasDirty()) {
            flushBuffers();
            notify('Configuration saved');
        } else if (!commit && hasDirty()) {
            // Notify modules that buffered changes were thrown away so they
            // can repaint any stale state derived from the buffer.
            for (var moduleId in dashboard.dirty) {
                if (!dashboard.dirty[moduleId]) continue;
                var mod = S.kernel.registry.get(moduleId);
                if (mod && mod.ui && mod.ui.section && typeof mod.ui.section.onCancel === 'function') {
                    try { mod.ui.section.onCancel(); }
                    catch (e) { S.kernel.error('ui', moduleId, 'onCancel threw:', e); }
                }
            }
        }
        dashboard.buffer = {};
        dashboard.dirty = {};
        if (dashboard.modal) {
            try { dashboard.modal.hide(); } catch (e) { /* ignore */ }
        }
    }

    function renderDashboard() {
        if (!dashboard.modal) return;
        var $body = dashboard.modal.Body();
        if (!$body || !$body.length) return;
        $body.empty();

        // Tab bar.
        var $tabs = $('<div>', { 'class': 'steward-tabs' });
        for (var i = 0; i < TAB_ORDER.length; i++) {
            (function (tab) {
                var $a = $('<a>', {
                    'href':       '#',
                    'class':      'steward-tab' + (tab.id === dashboard.activeTab ? ' active' : ''),
                    'data-tab':   tab.id
                }).text(tab.label);
                $a.on('click', function (e) {
                    e.preventDefault();
                    activateTab(tab.id);
                });
                $tabs.append($a);
            }(TAB_ORDER[i]));
        }
        $body.append($tabs);

        // Panel container.
        $body.append($('<div>', { 'class': 'steward-panel', 'id': 'steward-panel' }));

        renderFooter();
        activateTab(dashboard.activeTab);
    }

    function activateTab(tabId) {
        var $body = dashboard.modal.Body();
        $('.steward-tab', $body).removeClass('active');
        $('.steward-tab[data-tab="' + tabId + '"]', $body).addClass('active');
        dashboard.activeTab = tabId;

        var $panel = $('#steward-panel', $body);
        $panel.empty();
        // BS3 .row carries negative side margins; wrap in container-fluid
        // so the rows align with the panel edges instead of overflowing.
        var $container = $('<div>', { 'class': 'container-fluid' });
        $panel.append($container);

        if (tabId === 'status') {
            renderStatusTab($container);
        } else {
            renderModuleTab($container, tabId);
        }
    }

    function renderModuleTab($panel, tabId) {
        var h = S.kernel.ui.helpers;
        var mods = S.kernel.registry.byTab(tabId);
        if (!mods.length) {
            $panel.append(h.headerRow('No modules in this tab yet.'));
            return;
        }
        for (var i = 0; i < mods.length; i++) {
            renderSection($panel, mods[i]);
        }
    }

    // The shell builds the section's header row from the ui spec, then hands
    // the panel + helpers to the module so it can append its data rows.
    // Modules append directly to $panel — same flat sequence-of-rows layout
    // autoTSO uses (createTableRow per row, header rows interleaved).
    function renderSection($panel, mod) {
        var sec = mod.ui.section;
        var h = S.kernel.ui.helpers;

        $panel.append(h.headerRow(sec.title, {
            icon:   sec.icon,
            action: sec.action || null
        }));

        try {
            sec.render($panel, h);
        } catch (e) {
            S.kernel.error('ui', 'render threw for', mod.id, ':', e);
            $panel.append(h.formRow('Render failed — see log.', ''));
        }

        // Visual separator between sections — empty row.
        $panel.append($('<div>', { 'class': 'steward-section-spacer' })
            .css({ height: '10px' }));
    }

    // Render one event in the Status tab's "Active events" section.
    // Surfaces:
    //   - the event display name (Easter, XMAS, …)
    //   - phase: "Treasure phase" (green) when items are dropping,
    //            "Event Cooldown" (amber) when only the shop variant is
    //            live, otherwise the raw category list
    //   - the resource currency + the player's current count
    function renderEventRow(ev, h) {
        var $lbl = $('<span>');
        $lbl.append($('<strong>').text(ev.name));
        $lbl.append(document.createTextNode(' — '));

        var inTreasure = !!(ev.categories && ev.categories.treasure);
        var inCooldown = !!(ev.categories && ev.categories.shop && !inTreasure);
        var $phase;
        if (inTreasure) {
            $phase = $('<span>').css({ color: '#6cba5d', fontWeight: '600' })
                .text('Treasure phase');
        } else if (inCooldown) {
            $phase = $('<span>').css({ color: '#e8a64a', fontWeight: '600' })
                .text('Cooldown Phase');
        } else {
            $phase = $('<span>').text((ev.categoryList || []).join(', ') || 'live');
        }
        $lbl.append($phase);

        var $rhs = $('<span>');
        var resource = null;
        try {
            if (S.core.events.eventResource) {
                resource = S.core.events.eventResource(ev.code) || null;
            }
        } catch (e) { /* ignore */ }
        if (resource) {
            $rhs.append($('<code>').text(resource));
            var amount = null;
            try {
                if (S.core.events.eventResourceAmount) {
                    amount = S.core.events.eventResourceAmount(ev.code);
                }
            } catch (e) { /* ignore */ }
            if (typeof amount === 'number') {
                $rhs.append(document.createTextNode(' · '));
                $rhs.append($('<strong>').text(String(amount)));
                $rhs.append(document.createTextNode(' held'));
            }
        }
        return h.formRow($lbl, $rhs);
    }

    // -----------------------------------------------------------------
    // Status tab — built into the shell, not a module.
    // -----------------------------------------------------------------

    function renderStatusTab($panel) {
        var h = S.kernel.ui.helpers;

        // ---- Section: Steward Status ----
        $panel.append(h.headerRow('Steward Status', { icon: '★' }));

        $panel.append(h.formRow('Master pause', h.toggle({
            checked:  paused,
            onChange: function (next) { setPaused(next); }
        })));

        var withUi = S.kernel.registry.withUi();
        var enabledNames = [];
        for (var i = 0; i < withUi.length; i++) {
            if (isModuleEnabled(withUi[i].id)) enabledNames.push(withUi[i].ui.section.title);
        }
        var $modText = $('<span>');
        $modText.append($('<strong>').text(enabledNames.length));
        $modText.append(document.createTextNode(' of ' + withUi.length + ' enabled'));
        if (enabledNames.length) {
            $modText.append(document.createTextNode(' · ' + enabledNames.join(', ')));
        }
        $panel.append(h.formRow('Modules running', $modText));

        $panel.append(h.formRow('Queue depth', String(S.kernel.queue.depth())));
        $panel.append(h.formRow('Tick interval',
            S.kernel.scheduler.state.tickIntervalMs + ' ms'));
        $panel.append(h.formRow('Build', $('<code>').text('v0.4.0')));

        $panel.append($('<div>').css({ height: '10px' }));

        // ---- Section: Active events ----
        try {
            if (S.core.events && S.core.events.active) {
                var ev = S.core.events.active();
                $panel.append(h.headerRow('Active events', { icon: '⚑' }));
                if (ev.length === 0) {
                    $panel.append(h.formRow(
                        $('<em>').css({ color: '#a09a85' }).text('No events live.'),
                        ''));
                } else {
                    for (var k = 0; k < ev.length; k++) {
                        $panel.append(renderEventRow(ev[k], h));
                    }
                }
            }
        } catch (e) { /* ignore */ }
    }

    // -----------------------------------------------------------------
    // Footer
    // -----------------------------------------------------------------

    function renderFooter() {
        var $footer = dashboard.modal.Footer ? dashboard.modal.Footer() : null;
        if (!$footer || !$footer.length) return;
        $footer.empty();
        dashboard.saveBtn = $('<button>', {
            'type':  'button',
            'class': 'steward-btn steward-btn-save',
            'text':  'Save'
        });
        var $closeBtn = $('<button>', {
            'type':  'button',
            'class': 'steward-btn steward-btn-close',
            'text':  'Close'
        });
        dashboard.saveBtn.on('click', function () { closeDashboard(true); });
        $closeBtn.on('click', function () { closeDashboard(false); });
        $footer.append(dashboard.saveBtn).append($closeBtn);
        updateFooterButtons();
    }

    function hasDirty() {
        for (var k in dashboard.dirty) {
            if (dashboard.dirty[k]) return true;
        }
        return false;
    }

    function updateFooterButtons() {
        if (!dashboard.saveBtn) return;
        dashboard.saveBtn.prop('disabled', !hasDirty());
    }

    function flushBuffers() {
        for (var moduleId in dashboard.buffer) {
            if (!dashboard.dirty[moduleId]) continue;
            try {
                S.kernel.settings.write(moduleId, dashboard.buffer[moduleId]);
                S.kernel.log('ui', 'saved settings for', moduleId);
                var mod = S.kernel.registry.get(moduleId);
                if (mod && mod.ui && mod.ui.section &&
                        typeof mod.ui.section.onSave === 'function') {
                    try { mod.ui.section.onSave(); }
                    catch (e) { S.kernel.error('ui', moduleId, 'onSave threw:', e); }
                }
            } catch (e) {
                S.kernel.error('ui', 'failed to save', moduleId, ':', e);
            }
        }
    }

    // -----------------------------------------------------------------
    // Settings buffer
    // -----------------------------------------------------------------

    function bufferedSettings(moduleId) {
        if (!dashboard.buffer[moduleId]) {
            var stored = S.kernel.settings.read(moduleId) || {};
            var snap = {};
            for (var k in stored) snap[k] = stored[k];
            dashboard.buffer[moduleId] = snap;
        }
        return dashboard.buffer[moduleId];
    }

    function markDirty(moduleId) {
        dashboard.dirty[moduleId] = true;
        updateFooterButtons();
    }

    // -----------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------

    if (!S.kernel.ui) S.kernel.ui = {};
    S.kernel.ui.init             = init;
    S.kernel.ui.status           = {
        set:     setStatus,
        get:     function () { return statusText; },
        refresh: refreshStatus
    };
    S.kernel.ui.pause            = function () { setPaused(true); };
    S.kernel.ui.resume           = function () { setPaused(false); };
    S.kernel.ui.toggle           = togglePause;
    S.kernel.ui.isPaused         = isPaused;
    S.kernel.ui.seedPaused       = function (v) { paused = v === true; refreshStatus(); };

    S.kernel.ui.openDashboard    = openDashboard;
    S.kernel.ui.closeDashboard   = closeDashboard;
    S.kernel.ui.bufferedSettings = bufferedSettings;
    S.kernel.ui.markDirty        = markDirty;

    var statusUpdater = setInterval(refreshStatus, S.kernel.TIMEOUTS.STATUS_UPDATE_MS);
    S.kernel.ui.stopStatusUpdater = function () {
        if (statusUpdater) { clearInterval(statusUpdater); statusUpdater = null; }
    };

}(Steward));
