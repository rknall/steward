/*
 * Storehouse probe.
 *
 * Read-only dump of what a storehouse view would decide on: every resource
 * definition of the economy (group, category, tradable, event, the tab the
 * trader userscript would show it under), the held resources with the fields
 * the vector item carries beside the definition, the star-menu resource
 * entries, the warehouse capacity and every cap-like getter of the resources
 * object, and the bitmap sizes the icon getters return. Written as JSON under
 * steward/dumps/ as storehouse-<zone>-<epoch ms>.json.
 *
 * Reads the host objects directly (definition vector, raw held vector, asset
 * getters) because the core readers keep only name and amount and the point
 * of the probe is to see the fields they drop.
 *
 * Never enqueues queue work. Never sends a packet.
 *
 * Loads after army.js and inspect.js; every helper is read at call time.
 */

/* global ResourceGroupToWarehouseTab */

(function (S) {

    if (!S.modules.diagnostics) S.modules.diagnostics = {};

    // Longest log line when the dump cannot be written to a file.
    var CHUNK_LEN = 1500;

    // The two resources with caps of their own, so the dump shows whether the
    // host exposes those caps.
    var CAP_PROBES = ['StarfallStarDust', 'StarfallStarShards'];

    function notify(text) {
        try { if (typeof showGameAlert === 'function') showGameAlert('Steward: ' + text); }
        catch (e) { /* best effort */ }
    }

    // One failed read becomes a value in the document, never an abort.
    function guard(fn) {
        try { return fn(); }
        catch (e) { return { error: String(e) }; }
    }

    // A missing field stays null and is never turned into '', so the dump tells
    // absent from empty.
    function str(v) {
        return typeof v === 'string' ? v : null;
    }

    function byText(a, b) {
        return a < b ? -1 : (a > b ? 1 : 0);
    }

    // Comparison label only: the tab the trader userscript (upstream
    // getResourceList) files a resource under. The dump shows where it would
    // put each item; steward does not use it to decide anything.
    function traderTab(group, category) {
        var t = group || category || 'WarehouseTab7';
        var m = /^CL(\d+)$/.exec(t);
        if (m) t = 'WarehouseTab' + m[1];
        else if (t === 'Event') t = 'WarehouseTab6';
        else if (t === 'Collectibles') t = 'WarehouseTab7';
        if (t === 'WarehouseTab5') t = 'WarehouseTab8';
        return t;
    }

    // Width and height of a returned bitmap, never its pixels.
    function sizeOf(x) {
        if (!x) return null;
        var bd = x.bitmapData || x;
        if (typeof bd.width === 'number' && typeof bd.height === 'number') {
            return { kind: x.bitmapData ? 'bitmap' : 'bitmapData', w: bd.width, h: bd.height };
        }
        return { kind: typeof x };
    }

    function icon(name) {
        if (typeof assets === 'undefined' || !assets) return null;
        return {
            resourceIcon: typeof assets.GetResourceIcon === 'function'
                ? guard(function () { return sizeOf(assets.GetResourceIcon(name)); }) : null,
            bitmapData: typeof assets.GetBitmapData === 'function'
                ? guard(function () { return sizeOf(assets.GetBitmapData(name)); }) : null
        };
    }

    function defRecord(d, active) {
        var group = str(d.group_string);
        var category = str(d.category_string);
        var rec = {
            name:     str(d.resourceName_string) || str(d.name_string),
            group:    group,
            category: category,
            tradable: typeof d.tradable === 'boolean' ? d.tradable : null,
            event:    str(d.requiredEventName_string)
        };
        if (rec.event) {
            rec.eventActive = active.indexOf(rec.event) >= 0;
            // The trader's call, unconfirmed on this client: null when absent.
            rec.eventStarted = guard(function () {
                var em = game.gi.mEventManager;
                return (em && typeof em.isEventStarted === 'function')
                    ? em.isEventStarted(rec.event) : null;
            });
        }
        rec.tabKey = traderTab(group || '', category || '');
        return rec;
    }

    function definitionsRead() {
        var econ = game.def('ServerState::gEconomics');
        var vec = econ && econ.mResourceDefaultDefinition_vector;
        if (!vec || typeof vec.length !== 'number') return { error: 'no definition vector' };
        var active = S.core.events.liveEventNames();
        var list = [];
        var byName = {};
        for (var i = 0; i < vec.length; i++) {
            var item = vec[i];
            if (!item) continue;
            var rec = defRecord(item, active);
            if (!rec.name) continue;
            list.push(rec);
            byName[rec.name] = { raw: item, rec: rec };
        }
        list.sort(function (a, b) { return byText(a.name, b.name); });
        return { list: list, byName: byName };
    }

    function capacityRecord(probeNames) {
        var res = game.getResources();
        var methods = [];
        for (var k in res) {
            if (typeof res[k] === 'function' && /cap|limit|max/i.test(k)) methods.push(k);
        }
        methods.sort();
        var getters = [];
        for (var m = 0; m < methods.length; m++) {
            if (/^Get/.test(methods[m])) getters.push(methods[m]);
        }
        var global = {};
        for (var g = 0; g < getters.length; g++) {
            global[getters[g]] = guard(function () { return res[getters[g]](); });
        }
        var perItem = {};
        for (var p = 0; p < probeNames.length; p++) {
            var row = {};
            for (var q = 0; q < getters.length; q++) {
                row[getters[q]] = guard(function () { return res[getters[q]](probeNames[p]); });
            }
            perItem[probeNames[p]] = row;
        }
        return {
            // No argument: the AIR bridge throws on an extra one.
            warehouse: guard(function () { return res.GetWareHouseCapacity(); }),
            methods:   methods,
            global:    global,
            perItem:   perItem,
            // Sealed AS3 classes may hide methods from for-in; describe walks
            // its own getter list.
            describe:  S.modules.diagnostics.inspect.describe(res, 'game.getResources()')
        };
    }

    function heldRead(defs, mayor) {
        var res = game.getResources();
        var vec = res.GetPlayerResources_vector('');
        if (!vec || typeof vec.length !== 'number') return { error: 'no held vector' };
        var rows = [];
        var first = null;
        for (var i = 0; i < vec.length; i++) {
            var item = vec[i];
            if (!item || typeof item.name_string !== 'string' || !item.name_string) continue;
            if (!first) first = item;
            var name = item.name_string;
            var d = (defs && defs.byName && defs.byName[name]) ? defs.byName[name].rec : null;
            var vGroup = str(item.group_string);
            var vCat = str(item.category_string);
            var amt = item.amount;
            rows.push({
                name:      name,
                label:     S.core.locale.res(name),
                amount:    (typeof amt === 'number' && !isNaN(amt)) ? amt : null,
                vector:    { group: vGroup, category: vCat },
                def:       d,
                tabKey:    traderTab((d && d.group) || vGroup || '', (d && d.category) || vCat || ''),
                mayorHouse: mayor ? mayor.indexOf(name) >= 0 : null,
                icon:      icon(name)
            });
        }
        rows.sort(function (a, b) { return byText(a.name, b.name); });
        return { rows: rows, first: first };
    }

    function starRead(defs, heldNames) {
        var inv = S.core.buffs.inventory();
        var type = S.core.buffs.ADD_RESOURCE_TYPE;
        var map = {};
        var order = [];
        for (var i = 0; i < inv.length; i++) {
            if (inv[i].type !== type) continue;
            var r = inv[i].resource;
            var e = map[r];
            if (!e) {
                e = { resource: r, amount: 0, entries: 0 };
                map[r] = e;
                order.push(r);
            }
            e.entries++;
            if (inv[i].bad) e.bad = true;
            if (typeof inv[i].amount === 'number' && e.amount !== null) e.amount += inv[i].amount;
            else e.amount = null;
        }
        order.sort();
        var out = [];
        for (var j = 0; j < order.length; j++) {
            var row = map[order[j]];
            var d = (defs && defs.byName && defs.byName[row.resource]) ? defs.byName[row.resource].rec : null;
            row.held = heldNames.indexOf(row.resource) >= 0;
            row.def = d;
            row.tabKey = traderTab((d && d.group) || '', (d && d.category) || '');
            row.icon = icon(row.resource);
            out.push(row);
        }
        return out;
    }

    function bump(map, key) {
        var k = key === null ? '(missing)' : key;
        map[k] = (map[k] || 0) + 1;
    }

    function summary(defs, held) {
        var byGroup = { definitions: {}, held: {} };
        var byTabKey = {};
        var empty = [];
        var i;
        for (i = 0; i < defs.list.length; i++) {
            var d = defs.list[i];
            bump(byGroup.definitions, d.group);
            if (!d.group && d.category) empty.push(d.name);
        }
        var notMayor = [];
        var mayorOnly = [];
        var differs = [];
        for (i = 0; i < held.rows.length; i++) {
            var h = held.rows[i];
            bump(byGroup.held, h.def ? h.def.group : null);
            bump(byTabKey, h.tabKey);
            if (h.tabKey === 'WarehouseTab7' && h.mayorHouse === false) notMayor.push(h.name);
            if (h.mayorHouse === true && h.tabKey !== 'WarehouseTab7') mayorOnly.push(h.name);
            if (h.vector.group !== null && h.def && h.vector.group !== h.def.group) differs.push(h.name);
        }
        return {
            byGroup:                byGroup,
            byTabKey:               byTabKey,
            groupEmptyCategorySet:  empty,
            collectiblesNotMayor:   notMayor,
            mayorNotCollectibles:   mayorOnly,
            vectorGroupDiffers:     differs
        };
    }

    function hostTabMap() {
        if (typeof ResourceGroupToWarehouseTab === 'undefined' || !ResourceGroupToWarehouseTab) return null;
        var out = {};
        for (var k in ResourceGroupToWarehouseTab) out[k] = ResourceGroupToWarehouseTab[k];
        return out;
    }

    // The whole document. A part that fails becomes { error } and the rest
    // still dumps.
    function record() {
        var defs = guard(definitionsRead);
        var defsOk = defs && !defs.error;
        var mayor = guard(function () {
            var u = S.core.resources.uncategorized();
            if (!u) return null;
            var names = [];
            for (var i = 0; i < u.length; i++) names.push(u[i].name);
            return names;
        });
        if (mayor && mayor.error) mayor = null;
        var held = guard(function () { return heldRead(defsOk ? defs : null, mayor); });
        var heldOk = held && !held.error;
        var heldNames = [];
        var probes = CAP_PROBES.slice();
        if (heldOk) {
            var cl1 = null;
            for (var i = 0; i < held.rows.length; i++) {
                heldNames.push(held.rows[i].name);
                if (cl1 === null && held.rows[i].def && held.rows[i].def.group === 'CL1') {
                    cl1 = held.rows[i].name;
                }
            }
            var pick = cl1 || (held.rows.length ? held.rows[0].name : null);
            if (pick && probes.indexOf(pick) < 0) probes.push(pick);
        }
        var keys = {};
        if (defsOk) {
            for (var p = 0; p < probes.length; p++) {
                var entry = defs.byName[probes[p]];
                if (entry) {
                    keys[probes[p]] = S.modules.diagnostics.inspect.describe(entry.raw, probes[p]);
                }
            }
        }
        return {
            zoneId:         guard(function () { return S.core.zone.id(); }),
            home:           guard(function () { return S.core.zone.isHome(); }),
            activeEvents:   guard(function () { return S.core.events.liveEventNames(); }),
            capacity:       guard(function () { return capacityRecord(probes); }),
            hostTabMap:     guard(hostTabMap),
            definitionKeys: keys,
            heldItemKeys:   (heldOk && held.first)
                ? guard(function () {
                    return S.modules.diagnostics.inspect.describe(held.first, 'held item');
                }) : null,
            definitions:    defsOk ? defs.list : defs,
            held:           heldOk ? held.rows : held,
            star:           guard(function () { return starRead(defsOk ? defs : null, heldNames); }),
            summary:        (defsOk && heldOk) ? guard(function () { return summary(defs, held); })
                                               : { error: 'definitions or held unreadable' }
        };
    }

    // Logs the document in pieces for a dump that has no file to go to.
    function logChunks(cat, doc) {
        var parts = [
            ['head', { zoneId: doc.zoneId, home: doc.home, activeEvents: doc.activeEvents,
                       capacity: doc.capacity, hostTabMap: doc.hostTabMap,
                       definitionKeys: doc.definitionKeys, heldItemKeys: doc.heldItemKeys,
                       summary: doc.summary }],
            ['definitions', doc.definitions],
            ['held', doc.held],
            ['star', doc.star]
        ];
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
        var cat = 'diag:storehouse';
        S.kernel.log(cat, '--- storehouse ---');
        var doc = record();
        var text = null;
        try { text = JSON.stringify(doc, null, 2); }
        catch (e) { text = null; }

        var army = S.modules.diagnostics.army;
        var w = (text !== null)
            ? army.writeDump(army.dumpFileName('storehouse', doc.zoneId), text) : null;
        if (w && w.ok) {
            S.kernel.log(cat, 'storehouse written to ' + w.path);
            notify('Storehouse dumped to ' + w.path + '.');
        } else {
            S.kernel.warn(cat, w && w.path ? 'write failed: ' + w.message
                                           : 'no writable dumps folder, logging the document');
            logChunks(cat, doc);
            notify('Storehouse dumped to log (category ' + cat + ').');
        }
        S.kernel.log(cat, '--- end storehouse ---');
    }

    S.modules.diagnostics.storehouse = { dump: dump, record: record };

}(Steward));
