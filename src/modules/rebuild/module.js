/*
 * Rebuild module.
 *
 * Finds exhausted wells and fields on the home island (the depleted shells
 * named in settings.js) and rebuilds each with the configured well or field
 * type. Its section is on the Economy Advisor's Rebuild tab (ui.js), and its
 * switch sits in the ~Steward~ Production submenu.
 *
 * One rebuild is queued per plan. The queued action sends it through the
 * construction rebuild def, which refuses at fire time unless the grid still
 * holds an idle depleted shell and a build slot is free, and which verifies
 * the send on the grid itself. The attempt keeps the module busy until it
 * ends, so the next plan never counts a build queue that lags a send in
 * flight.
 *
 * Every rebuild is guarded by the send ledger: its entry is on disk before
 * the host call, and the grid stays blocked until the grid shows the rebuild
 * or proves that it did not happen. So a rebuild the server answers late is
 * never paid twice, across ticks, script reloads and client restarts. Each
 * plan first settles the entries left over from earlier sends.
 *
 * Every read that leads to a decision is a Result and fails closed: a
 * building list, build queue or shell state that does not read queues
 * nothing and is waited on, never taken as "nothing to do" or "room left".
 */

(function (S) {

    if (!S.modules.rebuild) S.modules.rebuild = {};

    var R = S.kernel.read;

    var OWNER = 'rebuild';

    // An unseen rebuild is only judged failed after this long, as mining
    // holds a build: a rebuild that still lands is answered well within it,
    // so the one new send that a proven no-effect allows cannot double one.
    var RESOLVE_AFTER_MS = 1800000;

    function readSettings() {
        return S.kernel.settings.merged('rebuild', S.modules.rebuild.defaultSettings);
    }

    function find(list, name) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].name === name) return list[i];
        }
        return null;
    }

    function entryOf(name) {
        var m = S.modules.rebuild;
        return find(m.wells, name) || find(m.fields, name);
    }

    // 'well' or 'field' for a well, a field or the shell either leaves
    // behind, null for any other building.
    function kindOf(name) {
        var m = S.modules.rebuild;
        if (name === m.depletedWell  || find(m.wells,  name)) return 'well';
        if (name === m.depletedField || find(m.fields, name)) return 'field';
        return null;
    }

    // The building a shell of this kind is rebuilt as: the configured type,
    // or the first of its list when the setting names none of them.
    function targetOf(kind, s) {
        var m = S.modules.rebuild;
        if (kind === 'well')  return find(m.wells,  s.wellType)  || m.wells[0];
        if (kind === 'field') return find(m.fields, s.fieldType) || m.fields[0];
        return null;
    }

    function isShell(name) {
        var m = S.modules.rebuild;
        return name === m.depletedWell || name === m.depletedField;
    }

    // The shell a well or field entry is rebuilt on.
    function shellOf(entry) {
        var m = S.modules.rebuild;
        return m.wells.indexOf(entry) !== -1 ? m.depletedWell : m.depletedField;
    }

    function key(grid) {
        return S.core.ledger.key('rebuild', 'home', grid);
    }

    function gridOfKey(k) {
        var parts = String(k).split('|');
        var g = Number(parts[parts.length - 1]);
        return S.kernel.is.finite(g) ? g : null;
    }

    function defFor(entry, grid) {
        return S.core.construction.rebuild(entry.id, grid, entry.name, shellOf(entry));
    }

    // True on a good read. A read that stays bad warns once per wait window.
    function awaited(what, r, text, opts) {
        var w = R.wait('rebuild', what, r, opts);
        if (w === 'expired') {
            S.kernel.warn('rebuild', text + ' unreadable: ' + (r && r.why) + '; no rebuilds until it reads');
        }
        return w === 'go';
    }

    // One row per well, field and depleted shell, in list order. The plan
    // rebuilds the ready, unblocked shells among them and the view lists all,
    // so both read the same rules. why and blocked are only read for shells.
    function scan(buildings, s) {
        var rows = [];
        for (var i = 0; i < buildings.length; i++) {
            var b = buildings[i];
            var name = S.core.buildings.name(b);
            var kind = kindOf(name);
            if (kind === null) continue;
            var grid = S.core.buildings.grid(b);
            var shell = isShell(name);
            rows.push({
                grid:    grid,
                name:    name,
                kind:    kind,
                shell:   shell,
                entry:   shell ? null : entryOf(name),
                target:  targetOf(kind, s),
                why:     shell ? S.core.shells.ready(b, name) : null,
                blocked: shell ? S.core.ledger.blocked(key(grid)) : null
            });
        }
        return rows;
    }

    function isReady(ctx) {
        var s = readSettings();
        return !!(s.enabled && ctx.zone && ctx.zone.isHome);
    }

    // Settles ledger entries from earlier sends: a grid that now shows the
    // rebuild clears its entry, and one that proves no effect frees its grid.
    function settle() {
        var items = S.core.ledger.snapshot(OWNER);
        for (var i = 0; i < items.length; i++) {
            var entry = entryOf(items[i].name);
            var grid = gridOfKey(items[i].key);
            if (!entry || grid === null) continue;
            S.core.ledger.reread(items[i].key, defFor(entry, grid));
        }
    }

    function plan() {
        var s = readSettings();
        if (!s.enabled) return;
        if (!S.core.ledger.usable()) {
            S.kernel.debug('rebuild', 'send ledger unusable, no rebuilds');
            return;
        }

        settle();

        var list = S.core.buildings.listRead();
        if (!awaited('list', list, 'building list', { accept: R.PARTIAL })) return;

        var rows = scan(list.value, s);
        var found = [];
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!row.shell) continue;
            if (row.why !== null) {
                if (R.isReadRefusal(row.why)) {
                    S.kernel.debug('rebuild', 'grid ' + row.grid + ' skipped: ' + row.why);
                }
                continue;
            }
            if (row.blocked !== null) continue;
            found.push({ grid: row.grid, entry: row.target });
        }
        // A partial list still shows real shells, so those may be rebuilt;
        // finding none on it only means nothing to do on this pass.
        if (!found.length) return;
        found.sort(function (a, c) { return a.grid - c.grid; });

        var cap = S.core.construction.capacity();
        if (!awaited('capacity', cap, 'build queue')) return;
        if (!(S.core.construction.freeSlots(cap.value) > 0)) {
            S.kernel.debug('rebuild', 'build queue full, no rebuild');
            return;
        }

        if (!S.core.ledger.admit(OWNER)) return;

        var pick = found[0];
        S.kernel.queue.add('rebuild.place', [pick.grid, pick.entry.name], 0);
        S.kernel.log('rebuild', 'queued rebuild of ' + pick.entry.name + ' on grid ' + pick.grid);
    }

    function place(params) {
        var grid = params[0];
        var name = params[1];
        var entry = entryOf(name);
        if (!entry) {
            S.kernel.warn('rebuild', 'unknown rebuild target ' + name + ' for grid ' + grid);
            return;
        }
        var ok = S.core.ledger.attempt(defFor(entry, grid), {
            key:            key(grid),
            owner:          OWNER,
            name:           entry.name,
            resolveAfterMs: RESOLVE_AFTER_MS
        });
        if (ok !== true) {
            S.kernel.error('rebuild', 'rebuild of ' + entry.name + ' on grid ' + grid + ' not started');
        }
    }

    function boot() {
        if (!S.kernel.settings.read('rebuild')) {
            S.kernel.settings.write('rebuild', S.modules.rebuild.defaultSettings);
        }
        S.core.ledger.register(OWNER, {
            category: 'rebuild',
            breaker:  S.modules.rebuild.BREAKER
        });
        S.core.ledger.load();
        S.kernel.queue.action('rebuild.place', place);
    }

    // The breaker's wording, registered with the ledger at boot and quoted
    // by the view's paused banner, so both say the same.
    S.modules.rebuild.BREAKER = {
        label:      'rebuild breaker',
        missText:   'rebuilds in a row were not seen on their grid',
        pausedText: 'rebuilding is paused',
        resumeText: 'rebuilding resumes'
    };

    S.modules.rebuild.readSettings = readSettings;
    S.modules.rebuild.scan         = scan;
    S.modules.rebuild.kindOf       = kindOf;
    S.modules.rebuild.targetOf     = targetOf;
    S.modules.rebuild.entryOf      = entryOf;
    S.modules.rebuild.gridOfKey    = gridOfKey;
    S.modules.rebuild.key          = key;

    S.kernel.register({
        id:       'rebuild',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        // Hooks are wrapped in closures so they resolve S.modules.rebuild.*
        // at call time. ui.js loads AFTER module.js (alphabetical concat
        // order), so a direct reference here would be undefined and
        // validateUi would reject the spec. toggleIn draws the quick toggle
        // in the Production submenu instead of the main ~Steward~ list.
        ui: {
            tab:       'rebuild',
            dashboard: S.Dashboard.Economy,
            toggleIn:  'production',
            section: {
                id:      'rebuild',
                title:   'Rebuild Wells and Fields',
                heading: 'Rebuild wells and fields',
                icon:    '↻',
                side: function ($side, h) {
                    if (S.modules.rebuild.side) S.modules.rebuild.side($side, h);
                },
                render: function ($main, h) {
                    if (S.modules.rebuild.render) S.modules.rebuild.render($main, h);
                },
                summary: function (h) {
                    return S.modules.rebuild.summary ? S.modules.rebuild.summary(h) : '';
                },
                tiles: function (h) {
                    return S.modules.rebuild.tiles ? S.modules.rebuild.tiles(h) : [];
                }
            }
        }
    });

}(Steward));
