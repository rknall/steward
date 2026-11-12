/*
 * "Steward production" window of the production module.
 *
 * A separate host Modal rather than a dashboard tab: the automatic-queue
 * table and the queue view need more room than a tab has. A zone load
 * closes host modals, so an unsaved draft can never outlive the island it
 * was edited on.
 *
 * Three tabs, opening on Production Manager: Production Manager, Queues and
 * Settings. Only Production Manager edits through a draft. Queues hands the
 * model's listed queue rows to S.modules.production.views.queues, read when
 * the tab renders or on Refresh, and never redraws on its own. The Settings
 * switch writes its one setting at once and is never part of the draft.
 *
 * Production Manager opens on All buildings until an automatic queue
 * exists, then on Automatic queues.
 *
 * Edits are buffered in `state.draft`, a copy of the stored buildings map,
 * until Save. `state.orig` is the normalized draft as it was when the window
 * opened or last saved, so the footer, the tab dot and the edit guard can
 * tell an unchanged draft from a changed one. Switching tabs keeps the
 * draft. Save writes only the buildings map.
 *
 * Hidden buffs: the buff drop-down lists only offered buffs in stock, so a
 * stored buff whose stock ran out reads None. Showing it so changes nothing:
 * the dirty check compares the raw draft, and the stored buff comes back
 * with its stock. A Save, though, writes what the window shows, so it clears
 * such a buff on every row of this island and names it in the change note.
 *
 * Item and buff names in the change note are the labels the rendered rows
 * carried, so the note never shows a raw id.
 *
 * The footer is built once per tab kind (orders, live or settings) and only
 * updated while the user types or picks: the Save button is never replaced
 * under a click.
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
    'use strict';

    if (!S.modules.production) S.modules.production = {};

    var MODAL_ID = 'StewardProduction';
    var TITLE = 'Steward production';

    var TABS = ['manager', 'queues', 'settings'];
    var FIELD_WORDS = { item: 'item', items: 'items', buff: 'buff', enabled: 'enabled' };
    var UNPRODUCIBLE = 'not producible now';

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

    function res(name) {
        return safe(function () { return S.core.locale.res(name) || name; }, name);
    }

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function clockSec(d) {
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    function labelOf(x) {
        return String(x.label || x.name);
    }

    // The window's one order for items and buffs: by label, ignoring case,
    // then by name so equal labels still sort the same way every time.
    function byLabel(a, b) {
        var c = labelOf(a).toLowerCase().localeCompare(labelOf(b).toLowerCase());
        if (c !== 0) return c;
        return String(a.name) < String(b.name) ? -1 : (String(a.name) > String(b.name) ? 1 : 0);
    }

    // Host pages are numbered groups: by number, anything else after them.
    function byPage(a, b) {
        var na = parseInt(a, 10);
        var nb = parseInt(b, 10);
        var aNum = !isNaN(na);
        var bNum = !isNaN(nb);
        if (aNum && bNum && na !== nb) return na - nb;
        if (aNum !== bNum) return aNum ? -1 : 1;
        return a < b ? -1 : (a > b ? 1 : 0);
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

    // The draft as a Save would write it: a buff the drop-down did not list
    // on its last render is cleared. Rows of other islands were not rendered
    // and keep theirs.
    function effective(draft) {
        var out = copyBuildings(draft);
        for (var name in out) {
            if (!has(out, name) || !has(state.buffShown, name)) continue;
            if (out[name].buff && !has(state.buffShown[name], out[name].buff)) out[name].buff = '';
        }
        return out;
    }

    // The raw draft, so merely showing a hidden buff as None is no change.
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

    function showValue(name, f, v) {
        if (f === 'enabled') return v === true ? 'on' : 'off';
        if (f === 'item' || f === 'buff') {
            if (!v) return 'none';
            var map = has(state.labels, name) ? state.labels[name][f] : null;
            return map && has(map, v) ? map[v] : res(v);
        }
        return String(v);
    }

    // One entry per changed field of the draft a Save would write, in
    // building-name order.
    function changes() {
        var a = JSON.parse(state.orig);
        var b = normalize(effective(state.draft));
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
                    showValue(names[i], f, was[f]) + ' → ' + showValue(names[i], f, now[f]));
            }
        }
        return out;
    }

    function changeNote() {
        if (!isDirty()) return 'No unsaved changes';
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
        return safe(function () { return M().model.isManaged(cfg); }, false) === true;
    }

    function anyManaged(map) {
        for (var k in map) {
            if (has(map, k) && isManaged(map[k])) return true;
        }
        return false;
    }

    // ---- Shell ----------------------------------------------------------------

    function tabKind(tab) {
        if (tab === 'manager') return 'orders';
        return tab === 'settings' ? 'settings' : 'live';
    }

    // One read pass per render: the status, the model calls and the footer
    // share the host lists they would otherwise each read again.
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
        // The Queues chip and the Queues tab count the same rows: read once
        // per render, inside the render pass, so they cannot differ.
        var queues = readQueues();
        $panel.append(tabBar(queues));
        $panel.append(tabBody(queues));
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

    // A failed read keeps its error for the Queues tab to show.
    function readQueues() {
        try {
            var list = M().model.queues();
            return { list: list || [], error: null };
        } catch (e) {
            return { list: [], error: e };
        }
    }

    function producingCount(list) {
        var n = 0;
        for (var i = 0; i < list.length; i++) if (list[i] && list[i].producing) n++;
        return n;
    }

    function managerLabel() {
        return 'Production Manager' + (isDirty() ? ' •' : '');
    }

    function tabBar(queues) {
        var items = [
            { id: 'manager',  label: managerLabel() },
            { id: 'queues',   label: 'Queues ' + producingCount(queues.list) },
            { id: 'settings', label: 'Settings' }
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

    function tabBody(queues) {
        var $box = $('<div>');
        try {
            if (state.tab === 'manager') renderManager($box);
            else if (state.tab === 'settings') renderSettings($box);
            else renderQueues($box, queues);
        } catch (e) {
            S.kernel.error('production', 'render ' + state.tab + ' tab threw:', e);
            $box = $('<div>');
            failureLine($box, e);
        }
        return $box;
    }

    // ---- Queues tab -----------------------------------------------------------

    function renderQueues($c, queues) {
        if (queues.error) throw queues.error;
        var views = M().views;
        var view = views ? views.queues : null;
        if (typeof view !== 'function') {
            $c.append(textEl('div', 'steward-muted', 'This view is not available.'));
            return;
        }
        view($c, H(), { queues: queues.list });
    }

    // ---- Settings tab ---------------------------------------------------------

    function renderSettings($c) {
        var h = H();
        var s = safe(function () { return M().readSettings(); }, null) || {};
        var $card = h.card({ icon: '⚙', title: 'Settings', meta: 'Applies at once' });
        $card.append(h.field('Bookbinder auto-complete',
            'Collects finished books while the Bookbinder row is enabled',
            h.toggle({
                checked: !!s.bookComplete,
                write: function (v) {
                    S.kernel.settings.write('production', { bookComplete: v });
                    S.kernel.log('ui', 'production', 'bookComplete', '→', v);
                }
            })));
        $c.append($card);
    }

    // ---- Production Manager tab -----------------------------------------------

    function itemsOf(row, cfg) {
        return safe(function () { return M().itemsFor(cfg, row.type); }, 1);
    }

    function orderMaxOf(row) {
        return safe(function () { return M().runsMax(row.type); }, 1);
    }

    function costOf(row, cfg) {
        if (!cfg.item) return '';
        return safe(function () { return row.costText(cfg.item, itemsOf(row, cfg)); }, '') || '';
    }

    // The labels each rendered row carried, item and buff, so the change
    // note names what the user saw. Kept across renders: a value that left
    // a list still reads by name.
    function recordLabels(row) {
        if (!has(state.labels, row.name)) state.labels[row.name] = { item: {}, buff: {} };
        var map = state.labels[row.name];
        var items = row.items || [];
        var buffs = row.buffs || [];
        var i;
        for (i = 0; i < items.length; i++) if (items[i]) map.item[items[i].name] = labelOf(items[i]);
        for (i = 0; i < buffs.length; i++) if (buffs[i]) map.buff[buffs[i].name] = labelOf(buffs[i]);
    }

    // (none), then the items the host would take now, alphabetical; grouped
    // under greyed page headers when they span more than one host page. A
    // saved item that is not listed comes last, so showing the row never
    // rewrites the stored choice.
    function itemOptions(row, cfg) {
        var all = row.items || [];
        var listed = [];
        var i;
        for (i = 0; i < all.length; i++) {
            if (all[i] && all[i].producible !== false) listed.push(all[i]);
        }
        listed.sort(byLabel);
        var pages = [];
        var titles = {};
        for (i = 0; i < listed.length; i++) {
            var p = listed[i].page === null || listed[i].page === undefined ? '' : String(listed[i].page);
            if (!has(titles, p)) {
                pages.push(p);
                titles[p] = listed[i].pageLabel || (p ? 'Group ' + p : 'Other');
            }
        }
        var options = [{ label: '(none)', value: '' }];
        var known = false;
        for (i = 0; i < listed.length; i++) if (listed[i].name === cfg.item) known = true;
        if (pages.length > 1) {
            pages.sort(byPage);
            for (var g = 0; g < pages.length; g++) {
                options.push({ label: titles[pages[g]], header: true });
                for (i = 0; i < listed.length; i++) {
                    var key = listed[i].page === null || listed[i].page === undefined ? '' : String(listed[i].page);
                    if (key === pages[g]) options.push({ label: labelOf(listed[i]), value: listed[i].name });
                }
            }
        } else {
            for (i = 0; i < listed.length; i++) options.push({ label: labelOf(listed[i]), value: listed[i].name });
        }
        var unlisted = cfg.item && !known ? cfg.item : null;
        if (unlisted) options.push({ label: showValue(row.name, 'item', unlisted), value: unlisted });
        return { options: options, unlisted: unlisted };
    }

    function itemCell(h, row, cfg, ctx) {
        var built = itemOptions(row, cfg);
        ctx.$cost = textEl('div', 'steward-muted', costOf(row, cfg));
        var $note = textEl('div', 'steward-muted', built.unlisted && cfg.item === built.unlisted ? UNPRODUCIBLE : '');
        var $sel = h.dropdown(built.options, {
            selected: cfg.item,
            width:    '100%',
            onChange: function (v) {
                var d = draftRow(row.name);
                d.item = v || '';
                ctx.$cost.text(costOf(row, d));
                $note.text(built.unlisted && d.item === built.unlisted ? UNPRODUCIBLE : '');
                updateFooter();
            }
        });
        return $('<div>').append($sel).append($note).append(ctx.$cost);
    }

    // The bound is the runs one order message of the type can carry, so it
    // is never retyped here; a type that takes one run shows a fixed 1.
    function itemsCell(h, row, cfg, ctx) {
        var max = orderMaxOf(row);
        var $c = $('<div>');
        if (max === 1) {
            $c.append(textEl('div', 'steward-muted', '1'));
            if (row.kind === S.ProductionKind.Books) $c.append(textEl('div', 'steward-muted', 'one book at a time'));
            return $c;
        }
        return $c.append(h.number({
            value: itemsOf(row, cfg),
            width: '50px',
            label: 'Items per order',
            parse: function (t) {
                var n = S.kernel.ui.settingsParse.whole(t);
                return n === null ? null : itemsOf(row, { items: n });
            },
            onChange: function (v) {
                var d = draftRow(row.name);
                d.items = v;
                if (ctx.$cost) ctx.$cost.text(costOf(row, d));
                updateFooter();
            }
        }));
    }

    // Offered buffs in stock, alphabetical. An unreadable stock is not "out
    // of stock": it is listed as (?).
    function buffList(row) {
        var all = row.buffs || [];
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i] && all[i].offered && all[i].amount !== 0) out.push(all[i]);
        }
        out.sort(byLabel);
        return out;
    }

    // Recorded for every row of the island, shown or not, so a Save clears
    // a hidden buff on rows behind the Automatic queues chip too.
    function recordBuffs(row) {
        var set = { '': true };
        var list = buffList(row);
        for (var i = 0; i < list.length; i++) set[list[i].name] = true;
        state.buffShown[row.name] = set;
    }

    function buffCell(h, row, cfg) {
        var options = [{ label: 'None', value: '' }];
        var list = buffList(row);
        // Nothing to pick: a lone "None" dropdown only looks like a choice.
        // A stored hidden buff is still cleared by Save via recordBuffs.
        if (!list.length) return textEl('span', 'steward-muted', '');
        var listed = false;
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            var known = typeof b.amount === 'number';
            var effect = b.effect ? ' - ' + b.effect : '';
            options.push({ label: labelOf(b) + effect + ' (' + (known ? b.amount : '?') + ')', value: b.name });
            if (b.name === cfg.buff) listed = true;
        }
        return h.dropdown(options, {
            selected: listed ? cfg.buff : '',
            width:    '100%',
            onChange: function (v) {
                draftRow(row.name).buff = v || '';
                updateFooter();
            }
        });
    }

    function enableCell(h, row, cfg) {
        return h.toggle({
            checked: cfg.enabled === true,
            label:   'Enable automatic queue',
            onChange: function (v) {
                draftRow(row.name).enabled = v === true;
                updateFooter();
            }
        });
    }

    function buildingCell(row) {
        var $c = $('<div>');
        $c.append(textEl('b', null, row.label));
        $c.append(textEl('div', 'steward-muted',
            '×' + row.count + ' · level ' + (row.level === null ? '?' : row.level)));
        return $c;
    }

    function orderRow(h, row) {
        // Cells read the draft, not the stored settings, so a re-render after
        // a tab switch shows the unsaved values.
        var cfg = has(state.draft, row.name) ? state.draft[row.name] : blank();
        var ctx = { $cost: null };
        return [buildingCell(row), itemCell(h, row, cfg, ctx), itemsCell(h, row, cfg, ctx),
                buffCell(h, row, cfg), enableCell(h, row, cfg)];
    }

    function renderManager($c) {
        var h = H();
        var rows = M().model.buildings() || [];
        var managed = [];
        state.buffShown = {};
        for (var i = 0; i < rows.length; i++) {
            recordLabels(rows[i]);
            recordBuffs(rows[i]);
            if (isManaged(state.draft[rows[i].name])) managed.push(rows[i]);
        }
        var list = state.filter === 'all' ? rows : managed;
        var $card = h.card({
            icon:  '⚙',
            title: 'Production Manager',
            meta:  'Cost shown per order, from the Items value'
        });
        $card.append(h.chips([
            { id: 'auto', label: 'Automatic queues ' + managed.length },
            { id: 'all',  label: 'All buildings ' + rows.length }
        ], state.filter, function (id) {
            state.filter = id === 'all' ? 'all' : 'auto';
            render();
        }));
        var cells = [];
        for (var r = 0; r < list.length; r++) cells.push(orderRow(h, list[r]));
        $card.append(h.table({
            fill: true,
            cols: [
                { label: 'Building',    width: '24%' },
                { label: 'Item · cost', width: '31%' },
                { label: 'Items',       width: '14%' },
                { label: 'Buff',        width: '22%' },
                { label: 'Enable',      width: '9%' }
            ],
            rows:      cells,
            emptyText: state.filter === 'all'
                ? 'No production queue buildings on this island.'
                : 'No automatic queues yet. Pick All buildings to set one up.'
        }));
        $c.append($card);
        h.fit();
    }

    // ---- Footer ---------------------------------------------------------------

    function closeWindow() {
        if (isDirty()) notify('Automatic queue changes discarded');
        // Hides only a shown window: a second hide during the fade would
        // unbalance the host's stage layer swap.
        if (S.kernel.ui && typeof S.kernel.ui.hideModal === 'function') S.kernel.ui.hideModal(modal);
    }

    function saveDraft() {
        if (!isDirty()) return;
        var eff = effective(state.draft);
        S.kernel.settings.write('production', { buildings: copyBuildings(eff) });
        notify('Automatic queues saved');
        state.draft = eff;
        state.orig = snapshot(eff);
        updateFooter();
    }

    function refresh() {
        render();
    }

    // Built once per tab kind: 'orders', 'live' or 'settings'.
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
        } else if (kind === 'settings') {
            $footer.append(textEl('span', 'steward-foot-note', 'Settings on this tab apply at once')).append($close);
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
            var $chip = state.$tabs.children('button').eq(TABS.indexOf('manager'));
            if ($chip && $chip.length) $chip.text(managerLabel());
        }
        if (!state.$mid) return;
        if (state.footKind === 'live') {
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
            tab: TABS.indexOf(tab) === -1 ? 'manager' : tab,
            filter: anyManaged(draft) ? 'auto' : 'all',
            draft: draft,
            orig: snapshot(draft),
            labels: {},
            buffShown: {},
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
