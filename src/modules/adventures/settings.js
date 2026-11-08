/*
 * Default settings for the adventures module.
 *
 * Stored under steward.adventures. Shape:
 *
 *   {
 *     lastDir:             '',
 *     stuckMinutes:        45,
 *     retrain:             false,
 *     retrainSettlersOnly: false
 *   }
 *
 * `lastDir` is the folder the battle-file picker last opened from, so the
 * next pick starts there.
 *
 * `stuckMinutes` is the stuck-step limit: a run step on the island that has
 * watched a wait this many minutes takes a zone trip home and back, which
 * makes the host refresh what it reports. 0 switches the trip off. It is
 * edited in the Adventures group of the Settings screen. `stuckMinutes()`
 * is the reader the trip uses.
 *
 * `retrain` switches retraining of the troops lost on a map on or off for
 * every run. It is read again each time a run reaches Snapshot, Account,
 * Population and Retrain, so a change takes effect in the middle of a run.
 * A `retrain` key in an older template file or run file is ignored, because
 * this setting alone decides. `retrainOn()` is its reader.
 *
 * `retrainSettlersOnly`, while retraining is on, skips retraining and moves
 * on instead of pausing when free settlers cannot cover the orders and
 * cannot be topped up with a population buff. `retrainSettlersOnly()` is its
 * reader. Both switches default to off, and any stored value that is not
 * exactly `true` reads as off, so a hand-edited file never turns them on.
 * On the Settings screen the second switch is greyed out while the first
 * is off, since it has no effect then; its stored value is kept.
 *
 * Run templates are not settings: each one is its own JSON file under the
 * steward folder (see templates.js), so they can be shared and survive a
 * profile switch. All module settings are scalars that are only ever
 * overwritten, never removed, so the host's merging write is correct for
 * them. One known overlap: the Settings screen snapshots the adventures
 * buffer when it is first used, so a `lastDir` the template dialog writes
 * while that buffer is dirty is overwritten by Save; `lastDir` is only the
 * dialog's start folder, so this is accepted.
 *
 * Older versions also stored a module-wide default horseshoe. That stored
 * key is ignored without any migration, because only keys present in these
 * defaults are read.
 *
 * The run request and the running wave executor's state are not settings
 * either: they live in their own steward file (see state.js), written whole
 * on every change, because the host's merging write would keep stale keys of
 * a shrinking object.
 *
 * There is no `enabled` key: the executor only acts while the user has
 * started a run, and Pause and Stop in the menu switch it off.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    S.modules.adventures.defaultSettings = {
        lastDir:             '',
        stuckMinutes:        45,
        retrain:             false,
        retrainSettlersOnly: false
    };

    // The stored settings with the defaults filled in (the defaults alone
    // while templates.js is not loaded yet), so every reader below sees the
    // same values.
    function settingsNow() {
        var a = S.modules.adventures;
        return a.templates && a.templates.settings ? a.templates.settings() : a.defaultSettings;
    }

    // A stored limit that is not a usable minute count falls back to the
    // default, so a hand-edited or missing value never disables the trip.
    function minutesOf(s) {
        var m = s ? s.stuckMinutes : undefined;
        if (typeof m === 'number' && isFinite(m) && m >= 0) return m;
        return S.modules.adventures.defaultSettings.stuckMinutes;
    }

    var SETTLERS_HELP = 'With too few settlers and no population buff, skip retraining instead of pausing the series';
    var SETTLERS_NEEDS = 'Needs Retrain lost troops';

    // The Adventures group of the Settings screen. Reads and writes go
    // through the shared settings buffer, so Save and Close on the screen
    // cover these fields. The shown values have the defaults filled in, and
    // the baseline makes them the saved state, so a default nobody stored
    // does not count as a change.
    S.modules.adventures.renderSettings = function ($main, h) {
        h.baseline('adventures', settingsNow());
        var s = h.settings('adventures');

        var $run = h.card({ icon: '⚔', title: 'Running an adventure' });
        $run.append(h.field('Stuck step limit',
            'A step on the island that waits this long goes home and back. 0 turns it off.',
            h.number({
                ns:    'adventures',
                path:  'stuckMinutes',
                value: minutesOf(s),
                unit:  'min',
                label: 'Stuck step limit'
            })));
        $main.append($run);

        // The settlers switch only means something while retraining is on,
        // so it follows the buffered retrain switch in place: a redraw here
        // would run at the blur of another field and swallow a Save click.
        var retrainOn = s.retrain === true;
        var $settlers = h.toggle({
            ns:       'adventures',
            path:     'retrainSettlersOnly',
            checked:  s.retrainSettlersOnly === true,
            disabled: !retrainOn,
            label:    'Only with enough settlers'
        });
        var $settlersField = h.field('Only with enough settlers',
            retrainOn ? SETTLERS_HELP : SETTLERS_NEEDS, $settlers,
            { sub: true, disabled: !retrainOn });

        var $after = h.card({ title: 'After each map' });
        $after.append(h.field('Retrain lost troops', 'Order the troops lost on the map', h.toggle({
            ns:       'adventures',
            path:     'retrain',
            checked:  retrainOn,
            label:    'Retrain lost troops',
            onChange: function (on) {
                var enable = on === true;
                $settlersField.toggleClass('steward-dis', !enable);
                $settlersField.children('.steward-field-lbl').children('.steward-field-help')
                    .text(enable ? SETTLERS_HELP : SETTLERS_NEEDS);
                $settlers.toggleClass('steward-disabled', !enable);
                $settlers.children('input').prop('disabled', !enable);
            }
        })));
        $after.append($settlersField);
        $main.append($after);

        $main.append(h.banner('Templates have their own window. Runs start from ~Steward~ › Adventures ' +
            'and are paused or stopped in the ~Adventures~ menu.', {
            icon:    'ℹ',
            $action: h.button('Run templates…', {
                size:    'sm',
                onClick: function () {
                    var d = S.modules.adventures.dialog;
                    if (d && d.open) d.open();
                }
            })
        }));
    };

    // The stored stuck-step limit in minutes. The trip and the Settings
    // summary both read it here, so they never disagree.
    S.modules.adventures.stuckMinutes = function () {
        return minutesOf(settingsNow());
    };

    // Whether lost troops are retrained. The run steps, the run state and the
    // summary all read it here; only a stored `true` switches it on.
    S.modules.adventures.retrainOn = function () {
        return settingsNow().retrain === true;
    };

    // Whether a settler shortage skips retraining instead of pausing the run.
    S.modules.adventures.retrainSettlersOnly = function () {
        return settingsNow().retrainSettlersOnly === true;
    };

    // Section summary, from the same readers the run uses.
    S.modules.adventures.settingsSummary = function () {
        var a = S.modules.adventures;
        var m = a.stuckMinutes();
        var text = m > 0 ? 'stuck limit ' + m + ' min' : 'stuck limit off';
        if (!a.retrainOn()) return text + ', retrain off';
        return text + (a.retrainSettlersOnly() ? ', retrain on, settlers only' : ', retrain on');
    };

}(Steward));
