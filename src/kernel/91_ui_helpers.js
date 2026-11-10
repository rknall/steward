/*
 * Dashboard helpers — the building blocks every view and module renders with.
 *
 * Modules' section render/side/tiles callbacks receive this object as `h` and
 * build cards, fields, controls and tables from it, so the markup and class
 * names stay in one place and match the stylesheet in 89_ui_style.js. Nothing
 * here picks colours, widths or font sizes; the classes do.
 *
 * Settings buffer:
 *   var s = h.settings('collect');                  // proxy via shell buffer
 *   h.update('collect', { enabled: true });          // patch + mark dirty
 *   h.set('mining', 'deposits.BronzeOre.max', 4);    // nested write
 *   h.get('mining', 'deposits.BronzeOre.max');       // nested read
 *
 * The buffer is committed when the user presses Save; Close discards.
 *
 * Bound controls (toggle, number, dropdown) take `ns` and `path`. A change
 * writes through `opts.write(value)` when given, else `h.set(ns, path, value)`,
 * then marks the control itself with `steward-dirty` while the buffered value
 * differs from the saved one, then calls `opts.onChange(value)`. The mark is
 * toggled on the existing element instead of re-rendering, because a redraw
 * at blur time swallows the click that caused the blur (the Save button).
 * The initial mark comes from the same check, so a kept buffer edit still
 * shows after the tab is drawn again. The screen object is read at call time:
 * it only exists while a screen is open.
 *
 * Escaping: every helper puts text in with .text(). The one exception is a
 * table cell given as `{ html: ... }`, which the caller has already escaped
 * (it may carry host image markup); escape() is there for that.
 */

(function (S) {
    'use strict';

    var swSeq = 0;

    // ---------------------------------------------------------------
    // Small internals.
    // ---------------------------------------------------------------

    function isEl(x) { return !!(x && x.jquery); }

    function screen() {
        return (S.kernel.ui && S.kernel.ui.screen) ? S.kernel.ui.screen : null;
    }

    function splitPath(path) { return String(path).split('.'); }

    function isBound(opts) {
        return !!(opts && opts.ns && opts.path !== undefined && opts.path !== null && opts.path !== '');
    }

    // Append a string/number as text, or an element as is.
    function put($parent, content) {
        if (isEl(content)) $parent.append(content);
        else if (content !== null && typeof content !== 'undefined') {
            $parent.append($('<span>').text(String(content)));
        }
        return $parent;
    }

    function guarded(what, fn) {
        return function () {
            try { return fn.apply(this, arguments); }
            catch (err) { S.kernel.error('ui', what + ' threw:', err); }
        };
    }

    // ---------------------------------------------------------------
    // Settings buffer proxy.
    // ---------------------------------------------------------------
    function settings(moduleId) {
        return S.kernel.ui.bufferedSettings(moduleId);
    }

    function update(moduleId, mutatorOrPatch) {
        var s = S.kernel.ui.bufferedSettings(moduleId);
        if (typeof mutatorOrPatch === 'function') {
            try { mutatorOrPatch(s); }
            catch (e) { S.kernel.error('ui', 'update mutator for', moduleId, 'threw:', e); }
        } else if (mutatorOrPatch && typeof mutatorOrPatch === 'object') {
            for (var k in mutatorOrPatch) s[k] = mutatorOrPatch[k];
        }
        S.kernel.ui.markDirty(moduleId);
    }

    // Nested write through update(), creating missing objects on the way.
    function set(ns, path, value) {
        var keys = splitPath(path);
        update(ns, function (s) {
            var o = s;
            for (var i = 0; i < keys.length - 1; i++) {
                if (!o[keys[i]] || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
                o = o[keys[i]];
            }
            o[keys[keys.length - 1]] = value;
        });
    }

    // Nested buffer read; undefined when any step is missing.
    function get(ns, path) {
        var o = S.kernel.ui.bufferedSettings(ns);
        var keys = splitPath(path);
        for (var i = 0; i < keys.length; i++) {
            if (o === null || typeof o !== 'object') return undefined;
            o = o[keys[i]];
        }
        return o;
    }

    function isChanged(ns, path) {
        var sc = screen();
        if (!sc || typeof sc.isChanged !== 'function') return false;
        try { return !!sc.isChanged(ns, path); }
        catch (e) { return false; }
    }

    function baseline(ns, shown) {
        var sc = screen();
        if (sc && typeof sc.baseline === 'function') sc.baseline(ns, shown);
    }

    // HTML-escape a user string for {html} table cells. null/undefined
    // become an empty string.
    function escape(s) {
        if (s === null || typeof s === 'undefined') return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Shared commit of a bound control: write, mark in place, notify.
    function commit(opts, $mark, value) {
        if (typeof opts.write === 'function') opts.write(value);
        else if (isBound(opts)) set(opts.ns, opts.path, value);
        if (isBound(opts)) $mark.toggleClass('steward-dirty', isChanged(opts.ns, opts.path));
        if (typeof opts.onChange === 'function') opts.onChange(value);
    }

    function markInitial(opts, $mark) {
        if (isBound(opts) && isChanged(opts.ns, opts.path)) $mark.addClass('steward-dirty');
    }

    // ---------------------------------------------------------------
    // Settings parsers and display converters, shared by the settings
    // screen and any module showing a stored unit in another one.
    // ---------------------------------------------------------------

    // The number typed, or null for blank, non-numeric or negative input.
    function parseNumber(text) {
        var t = String(text).replace(/^\s+|\s+$/g, '');
        if (t === '') return null;
        var n = Number(t);
        return (isFinite(n) && n >= 0) ? n : null;
    }

    // Each returns the stored unit, or null when the input is rejected.
    var settingsParse = {
        sizeKB: function (text) {
            var n = parseNumber(text);
            return n === null ? null : Math.round(n * 1024);
        },
        whole: function (text) {
            var n = parseNumber(text);
            return n === null ? null : Math.floor(n);
        },
        tickMs: function (text) {
            var n = parseNumber(text);
            if (n === null) return null;
            return Math.max(S.kernel.TIMEOUTS.TICK_INTERVAL_MIN_MS, Math.round(n * 1000));
        }
    };

    var settingsShow = {
        mb:      function (kb) { return Math.round(kb / 1024 * 100) / 100; },
        seconds: function (ms) { return ms / 1000; }
    };

    // ---------------------------------------------------------------
    // Structure: card, sub head, field.
    // ---------------------------------------------------------------
    function card(opts) {
        opts = opts || {};
        var $card = $('<div>', { 'class': 'steward-card' });
        if (opts.cls) $card.addClass(opts.cls);
        var $h = $('<div>', { 'class': 'steward-card-h' });
        if (opts.icon) $h.append($('<span>', { 'class': 'steward-icon' }).text(opts.icon));
        $h.append($('<span>').text(opts.title || ''));
        if (opts.meta !== undefined && opts.meta !== null && opts.meta !== '') {
            $h.append(put($('<span>', { 'class': 'steward-card-meta' }), opts.meta));
        }
        if (opts.$tools) $h.append(opts.$tools);
        $card.append($h);
        return $card;
    }

    function subHead(text, meta) {
        var $s = $('<div>', { 'class': 'steward-subhead' }).append($('<span>').text(text || ''));
        if (meta !== undefined && meta !== null && meta !== '') {
            $s.append(put($('<span>', { 'class': 'steward-subhead-meta' }), meta));
        }
        return $s;
    }

    // The control column floats right, so it goes first unless `wrap` puts
    // it under the label.
    function field(label, help, $ctl, opts) {
        opts = opts || {};
        var $f = $('<div>', { 'class': 'steward-field' });
        if (opts.sub)      $f.addClass('steward-sub');
        if (opts.disabled) $f.addClass('steward-dis');
        if (opts.wrap)     $f.addClass('steward-wrap');

        var $lbl = $('<span>', { 'class': 'steward-field-lbl' });
        $lbl.append($('<b>', { 'class': 'steward-field-name' }).text(label || ''));
        if (help) $lbl.append($('<span>', { 'class': 'steward-field-help' }).text(help));

        var $c = null;
        if ($ctl !== null && typeof $ctl !== 'undefined') {
            $c = put($('<span>', { 'class': 'steward-field-ctl' }), $ctl);
            if (opts.wide) $c.addClass('steward-wide');
        }
        if ($c && !opts.wrap) $f.append($c);
        $f.append($lbl);
        if ($c && opts.wrap) $f.append($c);
        return $f;
    }

    // ---------------------------------------------------------------
    // Toggle — host's native switch markup, restyled by our sheet.
    //   <label class="switch"><input type="checkbox"><span class="slider round"></span></label>
    // ---------------------------------------------------------------
    function toggle(opts) {
        opts = opts || {};
        var name = opts.id || ('steward-sw-' + (++swSeq));
        var isChecked = (opts.checked === undefined && isBound(opts))
            ? !!get(opts.ns, opts.path) : !!opts.checked;

        var $wrap = $('<label>', { 'class': 'switch' });
        if (opts.label) $wrap.attr('title', opts.label);
        var $input = $('<input>', { type: 'checkbox', id: name });
        if (isChecked) $input.attr('checked', 'checked');
        if (opts.disabled) {
            $input.attr('disabled', 'disabled');
            $wrap.addClass('steward-disabled');
        }
        $wrap.append($input).append($('<span>', { 'class': 'slider round' }));
        markInitial(opts, $wrap);

        if (isBound(opts) || typeof opts.write === 'function' || typeof opts.onChange === 'function') {
            $input.on('change', guarded('toggle handler', function () {
                commit(opts, $wrap, !!$input.prop('checked'));
            }));
        }
        return $wrap;
    }

    // ---------------------------------------------------------------
    // Parchment input (text / number).
    // ---------------------------------------------------------------
    function input(opts) {
        opts = opts || {};
        var $i = $('<input>', {
            type:    opts.type || 'text',
            value:   opts.value !== undefined ? String(opts.value) : '',
            'class': 'steward-input'
        });
        if (opts.cls) $i.addClass(opts.cls);
        if (opts.title) $i.attr('title', opts.title);
        if (opts.placeholder) $i.attr('placeholder', opts.placeholder);
        if (opts.width) $i.css({ width: opts.width });
        if (typeof opts.onChange === 'function') {
            $i.on('change', function () {
                try { opts.onChange($i.val()); }
                catch (err) { S.kernel.error('ui', 'input change threw:', err); }
            });
            // change fires only on blur; enable Save while typing so the
            // click that causes the blur is not swallowed by a disabled button.
            $i.on('input', function () {
                try {
                    if (S.kernel.ui && typeof S.kernel.ui.markEditing === 'function') {
                        S.kernel.ui.markEditing();
                    }
                } catch (err) { S.kernel.error('ui', 'input edit hook threw:', err); }
            });
        }
        return $i;
    }

    // Text input bound to a number. A rejected entry reverts to the last good
    // value; an accepted one shows show(value), so a clamped value is visible.
    // Without ns/path it only reports the value (session state, not settings).
    function number(opts) {
        opts = opts || {};
        var parse = typeof opts.parse === 'function' ? opts.parse : settingsParse.whole;
        var show = typeof opts.show === 'function' ? opts.show : function (v) { return v; };
        var current = (opts.value === undefined && isBound(opts)) ? get(opts.ns, opts.path) : opts.value;
        var shown = function (v) { return (v === undefined || v === null) ? '' : show(v); };

        var $i = input({
            value: shown(current),
            width: opts.width,
            title: opts.label,
            onChange: guarded('number change', function (text) {
                var next = parse(text);
                $i.removeClass('steward-invalid');
                if (next === null) {
                    $i.val(shown(current));
                    return;
                }
                current = next;
                $i.val(shown(current));
                commit(opts, $i, next);
            })
        });
        $i.on('input', function () {
            $i.toggleClass('steward-invalid', parse($i.val()) === null);
        });
        markInitial(opts, $i);

        var $wrap = $('<span>').append($i);
        if (opts.unit !== undefined && opts.unit !== null) {
            $wrap.append($('<span>', { 'class': 'steward-unit' }).text(opts.unit));
        }
        return $wrap;
    }

    // ---------------------------------------------------------------
    // Parchment dropdown. Options are strings or { label, value }; a bound
    // dropdown commits the option's own value, not the string the select
    // reports, so numeric values stay numbers in the buffer.
    // ---------------------------------------------------------------
    function dropdown(options, opts) {
        opts = opts || {};
        var $sel = $('<select>', { 'class': 'steward-dropdown' });
        if (opts.cls) $sel.addClass(opts.cls);
        if (opts.width) $sel.css({ width: opts.width });
        if (opts.disabled) $sel.attr('disabled', 'disabled');
        var selected = (opts.selected === undefined && isBound(opts)) ? get(opts.ns, opts.path) : opts.selected;
        var values = [];
        for (var i = 0; i < options.length; i++) {
            var o = options[i];
            var label, value;
            if (typeof o === 'string') { label = o; value = o; }
            else { label = o.label || o.value; value = (typeof o.value === 'undefined' ? label : o.value); }
            values.push(value);
            var $opt = $('<option>', { value: String(value) }).text(label);
            if (selected !== undefined && String(selected) === String(value)) {
                $opt.attr('selected', 'selected');
            }
            $sel.append($opt);
        }
        markInitial(opts, $sel);

        function valueOf(text) {
            for (var j = 0; j < values.length; j++) {
                if (String(values[j]) === String(text)) return values[j];
            }
            return text;
        }

        if (isBound(opts) || typeof opts.write === 'function') {
            $sel.on('change', guarded('dropdown change', function () {
                commit(opts, $sel, valueOf($sel.val()));
            }));
        } else if (typeof opts.onChange === 'function') {
            $sel.on('change', function () {
                try { opts.onChange($sel.val()); }
                catch (err) { S.kernel.error('ui', 'dropdown change threw:', err); }
            });
        }
        return $sel;
    }

    // ---------------------------------------------------------------
    // Buttons and links. The button keeps the host's image `.btn` so it
    // looks like the client's own; our classes only adjust size and accent.
    // ---------------------------------------------------------------
    function button(label, opts) {
        opts = opts || {};
        var $b = $('<button>', { type: 'button', 'class': 'btn steward-btn' }).text(label || '');
        if (opts.size === 'sm') $b.addClass('steward-btn-sm');
        if (opts.primary) $b.addClass('steward-primary');
        if (opts.disabled) $b.attr('disabled', 'disabled');
        if (opts.title) $b.attr('title', opts.title);
        if (typeof opts.onClick === 'function') {
            $b.on('click', function (e) {
                e.preventDefault();
                try { opts.onClick(); }
                catch (err) { S.kernel.error('ui', 'button onClick threw:', err); }
            });
        }
        return $b;
    }

    function link(label, onClick, opts) {
        opts = opts || {};
        var $a = $('<a>', { href: '#', 'class': 'steward-link' }).text(label || '');
        if (opts.danger) $a.addClass('steward-danger');
        if (opts.confirm) $a.addClass('steward-confirm');
        if (opts.title) $a.attr('title', opts.title);
        $a.on('click', function (e) {
            e.preventDefault();
            if (typeof onClick !== 'function') return;
            try { onClick(); }
            catch (err) { S.kernel.error('ui', 'link onClick threw:', err); }
        });
        return $a;
    }

    // Marks a control that acts at once instead of waiting for Save.
    function now() {
        return $('<span>', { 'class': 'steward-now' }).text('⚡ runs now');
    }

    // ---------------------------------------------------------------
    // Data display.
    // ---------------------------------------------------------------
    function badge(kind, text) {
        return $('<span>', { 'class': 'steward-badge steward-b-' + (kind || 'tag') }).text(text || '');
    }

    function chips(items, active, onPick) {
        var $c = $('<div>', { 'class': 'steward-chips' });
        for (var i = 0; i < (items || []).length; i++) {
            (function (item) {
                var $b = $('<button>', { type: 'button', 'class': 'steward-chip' }).text(item.label || '');
                if (item.id === active) $b.addClass('active');
                $b.on('click', function (e) {
                    e.preventDefault();
                    if (typeof onPick !== 'function') return;
                    try { onPick(item.id); }
                    catch (err) { S.kernel.error('ui', 'chip pick threw:', err); }
                });
                $c.append($b);
            }(items[i]));
        }
        return $c;
    }

    // Widths come from the item count, so the row needs no computed sizes.
    function stats(items) {
        items = items || [];
        var n = Math.max(1, Math.min(4, items.length));
        var $s = $('<div>', { 'class': 'steward-stats' });
        for (var i = 0; i < items.length; i++) {
            var it = items[i] || {};
            var $st = $('<div>', { 'class': 'steward-stat steward-stat-w' + n });
            $st.append($('<span>', { 'class': 'steward-stat-k' }).text(it.k || ''));
            var $v = $('<span>', { 'class': 'steward-stat-v' });
            if (isEl(it.$v)) $v.append(it.$v);
            else {
                $v.text(it.v === undefined || it.v === null ? '' : String(it.v));
                if (it.small) $v.append($('<small>').text(' ' + it.small));
            }
            $st.append($v);
            $s.append($st);
        }
        return $s;
    }

    function banner(content, opts) {
        opts = opts || {};
        var $b = $('<div>', { 'class': 'steward-banner' });
        if (opts.icon) $b.append($('<span>', { 'class': 'steward-icon' }).text(opts.icon));
        put($b, content);
        if (opts.$action) $b.append(opts.$action);
        return $b;
    }

    function empty(title, text) {
        var $e = $('<div>', { 'class': 'steward-empty' });
        $e.append($('<div>', { 'class': 'steward-empty-title' }).text(title || ''));
        if (text) $e.append($('<span>').text(text));
        return $e;
    }

    function grid(cols, $items) {
        var c = cols === 3 ? 3 : 2;
        var $g = $('<div>', { 'class': 'steward-grid' });
        for (var i = 0; i < ($items || []).length; i++) {
            $g.append(put($('<div>', { 'class': 'steward-cell steward-cell-' + c }), $items[i]));
        }
        return $g;
    }

    function toolRow(label, small, $btn) {
        var $t = $('<div>', { 'class': 'steward-tool' });
        if ($btn) $t.append($btn);
        var $l = $('<span>').text(label || '');
        if (small) $l.append($('<small>').text(small));
        $t.append($l);
        return $t;
    }

    // ---------------------------------------------------------------
    // Table. Fixed layout with a colgroup, so ellipsis works and the head of
    // a `fill` table lines up with the scrolling body table below it.
    // ---------------------------------------------------------------
    function colgroup(cols) {
        var $g = $('<colgroup>');
        for (var i = 0; i < cols.length; i++) {
            var $col = $('<col>');
            if (cols[i].width !== undefined && cols[i].width !== null) $col.css({ width: cols[i].width });
            $g.append($col);
        }
        return $g;
    }

    function cell(tag, c, colCls) {
        var $c = $('<' + tag + '>');
        if (colCls) $c.addClass(colCls);
        if (isEl(c)) return $c.append(c);
        if (c === null || typeof c === 'undefined') return $c;
        if (typeof c !== 'object') {
            return $c.text(String(c)).attr('title', String(c));
        }
        if (c.cls) $c.addClass(c.cls);
        if (c.html !== undefined && c.html !== null) {
            $c.html(String(c.html));
            if (c.title) $c.attr('title', c.title);
        } else if (isEl(c.$)) {
            $c.append(c.$);
            if (c.title) $c.attr('title', c.title);
        } else if (c.text !== undefined && c.text !== null) {
            $c.text(String(c.text)).attr('title', c.title ? c.title : String(c.text));
        } else if (c.title) {
            $c.attr('title', c.title);
        }
        return $c;
    }

    function table(opts) {
        opts = opts || {};
        var cols = opts.cols || [];
        var rows = opts.rows || [];

        var $head = $('<thead>');
        var $hr = $('<tr>');
        for (var i = 0; i < cols.length; i++) {
            $hr.append(cell('th', cols[i].label === undefined ? '' : cols[i].label, cols[i].cls));
        }
        $head.append($hr);

        var $body = $('<tbody>');
        if (!rows.length) {
            $body.append($('<tr>').append(
                $('<td>', { 'class': 'steward-muted', colspan: String(Math.max(1, cols.length)) })
                    .text(opts.emptyText || '')));
        }
        for (var r = 0; r < rows.length; r++) {
            var $tr = $('<tr>');
            var rc = typeof opts.rowCls === 'function' ? opts.rowCls(rows[r], r) : opts.rowCls;
            if (rc) $tr.addClass(rc);
            for (var k = 0; k < rows[r].length; k++) {
                $tr.append(cell('td', rows[r][k], cols[k] ? cols[k].cls : null));
            }
            $body.append($tr);
        }

        var $foot = null;
        if (opts.foot && opts.foot.length) {
            var $fr = $('<tr>');
            for (var f = 0; f < opts.foot.length; f++) {
                $fr.append(cell('td', opts.foot[f], cols[f] ? cols[f].cls : null));
            }
            $foot = $('<tfoot>').append($fr);
        }

        if (!opts.fill) {
            var $t = $('<table>', { 'class': 'steward-tbl' })
                .append(colgroup(cols)).append($head).append($body);
            if ($foot) $t.append($foot);
            return $t;
        }

        var $top = $('<table>', { 'class': 'steward-tbl' }).append(colgroup(cols)).append($head);
        var $bottom = $('<table>', { 'class': 'steward-tbl' }).append(colgroup(cols)).append($body);
        if ($foot) $bottom.append($foot);
        return $('<div>')
            .append($top)
            .append($('<div>', { 'class': 'steward-fill' }).append($bottom));
    }

    // ---------------------------------------------------------------
    // Busy time as text; null when there is none to show, so callers can
    // print a plain "Busy". The host's formatter is preferred.
    // ---------------------------------------------------------------
    function duration(ms) {
        if (typeof ms !== 'number' || !(ms > 0)) return null;
        try {
            if (typeof loca !== 'undefined' && loca && typeof loca.FormatDuration === 'function') {
                return loca.FormatDuration(ms, 1);
            }
        } catch (e) { /* fall through to the plain format */ }
        var totalMinutes = Math.round(ms / 60000);
        var hours = Math.floor(totalMinutes / 60);
        var minutes = totalMinutes % 60;
        return hours + 'h ' + (minutes < 10 ? '0' + minutes : minutes) + 'm';
    }

    // Busy/idle status as a badge. The busy label carries the remaining time
    // when there is one, so every table shows the same wording.
    function statusBadge(idle, ms) {
        if (idle) return badge('ok', 'Idle');
        var d = duration(ms);
        return badge('busy', d ? 'Busy ' + d : 'Busy');
    }

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    // Local time of day as HH:MM, of now when no date is given; '' for an
    // invalid date so a caller never prints "NaN:NaN".
    function clock(date) {
        var d = date || new Date();
        if (isNaN(d.getTime())) return '';
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    // Re-size the fill areas after a module redrew part of its tab.
    function fit() {
        var views = S.kernel.ui && S.kernel.ui.views;
        if (views && views.dashboard && typeof views.dashboard.fit === 'function') {
            try { views.dashboard.fit(); }
            catch (err) { S.kernel.error('ui', 'fit threw:', err); }
        }
    }

    // Run fn once, ms from now, to redraw a holder whose content was not ready
    // (a portrait the host had not decoded yet). The data flag makes it one
    // redraw per holder, and a detached holder (the tab was switched, which
    // empties the panel) is not redrawn. True when a redraw was scheduled.
    function redrawOnce($holder, fn, ms) {
        if (!$holder || !$holder.length) return false;
        if ($holder.data('stewardRedrawOnce')) return false;
        $holder.data('stewardRedrawOnce', true);
        setTimeout(guarded('redrawOnce', function () {
            if ($holder.parent().length === 0) return;
            fn();
        }), ms);
        return true;
    }

    // ---------------------------------------------------------------

    if (!S.kernel.ui) S.kernel.ui = {};
    S.kernel.ui.settingsParse = settingsParse;
    S.kernel.ui.settingsShow  = settingsShow;
    S.kernel.ui.helpers = {
        card:      card,
        subHead:   subHead,
        field:     field,
        toggle:    toggle,
        input:     input,
        number:    number,
        dropdown:  dropdown,
        button:    button,
        link:      link,
        now:       now,
        badge:     badge,
        chips:     chips,
        stats:     stats,
        banner:    banner,
        empty:     empty,
        grid:      grid,
        toolRow:   toolRow,
        table:     table,
        duration:  duration,
        clock:     clock,
        statusBadge: statusBadge,
        fit:       fit,
        redrawOnce: redrawOnce,
        set:       set,
        get:       get,
        settings:  settings,
        update:    update,
        escape:    escape,
        isChanged: isChanged,
        baseline:  baseline
    };

}(Steward));
