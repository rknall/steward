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

        // Live events — affect pickTask precedence in templates_explorers,
        // pickDeposits in templates_geologists, and any future event-aware
        // module. Surface them up-front so it's clear what the kernel sees.
        S.kernel.log('diag', '--- live events ---');
        try {
            if (S.core.events && S.core.events.liveEventNames) {
                var raw = S.core.events.liveEventNames();
                S.kernel.log('diag', 'GetActiveEventNames:', raw.length ? raw.join(', ') : '(none)');
                var ev = S.core.events.active();
                if (ev.length === 0) {
                    S.kernel.log('diag', 'matched against Steward.core.events.data: (none)');
                } else {
                    for (var k = 0; k < ev.length; k++) {
                        var values = S.core.events.treasureValues(ev[k].code);
                        S.kernel.log('diag', '  matched:', ev[k].code,
                                     '— categories:', (ev[k].categoryList || []).join(',') || '(none)',
                                     '— treasureValues:',
                                     (values && values.length) ? values.join(',') : '(none)',
                                     '— rawNames:', (ev[k].rawNames || []).join(','));
                    }
                }
            }
        } catch (e) { S.kernel.error('diag', 'events dump threw:', e); }

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

            // 1) Distribution: how many of each (GetType, classify, status)?
            //    Surfaces every type the host returns — including specials
            //    like Marshal (18), Courageous Explorer (32), Admiral, etc.
            var byTriple = {};        // 'type|classify|status' → count
            var byRawType = {};       //  raw GetType → count
            var firstByRaw = {};      //  raw GetType → first seen specialist
            for (var i = 0; i < all.length; i++) {
                var s = all[i];
                var raw = '?';
                try { raw = (typeof s.GetType === 'function') ? s.GetType() : '?'; } catch (e) { raw = 'threw'; }
                byRawType[raw] = (byRawType[raw] || 0) + 1;
                if (!firstByRaw[raw]) firstByRaw[raw] = s;
                var cls = c.classify(s);
                var st = c.status(s);
                var key = raw + '|' + cls + '|' + st;
                byTriple[key] = (byTriple[key] || 0) + 1;
            }

            S.kernel.log('diag', 'distribution by (GetType | classify | status):');
            var tripleKeys = Object.keys(byTriple).sort();
            for (var t = 0; t < tripleKeys.length; t++) {
                S.kernel.log('diag', '  ' + tripleKeys[t] + '  →  ' + byTriple[tripleKeys[t]]);
            }

            // 2) Dump one specimen per RAW GetType so we see Marshal,
            //    Courageous Explorer, etc., not just one per classify-result.
            S.kernel.log('diag', '--- one specimen per GetType ---');
            var rawKeys = Object.keys(firstByRaw).sort(function (a, b) { return Number(a) - Number(b); });
            for (var r = 0; r < rawKeys.length; r++) {
                var rt = rawKeys[r];
                var spec = firstByRaw[rt];
                var cls2 = c.classify(spec);
                var st2 = c.status(spec);
                var nm = '';
                try { nm = c.name(spec); } catch (e) { nm = '(name threw)'; }
                d.logLines('diag', d.describe(spec,
                    'specialist GetType=' + rt + ' classify=' + cls2 +
                    ' status=' + st2 + ' name=' + (nm || '?')));

                // Also dump the description object — that's where carrier
                // detection and capacity live.
                try {
                    if (typeof spec.GetSpecialistDescription === 'function') {
                        var desc = spec.GetSpecialistDescription();
                        if (desc) {
                            d.logLines('diag', d.describe(desc, 'description for GetType=' + rt));
                        }
                    }
                } catch (e) { S.kernel.warn('diag', 'description dump threw:', e); }

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
