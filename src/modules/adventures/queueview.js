/*
 * Queue views of the Run templates window.
 *
 * dialog.js owns the window, its Templates | Queues switch and the edit
 * guard; this file builds the two queue views inside its panel and keeps the
 * queue draft. The list shows every queue file, broken ones included so they
 * can be deleted, tags the queue that is running now and offers Edit and a
 * two-step Delete. The edit view holds the label, the entry rows (kind
 * badge, name, runs, up, down, remove), one Add entry select grouped
 * Adventures and Scenarios, and the Queue options (loop and passes, retrain,
 * no map left, the early switch).
 *
 * Edits are buffered in a draft until Save, which writes the file through
 * queues.save. `orig` is the normalized draft as it was when editing began,
 * so Save and the edit guard tell an unchanged draft from a changed one.
 * Save stays disabled until the draft changed and queues.validate is clean;
 * the line beside it names what is still missing. The footer is built once
 * per render and only updated while the user types or picks, so the Save
 * button is never replaced under a click.
 *
 * Editing the queue that is running is allowed: a started queue is a copy,
 * so a saved edit applies at its next start. The view says so, naming the
 * entry running now, and so does the notice after Save.
 *
 * An entry stores only its kind and id; the names shown are read from the
 * template or scenario record, and an entry whose record is missing or whose
 * kind this build does not know stays in the draft, marked, so the user can
 * remove it.
 *
 * The window calls renderList($c, ctx), renderEdit($c, ctx, id) (null id
 * starts a new queue), isDirty(), editing() (a draft is held, so the window
 * shows the editor) and reset(). ctx carries the window's
 * helpers: btn, iconBtn, textEl, act (wraps a click handler), notify,
 * syncMenu, render (rebuild the view), backToList.
 *
 * Reload safety: no timers and no function cached from another file; every
 * handler calls S.modules.adventures.* and S.kernel.* when it runs. Every
 * user-supplied string (labels, ids, messages) goes in with .text(), never
 * as HTML.
 *
 * Bundle slot: module file, after queues.js and before resolve.js; the top
 * level only assigns S.modules.adventures.queueview.
 */

(function (S) {
    'use strict';

    if (!S.modules.adventures) S.modules.adventures = {};

    // The edit view's draft, or null outside it.
    var view = null;
    // List view: the id awaiting a delete confirmation and the last error.
    var confirmDelete = null;
    var listError = null;
    // The footer elements of the edit view last rendered.
    var $save = null;
    var $mid = null;

    var PICK_SEP = ':';

    function Q() { return S.modules.adventures.queues; }
    function T() { return S.modules.adventures.templates; }
    function Sc() { return S.modules.adventures.scenarios; }
    function H() { return S.kernel.ui.helpers; }

    function plural(n, one, many) {
        return n + ' ' + (n === 1 ? one : many);
    }

    function snapshot(draft) {
        return JSON.stringify(Q().normalize(draft));
    }

    function isDirty() {
        return !!(view && view.draft && snapshot(view.draft) !== view.orig);
    }

    // True while a draft is held: New queue or a successful Edit began one.
    function editing() {
        return view !== null;
    }

    function reset() {
        view = null;
        confirmDelete = null;
        listError = null;
        $save = null;
        $mid = null;
    }

    // The running queue's copy, or null.
    function running() {
        var st = S.modules.adventures.state;
        if (!st || typeof st.current !== 'function') return null;
        var req = st.current().request;
        return req && req.queue ? req.queue : null;
    }

    // "entry k/K: <label>" of the running queue, from its own copy.
    function runningWhere(q) {
        var e = q.entries[q.index];
        return 'entry ' + (q.index + 1) + '/' + q.entries.length + (e ? ': ' + e.label : '');
    }

    // Whole number from typed text, or null when it is not one.
    function wholeOf(text, min) {
        var t = String(text).replace(/^\s+|\s+$/g, '');
        if (!/^\d+$/.test(t)) return null;
        var n = parseInt(t, 10);
        return n < min ? null : n;
    }

    // ---- List view ------------------------------------------------------------

    function kindCounts(rec) {
        var k = Q().KIND;
        var a = 0, s = 0, other = 0;
        for (var i = 0; i < rec.entries.length; i++) {
            var kind = rec.entries[i].kind;
            if (kind === k.Template) a++;
            else if (kind === k.Scenario) s++;
            else other++;
        }
        var parts = [];
        if (a) parts.push(plural(a, 'adventure', 'adventures'));
        if (s) parts.push(plural(s, 'scenario', 'scenarios'));
        if (other) parts.push(other + ' unknown');
        return rec.entries.length + (parts.length ? ' (' + parts.join(', ') + ')' : '');
    }

    function loopText(rec) {
        if (!rec.loop) return 'no loop';
        return rec.passes > 0 ? plural(rec.passes, 'pass', 'passes') : 'endless';
    }

    function optionsText(rec) {
        var text = 'retrain: ' + rec.retrain + ' · no map: ' + rec.noMap;
        return text + (rec.early ? ' · early' : '');
    }

    function newQueue(ctx) {
        beginEdit(Q().normalize({}));
        ctx.render();
    }

    function editQueue(ctx, id) {
        var rec = Q().get(id);
        if (!rec) {
            listError = 'Could not open ' + id;
            ctx.render();
            return;
        }
        beginEdit(rec);
        ctx.render();
    }

    function deleteLink(ctx, id, name) {
        var h = H();
        var confirming = confirmDelete === id;
        var onClick = ctx.act(function () {
            listError = null;
            if (!confirming) {
                confirmDelete = id;
            } else {
                confirmDelete = null;
                if (!Q().remove(id)) listError = 'Could not delete ' + name;
                else ctx.syncMenu();
            }
            ctx.render();
        });
        return confirming
            ? h.link('Delete for good', onClick, { danger: true, confirm: true })
            : h.link('Delete', onClick, { danger: true });
    }

    function actionsCell(ctx, rec, name, editable) {
        var $a = $('<span>');
        if (editable) {
            $a.append(ctx.btn('Edit', ctx.act(function () {
                confirmDelete = null;
                editQueue(ctx, rec.id);
            })));
            $a.append(' ');
        }
        $a.append(deleteLink(ctx, rec.id, name));
        return $a;
    }

    function recordRow(ctx, rec, run) {
        var $name = $('<span>').append(ctx.textEl('b', null, rec.label));
        if (run && run.id === rec.id) $name.append(' ').append(H().badge('busy', 'running now'));
        return [
            { $: $name, title: rec.label },
            kindCounts(rec),
            loopText(rec),
            optionsText(rec),
            actionsCell(ctx, rec, rec.id + T().EXT, true)
        ];
    }

    function brokenRow(ctx, rec) {
        var name = rec.id + T().EXT;
        return [
            { text: name, cls: 'steward-bad' },
            { text: rec.error, cls: 'steward-bad' },
            '',
            '',
            actionsCell(ctx, rec, name, false)
        ];
    }

    function renderList($c, ctx) {
        var h = H();
        var folder = Q().dirPath();
        if (listError) $c.append(ctx.textEl('div', 'steward-bad', listError));

        var run = running();
        var recs = Q().list();
        var rows = [];
        var good = 0;
        for (var i = 0; i < recs.length; i++) {
            if (recs[i].error !== undefined) {
                rows.push(brokenRow(ctx, recs[i]));
            } else {
                good++;
                rows.push(recordRow(ctx, recs[i], run));
            }
        }

        var $card = h.card({
            icon:   '⚔',
            title:  'Run queues',
            meta:   plural(good, 'queue', 'queues') + ' · start one from ~Steward~ › Adventures › Queues',
            $tools: folder ? ctx.btn('New queue', ctx.act(function () { newQueue(ctx); })) : null
        });
        $card.append(h.table({
            cols: [
                { label: 'Queue',   width: '27%' },
                { label: 'Entries', width: '25%' },
                { label: 'Loop',    width: '13%' },
                { label: 'Options', width: '12%' },
                { label: '',        width: '23%', cls: 'steward-num' }
            ],
            rows:      rows,
            emptyText: 'No queues yet. Make one with New queue.'
        }));
        $c.append($card);
        $c.append(folder
            ? ctx.textEl('div', 'steward-muted', 'Each queue is a file in ' + folder)
            : ctx.textEl('div', 'steward-bad', 'No writable steward folder'));
    }

    // ---- Edit view ------------------------------------------------------------

    function beginEdit(draft) {
        view = {
            draft:    draft,
            orig:     snapshot(draft),
            title:    draft.id ? (draft.label || draft.id) : null,
            // Read once per edit: the footer checks the label on every key.
            recs:     Q().list(),
            problems: null,
            moved:    -1,
            pick:     ''
        };
        confirmDelete = null;
        listError = null;
    }

    // What the footer still needs, from the store's own validation.
    function needs(draft, recs) {
        var problems = Q().validate(draft, recs);
        var out = [];
        var bad = [];
        for (var i = 0; i < problems.length; i++) {
            var p = problems[i];
            if (p.index !== undefined) bad.push(p.index + 1);
            else if (p.field === 'label') out.push(draft.label ? 'a free label' : 'a label');
            else if (p.field === 'entries') out.push('an entry');
        }
        if (bad.length) {
            var many = bad.length > 1;
            var last = bad.pop();
            out.push('readable ' + (many ? 'entries ' : 'entry ') +
                (many ? bad.join(', ') + ' and ' + last : last));
        }
        return out;
    }

    function updateFooter() {
        if (!view || !view.draft || !$save || !$mid) return;
        var missing = needs(view.draft, view.recs);
        var dirty = isDirty();
        var ok = dirty && missing.length === 0;
        $save.prop('disabled', !ok);
        $save.toggleClass('steward-primary', ok);
        $mid.removeClass('steward-foot-need steward-foot-dirty steward-foot-note');
        if (missing.length) {
            $mid.addClass('steward-foot-need').text('Still needs ' + missing.join(', '));
        } else if (dirty) {
            $mid.addClass('steward-foot-dirty').text('Unsaved queue changes');
        } else {
            $mid.addClass('steward-foot-note').text('No changes');
        }
    }

    function saveDraft(ctx) {
        if (!view || !isDirty() || needs(view.draft, view.recs).length) return;
        var run = running();
        var label = view.draft.label;
        var wasRunning = !!(run && view.draft.id && run.id === view.draft.id);
        var where = wasRunning ? runningWhere(run) : '';
        var r = Q().save(view.draft, new Date().getTime());
        if (!r.ok) {
            view.problems = r.problems;
            ctx.render();
            return;
        }
        reset();
        ctx.notify('Queue ' + label + ' saved.' + (wasRunning
            ? ' The running queue is not changed: your edits apply at its next start (it is on ' + where + ' now).'
            : ''));
        ctx.syncMenu();
        ctx.backToList();
    }

    // Moves entry idx by `by` through the template editor's reorder.
    function moveEntry(ctx, idx, by) {
        var list = view.draft.entries;
        var to = idx + by;
        if (!(idx >= 0 && idx < list.length) || to < 0 || to >= list.length) return;
        var order = [];
        for (var i = 0; i < list.length; i++) order.push(i);
        order[idx] = to;
        order[to] = idx;
        var next = T().reorderWaves(list, order);
        if (!next) return;
        view.draft.entries = next;
        view.moved = to;
        ctx.render();
    }

    function removeEntry(ctx, idx) {
        var list = view.draft.entries;
        if (!(idx >= 0 && idx < list.length)) return;
        list.splice(idx, 1);
        view.moved = -1;
        ctx.render();
    }

    // Name cell of an entry: kind badge, then the record's label (or what is
    // wrong with the entry) and its adventure.
    function nameCell(ctx, entry) {
        var k = Q().KIND;
        var $n = $('<span>');
        var rec = Q().entryRecord(entry);
        if (!Q().isKnownKind(entry.kind)) {
            $n.append(H().badge('paused', 'Unknown kind: ' + (entry.kind || '(none)')));
            $n.append(' ').append(ctx.textEl('b', null, entry.id));
            return { $: $n, adventure: 'unreadable', bad: true };
        }
        $n.append(H().badge('tag', entry.kind === k.Scenario ? 'Scenario' : 'Adventure'));
        $n.append(' ');
        if (!rec) {
            $n.append(ctx.textEl('b', null, entry.id));
            $n.append(' ').append(ctx.textEl('small', 'steward-bad',
                '(' + (entry.kind === k.Scenario ? 'scenario' : 'template') + ' missing)'));
            return { $: $n, adventure: 'unreadable', bad: true };
        }
        $n.append(ctx.textEl('b', null, rec.label));
        var adventure = S.core.adventures.label(rec.adventure) || rec.adventure;
        return { $: $n, adventure: adventure, bad: false };
    }

    function entryRows(ctx, draft) {
        var rows = [];
        var last = draft.entries.length - 1;
        for (var i = 0; i < draft.entries.length; i++) {
            (function (idx) {
                var entry = draft.entries[idx];
                var nc = nameCell(ctx, entry);
                var $runs = H().input({ value: entry.count, width: '56px', title: 'Runs' });
                $runs.on('input', function () {
                    var n = wholeOf($runs.val(), 1);
                    if (n === null) return;
                    entry.count = n;
                    updateFooter();
                });
                var $ctl = $('<span>');
                $ctl.append(ctx.iconBtn('↑', 'Move up', idx === 0, function () { moveEntry(ctx, idx, -1); }));
                $ctl.append(ctx.iconBtn('↓', 'Move down', idx === last, function () { moveEntry(ctx, idx, 1); }));
                $ctl.append(ctx.iconBtn('×', 'Remove', false, function () { removeEntry(ctx, idx); }));
                rows.push([String(idx + 1), { $: nc.$ }, { text: nc.adventure, cls: nc.bad ? 'steward-bad' : '' },
                    { $: $runs }, { $: $ctl, cls: 'steward-num' }]);
            }(i));
        }
        return rows;
    }

    // Adventures then Scenarios, readable records only, from the stores.
    function pickOptions() {
        var groups = [];
        var k = Q().KIND;
        var sources = [
            { kind: k.Template, label: 'Adventures', recs: T().list() },
            { kind: k.Scenario, label: 'Scenarios',  recs: Sc().list() }
        ];
        for (var g = 0; g < sources.length; g++) {
            var items = [];
            for (var i = 0; i < sources[g].recs.length; i++) {
                var r = sources[g].recs[i];
                if (r.error === undefined) items.push({ kind: sources[g].kind, id: r.id, label: r.label });
            }
            groups.push({ label: sources[g].label, items: items });
        }
        return groups;
    }

    function addEntry(ctx) {
        var at = view.pick.indexOf(PICK_SEP);
        if (at < 1) return;
        var kind = view.pick.substring(0, at);
        var id = view.pick.substring(at + 1);
        if (!Q().isKnownKind(kind) || !T().validId(id)) return;
        view.draft.entries.push({ kind: kind, id: id, count: 1 });
        view.pick = '';
        view.moved = view.draft.entries.length - 1;
        ctx.render();
    }

    function addSelect() {
        var $sel = $('<select>', { 'class': 'steward-dropdown', title: 'Add entry' });
        $sel.append($('<option>', { value: '' }).text('choose…'));
        var groups = pickOptions();
        for (var g = 0; g < groups.length; g++) {
            if (!groups[g].items.length) continue;
            var $grp = $('<optgroup>', { label: groups[g].label });
            for (var i = 0; i < groups[g].items.length; i++) {
                var it = groups[g].items[i];
                var value = it.kind + PICK_SEP + it.id;
                var $o = $('<option>', { value: value }).text(it.label);
                if (value === view.pick) $o.attr('selected', 'selected');
                $grp.append($o);
            }
            $sel.append($grp);
        }
        $sel.on('change', function () { view.pick = String($sel.val() || ''); });
        return $sel;
    }

    function entriesCard(ctx, draft, problems) {
        var h = H();
        var $card = h.card({
            icon:  '⚔',
            title: 'Entries',
            meta:  draft.entries.length ? kindCounts(draft) : 'no entries'
        });
        $card.append(h.table({
            cols: [
                { label: '#',         width: '6%' },
                { label: 'Entry',     width: '40%' },
                { label: 'Adventure', width: '24%' },
                { label: 'Runs',      width: '12%' },
                { label: '',          width: '18%', cls: 'steward-num' }
            ],
            rows:      entryRows(ctx, draft),
            emptyText: 'This queue has no entries',
            rowCls:    function (row, i) { return view.moved === i ? 'steward-moved' : ''; }
        }));
        var $add = $('<div>', { 'class': 'steward-card-foot' });
        $add.append(ctx.textEl('span', 'steward-muted', 'Add entry: ')).append(addSelect()).append(' ')
            .append(ctx.btn('Add entry', ctx.act(function () { addEntry(ctx); })));
        $card.append($add);
        for (var i = 0; i < problems.length; i++) {
            if (problems[i].index !== undefined) {
                $card.append(ctx.textEl('div', 'steward-bad', problems[i].message));
            }
        }
        return $card;
    }

    function enumOptions(en, labels) {
        var out = [];
        for (var key in en) {
            if (Object.prototype.hasOwnProperty.call(en, key)) {
                out.push({ label: labels[en[key]] || en[key], value: en[key] });
            }
        }
        return out;
    }

    function optionsCard(draft) {
        var h = H();
        var q = Q();
        var $card = h.card({ title: 'Queue options' });
        $card.append(h.field('Loop the whole queue', 'Start again at entry 1 after the last entry',
            h.toggle({ label: 'Loop', checked: draft.loop, onChange: function (on) {
                draft.loop = on;
                updateFooter();
            } })));
        var $passes = h.input({ value: draft.passes, width: '64px', title: 'Passes' });
        $passes.on('input', function () {
            var n = wholeOf($passes.val(), 0);
            if (n === null) return;
            draft.passes = n;
            updateFooter();
        });
        $card.append(h.field('Passes', '0 means until End repetition or Stop', $passes));
        $card.append(h.field('Retrain',
            'For every entry of this queue. A scenario entry retrains nothing either way.',
            h.dropdown(enumOptions(q.RETRAIN, { settings: 'Follow Settings › Adventures', on: 'On', off: 'Off' }), {
                selected: draft.retrain,
                onChange: function (v) { draft.retrain = v; updateFooter(); }
            }), { wide: true }));
        $card.append(h.field('No map left',
            'What happens when an entry has no map left in the star menu: Pause stops at StartMap as today; ' +
            'Skip entry steps over it with a log line and a notice.',
            h.dropdown(enumOptions(q.NO_MAP, { pause: 'Pause', skip: 'Skip entry' }), {
                selected: draft.noMap,
                onChange: function (v) { draft.noMap = v; updateFooter(); }
            }), { wide: true }));
        $card.append(h.field('Start the next entry while generals travel home',
            'Skips the finished entry\'s retrain, so the next map begins at once. Off: generals gather, ' +
            'troops are accounted and retrained first, as today.',
            h.toggle({ label: 'Early', checked: draft.early, onChange: function (on) {
                draft.early = on;
                updateFooter();
            } })));
        return $card;
    }

    function labelCard(draft) {
        var h = H();
        var $card = h.card({ title: 'Queue' });
        var $label = h.input({ value: draft.label, placeholder: 'Queue name', title: 'Label' });
        $label.on('input', function () {
            draft.label = $label.val();
            updateFooter();
        });
        $card.append(h.field('Label', 'Shown in the menu and the status line', $label, { wide: true }));
        return $card;
    }

    function footer(ctx) {
        var $f = $('<div>', { 'class': 'steward-card-foot' });
        $save = ctx.btn('Save queue', ctx.act(function () { saveDraft(ctx); }));
        $mid = $('<span>');
        $f.append($save).append(' ').append($mid).append(' ')
            .append(H().link('Back to list', ctx.act(function () {
                if (isDirty()) ctx.notify('Queue changes discarded');
                reset();
                ctx.backToList();
            })));
        return $f;
    }

    function renderEdit($c, ctx, id) {
        var h = H();
        // A draft of another queue is stale: the window resets it on leaving.
        if (view && id && view.draft.id !== id) view = null;
        if (!view) {
            var rec = id ? Q().get(id) : Q().normalize({});
            if (!rec) {
                $c.append(ctx.textEl('div', 'steward-bad', 'Could not open ' + id));
                $c.append(h.link('Back to list', ctx.act(ctx.backToList)));
                return;
            }
            beginEdit(rec);
        }
        var draft = view.draft;
        var $crumb = $('<div>', { 'class': 'steward-crumb' });
        $crumb.append(h.link('Run queues', ctx.act(function () {
            if (isDirty()) ctx.notify('Queue changes discarded');
            reset();
            ctx.backToList();
        })));
        $crumb.append(ctx.textEl('span', null, '›'));
        $crumb.append(ctx.textEl('b', null, draft.id ? (view.title || draft.id) : 'New queue'));
        $c.append($crumb);

        var run = running();
        if (run && draft.id && run.id === draft.id) {
            $c.append(h.banner(run.label + ' is running now (' + runningWhere(run) + '). Saved changes ' +
                'apply at the next start of this queue, not to the run in progress.', { icon: '⚠' }));
        }
        if (view.problems) {
            for (var p = 0; p < view.problems.length; p++) {
                $c.append(ctx.textEl('div', 'steward-bad', view.problems[p].message));
            }
        }

        var problems = Q().validate(draft, view.recs);
        $c.append(labelCard(draft));
        $c.append(entriesCard(ctx, draft, problems));
        $c.append(optionsCard(draft));
        $c.append(footer(ctx));
        updateFooter();
    }

    S.modules.adventures.queueview = {
        renderList: renderList,
        renderEdit: renderEdit,
        isDirty:    isDirty,
        editing:    editing,
        reset:      reset
    };

}(Steward));
