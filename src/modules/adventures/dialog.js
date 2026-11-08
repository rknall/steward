/*
 * Run-template window for the adventures module.
 *
 * A separate host Modal rather than a dashboard tab: building a template
 * needs a file picker and a reorderable wave list. Opening it hides the
 * dashboard (Modal.show semantics), and a zone load closes host modals, so
 * an unsaved draft can never outlive the island it was edited on.
 *
 * Two views. The list shows every template file, broken ones included so
 * they can be deleted, with Edit and a two-step Delete. The edit view holds
 * the template card (label, adventure, loadout), the speed card (horseshoe)
 * and the wave list, which a drag or the arrow buttons reorder.
 *
 * Edits are buffered in `state.draft` until Save; templates themselves are
 * files, so Save writes one and Delete removes one. `state.orig` is the
 * normalized draft as it was when editing began, so the footer and the edit
 * guard can tell an unchanged draft from a changed one. DOM only: all data
 * comes through templates, S.core.* and S.kernel.*. Open, save and delete
 * resync the native menu's template list.
 *
 * The footer is built once per view and only updated while the user types
 * or picks: the Save button is never replaced under a click. Save stays
 * disabled until the draft changed and has everything a template needs;
 * the footer names what is still missing.
 *
 * The window registers an edit guard with the kernel UI, so the dashboard
 * and Settings screens refuse to open over a changed draft, and this window
 * refuses to open over unsaved dashboard or Settings changes.
 *
 * A view is built detached and swapped in only once complete: a view that
 * throws while building leaves a failure view with a way back to the list,
 * never a half-emptied body.
 *
 * Reload safety: the file starts no timers and caches no function from
 * another file. Every handler calls S.modules.adventures.*, S.core.* and
 * S.kernel.* when it runs, so a window left open across a script reload
 * drives the new instance's code.
 *
 * Every user-supplied string (labels, paths, file names, messages) goes in
 * with .text() through the kernel helpers, never as HTML.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    var MODAL_ID = 'StewardAdventures';
    var TITLE = 'Steward adventures';

    var modal = null;
    var state = null;

    // ---- Small helpers --------------------------------------------------------

    function T() { return S.modules.adventures.templates; }
    function H() { return S.kernel.ui.helpers; }

    function notify(text) {
        if (S.kernel.ui && S.kernel.ui.notify) S.kernel.ui.notify(text);
    }

    // The native menu lists the templates; it rebuilds only when the set changed.
    function syncMenu() {
        var m = S.modules.adventures.menu;
        if (m && m.sync) m.sync();
    }

    function textEl(tag, cls, text) {
        var $e = $('<' + tag + '>');
        if (cls) $e.addClass(cls);
        return $e.text(text);
    }

    function plural(n, word) {
        return n + ' ' + word + (n === 1 ? '' : 's');
    }

    function startDir() {
        return T().lastDir() || S.kernel.host.battleTemplateDir() || '';
    }

    function rememberDir(path) {
        var info = S.kernel.files.info(path);
        if (info && info.parent) T().setLastDir(info.parent);
    }

    function act(fn) {
        return function () {
            state.error = null;
            // A pending delete confirmation and a moved-row mark must not
            // outlive any other action.
            state.confirmDelete = null;
            state.moved = -1;
            fn();
        };
    }

    function btn(label, onClick) {
        return H().button(label, { size: 'sm', onClick: onClick });
    }

    function iconBtn(text, title, disabled, onClick) {
        var $b = $('<button>', { type: 'button', 'class': 'steward-iconbtn', title: title }).text(text);
        if (disabled) $b.attr('disabled', 'disabled');
        $b.on('click', function (e) {
            if (e && e.preventDefault) e.preventDefault();
            try { onClick(); }
            catch (err) { S.kernel.error('adventures', 'wave button threw:', err); }
        });
        return $b;
    }

    // ---- Draft state ----------------------------------------------------------

    function snapshot(draft) {
        return JSON.stringify(T().normalize(draft));
    }

    function isDirty() {
        return !!(state && state.view === 'edit' && state.draft &&
            snapshot(state.draft) !== state.orig);
    }

    function bodyVisible() {
        if (!modal) return false;
        try {
            var $b = modal.Body();
            return !!($b && $b.length && typeof $b.is === 'function' && $b.is(':visible'));
        } catch (e) {
            return false;
        }
    }

    // The edit guard: a changed draft in a window the user can see. A hidden
    // window (closed by its header X or a zone load) holds nothing to lose.
    function hasEdits() {
        return bodyVisible() && isDirty();
    }

    var NEED_PHRASES = {
        label:     'a label',
        adventure: 'an adventure',
        loadout:   'a loadout',
        speedBuff: 'a known horseshoe'
    };

    // Pure over the template store's own checks: what the draft still lacks
    // before it can be saved, as short phrases for the footer. `recs` is the
    // template list the label is checked against.
    function needs(draft, recs) {
        var t = T();
        var rec = t.normalize(draft);
        var problems = t.validate(rec);
        var out = [];
        for (var i = 0; i < problems.length; i++) {
            var f = problems[i].field;
            var phrase = f === 'waves'
                ? (rec.waves.length ? 'a file for every wave' : 'at least one wave')
                : NEED_PHRASES[f];
            if (phrase && out.indexOf(phrase) === -1) out.push(phrase);
        }
        if (t.labelTaken(rec.label, rec.id, recs || [])) out.push('a label no other template uses');
        return out;
    }

    function beginEdit(draft) {
        state.draft = draft;
        state.orig = snapshot(draft);
        state.title = draft.id ? (draft.label || draft.id) : null;
        // Read once per edit: the footer checks the label on every key.
        state.recs = T().list();
        state.problems = null;
        state.lastBuff = null;
        state.moved = -1;
        state.view = 'edit';
        render();
    }

    // Leaves the edit view; a changed draft is dropped with a notice, so a
    // click never loses work silently.
    function leaveEdit() {
        if (isDirty()) notify('Template changes discarded');
        state.draft = null;
        state.orig = null;
        state.recs = null;
        state.problems = null;
        state.view = 'list';
    }

    // ---- Shell ----------------------------------------------------------------

    function render() {
        if (!modal) return;
        var $body = modal.Body();
        if (!$body || !$body.length) return;
        state.labelInput = null;
        // Build detached: the old view stays until the new one is complete, so
        // a throw part-way never leaves an emptied, half-built body. The
        // window has no fill sizing, so its panel scrolls.
        var $panel = $('<div>', { 'class': 'steward-panel steward-compact' });
        var failed = false;
        try {
            if (state.view === 'edit') renderEdit($panel);
            else renderList($panel);
        } catch (e) {
            S.kernel.error('adventures', 'render ' + state.view + ' view threw:', e);
            state.labelInput = null;
            failed = true;
            $panel.empty();
            renderFailure($panel, e);
        }
        $body.empty();
        $body.append($panel);
        var kind = failed ? 'failed' : state.view;
        if (state.footKind !== kind) renderFooter(kind);
        else updateFooter();
    }

    // Leaves the broken view behind; it renders only on click, so a list that
    // throws again simply shows this view again instead of looping.
    function backToListFromFailure() {
        state.draft = null;
        state.orig = null;
        state.problems = null;
        state.view = 'list';
        render();
    }

    function renderFailure($c, e) {
        var h = H();
        var message = e && e.message ? e.message : String(e);
        var $card = h.card({ icon: '⚔', title: 'Run templates' });
        $card.append(textEl('div', 'steward-bad',
            'This view could not be shown: ' + message + ' (details in the console log)'));
        $card.append(h.link('Back to list', act(backToListFromFailure)));
        $c.append($card);
    }

    function closeWindow() {
        if (isDirty()) notify('Template changes discarded');
        try { modal.hide(); } catch (e) { /* ignore */ }
    }

    function backToList() {
        leaveEdit();
        render();
    }

    // Built once per view kind: 'list', 'edit' or 'failed'.
    function renderFooter(kind) {
        state.footKind = kind;
        state.$save = null;
        state.$mid = null;
        var $footer = modal.Footer ? modal.Footer() : null;
        if (!$footer || !$footer.length) return;
        var h = H();
        $footer.empty();
        if (kind === 'edit') {
            state.$save = h.button('Save template', { onClick: act(saveDraft) });
            state.$mid = $('<span>');
            var $back = h.button('Back to list', { onClick: act(backToList) });
            $back.addClass('steward-foot-right');
            $footer.append(state.$save).append(state.$mid).append($back);
            updateFooter();
            return;
        }
        var $close = h.button('Close', { onClick: closeWindow });
        $close.addClass('steward-foot-right');
        $footer.append($close);
        var folder = T().dirPath();
        $footer.append(folder
            ? textEl('span', 'steward-foot-note', 'Each template is a file in ' + folder)
            : textEl('span', 'steward-bad', 'No writable steward folder'));
    }

    function canSaveDraft() {
        return isDirty() && needs(state.draft, state.recs).length === 0;
    }

    // Text, classes and disabled state only, on the existing elements.
    function updateFooter() {
        if (!state || !state.$save || !state.$mid || state.view !== 'edit' || !state.draft) return;
        var missing = needs(state.draft, state.recs);
        var dirty = isDirty();
        var ok = dirty && missing.length === 0;
        state.$save.prop('disabled', !ok);
        state.$save.toggleClass('steward-primary', ok);
        state.$mid.removeClass('steward-foot-need steward-foot-dirty steward-foot-note');
        if (missing.length) {
            state.$mid.addClass('steward-foot-need').text('Still needs ' + missing.join(', '));
        } else if (dirty) {
            state.$mid.addClass('steward-foot-dirty').text('Unsaved template changes');
        } else {
            state.$mid.addClass('steward-foot-note').text('No changes');
        }
    }

    function open() {
        if (typeof Modal === 'undefined') {
            S.kernel.error('adventures', 'host Modal class unavailable — cannot open the template dialog');
            notify('The template dialog needs the game window; try again once the island is loaded.');
            return;
        }
        // Opening drops the draft, and hiding the dashboard would strand its
        // unsaved changes, so either kind of open edit refuses.
        var ui = S.kernel.ui;
        if (ui && typeof ui.hasOpenEdits === 'function' && ui.hasOpenEdits()) {
            notify('Save or close the open window first');
            return;
        }
        if (ui && typeof ui.ensureStyle === 'function') ui.ensureStyle(MODAL_ID);
        state = {
            view: 'list', draft: null, orig: null, title: null, recs: null, problems: null,
            confirmDelete: null, error: null, labelInput: null, lastBuff: null, moved: -1,
            footKind: null, $save: null, $mid: null
        };
        try {
            modal = new Modal(MODAL_ID, TITLE, true);
            modal.create();
            render();
            modal.show();
            syncMenu();
        } catch (e) {
            S.kernel.error('adventures', 'open template dialog threw:', e);
        }
    }

    function errorLine($c) {
        if (!state.error) return;
        $c.append(textEl('div', 'steward-bad', state.error));
    }

    // ---- List view ------------------------------------------------------------

    function newTemplate() {
        var draft = T().normalize({});
        // A new template starts with the horseshoe on, even with none in stock.
        draft.speedBuff = T().enabledSpeedBuff(null, S.core.buffs.speedBuffs());
        beginEdit(draft);
    }

    function editTemplate(id) {
        var rec = T().get(id);
        if (!rec) {
            state.error = 'Could not open ' + id;
            render();
            return;
        }
        rec.speedBuff = T().initialSpeedBuff(rec, S.core.buffs.speedBuffs());
        beginEdit(rec);
    }

    function deleteLink(id, name) {
        var h = H();
        var confirming = state.confirmDelete === id;
        var onClick = function () {
            state.error = null;
            state.moved = -1;
            if (!confirming) {
                state.confirmDelete = id;
            } else {
                state.confirmDelete = null;
                if (!T().remove(id)) state.error = 'Could not delete ' + name;
                else syncMenu();
            }
            render();
        };
        return confirming
            ? h.link('Delete for good', onClick, { danger: true, confirm: true })
            : h.link('Delete', onClick, { danger: true });
    }

    function actionsCell(rec, name, editable) {
        var $a = $('<span>');
        if (editable) {
            $a.append(btn('Edit', act(function () { editTemplate(rec.id); })));
            $a.append(' ');
        }
        $a.append(deleteLink(rec.id, name));
        return $a;
    }

    // The horseshoe's short name (the label before its stock count) with
    // the full one as the tooltip.
    function horseshoeCell(rec, buffs) {
        var name = T().resolveSpeedBuff(rec, buffs);
        if (name === null) return { text: 'none', cls: 'steward-muted' };
        var full = T().buffLabel(buffs, name);
        var cut = full.indexOf(' (');
        return { text: cut === -1 ? full : full.substring(0, cut), title: full };
    }

    function recordRow(rec, buffs) {
        var adventure = S.core.adventures.label(rec.adventure) || rec.adventure;
        return [
            { $: $('<b>').text(rec.label), title: rec.label },
            adventure,
            String(rec.waves.length),
            horseshoeCell(rec, buffs),
            actionsCell(rec, rec.id + T().EXT, true)
        ];
    }

    function brokenRow(rec) {
        var name = rec.id + T().EXT;
        return [
            { text: name, cls: 'steward-bad' },
            { text: rec.error, cls: 'steward-bad' },
            '',
            '',
            actionsCell(rec, name, false)
        ];
    }

    function renderList($c) {
        var h = H();
        var t = T();
        var folder = t.dirPath();

        var phase = S.modules.adventures.runPhase ? S.modules.adventures.runPhase() : 'none';
        var store = S.modules.adventures.state;
        if (phase !== 'none' && store) {
            $c.append(h.banner(store.status() + '. Pause or stop it in the ~Adventures~ menu.', { icon: '⚔' }));
        }
        errorLine($c);

        var buffs = S.core.buffs.speedBuffs();
        var recs = t.list();
        var rows = [];
        for (var i = 0; i < recs.length; i++) {
            rows.push(recs[i].error !== undefined ? brokenRow(recs[i]) : recordRow(recs[i], buffs));
        }

        var $card = h.card({
            icon:   '⚔',
            title:  'Run templates',
            meta:   plural(recs.length, 'template') + ' · start one from ~Steward~ › Adventures',
            $tools: folder ? btn('New template', act(newTemplate)) : null
        });
        $card.append(h.table({
            cols: [
                { label: 'Template',  width: '27%' },
                { label: 'Adventure', width: '25%' },
                { label: 'Waves',     width: '8%', cls: 'steward-num' },
                { label: 'Horseshoe', width: '17%' },
                { label: '',          width: '23%', cls: 'steward-num' }
            ],
            rows:      rows,
            emptyText: 'No templates yet. Make one with New template.'
        }));
        $c.append($card);
    }

    // ---- Edit view ------------------------------------------------------------

    function adventureControl(draft) {
        var h = H();
        var defs = S.core.adventures.definitions();
        if (!defs.length) {
            var $in = h.input({ value: draft.adventure, placeholder: 'Adventure name', title: 'Adventure' });
            $in.on('input', function () {
                draft.adventure = $in.val();
                updateFooter();
            });
            return $in;
        }
        // One flat list in label order, so a map is found by the name shown.
        var list = S.core.adventures.selectable(defs);
        var $sel = $('<select>', { 'class': 'steward-dropdown', title: 'Adventure' });
        var found = false;
        $sel.append($('<option>', { value: '' }).text('— choose —'));
        for (var i = 0; i < list.length; i++) {
            var def = list[i];
            var $o = $('<option>', { value: def.name }).text(def.label);
            if (def.name === draft.adventure) { $o.attr('selected', 'selected'); found = true; }
            $sel.append($o);
        }
        // An old template keeps its map even when it is no longer listed.
        if (draft.adventure && !found) {
            var $x = $('<option>', { value: draft.adventure })
                .text(S.core.adventures.label(draft.adventure) || draft.adventure);
            $x.attr('selected', 'selected');
            $sel.append($x);
        }
        $sel.on('change', function () {
            // Keep the user's own label; only an empty or auto-filled one follows the map.
            var prevLabel = draft.adventure ? (S.core.adventures.label(draft.adventure) || draft.adventure) : '';
            var name = $sel.val();
            var nextLabel = name ? (S.core.adventures.label(name) || name) : '';
            var current = state.labelInput ? state.labelInput.val() : draft.label;
            var auto = T().autoLabel(current, prevLabel, nextLabel);
            if (auto !== null) {
                draft.label = auto;
                if (state.labelInput) state.labelInput.val(auto);
            }
            draft.adventure = name;
            updateFooter();
        });
        return $sel;
    }

    // The loadout's general lines, troops and problems as one line of text.
    function loadoutSummary(path) {
        var ld = S.core.battles.load(path);
        var generals = 0;
        var units = {};
        for (var i = 0; i < ld.lines.length; i++) {
            var l = ld.lines[i];
            if (!S.core.battles.isGeneralLine(l)) continue;
            generals++;
            units = S.core.army.add(units, l.army);
        }
        return plural(generals, 'general line') + ' · ' + S.core.army.text(units) + ' · ' +
            plural(ld.problems.length, 'problem');
    }

    function pickLoadout() {
        var ok = S.kernel.files.browse({
            title: 'Choose the loadout battle file',
            multiple: false,
            filters: S.core.battles.BROWSE_FILTERS,
            startDir: startDir()
        }, function (paths) {
            if (!paths.length) return;
            state.draft.loadout = paths[0];
            rememberDir(paths[0]);
            render();
        });
        if (!ok) { state.error = 'Could not open the file picker'; render(); }
    }

    function pickWaves() {
        var ok = S.kernel.files.browse({
            title: 'Choose wave battle files',
            multiple: true,
            filters: S.core.battles.BROWSE_FILTERS,
            startDir: startDir()
        }, function (paths) {
            if (!paths.length) return;
            for (var i = 0; i < paths.length; i++) state.draft.waves.push(paths[i]);
            rememberDir(paths[paths.length - 1]);
            render();
        });
        if (!ok) { state.error = 'Could not open the file picker'; render(); }
    }

    function moveWave(idx, by) {
        var w = state.draft.waves;
        var to = idx + by;
        if (!(idx >= 0 && idx < w.length) || to < 0 || to >= w.length) return;
        var tmp = w[idx];
        w[idx] = w[to];
        w[to] = tmp;
        state.moved = to;
        render();
    }

    // Attack and move lines of a wave file, or null when it cannot be read.
    function waveCounts(path) {
        var ld = S.core.battles.load(path);
        if (!ld.ok) return null;
        var attack = 0;
        var move = 0;
        for (var i = 0; i < ld.lines.length; i++) {
            if (ld.lines[i].kind === S.BattleLine.Attack) attack++;
            else if (ld.lines[i].kind === S.BattleLine.Move) move++;
        }
        return plural(attack, 'attack') + ' · ' + plural(move, 'move');
    }

    // Number and arrow states of every row from its current position.
    function renumber(rows) {
        var n = rows.length;
        for (var i = 0; i < n; i++) {
            var r = rows[i];
            r.$li.attr('data-idx', String(i));
            r.$n.text(String(i + 1));
            r.$up.prop('disabled', i === 0);
            r.$down.prop('disabled', i === n - 1);
        }
    }

    function waveList(draft) {
        var $ol = $('<ol>', { 'class': 'steward-waves' });
        var sortable = !!($.fn && $.fn.sortable);
        var rows = [];
        // A drag renumbers rows in place, so every button reads its row's
        // index at click time rather than the one it was built with.
        var at = function ($li) { return parseInt($li.attr('data-idx'), 10); };
        for (var i = 0; i < draft.waves.length; i++) {
            (function (idx) {
                var path = draft.waves[idx];
                var last = draft.waves.length - 1;
                var $li = $('<li>', { 'data-idx': String(idx) });
                if (state.moved === idx) $li.addClass('steward-moved');
                if (sortable) $li.append(textEl('span', 'steward-handle', '⋮⋮'));
                var $n = textEl('span', 'steward-wave-n', String(idx + 1));
                $li.append($n);
                var counts = waveCounts(path);
                var $f = $('<span>', { 'class': 'steward-wave-f', title: path }).text(T().fileName(path));
                $f.append(counts === null ? textEl('small', 'steward-bad', 'unreadable') : textEl('small', null, counts));
                $li.append($f);
                var $up = iconBtn('↑', 'Move up', idx === 0, function () { moveWave(at($li), -1); });
                var $down = iconBtn('↓', 'Move down', idx === last, function () { moveWave(at($li), 1); });
                var $rm = iconBtn('×', 'Remove', false, function () {
                    var k = at($li);
                    if (!(k >= 0 && k < draft.waves.length)) return;
                    draft.waves.splice(k, 1);
                    state.moved = -1;
                    render();
                });
                $li.append($up).append($down).append($rm);
                rows.push({ $li: $li, $n: $n, $up: $up, $down: $down });
                $ol.append($li);
            }(i));
        }
        // The update handler runs inside the sortable's own mouse-stop, so it
        // must not re-render (that would destroy the sortable under it): it
        // reorders the draft and renumbers the rows in place.
        if (sortable && draft.waves.length > 1) {
            $ol.sortable({
                update: function () {
                    var order = [];
                    $ol.children('li').each(function () {
                        order.push(parseInt($(this).attr('data-idx'), 10));
                    });
                    var next = T().reorderWaves(draft.waves, order);
                    if (next === null) {
                        // The next render shows the draft's real order again.
                        S.kernel.warn('adventures', 'wave reorder ignored: bad order');
                        return;
                    }
                    draft.waves = next;
                    var byOld = [];
                    for (var k = 0; k < order.length; k++) byOld.push(rows[order[k]]);
                    rows = byOld;
                    renumber(rows);
                    updateFooter();
                }
            });
        }
        return $ol;
    }

    function saveDraft() {
        if (!canSaveDraft()) return;
        var r = T().save(state.draft, new Date().getTime());
        if (!r.ok) {
            state.problems = r.problems;
            render();
            return;
        }
        state.draft = null;
        state.orig = null;
        state.recs = null;
        state.problems = null;
        state.view = 'list';
        render();
        syncMenu();
    }

    function templateCard(draft) {
        var h = H();
        var $card = h.card({ icon: '⚔', title: 'Template' });

        var $label = h.input({ value: draft.label, placeholder: 'Template name', title: 'Label' });
        $label.on('input', function () {
            draft.label = $label.val();
            updateFooter();
        });
        state.labelInput = $label;
        $card.append(h.field('Label', 'Shown in the menu', $label, { wide: true }));
        $card.append(h.field('Adventure', null, adventureControl(draft), { wide: true }));

        var help = draft.loadout
            ? T().fileName(draft.loadout) + ' · ' + loadoutSummary(draft.loadout)
            : 'No loadout file chosen yet';
        $card.append(h.field('Loadout', help, btn('Choose…', act(pickLoadout))));
        return $card;
    }

    function speedCard(draft) {
        var h = H();
        var t = T();
        var buffs = S.core.buffs.speedBuffs();
        var useShoe = draft.speedBuff !== S.SpeedBuffChoice.None;
        var $card = h.card({ title: 'Speed' });
        // The re-render shows the switch off again when no buff exists at all,
        // and turning it back on restores the buff it held.
        $card.append(h.field('Use a horseshoe', 'Speeds up the generals on the map', h.toggle({
            checked:  useShoe,
            label:    'Use a horseshoe',
            onChange: function (on) {
                if (on) {
                    draft.speedBuff = t.enabledSpeedBuff(state.lastBuff, buffs);
                } else {
                    state.lastBuff = draft.speedBuff;
                    draft.speedBuff = S.SpeedBuffChoice.None;
                }
                render();
            }
        })));
        // While off, the dropdown shows the buff the switch would restore.
        var shown = useShoe ? draft.speedBuff : t.enabledSpeedBuff(state.lastBuff, buffs);
        var options = t.speedBuffOptions(buffs, shown);
        var $dd = h.dropdown(options, {
            selected: shown,
            disabled: !useShoe,
            onChange: function (v) {
                draft.speedBuff = v;
                render();
            }
        });
        $card.append(h.field('Horseshoe', null, $dd, { sub: true, disabled: !useShoe, wrap: true }));
        if (useShoe) {
            for (var i = 0; i < options.length; i++) {
                if (options[i].value === draft.speedBuff && options[i].warn) {
                    $card.append(textEl('div', 'steward-warn', 'None in stock: a run would skip the horseshoe'));
                }
            }
        }
        return $card;
    }

    function wavesCard(draft) {
        var h = H();
        var $card = h.card({ title: 'Waves', meta: draft.waves.length + ' · in the order they run' });
        if (!draft.waves.length) {
            $card.append(h.empty('No waves yet.', 'Add the wave files of this adventure, in the order they run.'));
        } else {
            $card.append(waveList(draft));
        }
        $card.append(h.field('', 'Drag a wave or use the arrows to change the order.',
            btn('Add waves…', act(pickWaves))));
        return $card;
    }

    function renderEdit($c) {
        var h = H();
        var draft = state.draft;

        var $crumb = $('<div>', { 'class': 'steward-crumb' });
        $crumb.append(h.link('Run templates', act(backToList)));
        $crumb.append(textEl('span', null, '›'));
        $crumb.append(textEl('b', null, draft.id ? (state.title || draft.id) : 'New template'));
        $c.append($crumb);

        errorLine($c);
        if (state.problems) {
            for (var p = 0; p < state.problems.length; p++) {
                $c.append(textEl('div', 'steward-bad', state.problems[p].message));
            }
        }

        var $cols = $('<div>', { 'class': 'steward-cols' });
        var $side = $('<div>', { 'class': 'steward-side steward-edit' });
        var $main = $('<div>', { 'class': 'steward-main' });
        $side.append(templateCard(draft)).append(speedCard(draft));
        $main.append(wavesCard(draft));
        $cols.append($side).append($main);
        $c.append($cols);
    }

    // A section-limited boot without the kernel UI shell still loads this file.
    if (S.kernel.ui && typeof S.kernel.ui.addEditGuard === 'function') {
        S.kernel.ui.addEditGuard('adventures', hasEdits);
    }

    S.modules.adventures.dialog = {
        open:     open,
        hasEdits: hasEdits,
        needs:    needs
    };

}(Steward));
