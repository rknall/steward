/*
 * Dashboard surface for the mining module.
 *
 * Owns the Mining tab: `side` is the settings column (module switch, delay,
 * pause threshold, build queue and licence counts) and `render` is the
 * per-deposit table over all deposit types in S.core.deposits.types()
 * order. Stone/Marble/Granite have no mine, so they are listed apart as
 * not managed; their Active count reads the mason building instead.
 *
 * Every shown value is the stored setting overlaid with the dashboard
 * buffer, so a re-render keeps a pending edit visible. Per-deposit writes
 * go through updateDeposit, which preserves every schema field (build,
 * upgrade, targetLevel, pause, buff, refill) so later phase landings don't
 * have to migrate user settings.
 */

(function (S) {

    if (!S.modules.mining) S.modules.mining = {};

    function readSettings() {
        var stored = S.kernel.settings.read('mining') || {};
        var defaults = S.modules.mining.defaultSettings || {};
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        var depMerged = {};
        var defaultDeps = defaults.deposits || {};
        var storedDeps  = stored.deposits  || {};
        for (key in defaultDeps) depMerged[key] = defaultDeps[key];
        for (key in storedDeps)  depMerged[key] = storedDeps[key];
        merged.deposits = depMerged;
        return merged;
    }

    // What the screen shows: the stored settings with the unsaved buffer
    // laid over them, deposit by deposit so a partly edited row keeps the
    // fields the buffer lacks.
    function shownSettings(h) {
        var base = readSettings();
        var buf = h.settings('mining') || {};
        var out = {};
        var key;
        for (key in base) out[key] = base[key];
        for (key in buf)  out[key] = buf[key];
        var deps = {};
        var baseDeps = base.deposits || {};
        var bufDeps = buf.deposits || {};
        var name, f;
        for (name in baseDeps) deps[name] = baseDeps[name];
        for (name in bufDeps) {
            var row = {};
            var under = baseDeps[name] || {};
            for (f in under) row[f] = under[f];
            for (f in bufDeps[name]) row[f] = bufDeps[name][f];
            deps[name] = row;
        }
        out.deposits = deps;
        return out;
    }

    function activeCount(info) {
        if (!info) return 0;
        var n = info.mineName || info.masonName;
        if (!n) return 0;
        if (!S.core.buildings || !S.core.buildings.byName) return 0;
        try { return S.core.buildings.byName(n).length; }
        catch (e) { return 0; }
    }

    function readQueueCounts() {
        var slotsTotal = 0, slotsUsed = 0;
        var licMax = 0, licUsed = 0;
        try {
            var p = game.gi.mCurrentPlayer;
            var bq = p.mBuildQueue;
            slotsTotal = bq.GetTotalAvailableSlots();
            slotsUsed  = bq.GetQueue_vector().length;
            licMax     = p.GetMaxBuildingCount();
            licUsed    = p.mCurrentBuildingsCountAll;
        } catch (e) { /* leave 0 */ }
        return {
            slotsTotal: slotsTotal,
            slotsUsed:  slotsUsed,
            licMax:     licMax,
            licUsed:    licUsed
        };
    }

    function depositTypes() {
        var d = S.core.deposits;
        if (!d || !d.types) return [];
        return d.types() || [];
    }

    // The game's name for a deposit; the key itself when the locale lacks it.
    function depositLabel(name) {
        var text = null;
        try { text = S.core.locale.res(name); }
        catch (e) { text = null; }
        return text ? String(text) : String(name);
    }

    function pausedCount(s) {
        var types = depositTypes();
        var n = 0;
        for (var i = 0; i < types.length; i++) {
            var cfg = (s.deposits || {})[types[i].name];
            if (types[i].mineName && cfg && cfg.pause === true) n++;
        }
        return n;
    }

    function minesActive() {
        var types = depositTypes();
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
        return [{
            title: 'Mining',
            icon:  '⚒',
            lines: [
                'Build queue ' + counts.slotsUsed + ' of ' + counts.slotsTotal +
                    ' · licences ' + counts.licUsed + ' of ' + counts.licMax,
                minesActive() + ' mines active, ' + (paused === 0 ? 'none' : paused) + ' paused'
            ]
        }];
    }

    function updateDeposit(h, depositName, partial) {
        // Read from the dashboard buffer, NOT from persisted settings —
        // multiple edits before Save must layer on top of each other or
        // earlier pending changes get clobbered by stale persisted reads.
        var s = h.settings('mining');
        var deposits = {};
        var k;
        for (k in (s.deposits || {})) deposits[k] = s.deposits[k];
        var current = deposits[depositName] || {};
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
    // asks IsUpgradeAllowed before it queues an upgrade, so a target above a
    // mine's real maximum just stops there.
    function parseLevel(text) {
        var n = S.kernel.ui.settingsParse.whole(text);
        return (n === null || n < 1) ? null : n;
    }

    function side($side, h) {
        h.baseline('mining', readSettings());
        var s = shownSettings(h);

        var $card = h.card({ icon: '⚒', title: 'Mining' });
        $card.append(h.field('Build and upgrade mines', 'Module on or off',
            h.toggle({
                ns: 'mining', path: 'enabled', checked: !!s.enabled,
                label: 'Build and upgrade mines'
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
    }

    function render($main, h) {
        h.baseline('mining', readSettings());
        var s = shownSettings(h);
        var types = depositTypes();
        var depCfg = s.deposits || {};

        var mineRows = [];
        var otherRows = [];
        var active = 0;

        for (var i = 0; i < types.length; i++) {
            var info = types[i];
            var count = activeCount(info);
            var label = { text: depositLabel(info.name), title: info.name };
            if (!info.mineName) {
                otherRows.push([label, { text: 'no mine settings', cls: 'steward-muted' }, count]);
                continue;
            }
            active += count;
            mineRows.push(mineRow(h, info, label, depCfg[info.name] || {}, count));
        }

        var paused = pausedCount(s);
        var meta = active + ' mines active · ' + (paused === 0 ? 'none' : paused) + ' paused';
        var $card = h.card({ title: 'Mines per deposit', meta: meta });
        $card.append(h.table({
            fill: true,
            cols: [
                { label: 'Deposit',      width: '25%' },
                { label: 'Build',        width: '14%', cls: 'steward-c' },
                { label: 'Upgrade',      width: '14%', cls: 'steward-c' },
                { label: 'Up to level',  width: '17%', cls: 'steward-c' },
                { label: 'Pause',        width: '15%', cls: 'steward-c' },
                { label: 'Active',       width: '15%', cls: 'steward-num' }
            ],
            rows: mineRows,
            emptyText: 'No deposit types known yet.'
        }));
        if (otherRows.length) {
            $card.append(h.subHead('NOT MANAGED BY STEWARD'));
            $card.append(h.table({
                cols: [
                    { label: 'Deposit', width: '25%' },
                    { label: 'Mine',    width: '60%' },
                    { label: 'Active',  width: '15%', cls: 'steward-num' }
                ],
                rows: otherRows
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
        return [label, flag('build'), flag('upgrade'), level, flag('pause'), count];
    }

    S.modules.mining.readSettings  = readSettings;
    S.modules.mining.side          = side;
    S.modules.mining.render        = render;
    S.modules.mining.summary       = summary;
    S.modules.mining.tiles         = tiles;

}(Steward));
