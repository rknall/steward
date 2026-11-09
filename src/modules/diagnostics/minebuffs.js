/*
 * Mine buff probe.
 *
 * Read-only dump of everything the mining buff feature decides on: for each
 * mine and mason of the viewed zone its production state, why a buff may or
 * may not be applied and the buff already running; the buff inventory with
 * each entry's buff type and targets; the buffs offered per building; the
 * stored per-deposit buff settings and the circuit breaker. Written as JSON
 * under steward/dumps/ as minebuffs-<zone>-<epoch ms>.json.
 *
 * Nothing time-based is stored except each building's remainingMs, so a dump
 * taken before and after a hand-applied buff diffs directly.
 *
 * Never enqueues queue work. Never sends a packet or applies a buff.
 *
 * Loads after inspect.js; every helper is read at call time.
 */

(function (S) {

    if (!S.modules.diagnostics) S.modules.diagnostics = {};

    // Longest log line when the dump cannot be written to a file.
    var CHUNK_LEN = 1500;

    function notify(text) {
        try { if (typeof showGameAlert === 'function') showGameAlert('Steward: ' + text); }
        catch (e) { /* best effort */ }
    }

    // One failed read becomes a value in the document, never an abort.
    function guard(fn) {
        try { return fn(); }
        catch (e) { return { error: String(e) }; }
    }

    // Reads through the mining module's own settings reader so the dump shows
    // what the buff feature decides on, not a second merge of the same store.
    function settingsRecord(types) {
        var deps = guard(function () { return S.modules.mining.readSettings().deposits; });
        var out = {};
        for (var i = 0; i < types.length; i++) {
            var name = types[i].name;
            out[name] = (deps && deps.error !== undefined && !deps[name])
                ? deps
                : guard(function () { return deps[name].buff; });
        }
        return out;
    }

    function inventoryRecord() {
        var b = S.core.buffs;
        var inv = b.inventory();
        var out = [];
        for (var i = 0; i < inv.length; i++) {
            var type = inv[i].type;
            out.push({
                type:     type,
                resource: inv[i].resource,
                amount:   inv[i].amount,
                buffType: guard(function () { return b.buffTypeOf(type); }),
                targets:  guard(function () { return b.targetsOf(type); })
            });
        }
        out.sort(function (x, y) { return x.type < y.type ? -1 : (x.type > y.type ? 1 : 0); });
        return out;
    }

    function buildingRecord(x) {
        var bl = S.core.buildings;
        return {
            grid:           bl.grid(x),
            level:          bl.level(x),
            state:          guard(function () { return bl.buffState(x); }),
            block:          guard(function () { return bl.buffBlock(x); }),
            productionBuff: guard(function () { return bl.productionBuffInfo(x); })
        };
    }

    function gridOrder(a, b) {
        var ag = (typeof a.grid === 'number');
        var bg = (typeof b.grid === 'number');
        if (ag && bg) return a.grid - b.grid;
        if (ag) return -1;
        if (bg) return 1;
        return 0;
    }

    function buildingsRecord(name) {
        var all = S.core.buildings.byName(name);
        var out = [];
        for (var i = 0; i < all.length; i++) {
            var x = all[i];
            out.push(guard(function () { return buildingRecord(x); }));
        }
        out.sort(gridOrder);
        return out;
    }

    function typeRecord(info) {
        var building = info.mineName || info.masonName;
        return {
            deposit:    info.name,
            building:   building,
            candidates: guard(function () { return S.core.buffs.buildingBuffCandidates(building, true); }),
            buildings:  guard(function () { return buildingsRecord(building); })
        };
    }

    // The whole document. The building snapshot is dropped first because the
    // scheduler may be paused and the per-tick snapshot would be stale.
    function record() {
        var types = guard(function () {
            var all = S.core.deposits.types();
            var out = [];
            for (var i = 0; i < all.length; i++) {
                if (all[i].mineName || all[i].masonName) out.push(all[i]);
            }
            return out;
        });
        var failed = !!(types && types.error);
        var list = failed ? [] : types;
        try { S.core.buildings.invalidate(); } catch (e) { /* the reads below report it */ }
        var mining = S.modules.mining;
        var tr = [];
        for (var i = 0; i < list.length; i++) {
            var info = list[i];
            tr.push(guard(function () { return typeRecord(info); }));
        }
        return {
            zoneId:    guard(function () { return S.core.zone.id(); }),
            home:      guard(function () { return S.core.zone.isHome(); }),
            settings:  settingsRecord(list),
            breaker:   guard(function () {
                return (mining && mining.buffBreaker) ? mining.buffBreaker.snapshot() : null;
            }),
            inventory: guard(inventoryRecord),
            types:     failed ? types : tr
        };
    }

    // Logs the document in pieces, one header per type, for a dump that has
    // no file to go to.
    function logChunks(cat, doc) {
        var parts = [['head', { zoneId: doc.zoneId, home: doc.home, settings: doc.settings,
                                breaker: doc.breaker, inventory: doc.inventory }]];
        var types = (doc.types && typeof doc.types.length === 'number') ? doc.types : [doc.types];
        for (var i = 0; i < types.length; i++) {
            parts.push([(types[i] && types[i].deposit) || ('type ' + i), types[i]]);
        }
        for (var p = 0; p < parts.length; p++) {
            var text;
            try { text = JSON.stringify(parts[p][1]); }
            catch (e) { text = '[unprintable]'; }
            var n = Math.max(1, Math.ceil(text.length / CHUNK_LEN));
            for (var c = 0; c < n; c++) {
                S.kernel.log(cat, parts[p][0] + ' ' + (c + 1) + '/' + n + ': ' +
                                  text.substr(c * CHUNK_LEN, CHUNK_LEN));
            }
        }
    }

    function dump() {
        var cat = 'diag:minebuffs';
        S.kernel.log(cat, '--- mine buffs ---');
        var doc = record();
        var text = null;
        try { text = JSON.stringify(doc, null, 2); }
        catch (e) { text = null; }

        var army = S.modules.diagnostics.army;
        var w = (text !== null)
            ? army.writeDump(army.dumpFileName('minebuffs', doc.zoneId), text) : null;
        if (w && w.ok) {
            S.kernel.log(cat, 'mine buffs written to ' + w.path);
            notify('Mine buffs dumped to ' + w.path + '.');
        } else {
            S.kernel.warn(cat, w && w.path ? 'write failed: ' + w.message
                                           : 'no writable dumps folder, logging the document');
            logChunks(cat, doc);
            notify('Mine buffs dumped to log (category ' + cat + ').');
        }
        S.kernel.log(cat, '--- end mine buffs ---');
    }

    S.modules.diagnostics.mineBuffs = { dump: dump, record: record };

}(Steward));
