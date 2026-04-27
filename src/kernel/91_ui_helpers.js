/*
 * Dashboard helpers.
 *
 * Modules' section.render($body, h) callbacks use these to emit form rows.
 * All output is plain markup with classes scoped under #StewardDashboard
 * so the shell's stylesheet can paint everything consistently.
 *
 * Settings buffer:
 *   var s = h.settings('collect');                  // proxy via shell buffer
 *   h.update('collect', { enabled: true });          // patch + mark dirty
 *
 * The buffer is committed when the user presses Save in the footer; Close
 * discards. See Steward.kernel.ui.bufferedSettings / markDirty.
 */

(function (S) {

    // ---------------------------------------------------------------
    // Form row — light label on the left, control on the right. Lives
    // inside a section's .section-rows container.
    // ---------------------------------------------------------------

    function formRow(label, $control, helpText, opts) {
        opts = opts || {};
        var classes = 'steward-row';
        if (opts.disabled) classes += ' steward-row-disabled';
        var $row = $('<div>', { 'class': classes });

        var $label = $('<span>', { 'class': 'steward-row-label' });
        if (typeof label === 'string') $label.text(label);
        else if (label && label.jquery) $label.append(label);
        $row.append($label);

        var $ctl = $('<span>', { 'class': 'steward-row-ctl' });
        if ($control) {
            if ($control.jquery) $ctl.append($control);
            else $ctl.text(String($control));
        }
        if (helpText) {
            $ctl.append($('<span>', { 'class': 'steward-row-help' }).text(helpText));
        }
        $row.append($ctl);
        return $row;
    }

    // Sub-hint row, shown indented below another row with a ↳ glyph.
    // autoTSO uses this for "On: Use template / Off: Use defaults task".
    function indentRow(text) {
        var $row = $('<div>', { 'class': 'steward-row steward-row-indent' });
        var $lbl = $('<span>', { 'class': 'steward-row-label' });
        $lbl.append($('<span>', { 'class': 'steward-row-arrow' }).text('↳'));
        $lbl.append(document.createTextNode(' ' + (text || '')));
        $row.append($lbl);
        return $row;
    }

    // ---------------------------------------------------------------
    // Toggle (iOS-style blue, mirrors autoTSO).
    // ---------------------------------------------------------------

    function toggle(opts) {
        opts = opts || {};
        var $t = $('<span>', { 'class': 'steward-toggle' + (opts.checked ? ' on' : '') });
        var state = !!opts.checked;
        var onChange = opts.onChange;
        $t.on('click', function (e) {
            e.preventDefault();
            state = !state;
            if (state) $t.addClass('on'); else $t.removeClass('on');
            if (typeof onChange === 'function') {
                try { onChange(state); }
                catch (err) { S.kernel.error('ui', 'toggle handler threw:', err); }
            }
        });
        return $t;
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
        if (opts.placeholder) $i.attr('placeholder', opts.placeholder);
        if (opts.width) $i.css({ width: opts.width });
        if (typeof opts.onChange === 'function') {
            $i.on('change', function () {
                try { opts.onChange($i.val()); }
                catch (err) { S.kernel.error('ui', 'input change threw:', err); }
            });
        }
        return $i;
    }

    // ---------------------------------------------------------------
    // Parchment dropdown.
    // ---------------------------------------------------------------

    function dropdown(options, opts) {
        opts = opts || {};
        var $sel = $('<select>', { 'class': 'steward-dropdown' });
        if (opts.width) $sel.css({ width: opts.width });
        for (var i = 0; i < options.length; i++) {
            var o = options[i];
            var label, value;
            if (typeof o === 'string') { label = o; value = o; }
            else { label = o.label || o.value; value = (typeof o.value === 'undefined' ? label : o.value); }
            var $opt = $('<option>', { value: String(value) }).text(label);
            if (opts.selected !== undefined && String(opts.selected) === String(value)) {
                $opt.attr('selected', 'selected');
            }
            $sel.append($opt);
        }
        if (typeof opts.onChange === 'function') {
            $sel.on('change', function () {
                try { opts.onChange($sel.val()); }
                catch (err) { S.kernel.error('ui', 'dropdown change threw:', err); }
            });
        }
        return $sel;
    }

    // ---------------------------------------------------------------
    // Parchment button.
    // ---------------------------------------------------------------

    function button(label, opts) {
        opts = opts || {};
        var classes = 'steward-btn';
        if (opts.size === 'sm') classes += ' steward-btn-sm';
        var $b = $('<button>', { type: 'button', 'class': classes }).text(label || '');
        if (typeof opts.onClick === 'function') {
            $b.on('click', function (e) {
                e.preventDefault();
                try { opts.onClick(); }
                catch (err) { S.kernel.error('ui', 'button onClick threw:', err); }
            });
        }
        return $b;
    }

    // ---------------------------------------------------------------
    // Decorative bits.
    // ---------------------------------------------------------------

    // Small blue "i" — title attribute carries the tooltip text.
    function helpIcon(text) {
        return $('<span>', { 'class': 'steward-help-i', title: text || '' }).text('i');
    }

    // Red "NEW" sticker, inline with a label.
    function newBadge() {
        return $('<span>', { 'class': 'steward-new-badge' }).text('NEW');
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

    // ---------------------------------------------------------------

    if (!S.kernel.ui) S.kernel.ui = {};
    S.kernel.ui.helpers = {
        formRow:   formRow,
        indentRow: indentRow,
        toggle:    toggle,
        input:     input,
        dropdown:  dropdown,
        button:    button,
        helpIcon:  helpIcon,
        newBadge:  newBadge,
        settings:  settings,
        update:    update
    };

}(Steward));
