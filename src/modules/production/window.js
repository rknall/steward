/*
 * "Steward production" window of the production module.
 *
 * A separate host Modal rather than a dashboard tab: the standing-order
 * table and the live views need more room than a tab has. A zone load
 * closes host modals, so an unsaved draft can never outlive the island it
 * was edited on.
 *
 * Standing orders opens on All until a standing order exists, then on
 * Managed.
 *
 * Five tabs, Queues by default: Queues, Demand, Standing orders,
 * Bookbinder & on/off and Recent. Only Standing orders edits anything; the
 * other tabs hand their data to S.modules.production.views.<tab>, read when
 * the tab renders or on Refresh, and never redraw on their own.
 *
 * Standing-order edits are buffered in `state.draft`, a copy of the stored
 * buildings map, until Save. `state.orig` is the normalized draft as it was
 * when the window opened or last saved, so the footer, the tab dot and the
 * edit guard can tell an unchanged draft from a changed one. Switching tabs
 * keeps the draft. Save writes only the buildings map.
 *
 * The footer is built once per tab kind (orders or live) and only updated
 * while the user types or picks: the Save button is never replaced under a
 * click.
 *
 * The window registers an edit guard with the kernel UI, so the dashboard
 * and Settings screens refuse to open over a changed draft, and this window
 * refuses to open over unsaved dashboard or Settings changes.
 *
 * A tab body is built detached and swapped in only once complete: a view
 * that throws leaves a failure line in that tab, never a half-built body.
 *
 * Reload safety: the file starts no timers and caches no function from
 * another file. Every handler calls S.modules.production.*, S.core.* and
 * S.kernel.* when it runs, so a window left open across a script reload
 * drives the new instance's code.
 *
 * Every user-visible string goes in with .text() through the kernel
 * helpers, never as HTML.
 *
 * Bundle slot: module, loads after the other production files (name
 * order); every S.modules.production.* reference happens at call time.
 */

(function (S) {

    if (!S.modules.production) S.modules.production = {};

    var MODAL_ID = 'StewardProduction';
    var TITLE = 'Steward production';

    var TABS = ['queues', 'demand', 'orders', 'books', 'recent'];
    var FIELD_WORDS = { item: 'item', amount: 'keep', stack: 'stack', buff: 'buff' };

    var modal = null;
    var state = null;

    // ---- Small helpers --------------------------------------------------------

    function M() { return S.modules.production; }
    function H() { return S.kernel.ui.helpers; }

    function notify(text) {
        if (S.kernel.ui && S.kernel.ui.notify) S.kernel.ui.notify(text);
    }

    function has(o, k) {
        return Object.prototype.hasOwnProperty.call(o, k);
    }

    function textEl(tag, cls, text) {
        var $e = $('<' + tag + '>');
        if (cls) $e.addClass(cls);
        return $e.text(text);
    }

    function safe(fn, fallback) {
        try {
            var v = fn();
            return v === undefined ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    function bui(name) {
        return safe(function () { return S.core.locale.bui(name) || name; }, name);
    }

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function clockSec(d) {
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    function clockAt(ms) {
        return typeof ms === 'number' ? H().clock(new Date(ms)) : '';
    }

    // ---- Draft state ----------------------------------------------------------

    // The per-building fields come from the module's default row, so a field
    // added there is drafted, compared and saved here without a second list.
    function fields() {
        var b = M().defaultBuilding;
        var out = [];
        if (!b || typeof b !== 'object') return out;
        for (var k in b) if (has(b, k)) out.push(k);
        return out;
    }

    function fieldWord(f) {
        return has(FIELD_WORDS, f) ? FIELD_WORDS[f] : f;
    }

    function blank() {
        var b = M().defaultBuilding;
        var list = fields();
        var out = {};
        for (var i = 0; i < list.length; i++) out[list[i]] = b[list[i]];
        return out;
    }

    function copyBuildings(src) {
        var list = fields();
        var out = {};
        for (var name in src) {
            if (!has(src, name) || !src[name] || typeof src[name] !== 'object') continue;
            var row = blank();
            for (var i = 0; i < list.length; i++) {
                var f = list[i];
                if (src[name][f] !== undefined) row[f] = src[name][f];
            }
            out[name] = row;
        }
        return out;
    }

    // Sorted names with every field filled in; an all-off row is the same as
    // a missing one, so touching a row without changing it is no change.
    function normalize(draft) {
        var empty = JSON.stringify(blank());
        var names = [];
        for (var n in draft) if (has(draft, n)) names.push(n);
        names.sort();
        var out = {};
        for (var i = 0; i < names.length; i++) {
            var row = copyBuildings({ x: draft[names[i]] }).x;
            if (!row || JSON.stringify(row) === empty) continue;
            out[names[i]] = row;
        }
        return out;
    }

    function snapshot(draft) {
        return JSON.stringify(normalize(draft));
    }

    function isDirty() {
        return !!(state && state.draft && snapshot(state.draft) !== state.orig);
    }

    // Shown as Bootstrap sees it: a window fading out after a hide reads closed.
    function shown() {
        var ui = S.kernel.ui;
        return !!(modal && ui && typeof ui.isModalShown === 'function' && ui.isModalShown(modal));
    }

    // The edit guard: a changed draft in a window the user can see. A hidden
    // window (closed by its header X or a zone load) holds nothing to lose.
    function hasEdits() {
        return shown() && isDirty();
    }

    function showValue(f, v) {
        if (f === 'item' || f === 'buff') return v ? String(v) : 'none';
        return String(v);
    }

    // One entry per changed field, in building-name order.
    function changes() {
        var a = JSON.parse(state.orig);
        var b = normalize(state.draft);
        var names = [];
        var n;
        for (n in a) if (has(a, n)) names.push(n);
        for (n in b) if (has(b, n) && !has(a, n)) names.push(n);
        names.sort();
        var list = fields();
        var out = [];
        for (var i = 0; i < names.length; i++) {
            var was = has(a, names[i]) ? a[names[i]] : blank();
            var now = has(b, names[i]) ? b[names[i]] : blank();
            for (var k = 0; k < list.length; k++) {
                var f = list[k];
                if (was[f] === now[f]) continue;
                out.push(bui(names[i]) + ' ' + fieldWord(f) + ' ' +
                    showValue(f, was[f]) + ' → ' + showValue(f, now[f]));
            }
        }
        return out;
    }

    function changeNote() {
        var list = changes();
        if (!list.length) return 'No unsaved changes';
        if (list.length === 1) return '1 change: ' + list[0];
        return list.length + ' changes';
    }

    function draftRow(name) {
        if (!has(state.draft, name)) state.draft[name] = blank();
        return state.draft[name];
    }

    function isManaged(cfg) {
        return !!(cfg && ((cfg.item && cfg.amount > 0) || cfg.buff));
    }

    function anyManaged(map) {
        for (var k in map) {
            if (has(map, k) && isManaged(map[k])) return true;
        }
        return false;
    }

    // ---- Shell ----------------------------------------------------------------

    function tabKind(tab) {
        return tab === 'orders' ? 'orders' : 'live';
    }

    // One read pass per render: the status, the tab's model call and the
    // footer share the host lists they would otherwise each read again.
    function render() {
        var t0 = Date.now();
        var hr = S.kernel.hostRead;
        if (hr && typeof hr.pass === 'function') hr.pass(renderNow);
        else renderNow();
        if (modal && state) {
            S.kernel.debug('production', 'window render ' + state.tab + ' took ' + (Date.now() - t0) + ' ms');
        }
    }

    function renderNow() {
        if (!modal || !state) return;
        var $body = modal.Body();
        if (!$body || !$body.length) return;
        state.$tabs = null;
        state.readAt = new Date();
        var $panel = $('<div>', { 'class': 'steward-panel steward-compact' });
        var st = safe(function () { return M().model.status(); }, null);
        $panel.append(headerLine(st));
        // The chip and the tabs count the same rows: read once per render,
        // inside the render pass, so they cannot differ.
        var rows = demandRows();
        $panel.append(tabBar(st, rows));
        $panel.append(tabBody(rows));
        $body.empty();
        $body.append($panel);
        var kind = tabKind(state.tab);
        if (state.footKind !== kind) renderFooter(kind);
        else updateFooter();
    }

    // The status part is the submenu's status line, so the two never differ.
    function headerLine(st) {
        var tail = safe(function () { return M().menu.statusText(st); }, 'Production status unavailable');
        return textEl('div', 'steward-subhead',
            'Auto-production ' + (st && st.enabled ? 'on' : 'off') + ' · ' + tail);
    }

    function demandRows() {
        var r = safe(function () { return M().assess(); }, null);
        return r && r.rows ? r.rows : [];
    }

    function ordersLabel() {
        return 'Standing orders' + (isDirty() ? ' •' : '');
    }

    function tabBar(st, rows) {
        var items = [
            { id: 'queues', label: 'Queues ' + ((st && st.queues) || 0) },
            { id: 'demand', label: 'Demand ' + rows.length },
            { id: 'orders', label: ordersLabel() },
            { id: 'books',  label: 'Bookbinder & on/off' },
            { id: 'recent', label: 'Recent' }
        ];
        state.$tabs = H().chips(items, state.tab, function (id) {
            if (TABS.indexOf(id) === -1) return;
            state.tab = id;
            render();
        });
        return state.$tabs;
    }

    function failureLine($c, e) {
        var message = e && e.message ? e.message : String(e);
        $c.append(textEl('div', 'steward-bad',
            'This view could not be shown: ' + message + ' (details in the console log)'));
    }

    function tabBody(rows) {
        var $box = $('<div>');
        try {
            if (state.tab === 'orders') renderOrders($box);
            else renderLive($box, state.tab, rows);
        } catch (e) {
            S.kernel.error('production', 'render ' + state.tab + ' tab threw:', e);
            $box = $('<div>');
            failureLine($box, e);
        }
        return $box;
    }

    // ---- Live tabs ------------------------------------------------------------

    function liveData(tab, rows) {
        var model = M().model;
        if (tab === 'queues') return { queues: model.queues(), rows: rows };
        if (tab === 'demand') {
            return { rows: rows, reservations: model.reservations(rows) };
        }
        if (tab === 'books') {
            var oo = model.onOff();
            return { books: model.books(), onOff: oo.rows, counts: oo.counts };
        }
        return M().recent();
    }

    function renderLive($c, tab, rows) {
        var views = M().views;
        var view = views ? views[tab] : null;
        if (typeof view !== 'function') {
            $c.append(textEl('div', 'steward-muted', 'This view is not available.'));
            return;
        }
        view($c, H(), liveData(tab, rows));
    }

    // ---- Standing orders tab --------------------------------------------------

    // The module's own default, so the shown value is the one it orders with.
    function stackDefault(row) {
        return safe(function () { return M().defaultStack(row.type); }, 1);
    }

    function itemCell(h, row, cfg) {
        var options = [{ label: '(none)', value: '' }];
        var items = row.items || [];
        var known = false;
        for (var i = 0; i < items.length; i++) {
            options.push({ label: items[i].label || items[i].name, value: items[i].name });
            if (items[i].name === cfg.item) known = true;
        }
        // Kept selectable so showing the row never rewrites the stored choice.
        if (cfg.item && !known) options.push({ label: cfg.item, value: cfg.item });
        var $cost = textEl('div', 'steward-muted', cfg.item ? row.costText(cfg.item) : '');
        var $sel = h.dropdown(options, {
            selected: cfg.item,
            width:    '100%',
            onChange: function (v) {
                draftRow(row.name).item = v || '';
                $cost.text(v ? row.costText(v) : '');
                updateFooter();
            }
        });
        return $('<div>').append($sel).append($cost);
    }

    function keepCell(h, row, cfg) {
        // The bound comes from the queue's profile (one book at a time for
        // the Bookbinder), so it is never retyped here.
        var max = S.core.production.keepMax(row.type);
        if (typeof max !== 'number') max = 0;
        var $n = h.number({
            value: cfg.amount,
            width: '60px',
            label: 'Items to keep queued',
            parse: function (t) {
                var n = S.kernel.ui.settingsParse.whole(t);
                return n === null ? null : Math.max(0, Math.min(max, n));
            },
            onChange: function (v) {
                draftRow(row.name).amount = v;
                updateFooter();
            }
        });
        var $c = $('<div>').append($n);
        if (row.kind === S.ProductionKind.Books) $c.append(textEl('div', 'steward-muted', 'one book at a time'));
        return $c;
    }

    function stackCell(h, row, cfg) {
        var K = S.ProductionKind;
        var stackable = !!(row.profile && row.profile.stackable);
        if (!stackable && row.kind !== K.Timed) return { text: '–', cls: 'steward-muted' };
        var max = S.core.production.STACK_SIZE;
        return h.number({
            value: cfg.stack > 0 ? cfg.stack : stackDefault(row),
            width: '50px',
            label: 'Items per order',
            parse: function (t) {
                var n = S.kernel.ui.settingsParse.whole(t);
                return n === null ? null : Math.max(1, Math.min(max, n));
            },
            onChange: function (v) {
                draftRow(row.name).stack = v;
                updateFooter();
            }
        });
    }

    function buffCell(h, row, cfg) {
        var options = [{ label: 'None', value: '' }];
        var list = row.buffs || [];
        var listed = false;
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            // An unreadable star menu is not "out of stock": show ? and no warning.
            var known = typeof b.amount === 'number';
            var label = (b.label || b.name) + ' (' + (known ? b.amount : '?') + ')';
            if (!b.offered) label = (b.label || b.name) + ' (not offered)';
            else if (known && !(b.amount > 0)) label += ' - out of stock';
            options.push({ label: label, value: b.name });
            if (b.name === cfg.buff) listed = true;
        }
        if (cfg.buff && !listed) options.push({ label: cfg.buff + ' (not offered)', value: cfg.buff });
        return h.dropdown(options, {
            selected: cfg.buff,
            width:    '100%',
            onChange: function (v) {
                draftRow(row.name).buff = v || '';
                updateFooter();
            }
        });
    }

    function buildingCell(row) {
        var $c = $('<div>');
        $c.append(textEl('b', null, row.label));
        var sub = '×' + row.count + ' · level ' + (row.level === null ? '?' : row.level);
        if (row.kind === S.ProductionKind.Timed) sub = 'event · ' + sub;
        $c.append(textEl('div', 'steward-muted', sub));
        return $c;
    }

    function cooldownText(row) {
        var ms = safe(function () { return S.core.production.cooldownMs(row.type); }, null);
        return typeof ms === 'number' && ms > 0 ? 'cooldown ' + clockAt(Date.now() + ms) : 'cooldown';
    }

    function orderRow(h, row) {
        // Cells read the draft, not the stored settings, so a re-render after
        // a tab switch shows the unsaved values.
        var cfg = has(state.draft, row.name) ? state.draft[row.name] : blank();
        if (row.kind === S.ProductionKind.Cooldown) {
            var dash = { text: '–', cls: 'steward-muted' };
            return [buildingCell(row), { text: cooldownText(row), cls: 'steward-muted' }, dash, dash, dash];
        }
        return [buildingCell(row), itemCell(h, row, cfg), keepCell(h, row, cfg),
                stackCell(h, row, cfg), buffCell(h, row, cfg)];
    }

    function renderOrders($c) {
        var h = H();
        var rows = M().model.buildings() || [];
        var managed = [];
        for (var i = 0; i < rows.length; i++) {
            if (isManaged(state.draft[rows[i].name])) managed.push(rows[i]);
        }
        var shown = state.filter === 'all' ? rows : managed;
        var $card = h.card({
            icon:  '⚙',
            title: 'Standing orders',
            meta:  managed.length + ' managed of ' + rows.length + ' buildings · Save applies to this tab only'
        });
        $card.append(h.chips([
            { id: 'managed', label: 'Managed ' + managed.length },
            { id: 'all',     label: 'All ' + rows.length }
        ], state.filter, function (id) {
            state.filter = id === 'all' ? 'all' : 'managed';
            render();
        }));
        var cells = [];
        for (var r = 0; r < shown.length; r++) cells.push(orderRow(h, shown[r]));
        $card.append(h.table({
            fill: true,
            cols: [
                { label: 'Building',    width: '22%' },
                { label: 'Item · cost', width: '30%' },
                { label: 'Keep',        width: '12%' },
                { label: 'Stack',       width: '10%' },
                { label: 'Buff',        width: '26%' }
            ],
            rows:      cells,
            emptyText: state.filter === 'all'
                ? 'No production queue buildings on this island.'
                : 'No standing orders yet. Pick All to set one up.'
        }));
        $c.append($card);
        h.fit();
    }

    // ---- Footer ---------------------------------------------------------------

    function closeWindow() {
        if (isDirty()) notify('Standing-order changes discarded');
        // Hides only a shown window: a second hide during the fade would
        // unbalance the host's stage layer swap.
        if (S.kernel.ui && typeof S.kernel.ui.hideModal === 'function') S.kernel.ui.hideModal(modal);
    }

    function saveDraft() {
        if (!isDirty()) return;
        var buildings = copyBuildings(state.draft);
        S.kernel.settings.write('production', { buildings: buildings });
        notify('Standing orders saved');
        state.orig = snapshot(state.draft);
        updateFooter();
    }

    function refresh() {
        render();
    }

    // Built once per tab kind: 'orders' or 'live'.
    function renderFooter(kind) {
        state.footKind = kind;
        state.$save = null;
        state.$mid = null;
        var $footer = modal.Footer ? modal.Footer() : null;
        if (!$footer || !$footer.length) return;
        var h = H();
        $footer.empty();
        var $close = h.button('Close', { onClick: closeWindow });
        $close.addClass('steward-foot-right');
        if (kind === 'orders') {
            state.$save = h.button('Save', { onClick: saveDraft });
            state.$mid = $('<span>');
            $footer.append(state.$save).append(state.$mid).append($close);
        } else {
            state.$mid = textEl('span', 'steward-foot-note', '');
            $footer.append(h.button('Refresh', { onClick: refresh })).append(state.$mid).append($close);
        }
        updateFooter();
    }

    // Text, classes and disabled state only, on the existing elements.
    function updateFooter() {
        if (!state) return;
        var dirty = isDirty();
        if (state.$tabs) {
            var $chip = state.$tabs.children('button').eq(TABS.indexOf('orders'));
            if ($chip && $chip.length) $chip.text(ordersLabel());
        }
        if (!state.$mid) return;
        if (state.footKind !== 'orders') {
            state.$mid.text('Read ' + clockSec(state.readAt || new Date()) +
                ' · live views do not redraw on their own');
            return;
        }
        if (!state.$save) return;
        state.$save.prop('disabled', !dirty);
        state.$save.toggleClass('steward-primary', dirty);
        state.$mid.removeClass('steward-foot-dirty steward-foot-note');
        state.$mid.addClass(dirty ? 'steward-foot-dirty' : 'steward-foot-note').text(changeNote());
    }

    // ---- Open -----------------------------------------------------------------

    function open(tab) {
        if (typeof Modal === 'undefined') {
            S.kernel.error('production', 'host Modal class unavailable — cannot open the production window');
            notify('The production window needs the game window; try again once the island is loaded.');
            return;
        }
        // Opening drops the draft, and hiding the dashboard would strand its
        // unsaved changes (its own buffer counts here), so any open edit
        // refuses.
        var ui = S.kernel.ui;
        if (ui && typeof ui.hasOpenEdits === 'function' && ui.hasOpenEdits()) {
            notify('Save or close the open window first');
            return;
        }
        if (ui && typeof ui.ensureStyle === 'function') ui.ensureStyle(MODAL_ID);
        var stored = safe(function () { return M().readSettings().buildings; }, null) || {};
        var draft = copyBuildings(stored);
        state = {
            tab: TABS.indexOf(tab) === -1 ? 'queues' : tab,
            filter: anyManaged(draft) ? 'managed' : 'all',
            draft: draft,
            orig: snapshot(draft),
            readAt: null,
            footKind: null, $save: null, $mid: null, $tabs: null
        };
        try {
            modal = new Modal(MODAL_ID, TITLE, true);
            modal.create();
            render();
            // The dashboard is clean here. Releasing it resets its buffer, so
            // its next open re-reads the settings and a Save in this window is
            // never overwritten by a stale dashboard snapshot. It is not hidden
            // here: the host's Modal.show hides it, and a hide first would fire
            // a second hide event during its fade and leave the game layer on
            // top of every window. Releasing after render() keeps the dashboard
            // tracked when create or render throws.
            if (ui && typeof ui.releaseDashboard === 'function') ui.releaseDashboard();
            if (ui && typeof ui.showModal === 'function') ui.showModal(modal);
            else modal.show();
        } catch (e) {
            S.kernel.error('production', 'open production window threw:', e);
        }
    }

    function isOpen() {
        return shown();
    }

    // A section-limited boot without the kernel UI shell still loads this file.
    if (S.kernel.ui && typeof S.kernel.ui.addEditGuard === 'function') {
        S.kernel.ui.addEditGuard('production-window', hasEdits);
    }

    S.modules.production.window = {
        open:     open,
        isOpen:   isOpen,
        hasEdits: hasEdits
    };

}(Steward));
