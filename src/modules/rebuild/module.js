/*
 * Rebuild module.
 *
 * Finds exhausted wells and fields on the home island (the depleted shells
 * named in settings.js) and rebuilds each with the configured well or field
 * type. No UI; it is switched on through settings.json ('steward.rebuild').
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
        var stored = S.kernel.settings.read('rebuild') || {};
        var defaults = S.modules.rebuild.defaultSettings;
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        return merged;
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

    // The building to place on a depleted shell of the given name, or null
    // when the name is not an exhausted well or field.
    function target(depletedName, s) {
        var m = S.modules.rebuild;
        if (depletedName === m.depletedWell)  return find(m.wells,  s.wellType)  || m.wells[0];
        if (depletedName === m.depletedField) return find(m.fields, s.fieldType) || m.fields[0];
        return null;
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
        return isFinite(g) ? g : null;
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

        var found = [];
        for (var i = 0; i < list.value.length; i++) {
            var b = list.value[i];
            var name = S.core.buildings.name(b);
            var entry = target(name, s);
            if (!entry) continue;
            var grid = S.core.buildings.grid(b);
            var why = S.core.shells.ready(b, name);
            if (why !== null) {
                if (R.isReadRefusal(why)) {
                    S.kernel.debug('rebuild', 'grid ' + grid + ' skipped: ' + why);
                }
                continue;
            }
            if (S.core.ledger.blocked(key(grid)) !== null) continue;
            found.push({ grid: grid, entry: entry });
        }
        // A partial list still shows real shells, so those may be rebuilt;
        // finding none on it only means nothing to do on this pass.
        if (!found.length) return;
        found.sort(function (a, c) { return a.grid - c.grid; });

        var cap = S.core.construction.capacity();
        if (!awaited('capacity', cap, 'build queue')) return;
        if (!(cap.value.slotsTotal - cap.value.slotsUsed > 0)) {
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
            breaker: {
                label:      'rebuild breaker',
                missText:   'rebuilds in a row were not seen on their grid',
                pausedText: 'rebuilding is paused',
                resumeText: 'rebuilding resumes'
            }
        });
        S.core.ledger.load();
        S.kernel.queue.action('rebuild.place', place);
    }

    S.kernel.register({
        id:       'rebuild',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan
    });

}(Steward));
