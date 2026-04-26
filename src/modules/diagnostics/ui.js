/*
 * Diagnostics UI.
 *
 * Steward → Diagnostics submenu. Each item is a one-shot read-only probe.
 * Output goes to the standard log (category 'diag') so it lands in the
 * console.log file the user can paste back.
 */

(function (S) {

    if (!S.modules.diagnostics) S.modules.diagnostics = {};

    var MENU_ENTRY_NAME = 'StewardDiagnosticsMenu';

    function dumpHostSnapshot() {
        var d = S.modules.diagnostics.inspect;
        S.kernel.log('diag', '--- host snapshot ---');
        try {
            if (S.kernel.host && S.kernel.host.snapshot) {
                var snap = S.kernel.host.snapshot();
                d.logLines('diag', d.describe(snap, 'Steward.kernel.host.snapshot()'));
            }
        } catch (e) { S.kernel.error('diag', 'host snapshot threw:', e); }

        try {
            if (typeof mainSettings !== 'undefined' && mainSettings) {
                d.logLines('diag', d.describe(mainSettings, 'mainSettings'));
            }
        } catch (e) { S.kernel.error('diag', 'mainSettings dump threw:', e); }

        try {
            if (typeof settings !== 'undefined' && settings && settings.settings) {
                S.kernel.log('diag', '--- host settings.settings keys ---');
                var keys = Object.keys(settings.settings).sort();
                for (var i = 0; i < keys.length; i++) {
                    var v = settings.settings[keys[i]];
                    var n = (v && typeof v === 'object') ? Object.keys(v).length : 0;
                    S.kernel.log('diag', '  ' + keys[i] + '  (' + n + ' field' + (n === 1 ? '' : 's') + ')');
                }
            }
        } catch (e) { S.kernel.error('diag', 'settings dump threw:', e); }
        notify('Host snapshot dumped to log.');
    }

    function dumpKernelState() {
        S.kernel.log('diag', '--- kernel state ---');
        try {
            S.kernel.log('diag', 'paused:', S.kernel.ui && S.kernel.ui.isPaused ? S.kernel.ui.isPaused() : '?');
            S.kernel.log('diag', 'modules registered:', S.kernel.registry.count());
            var mods = S.kernel.registry.list();
            for (var i = 0; i < mods.length; i++) {
                var m = mods[i];
                S.kernel.log('diag', '  -', m.id, '(' + m.priority + ')',
                             m.experimental ? '[experimental]' : '',
                             'busy:', S.kernel.queue.isModuleBusy(m.id),
                             'depth:', S.kernel.queue.depthByModule(m.id));
            }
            S.kernel.log('diag', 'queue total depth:', S.kernel.queue.depth());
            S.kernel.log('diag', 'queue running:', S.kernel.queue.runningModule());
        } catch (e) { S.kernel.error('diag', 'kernel state dump threw:', e); }
        notify('Kernel state dumped to log.');
    }

    function inspectSpecialists() {
        var d = S.modules.diagnostics.inspect;
        var c = S.core.specialists;
        S.kernel.log('diag', '--- specialists on current zone ---');
        try {
            var all = c.all();
            S.kernel.log('diag', 'total:', all.length);

            // Group: first general we find, first carrier, first explorer (idle),
            // first explorer (busy), first geologist (idle), first geologist (busy).
            var picked = {};
            for (var i = 0; i < all.length; i++) {
                var s = all[i];
                var cls = c.classify(s);
                var st = c.status(s);
                var key = cls + ':' + st;
                if (!picked[key]) picked[key] = s;
            }

            var pickedKeys = Object.keys(picked);
            S.kernel.log('diag', 'unique class:status pairs:', pickedKeys.length);

            for (var k = 0; k < pickedKeys.length; k++) {
                var label = pickedKeys[k];
                var spec = picked[label];
                d.logLines('diag', d.describe(spec, 'specialist [' + label + '] name=' + (c.name(spec) || '?')));
                S.kernel.log('diag', '');
            }
        } catch (e) {
            S.kernel.error('diag', 'inspectSpecialists threw:', e);
        }
        notify('Specialist inspection dumped to log.');
    }

    function inspectCurrentZone() {
        var d = S.modules.diagnostics.inspect;
        S.kernel.log('diag', '--- current zone ---');
        try {
            var z = S.core.zone.current();
            d.logLines('diag', d.describe(z, 'mCurrentPlayerZone'));
        } catch (e) { S.kernel.error('diag', 'zone dump threw:', e); }
        notify('Zone dumped to log.');
    }

    function notify(text) {
        try { if (typeof showGameAlert === 'function') showGameAlert('Steward: ' + text); }
        catch (e) { /* best effort */ }
    }

    function buildSpec() {
        return {
            name:  MENU_ENTRY_NAME,
            label: 'Diagnostics',
            items: [
                { label: 'Inspect specialists',  onSelect: inspectSpecialists },
                { label: 'Inspect current zone', onSelect: inspectCurrentZone },
                { type: 'separator' },
                { label: 'Dump host snapshot',   onSelect: dumpHostSnapshot },
                { label: 'Dump kernel state',    onSelect: dumpKernelState }
            ]
        };
    }

    function renderMenu() {
        if (!S.kernel.ui || !S.kernel.ui.menu) return;
        S.kernel.ui.menu.replaceByName(MENU_ENTRY_NAME, buildSpec());
    }

    S.modules.diagnostics.renderMenu          = renderMenu;
    S.modules.diagnostics.inspectSpecialists  = inspectSpecialists;
    S.modules.diagnostics.inspectCurrentZone  = inspectCurrentZone;
    S.modules.diagnostics.dumpHostSnapshot    = dumpHostSnapshot;
    S.modules.diagnostics.dumpKernelState     = dumpKernelState;

}(Steward));
