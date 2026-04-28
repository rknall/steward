/*
 * Dashboard surface for the mining module.
 *
 * Renders inside the Geologists tab as a "Mining" section beside the
 * existing Geologists section. Master toggle + per-deposit table over
 * all 9 deposit types (canonical S.core.deposits.types() order).
 *
 * Stone/Marble/Granite show '—' in the action columns since they have
 * no mine; their Active count reads the mason building instead.
 *
 * Per-deposit writes go through updateDeposit, which preserves every
 * schema field (build, upgrade, targetLevel, pause, buff, refill) so
 * later phase landings don't have to migrate user settings.
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

    function summary() {
        var s = readSettings();
        if (!s.enabled) return 'disabled';
        var counts = readQueueCounts();
        return counts.slotsUsed + '/' + counts.slotsTotal + ' build slots';
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

    function renderSection($panel, h) {
        var s = h.settings('mining');

        $panel.append(h.formRow('Run on Startup', h.toggle({
            checked:  !!s.enabled,
            onChange: function (next) {
                h.update('mining', { enabled: next });
            }
        })));

        $panel.append(h.formRow('Action delay', h.input({
            type:     'number',
            value:    s.actionDelay || 1500,
            width:    '90px',
            onChange: function (val) {
                var n = parseInt(val, 10);
                if (!isNaN(n) && n >= 0) {
                    h.update('mining', { actionDelay: n });
                }
            }
        }), 'ms — pause between sends'));

        $panel.append(h.formRow('Pause threshold', h.input({
            type:     'number',
            value:    typeof s.pauseThreshold === 'number' ? s.pauseThreshold : 50,
            width:    '90px',
            onChange: function (val) {
                var n = parseInt(val, 10);
                if (!isNaN(n) && n >= 0) {
                    h.update('mining', { pauseThreshold: n });
                }
            }
        }), 'auto-pause when deposit remaining drops below this'));

        appendDepositTable($panel, h, s);
        appendStatusFooter($panel, h);
    }

    function appendDepositTable($panel, h, s) {
        var d = S.core.deposits;
        if (!d || !d.types) return;
        var types = d.types();
        var depCfg = (s && s.deposits) || {};

        $panel.append(h.gridRow(
            [[3, 'Deposit'], [2, 'Build Mine'], [2, 'Upgrade Mine'],
             [2, 'Target Lvl'], [2, 'Pause'], [1, 'Active']],
            { headerCells: true }
        ));

        for (var i = 0; i < types.length; i++) {
            var info = types[i];
            var cfg = depCfg[info.name] || {};
            var active = activeCount(info);

            (function (depositName, currentCfg, activeNum, mineable) {
                var $buildCell, $upgradeCell, $targetCell, $pauseCell;
                if (mineable) {
                    $buildCell = h.toggle({
                        checked:  !!currentCfg.build,
                        onChange: function (next) {
                            updateDeposit(h, depositName, { build: next });
                        }
                    });
                    $upgradeCell = h.toggle({
                        checked:  !!currentCfg.upgrade,
                        onChange: function (next) {
                            updateDeposit(h, depositName, { upgrade: next });
                        }
                    });
                    $targetCell = h.input({
                        type:     'number',
                        value:    typeof currentCfg.targetLevel === 'number' ? currentCfg.targetLevel : 3,
                        width:    '60px',
                        // TSO mines cap at level 5; reject out-of-range input rather than persist garbage.
                        onChange: function (val) {
                            var n = parseInt(val, 10);
                            if (!isNaN(n) && n >= 1 && n <= 5) {
                                updateDeposit(h, depositName, { targetLevel: n });
                            }
                        }
                    });
                    $pauseCell = h.toggle({
                        checked:  !!currentCfg.pause,
                        onChange: function (next) {
                            updateDeposit(h, depositName, { pause: next });
                        }
                    });
                } else {
                    $buildCell   = '—';
                    $upgradeCell = '—';
                    $targetCell  = '—';
                    $pauseCell   = '—';
                }
                $panel.append(h.gridRow(
                    [[3, depositName],
                     [2, $buildCell],
                     [2, $upgradeCell],
                     [2, $targetCell],
                     [2, $pauseCell],
                     [1, String(activeNum)]]
                ));
            })(info.name, cfg, active, !!info.mineName);
        }
    }

    function appendStatusFooter($panel, h) {
        var counts = readQueueCounts();
        var line = 'Build queue: ' + counts.slotsUsed + '/' + counts.slotsTotal +
                   ' slots used  ·  Licenses: ' + counts.licUsed + '/' + counts.licMax;
        $panel.append(h.formRow('Status', line));
    }

    S.modules.mining.readSettings  = readSettings;
    S.modules.mining.renderSection = renderSection;
    S.modules.mining.summary       = summary;

}(Steward));
