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
 * the template card (label, adventure, loadout), the speed card (horseshoe),
 * the arrival card (send all to the star) and the list of waves and steps,
 * which a drag or the arrow buttons reorder. Steps (unload, send home,
 * pause) are rows of the same list between the battle files; the Add-step
 * card under the list builds one from the step registry. A step is changed
 * by removing it and adding a new one: one way in keeps the window small.
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
 * the footer names what is still missing, including a step row that does
 * not fit the sequence (a wave using a general sent home before it).
 *
 * Battle files are read at most once per render (a per-render cache keyed by
 * path): the row counts, the loadout names and the sequence check all read
 * the same files, and a drag reuses them, because a path still names the
 * same file after the list is reordered.
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
    // The step registry is another file; a build without it shows a plain
    // wave list, so every use goes through these guards.
    function St() { return S.modules.adventures.steps || null; }
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

    function isItem(v) {
        var st = St();
        return !!(st && typeof st.isItem === 'function' && st.isItem(v));
    }

    // Waves count battle files only, so a step row never shifts a number.
    // Without a registry no object survives normalize, so every entry is a wave.
    function waveTotal(list) {
        var st = St();
        return st && typeof st.waveCount === 'function' ? st.waveCount(list) : list.length;
    }

    function waveNo(list, i) {
        var st = St();
        return st && typeof st.waveNumber === 'function' ? st.waveNumber(list, i) : i + 1;
    }

    function kindLabel(item) {
        var st = St();
        return st && item && typeof st.titleOf === 'function' ? st.titleOf(item) : 'step';
    }

    // A battle file read once per render; see the file header.
    function loadFile(path) {
        if (!state.files) state.files = {};
        var k = 'f:' + path;
        if (!Object.prototype.hasOwnProperty.call(state.files, k)) state.files[k] = S.core.battles.load(path);
        return state.files[k];
    }

    // The loadout's general lines with their keys and plain names, or null
    // while no loadout is chosen or it cannot be read.
    function loadoutOf(draft) {
        if (!draft.loadout) return null;
        var ld = loadFile(draft.loadout);
        if (!ld.ok) return null;
        var st = St();
        var gens = [];
        for (var i = 0; i < ld.lines.length; i++) {
            if (S.core.battles.isGeneralLine(ld.lines[i])) gens.push(ld.lines[i]);
        }
        return {
            lines: gens,
            keys:  S.core.battles.loadoutKeys(ld.lines),
            names: st && typeof st.namesOf === 'function' ? st.namesOf(ld.lines) : {}
        };
    }

    // The registry's start-check problems of the draft's sequence, so the
    // window refuses what the run start would refuse.
    function seqOf(draft) {
        var st = St();
        if (!st || typeof st.checkSequence !== 'function') return [];
        var lo = loadoutOf(draft);
        var ctx = {
            loadoutKeys: lo ? lo.keys : null,
            names:       lo ? lo.names : {},
            // By the path at index i now, so a reordered list maps correctly.
            waveKeys:    function (i) {
                var p = draft.waves[i];
                if (typeof p !== 'string' || !p) return null;
                var f = loadFile(p);
                return f.ok ? S.core.battles.loadoutKeys(f.lines) : null;
            },
            fileName:    function (p) { return T().fileName(p); }
        };
        try {
            return st.checkSequence(draft.waves, ctx) || [];
        } catch (e) {
            S.kernel.error('adventures', 'step sequence check threw:', e);
            return [];
        }
    }

    // ---- Draft state ----------------------------------------------------------

    function snapshot(draft) {
        return JSON.stringify(T().normalize(draft));
    }

    function isDirty() {
        return !!(state && state.view === 'edit' && state.draft &&
            snapshot(state.draft) !== state.orig);
    }

    // Shown as Bootstrap sees it: a window fading out after a hide reads closed.
    function shown() {
        var ui = S.kernel.ui;
        return !!(modal && ui && typeof ui.isModalShown === 'function' && ui.isModalShown(modal));
    }

    // The edit guard: a changed draft in a window the user can see. A hidden
    // or fading window (closed by its header X or a zone load) holds nothing
    // to lose.
    function hasEdits() {
        return shown() && isDirty();
    }

    var NEED_PHRASES = {
        label:     'a label',
        adventure: 'an adventure',
        loadout:   'a loadout',
        speedBuff: 'a known horseshoe'
    };

    function fixPhrase(list, i) {
        if (typeof i !== 'number' || !(i >= 0 && i < list.length)) return 'a fix in the steps';
        var what = typeof list[i] === 'string' ? 'wave ' + waveNo(list, i) : kindLabel(list[i]);
        return 'a fix in row ' + (i + 1) + ' (' + what + ')';
    }

    // Pure over the template store's own checks: what the draft still lacks
    // before it can be saved, as short phrases for the footer. `recs` is the
    // template list the label is checked against; `seq` holds the sequence
    // problems of the draft (seqOf), each naming the row to fix.
    function needs(draft, recs, seq) {
        var t = T();
        var rec = t.normalize(draft);
        var problems = t.validate(rec);
        var out = [];
        var add = function (phrase) {
            if (phrase && out.indexOf(phrase) === -1) out.push(phrase);
        };
        for (var i = 0; i < problems.length; i++) {
            var f = problems[i].field;
            if (f === 'waves') add(waveTotal(rec.waves) ? 'a file for every wave' : 'at least one wave');
            else if (f === 'steps') add(fixPhrase(rec.waves, problems[i].index));
            else add(NEED_PHRASES[f]);
        }
        seq = seq || [];
        for (var j = 0; j < seq.length; j++) add(fixPhrase(draft.waves, seq[j].index));
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
        state.adding = null;
        state.seqProblems = [];
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
        state.adding = null;
        state.seqProblems = [];
        state.view = 'list';
    }

    // ---- Shell ----------------------------------------------------------------

    function render() {
        if (!modal) return;
        var $body = modal.Body();
        if (!$body || !$body.length) return;
        state.labelInput = null;
        state.$addStep = null;
        state.$addNote = null;
        // Read every file afresh per render: one may have changed on disk.
        state.files = {};
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
        state.adding = null;
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

    // Hides only a dialog that is really shown: a second hide during the fade
    // would unbalance the host's stage swap and leave the game layer on top.
    function closeWindow() {
        if (isDirty()) notify('Template changes discarded');
        var ui = S.kernel.ui;
        if (ui && typeof ui.hideModal === 'function') ui.hideModal(modal);
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
        return isDirty() && needs(state.draft, state.recs, state.seqProblems).length === 0;
    }

    // Text, classes and disabled state only, on the existing elements.
    function updateFooter() {
        if (!state || !state.$save || !state.$mid || state.view !== 'edit' || !state.draft) return;
        var missing = needs(state.draft, state.recs, state.seqProblems);
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
            footKind: null, $save: null, $mid: null,
            adding: null, $addStep: null, $addNote: null, seqProblems: [], files: {}
        };
        try {
            modal = new Modal(MODAL_ID, TITLE, true);
            modal.create();
            render();
            // The kernel show settles dialogs still fading out, which a raw
            // host show would hide a second time.
            if (ui && typeof ui.showModal === 'function') ui.showModal(modal);
            else modal.show();
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
            String(waveTotal(rec.waves)),
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
        var ld = loadFile(path);
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
        var ld = loadFile(path);
        if (!ld.ok) return null;
        var attack = 0;
        var move = 0;
        for (var i = 0; i < ld.lines.length; i++) {
            if (ld.lines[i].kind === S.BattleLine.Attack) attack++;
            else if (ld.lines[i].kind === S.BattleLine.Move) move++;
        }
        return plural(attack, 'attack') + ' · ' + plural(move, 'move');
    }

    // Number and arrow states of every row from its current position in
    // `list`: battle files carry their wave number, step rows a bullet.
    function renumber(rows, list) {
        var n = rows.length;
        for (var i = 0; i < n; i++) {
            var r = rows[i];
            r.$li.attr('data-idx', String(i));
            r.$n.text(typeof list[i] === 'string' ? String(waveNo(list, i)) : '•');
            r.$up.prop('disabled', i === 0);
            r.$down.prop('disabled', i === n - 1);
        }
    }

    // The first sequence problem filed against row i, or null.
    function rowProblem(i) {
        var seq = state.seqProblems || [];
        for (var k = 0; k < seq.length; k++) {
            if (seq[k].index === i) return seq[k].message;
        }
        return null;
    }

    // Name slot of a step row: the kind label in bold, then the rest of the
    // registry's row text; a sequence problem replaces the help line.
    function itemSlot(entry, idx, names) {
        var st = St();
        var $f = $('<span>', { 'class': 'steward-wave-f' });
        if (!isItem(entry)) {
            $f.append(textEl('b', null, 'Unknown step'));
            $f.append(textEl('small', 'steward-bad', 'this build cannot run it; remove it'));
            return $f;
        }
        var txt = st.itemText(entry, names) || { name: kindLabel(entry), small: '' };
        var name = String(txt.name || '');
        var label = kindLabel(entry);
        if (name.indexOf(label) === 0) {
            $f.append(textEl('b', null, label));
            if (name.length > label.length) $f.append(textEl('span', null, name.substring(label.length)));
        } else {
            $f.append(textEl('b', null, name));
        }
        var bad = rowProblem(idx);
        $f.append(bad !== null ? textEl('small', 'steward-bad', bad) : textEl('small', null, txt.small || ''));
        return $f;
    }

    function waveList(draft) {
        var $ol = $('<ol>', { 'class': 'steward-waves' });
        var sortable = !!($.fn && $.fn.sortable);
        var rows = [];
        // A drag renumbers rows in place, so every button reads its row's
        // index at click time rather than the one it was built with.
        var at = function ($li) { return parseInt($li.attr('data-idx'), 10); };
        var lo = loadoutOf(draft);
        var names = lo ? lo.names : {};
        for (var i = 0; i < draft.waves.length; i++) {
            (function (idx) {
                var entry = draft.waves[idx];
                var file = typeof entry === 'string';
                var last = draft.waves.length - 1;
                var $li = $('<li>', { 'data-idx': String(idx) });
                if (state.moved === idx) $li.addClass('steward-moved');
                if (sortable) $li.append(textEl('span', 'steward-handle', '⋮⋮'));
                var $n = textEl('span', 'steward-wave-n', file ? String(waveNo(draft.waves, idx)) : '•');
                $li.append($n);
                if (file) {
                    var counts = waveCounts(entry);
                    var $f = $('<span>', { 'class': 'steward-wave-f', title: entry }).text(T().fileName(entry));
                    $f.append(counts === null ? textEl('small', 'steward-bad', 'unreadable') : textEl('small', null, counts));
                    $li.append($f);
                } else {
                    $li.append(itemSlot(entry, idx, names));
                }
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
        // reorders the draft, renumbers the rows in place and checks the new
        // sequence, so the footer and Save follow the drag at once. The row
        // problem texts keep their old rows until the next render.
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
                    renumber(rows, draft.waves);
                    state.seqProblems = seqOf(draft);
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

    function arrivalCard(draft) {
        var h = H();
        var $card = h.card({ title: 'On arrival' });
        $card.append(h.field('Send all to the star on arrival',
            'Every general walks to the star first, then each wave sends him to his grid', h.toggle({
                checked:  draft.starAll !== false,
                label:    'Send all to the star on arrival',
                onChange: function (on) {
                    draft.starAll = !!on;
                    render();
                }
            })));
        return $card;
    }

    function wavesCard(draft) {
        var h = H();
        var waves = waveTotal(draft.waves);
        var steps = draft.waves.length - waves;
        var meta = plural(waves, 'wave') + (steps ? ' · ' + plural(steps, 'step') : '') + ' · in the order they run';
        var $card = h.card({ title: 'Waves and steps', meta: meta });
        if (!draft.waves.length) {
            $card.append(h.empty('No waves yet.', 'Add the wave files of this adventure, in the order they run.'));
        } else {
            $card.append(waveList(draft));
        }
        var $btns = $('<span>').append(btn('Add waves…', act(pickWaves)));
        if (stepKinds().length) {
            $btns.append(' ').append(h.button('Add step…', {
                size: 'sm', primary: !!state.adding, onClick: act(openAdding)
            }));
        }
        $card.append(h.field('', 'Drag a row or use the arrows to change the order.', $btns, { wide: true }));
        return $card;
    }

    // ---- Add-step card --------------------------------------------------------
    //
    // `state.adding` holds the open card's choices ({ kind, generals, message,
    // minutes, place }) or null while it is closed. Kinds, labels, help and
    // the checks all come from the step registry.

    function stepKinds() {
        var st = St();
        return st && typeof st.kinds === 'function' ? st.kinds() : [];
    }

    function kindRow(kind) {
        var st = St();
        return st && typeof st.byKind === 'function' ? st.byKind(kind) : null;
    }

    function minutesOf(text) {
        var s = String(text || '').replace(/^\s+|\s+$/g, '');
        if (s === '') return null;
        var n = Number(s);
        return isNaN(n) ? null : n;
    }

    // A widget per kind of input, never per kind of step: the step's registry
    // row names the input it takes, and the card draws that one.
    var INPUTS = {
        generals: {
            blank: function () { return []; },
            value: function (a) { return a.generals.slice(0); },
            render: function ($card, draft, a, at) { generalFields($card, draft, a, at); }
        },
        message: {
            blank: function () { return ''; },
            value: function (a) { return a.message; },
            render: function ($card, draft, a) {
                var $msg = H().input({ value: a.message, placeholder: 'Optional', title: 'Message' });
                $msg.on('input', function () {
                    a.message = $msg.val();
                    updateAdding();
                });
                $card.append(H().field('Message', 'Shown in the run menu and the game alert', $msg, { wide: true }));
            }
        },
        minutes: {
            blank: function () { return ''; },
            value: function (a) { return minutesOf(a.minutes); },
            render: function ($card, draft, a) {
                var st = St();
                var $min = H().input({ value: a.minutes, placeholder: 'Minutes', title: 'Minutes', width: '80px' });
                $min.on('input', function () {
                    a.minutes = $min.val();
                    updateAdding();
                });
                $card.append(H().field('Minutes',
                    'Whole minutes from ' + st.MIN_MINUTES + ' to ' + st.MAX_MINUTES + '; the run then goes on by itself',
                    $min));
            }
        }
    };

    function openAdding() {
        var ks = stepKinds();
        if (!ks.length) return;
        if (!state.adding) {
            state.adding = { kind: ks[0].kind, place: 'end' };
            for (var name in INPUTS) {
                if (Object.prototype.hasOwnProperty.call(INPUTS, name)) state.adding[name] = INPUTS[name].blank();
            }
        }
        render();
    }

    function cancelAdding() {
        state.adding = null;
        render();
    }

    // Where the new row goes: 'end', or after wave N and the step rows
    // directly after it, which is right before wave N + 1.
    function placeIndex(list, place) {
        if (place === 'end') return list.length;
        var n = parseInt(place, 10);
        var st = St();
        var at = st && typeof st.indexOfWave === 'function' ? st.indexOfWave(list, n + 1) : -1;
        return at === -1 ? list.length : at;
    }

    // The item the card would add, through the registry's own parser.
    function addingItem(a) {
        var st = St();
        if (!st || typeof st.normItem !== 'function') return null;
        var row = kindRow(a.kind);
        if (!row || !INPUTS[row.input]) return null;
        var raw = { step: a.kind };
        raw[row.input] = INPUTS[row.input].value(a);
        return st.normItem(raw);
    }

    function addingProblems(a) {
        var item = addingItem(a);
        if (!item) return ['unknown step'];
        var st = St();
        var ps = typeof st.itemProblems === 'function' ? (st.itemProblems(item) || []) : [];
        return ps.slice(0);
    }

    // Text and disabled state only, so typing keeps the focus.
    function updateAdding() {
        if (!state.adding || !state.$addStep) return;
        var ps = addingProblems(state.adding);
        state.$addStep.prop('disabled', ps.length > 0);
        state.$addStep.toggleClass('steward-primary', ps.length === 0);
        if (state.$addNote) state.$addNote.text(ps.length ? ps[0] : '');
    }

    function addStep() {
        var a = state.adding;
        if (!a || addingProblems(a).length) return;
        var item = addingItem(a);
        var at = placeIndex(state.draft.waves, a.place);
        state.draft.waves.splice(at, 0, item);
        state.adding = null;
        state.moved = at;
        render();
    }

    function generalFields($card, draft, a, at) {
        var h = H();
        var lo = loadoutOf(draft);
        if (!lo) {
            $card.append(textEl('div', 'steward-muted', 'Choose a readable loadout first: the generals come from it'));
            return;
        }
        // The same rule the start check applies to Unload and Send home rows,
        // from the one function. It maps a key to its row index, and a row at
        // index 0 has value 0, so membership is tested, never truthiness.
        var sent = (St() && typeof St().sentBefore === 'function') ? St().sentBefore(draft.waves, at) : {};
        function isSent(key) { return Object.prototype.hasOwnProperty.call(sent, key); }
        var keys = [];
        for (var i = 0; i < lo.lines.length; i++) {
            var key = lo.lines[i].key;
            if (key && keys.indexOf(key) === -1) keys.push(key);
        }
        // A general that cannot be chosen at this place is never kept chosen.
        var kept = [];
        for (var g = 0; g < a.generals.length; g++) {
            if (keys.indexOf(a.generals[g]) !== -1 && !isSent(a.generals[g])) kept.push(a.generals[g]);
        }
        a.generals = kept;
        $card.append(h.subHead('Generals', 'from the loadout · ' + keys.length));
        var seen = {};
        for (var j = 0; j < lo.lines.length; j++) {
            (function (line) {
                if (!line.key || seen[line.key]) return;
                seen[line.key] = true;
                var name = lo.names[line.key] || line.name || line.key;
                var off = isSent(line.key);
                var help = off ? 'Sent home at an earlier row' : 'Loadout: ' + S.core.army.text(line.army);
                $card.append(h.field(name, help, h.toggle({
                    checked:  a.generals.indexOf(line.key) !== -1,
                    disabled: off,
                    label:    name,
                    onChange: function (on) {
                        // Rebuilt in loadout order, so the row reads like the loadout.
                        var next = [];
                        for (var k = 0; k < keys.length; k++) {
                            var chosen = keys[k] === line.key ? on : a.generals.indexOf(keys[k]) !== -1;
                            if (chosen) next.push(keys[k]);
                        }
                        a.generals = next;
                        updateAdding();
                    }
                }), { disabled: off }));
            }(lo.lines[j]));
        }
    }

    function addStepCard(draft) {
        var h = H();
        var a = state.adding;
        var row = kindRow(a.kind) || kindRow(stepKinds()[0].kind);
        a.kind = row.kind;
        var $card = h.card({ title: 'Add a step' });

        var ks = stepKinds();
        var opts = [];
        for (var i = 0; i < ks.length; i++) opts.push({ label: ks[i].addLabel, value: ks[i].kind });
        $card.append(h.field('Step', row.help, h.dropdown(opts, {
            selected: a.kind,
            onChange: function (v) {
                a.kind = v;
                render();
            }
        }), { wide: true }));

        var at = placeIndex(draft.waves, a.place);
        if (INPUTS[row.input]) INPUTS[row.input].render($card, draft, a, at);

        var places = [{ label: 'At the end', value: 'end' }];
        var count = waveTotal(draft.waves);
        for (var n = 1; n < count; n++) places.push({ label: 'After wave ' + n, value: String(n) });
        $card.append(h.field('Place', 'Where the new row goes', h.dropdown(places, {
            selected: a.place,
            onChange: function (v) {
                a.place = v;
                render();
            }
        }), { wide: true }));

        var $foot = $('<div>', { 'class': 'steward-card-foot' });
        state.$addStep = h.button('Add step', { size: 'sm', onClick: act(addStep) });
        state.$addNote = textEl('span', 'steward-muted', '');
        $foot.append(state.$addStep).append(' ').append(h.link('Cancel', act(cancelAdding)))
            .append(' ').append(state.$addNote);
        $card.append($foot);
        updateAdding();
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
        // Once per render, before the rows that show its problems.
        state.seqProblems = seqOf(draft);
        $side.append(templateCard(draft)).append(speedCard(draft)).append(arrivalCard(draft));
        $main.append(wavesCard(draft));
        if (state.adding && stepKinds().length) $main.append(addStepCard(draft));
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
