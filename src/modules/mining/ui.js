/*
 * Dashboard surface for the mining module.
 *
 * Owns the Mining tab: `side` is the settings column (module switch, delay,
 * pause threshold, build queue, licence and buff counts, buff breaker) and
 * `render` is the per-deposit table over all deposit types in
 * S.core.deposits.types() order. Stone/Marble/Granite have no mine, so they
 * form the managed MASONS sub-table, which only picks a buff: steward never
 * builds masons, but it does buff them. Their Active count reads the mason
 * building.
 *
 * The Buff choice lists the production buffs the game offers for the
 * building (S.core.buffs.buildingBuffs). A stored buff that is no longer
 * offered stays in the list, marked, so showing the row never drops it from
 * the settings; the module refuses to apply it anyway.
 *
 * Every shown value is the stored setting overlaid with the dashboard
 * buffer, so a re-render keeps a pending edit visible. Per-deposit writes
 * go through updateDeposit, which starts from the shown row and keeps every
 * schema field (enabled, build, upgrade, targetLevel, pause, buff, refill),
 * so a saved row is always whole, even for a type the store lacked.
 *
 * The tab is drawn in one host-read pass, so every option and status line of
 * a draw shows the same stock read, and an unreadable stock shows `?`.
 */

(function (S) {

    if (!S.modules.mining) S.modules.mining = {};

    // The one reader lives in module.js; read it at call time.
    function readSettings() {
        return S.modules.mining.readSettings();
    }

    // What the screen shows: the stored settings with the unsaved buffer
    // laid over them, deposit by deposit so a partly edited row keeps the
    // fields the buffer lacks.
    function shownSettings(h) {
        return h.shown('mining', readSettings(), { deposits: 'fields' });
    }

    function activeCount(info) {
        if (!info) return 0;
        var n = info.mineName || info.masonName;
        if (!n) return 0;
        if (!S.core.buildings || !S.core.buildings.byName) return 0;
        try { return S.core.buildings.byName(n).length; }
        catch (e) { return 0; }
    }

    // Core reads for the Buff column. Each is read at call time, and a
    // missing or throwing core reads as empty, like activeCount.
    function buildingOf(info) {
        return info ? (info.mineName || info.masonName || null) : null;
    }

    function offeredBuffs(bName) {
        if (!bName || !S.core.buffs || !S.core.buffs.buildingBuffs) return [];
        try { return S.core.buffs.buildingBuffs(bName, true) || []; }
        catch (e) { return []; }
    }

    // Stock of a plain buff; null when the star menu cannot be read.
    function buffStock(name) {
        if (!S.core.buffs || !S.core.buffs.stock) return null;
        try { return S.core.buffs.stock(name, ''); }
        catch (e) { return null; }
    }

    // Buildings of this type with a production buff running now.
    function buffedCount(info) {
        var n = buildingOf(info);
        if (!n || !S.core.buildings || !S.core.buildings.byName) return 0;
        try {
            var list = S.core.buildings.byName(n);
            var c = 0;
            for (var i = 0; i < list.length; i++) {
                if (S.core.buildings.hasProductionBuff(list[i]) === true) c++;
            }
            return c;
        } catch (e) { return 0; }
    }

    function buffBreaker() {
        var b = S.modules.mining.buffBreaker;
        return (b && typeof b.isOpen === 'function') ? b : null;
    }

    function breakerOpen() {
        var b = buffBreaker();
        try { return !!(b && b.isOpen()); }
        catch (e) { return false; }
    }

    // Buildings and buffed buildings over every deposit type, masons included.
    function buffTotals() {
        var types = S.core.deposits.types();
        var out = { buffed: 0, buildings: 0 };
        for (var i = 0; i < types.length; i++) {
            out.buffed    += buffedCount(types[i]);
            out.buildings += activeCount(types[i]);
        }
        return out;
    }

    // Zeros while the build queue cannot be read.
    function readQueueCounts() {
        var cap = S.core.construction.capacity();
        var v = S.kernel.read.isOk(cap) ? cap.value : null;
        return {
            slotsTotal: v ? v.slotsTotal : 0,
            slotsUsed:  v ? v.slotsUsed  : 0,
            licMax:     v ? v.licMax     : 0,
            licUsed:    v ? v.licUsed    : 0
        };
    }

    function pausedCount(s) {
        var types = S.core.deposits.types();
        var n = 0;
        for (var i = 0; i < types.length; i++) {
            var cfg = (s.deposits || {})[types[i].name];
            if (types[i].mineName && cfg && cfg.pause === true) n++;
        }
        return n;
    }

    function minesActive() {
        var types = S.core.deposits.types();
        var n = 0;
        for (var i = 0; i < types.length; i++) {
            if (types[i].mineName) n += activeCount(types[i]);
        }
        return n;
    }

    function thresholdOf(s) {
        return typeof s.pauseThreshold === 'number' ? s.pauseThreshold
            : S.modules.mining.defaultSettings.pauseThreshold;
    }

    function delayOf(s) {
        return typeof s.actionDelay === 'number' ? s.actionDelay
            : S.modules.mining.defaultSettings.actionDelay;
    }

    function summary(h) {
        var s = shownSettings(h);
        var counts = readQueueCounts();
        return delayOf(s) + ' ms · pause below ' + thresholdOf(s) +
               ' · queue ' + counts.slotsUsed + '/' + counts.slotsTotal;
    }

    function tiles(h) {
        var s = shownSettings(h);
        var counts = readQueueCounts();
        var paused = pausedCount(s);
        var lines = [
            'Build queue ' + counts.slotsUsed + ' of ' + counts.slotsTotal +
                ' · licences ' + counts.licUsed + ' of ' + counts.licMax,
            minesActive() + ' mines active, ' + (paused === 0 ? 'none' : paused) + ' paused'
        ];
        if (breakerOpen()) lines.push('Buffing paused (breaker)');
        return [{
            title: 'Mining',
            icon:  '⚒',
            lines: lines
        }];
    }

    function updateDeposit(h, depositName, partial) {
        // The edit starts from the row the screen shows (buffer over stored
        // over default): pending edits layer on each other, and a row the
        // store lacks is saved whole instead of as the one edited field,
        // which would leave it disabled. Only the edited row enters the
        // buffer; the others stay as the buffer holds them.
        var s = h.settings('mining');
        var deposits = {};
        var k;
        for (k in (s.deposits || {})) deposits[k] = s.deposits[k];
        var current = shownSettings(h).deposits[depositName] || {};
        // Preserve every known field — copy first, then overlay partial.
        var next = {};
        var fields = ['enabled', 'build', 'upgrade', 'targetLevel',
                      'pause', 'buff', 'refill'];
        for (var f = 0; f < fields.length; f++) {
            var key = fields[f];
            if (typeof current[key] !== 'undefined') next[key] = current[key];
        }
        for (var pk in partial) next[pk] = partial[pk];
        deposits[depositName] = next;
        h.update('mining', { deposits: deposits });
    }

    // Any whole level from 1 up. The game decides the top level: tryUpgrade
    // asks S.core.buildings.isUpgradable before it queues an upgrade, so a target above a
    // mine's real maximum just stops there.
    function parseLevel(text) {
        var n = S.kernel.ui.settingsParse.whole(text);
        return (n === null || n < 1) ? null : n;
    }

    function side($side, h) {
        h.baseline('mining', readSettings());
        var s = shownSettings(h);

        var $card = h.card({ icon: '⚒', title: 'Mining' });
        $card.append(h.field('Build, upgrade and buff mines', 'Module on or off',
            h.toggle({
                ns: 'mining', path: 'enabled', checked: !!s.enabled,
                label: 'Build, upgrade and buff mines'
            })));
        $card.append(h.field('Delay between actions', null,
            h.number({
                ns: 'mining', path: 'actionDelay', value: delayOf(s),
                unit: 'ms', label: 'Delay between actions'
            })));
        $card.append(h.field('Pause threshold',
            'Pause a mine when its deposit has less than this left',
            h.number({
                ns: 'mining', path: 'pauseThreshold', value: thresholdOf(s),
                unit: 'units', label: 'Pause threshold'
            })));
        $side.append($card);

        var counts = readQueueCounts();
        var $stats = $('<div>', { 'class': 'steward-card' });
        $stats.append(h.stats([
            { k: 'Build queue', v: counts.slotsUsed, small: 'of ' + counts.slotsTotal + ' slots' },
            { k: 'Licences',    v: counts.licUsed,   small: 'of ' + counts.licMax }
        ]));
        $side.append($stats);

        var totals = buffTotals();
        var open = breakerOpen();
        var $buffs = $('<div>', { 'class': 'steward-card' });
        $buffs.append(h.stats([
            { k: 'Buffed now',   v: totals.buffed, small: 'of ' + totals.buildings },
            { k: 'Buff breaker', $v: h.badge(open ? 'paused' : 'ok', open ? 'open' : 'closed') }
        ]));
        $side.append($buffs);
    }

    function render($main, h) {
        h.baseline('mining', readSettings());
        var s = shownSettings(h);
        var types = S.core.deposits.types();
        var depCfg = s.deposits || {};

        var mineRows = [];
        var masonRows = [];
        var active = 0;
        var buffed = 0;

        for (var i = 0; i < types.length; i++) {
            var info = types[i];
            var count = activeCount(info);
            var label = { text: S.core.locale.res(info.name), title: info.name };
            var cfg = depCfg[info.name] || {};
            buffed += buffedCount(info);
            if (!info.mineName) {
                masonRows.push(masonRow(h, info, label, cfg, count));
                continue;
            }
            active += count;
            mineRows.push(mineRow(h, info, label, cfg, count));
        }

        var b = buffBreaker();
        if (breakerOpen()) {
            $main.append(h.banner('Buffing paused: ' + b.snapshot().run + ' buff applies in a row ' +
                'were not seen on their building. One probe every ' +
                S.kernel.text.minText(b.COOLDOWN_MS) + '; reloading scripts resets it. ' +
                'Build, upgrade and pause keep running.', { icon: '⚠' }));
        }

        var paused = pausedCount(s);
        var meta = active + ' mines active · ' + (paused === 0 ? 'none' : paused) + ' paused' +
                   ' · ' + buffed + ' buffed';
        var $card = h.card({ title: 'Mines per deposit', meta: meta });
        $card.append(h.table({
            fill: true,
            cols: [
                { label: 'Deposit',      width: '19%' },
                { label: 'Build',        width: '10%', cls: 'steward-c' },
                { label: 'Upgrade',      width: '11%', cls: 'steward-c' },
                { label: 'Up to level',  width: '11%', cls: 'steward-c' },
                { label: 'Pause',        width: '9%',  cls: 'steward-c' },
                { label: 'Buff',         width: '31%' },
                { label: 'Active',       width: '9%',  cls: 'steward-num' }
            ],
            rows: mineRows,
            emptyText: 'No deposit types known yet.'
        }));
        if (masonRows.length) {
            $card.append(h.subHead('MASONS', 'buff only · steward does not build masons'));
            $card.append(h.table({
                cols: [
                    { label: 'Deposit', width: '30%' },
                    { label: 'Buff',    width: '55%' },
                    { label: 'Active',  width: '15%', cls: 'steward-num' }
                ],
                rows: masonRows
            }));
        }
        $main.append($card);
    }

    // One row of the mine table. Every control writes through updateDeposit
    // so a stored deposit keeps all of its fields.
    function mineRow(h, info, label, cfg, count) {
        var name = info.name;
        var path = 'deposits.' + name + '.';
        function flag(field) {
            return h.toggle({
                ns: 'mining', path: path + field, checked: !!cfg[field],
                label: field + ' ' + name,
                write: function (next) {
                    var partial = {};
                    partial[field] = next;
                    updateDeposit(h, name, partial);
                }
            });
        }
        var level = h.number({
            ns: 'mining', path: path + 'targetLevel',
            value: typeof cfg.targetLevel === 'number' ? cfg.targetLevel : 3,
            parse: parseLevel, width: '50px', label: 'Up to level ' + name,
            write: function (next) { updateDeposit(h, name, { targetLevel: next }); }
        });
        return [label, flag('build'), flag('upgrade'), level, flag('pause'),
                buffCell(h, info, cfg), count];
    }

    // One row of the mason table: masons are only buffed.
    function masonRow(h, info, label, cfg, count) {
        return [label, buffCell(h, info, cfg), count];
    }

    // The Buff choice with a one-line status under it.
    function buffCell(h, info, cfg) {
        var name = info.name;
        var chosen = typeof cfg.buff === 'string' ? cfg.buff : '';
        var list = offeredBuffs(buildingOf(info));
        var options = [{ label: 'None', value: '' }];
        var offered = false;
        for (var i = 0; i < list.length; i++) {
            options.push({ label: list[i].label + ' (' + (typeof list[i].amount === 'number' ? list[i].amount : '?') + ')' + ': ' + list[i].effect, value: list[i].name });
            if (list[i].name === chosen) offered = true;
        }
        // Kept selectable so showing the row never rewrites the stored choice.
        if (chosen && !offered) options.push({ label: chosen + ' (not offered)', value: chosen });
        var $sel = h.dropdown(options, {
            ns: 'mining', path: 'deposits.' + name + '.buff', selected: chosen,
            width: '100%',
            write: function (next) { updateDeposit(h, name, { buff: next }); }
        });
        return $('<div>').append($sel).append(buffStatus(h, info, chosen, offered));
    }

    // Out of stock outranks the open breaker: without stock no probe can run.
    function buffStatus(h, info, chosen, offered) {
        var $s = $('<div>', { 'class': 'steward-muted' });
        if (!chosen) return $s.text('off');
        if (!offered) return $s.append(h.badge('tag', 'not offered for this building'));
        var stock = buffStock(chosen);
        if (typeof stock !== 'number') return $s.text('stock unreadable');
        var done = buffedCount(info) + ' of ' + activeCount(info) + ' buffed';
        if (stock <= 0) {
            return $s.append(h.badge('paused', 'out of stock')).append($('<span>').text(' ' + done));
        }
        var text = stock + ' in stock · ' + done;
        if (breakerOpen()) {
            return $s.append(h.badge('paused', 'paused')).append($('<span>').text(' ' + text));
        }
        return $s.text(text);
    }

    S.modules.mining.side          = side;
    S.modules.mining.render        = render;
    S.modules.mining.summary       = summary;
    S.modules.mining.tiles         = tiles;

}(Steward));
