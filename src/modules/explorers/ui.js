/*
 * Dashboard surface for the explorers module.
 *
 * Renders inside the Explorers tab: a settings column (`side`) beside a live
 * table of every explorer (`render`). The per-explorer override map is still
 * hand-edited in settings.json; the "Show in log" button dumps the current
 * state (overrides, idle/busy counts, pickTask results) to the log so users
 * can see what dispatches will look like before turning the module on.
 */

(function (S) {

    if (!S.modules.explorers) S.modules.explorers = {};

    // Row filter of the live table, kept while the dashboard stays loaded.
    var filter = 'all';

    function readSettings() {
        var stored = S.kernel.settings.read('explorers') || {};
        var defaults = S.modules.explorers.defaultSettings || {};
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        return merged;
    }

    function writeSettings(s) {
        S.kernel.settings.write('explorers', s);
    }

    // Runs-now button: dump explorer state + per-explorer pickTask results
    // to the log. Helps users tune overrides before flipping `enabled`.
    function showOverrides() {
        var s = readSettings();
        // A stored 0 is a real delay, so test the type rather than truthiness.
        var delay = (typeof s.dispatchDelay === 'number') ? s.dispatchDelay : S.modules.explorers.defaultSettings.dispatchDelay;
        S.kernel.log('explorers', '--- explorer state ---');
        S.kernel.log('explorers', 'enabled:', !!s.enabled,
                     '  dispatchDelay:', delay, 'ms');

        try {
            var liveRaw = S.core.events.liveEventNames();
            S.kernel.log('explorers', 'host events (raw):',
                         liveRaw.length ? liveRaw.join(', ') : '(none)');
            var matched = S.core.events.active();
            if (matched.length === 0) {
                S.kernel.log('explorers',
                    'matched events: (none — pickTask falls back to host explDefTask)');
            } else {
                for (var m = 0; m < matched.length; m++) {
                    var ev = matched[m];
                    var values = S.core.events.treasureValues(ev.code);
                    S.kernel.log('explorers', '  matched:', ev.code,
                                 '— categories:', (ev.categoryList || []).join(',') || '(none)',
                                 '— treasureValues:',
                                 (values && values.length) ? values.join(',') : '(none)');
                }
            }
        } catch (e) {
            S.kernel.error('explorers', 'event dump threw:', e);
        }
        S.kernel.log('explorers',
                     'host explDefTask:', S.kernel.host.explDefTaskGlobal(),
                     ' explDefTaskByType keys:',
                     Object.keys((typeof mainSettings !== 'undefined' && mainSettings &&
                                  mainSettings.explDefTaskByType) || {}).length);

        var c = S.core.specialists;
        var read = listExplorers();
        if (!read.has) {
            S.kernel.log('explorers', 'explorers not readable yet:', S.kernel.read.show(read.r));
            return S.kernel.ui.notify('Explorers are still being read — try again in a moment.');
        }
        var explorers = read.list;

        var counts = tally(explorers);
        S.kernel.log('explorers', 'explorers — total:', explorers.length,
                     '  idle:', counts.idle, '  busy:', counts.busy,
                     '  unknown:', counts.unknown);

        // pickTask preview per explorer.
        for (var j = 0; j < explorers.length; j++) {
            var spec = explorers[j];
            var name = c.name(spec) || '?';
            var picked = '?';
            try { picked = c.pickTask(spec) || '?'; } catch (e) { picked = 'threw'; }
            var override = c.namedOverride(s.overrides, name);
            S.kernel.log('explorers',
                '  [' + statusWord(c.status(spec)) + ']',
                name,
                '→ pickTask:', picked,
                override ? ('(override: ' + override + ')') : '');
        }
        S.kernel.ui.notify('Explorer state dumped to log.');
    }

    // Build dropdown options for the "Default task" picker. Values are
    // ExplorerTask enum strings (matching `core/specialists.taskLabel`).
    // Empty value = "use Steward's longest-available baseline (Prolonged)".
    // Skill-locked variants (Erudite/BeanACollada) are intentionally
    // omitted — they only apply to explorers who learned the skill, and
    // pickTask routes those automatically.
    function defaultTaskOptions() {
        var opts = [
            { value: '', label: 'Auto (Prolonged baseline)' }
        ];
        var c = S.core.specialists;
        var enums = [
            S.ExplorerTask.Short,
            S.ExplorerTask.Medium,
            S.ExplorerTask.Long,
            S.ExplorerTask.EvenLonger,
            S.ExplorerTask.Prolonged,
            S.ExplorerTask.AdventureZoneShort,
            S.ExplorerTask.AdventureZoneMedium,
            S.ExplorerTask.AdventureZoneLong,
            S.ExplorerTask.AdventureZoneVeryLong
        ];
        for (var i = 0; i < enums.length; i++) {
            var label = (c && c.taskLabel) ? c.taskLabel(enums[i]) : enums[i];
            opts.push({ value: enums[i], label: label });
        }
        return opts;
    }

    // Label of a stored default task, taken from the same options the picker shows.
    function taskLabelFor(value) {
        var opts = defaultTaskOptions();
        for (var i = 0; i < opts.length; i++) {
            if (opts[i].value === (value || '')) return opts[i].label;
        }
        return String(value);
    }

    function summary(h) {
        var s = h.settings('explorers');
        var delay = (typeof s.dispatchDelay === 'number') ? s.dispatchDelay : S.modules.explorers.defaultSettings.dispatchDelay;
        return delay + ' ms · ' +
            (s.forceTreasureOnEvents !== false ? 'treasure in events' : 'adventures in events') +
            ' · ' + taskLabelFor(s.defaultTask);
    }

    // Log word of a status. Unknown is its own word: a status the game call
    // failed on is neither idle nor busy.
    function statusWord(status) {
        if (status === S.SpecialistStatus.Idle) return 'idle';
        if (status === S.SpecialistStatus.Unknown) return 'unknown';
        return 'busy';
    }

    // Idle, busy and unknown explorers of a list; the three sum to its length.
    function tally(list) {
        var out = { idle: 0, busy: 0, unknown: 0 };
        for (var i = 0; i < list.length; i++) {
            out[statusWord(S.core.specialists.status(list[i]))]++;
        }
        return out;
    }

    // One read of the explorer list per call, memoized by the dashboard pass.
    // { r, has, list }: `has` is false while the list is unreadable or not
    // ready, which is not the same as having no explorers; a partial list
    // keeps its rows (`r.state`) and the caller notes the gap. `list` is a
    // copy sorted by display name (stable across renders), so the memoized
    // value is never reordered.
    function listExplorers() {
        var c = S.core.specialists;
        var r = c.byTypeRead(S.SpecialistType.Explorer);
        var has = S.kernel.read.has(r);
        var list = has ? r.value.slice() : [];
        list.sort(c.compareByName);
        return { r: r, has: has, list: list };
    }

    function overrideCount(s) {
        return Object.keys((s && s.overrides) || {}).length;
    }

    function side($side, h) {
        // The buffer starts from the stored settings so edits count as changes.
        h.baseline('explorers', readSettings());
        var s = h.settings('explorers');

        var $card = h.card({ icon: '⌖', title: 'Explorers', meta: 'settings' });
        $card.append(h.field('Send explorers', 'Module on or off',
            h.toggle({ ns: 'explorers', path: 'enabled', label: 'Send explorers' })));
        $card.append(h.field('Delay between sends', null,
            h.number({ ns: 'explorers', path: 'dispatchDelay', unit: 'ms',
                       label: 'Delay between sends' })));
        // forceTreasureOnEvents: when ON, every explorer goes on a treasure
        // dispatch during a treasure event's content phase (cooldown or
        // shop-only does not trigger this, see core/specialists
        // activeEventContext). When OFF, adventure-biased explorers stay on
        // adventures even during events.
        $card.append(h.field('Treasure during events',
            'No event items drop on adventures. Keep on unless you farm adventure scrolls.',
            h.toggle({ ns: 'explorers', path: 'forceTreasureOnEvents',
                       checked: s.forceTreasureOnEvents !== false,
                       label: 'Treasure during events' })));
        // Applies to vanilla explorers and to inactive-trait cases; pickTask
        // consults it before the host's own default task.
        $card.append(h.field('Default task', 'For explorers without a trait recommendation',
            h.dropdown(defaultTaskOptions(), {
                ns: 'explorers', path: 'defaultTask',
                selected: s.defaultTask || '',
                write: function (val) { h.set('explorers', 'defaultTask', val || null); }
            }), { wrap: true }));
        $card.append(h.field('Per-explorer overrides',
            overrideCount(s) + ' have a fixed task (edited in settings.json)',
            $('<span>').append(h.now()).append(' ').append(
                h.button('Show in log', { size: 'sm', onClick: showOverrides })),
            { wide: true, wrap: true }));
        $side.append($card);
    }

    function render($main, h) {
        var s = h.settings('explorers');
        var c = S.core.specialists;
        var $slot = $('<div>');
        $main.append($slot);

        // Rebuilds only the live card, so a chip click keeps the rest of the tab.
        function draw() {
            // A portrait the host had not decoded yet is asked for once more a second later.
            var pass = {};
            var read = listExplorers();
            var explorers = read.list;
            var overrides = (s && s.overrides) || {};
            var rows = [];
            var busy = 0, idle = 0, ov = 0;

            for (var i = 0; i < explorers.length; i++) {
                var spec = explorers[i];
                var name = c.name(spec) || '?';
                var st = c.status(spec);
                var isIdle = (st === S.SpecialistStatus.Idle);
                var isUnknown = (st === S.SpecialistStatus.Unknown);
                var hasOv = !!c.namedOverride(overrides, name);
                if (isIdle) idle++;
                else if (!isUnknown) busy++;
                if (hasOv) ov++;
                if (filter === 'busy' && (isIdle || isUnknown)) continue;
                if (filter === 'idle' && !isIdle) continue;
                if (filter === 'ov' && !hasOv) continue;

                var portrait = c.portraitTag(spec, null, pass);
                if (portrait) portrait += ' ';

                var $status = isUnknown ? h.unknown('status not readable')
                    : h.statusBadge(isIdle, isIdle ? null : c.orders.remaining(spec));

                var current = null;
                if (!isIdle && !isUnknown && c.currentTask) {
                    var ct = c.currentTask(spec);
                    if (ct) current = c.taskLabel(ct);
                }
                var next = '?';
                try {
                    var nt = c.pickTask(spec);
                    if (nt) next = c.taskLabel(nt);
                } catch (ePick) { /* keep '?' */ }
                var $next = $('<span>').text(next).attr('title', next);
                if (hasOv) $next.append(' ').append(h.badge('tag', 'override'));

                rows.push([
                    { html: portrait + '<span>' + h.escape(name) + '</span>', title: name, cls: 'steward-who' },
                    $status,
                    current ? current : { text: '—', cls: 'steward-muted' },
                    $next
                ]);
            }

            if (!read.has) {
                // Neither "none" nor a count: the list is not readable now and a
                // redraw fills it in once it is.
                var $card0 = h.card({ title: 'Live state', meta: 'updated ' + h.clock() });
                var $e = h.reading();
                $slot.empty().append($card0.append($e));
                h.fit();
                return;
            }
            var $card = h.card({
                title: 'Live state',
                meta: explorers.length + ' explorers' +
                      (read.r.state === S.kernel.read.PARTIAL ? ' (partial)' : '') +
                      ' · updated ' + h.clock()
            });
            $card.append(h.chips([
                { id: 'all',  label: 'All ' + explorers.length },
                { id: 'busy', label: 'Busy ' + busy },
                { id: 'idle', label: 'Idle ' + idle },
                { id: 'ov',   label: 'Overrides ' + ov }
            ], filter, function (id) { filter = id; draw(); }));
            $card.append(h.table({
                fill: true,
                cols: [
                    { label: 'Explorer',     width: '34%' },
                    { label: 'Status',       width: '20%' },
                    { label: 'Current task', width: '22%' },
                    { label: 'Next task',    width: '24%' }
                ],
                rows: rows,
                emptyText: explorers.length ? 'No explorers match this filter.' : 'No explorers found.'
            }));
            $slot.empty().append($card);
            h.fit();
            if (pass.portraitMissed) h.redrawOnce($slot, draw, S.kernel.TIMEOUTS.PORTRAIT_RETRY_MS);
        }

        draw();
    }

    function tiles(h) {
        var read = listExplorers();
        var s = h.settings('explorers');
        var $line;
        if (!read.has) {
            $line = h.unknown('explorers not readable');
        } else {
            var counts = tally(read.list);
            $line = $('<span>').text(read.list.length + ' explorers · ')
                .append($('<span>', { 'class': 'steward-warn' }).text(counts.busy + ' busy'))
                .append(' · ' + counts.idle + ' idle');
            if (counts.unknown) {
                $line.append(' · ').append(h.unknown('status not readable').text(counts.unknown + ' ' + h.READING));
            }
        }
        return [{
            title: 'Explorers',
            icon: '⌖',
            lines: [$line, 'Default task: ' + taskLabelFor(s.defaultTask)]
        }];
    }

    S.modules.explorers.readSettings   = readSettings;
    S.modules.explorers.writeSettings  = writeSettings;
    S.modules.explorers.side           = side;
    S.modules.explorers.render         = render;
    S.modules.explorers.summary        = summary;
    S.modules.explorers.tiles          = tiles;
    S.modules.explorers.showOverrides  = showOverrides;

}(Steward));
