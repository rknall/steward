/*
 * Production probe.
 *
 * Read-only dump of everything the production manager has to decide on and
 * cannot yet assume: for every production queue type of the viewed zone the
 * host enum name, the buildings that run it, every queue field and every
 * capacity-looking getter, each queue entry with its order VO and the items
 * the host offers for that type. Once per document: the unit catalogue by
 * tier and by elite flag, the book list, the produceable buffs and their
 * star stock. Written as JSON under steward/dumps/ as
 * production-<zone>-<epoch ms>.json.
 *
 * Reads the host directly and not the production core readers, so the dump
 * stays valid when those readers rest on a wrong assumption.
 *
 * Never enqueues queue work. Never sends a packet.
 *
 * Loads after inspect.js; every helper is read at call time.
 */

(function (S) {

    if (!S.modules.diagnostics) S.modules.diagnostics = {};

    // Longest log line when the dump cannot be written to a file.
    var CHUNK_LEN = 1500;

    // Queue keys whose zero-argument getter may reveal the queue capacity.
    var CAPACITY_KEY = /max|slot|size|capacity|limit/i;

    var TIERS = [1, 2, 3];

    function notify(text) {
        try { if (typeof showGameAlert === 'function') showGameAlert('Steward: ' + text); }
        catch (e) { /* best effort */ }
    }

    // One failed read becomes a value in the document, never an abort.
    function guard(fn) {
        try { return fn(); }
        catch (e) { return { error: String(e) }; }
    }

    // The host definition that holds the item vectors (timedProductions_vector,
    // skillPoints_vector).
    function hostGlobal() {
        var g = game.def('global');
        if (!g) throw new Error('no global definition');
        return g;
    }

    // A host vector as a plain array; an unreadable one throws into guard.
    function toArray(vec) {
        var out = [];
        if (!vec) return out;
        for (var i = 0; i < vec.length; i++) out.push(vec[i]);
        return out;
    }

    // Kernel single read: the member is read once, so a getter that the host
    // swaps between a value and a function is not seen twice in one dump line.
    function call(o, method) {
        return S.kernel.hostRead.call(o, method);
    }

    function enumName(type) {
        return guard(function () {
            return swmmo.getDefinitionByName('Enums::TIMED_PRODUCTION_TYPE').toString(type);
        });
    }

    function queueType(b) {
        var q = b.productionQueue;
        var t = q ? q.mProductionType : undefined;
        return (typeof t === 'number') ? t : b.productionType;
    }

    function buildingRecord(b) {
        var bl = S.core.buildings;
        return {
            name:            bl.name(b),
            grid:            bl.grid(b),
            level:           bl.level(b),
            active:          guard(function () { return b.IsProductionActive(); }),
            productionState: guard(function () { return b.GetResourceCreation().GetProductionState(); }),
            productionBuff:  !!b.productionBuff,
            cooldown:        guard(function () {
                var pb = b.productionQueue && b.productionQueue.productionBuilding;
                return (pb && typeof pb.getRemainingCooldown === 'function')
                    ? pb.getRemainingCooldown() : null;
            })
        };
    }

    // Every own enumerable key: a primitive keeps its value, anything else its
    // typeof. A capacity-looking getter is also called once with no argument.
    function queueFields(q) {
        var out = {};
        var calls = {};
        for (var k in q) {
            var v;
            try { v = q[k]; } catch (e) { out[k] = { error: String(e) }; continue; }
            var tv = typeof v;
            out[k] = (tv === 'string' || tv === 'number' || tv === 'boolean' || v === null) ? v : tv;
            if (tv === 'function' && CAPACITY_KEY.test(k)) {
                calls[k] = guard(function () { return q[k](); });
            }
        }
        return { fields: out, capacityCalls: calls };
    }

    function entryRecord(e) {
        return {
            type:        guard(function () { return call(e, 'GetType'); }),
            typeString:  guard(function () { return call(e, 'GetType_string'); }),
            amount:      guard(function () { return call(e, 'GetAmount'); }),
            produced:    guard(function () { return call(e, 'GetProducedItems'); }),
            timeMs:      guard(function () { return call(e, 'GetProductionTime'); }),
            collectedMs: guard(function () { return call(e, 'GetCollectedTime'); }),
            timeBonus:   guard(function () { return e.GetProductionOrder().GetTimeBonus(); }),
            vo:          guard(function () {
                var vo = e.GetProductionOrder().GetProductionVO();
                return {
                    type_string:    vo.type_string,
                    amount:         vo.amount,
                    stacks:         vo.stacks,
                    producedItems:  vo.producedItems,
                    productionType: vo.productionType,
                    buildingGrid:   vo.buildingGrid
                };
            })
        };
    }

    function costLines(item) {
        return guard(function () {
            var vec = toArray(item.GetCosts_vector());
            var out = [];
            for (var i = 0; i < vec.length; i++) {
                var line = vec[i];
                out.push({
                    name:   guard(function () { return line.GetName_string(); }),
                    amount: guard(function () { return line.GetAmount(); })
                });
            }
            return out;
        });
    }

    function timedItems(type) {
        return guard(function () {
            var vec = toArray(hostGlobal().timedProductions_vector[type]);
            var out = [];
            for (var i = 0; i < vec.length; i++) {
                var it = vec[i];
                out.push({
                    name:  guard(function () { return it.name_string; }),
                    costs: costLines(it),
                    yield: guard(function () { return it.GetProductionAmount(); })
                });
            }
            return out;
        });
    }

    function queueRecord(type) {
        var q = guard(function () { return S.core.zone.current().GetProductionQueue(type); });
        if (!q) return { error: 'no queue' };
        if (q.error) return q;
        var f = guard(function () { return queueFields(q); });
        return {
            fields:          f.fields,
            capacityCalls:   f.capacityCalls,
            error:           f.error,
            mProductionType: guard(function () { return q.mProductionType; }),
            buildingGrid:    guard(function () { return q.productionBuilding.GetGrid(); }),
            entries:         guard(function () {
                var vec = toArray(q.mTimedProductions_vector);
                var out = [];
                for (var i = 0; i < vec.length; i++) {
                    var e = vec[i];
                    out.push(guard(function () { return entryRecord(e); }));
                }
                return out;
            })
        };
    }

    function typeRecord(type, buildings) {
        var recs = [];
        for (var i = 0; i < buildings.length; i++) {
            var b = buildings[i];
            recs.push(guard(function () { return buildingRecord(b); }));
        }
        return {
            type:      type,
            enumName:  enumName(type),
            buildings: recs,
            queue:     queueRecord(type),
            items:     timedItems(type)
        };
    }

    function queueTypeRecords() {
        var all = S.core.buildings.list();
        var byType = {};
        var order = [];
        for (var i = 0; i < all.length; i++) {
            var b = all[i];
            if (!b || !b.productionQueue) continue;
            var t = guard(function () { return queueType(b); });
            if (typeof t !== 'number') continue;
            if (!byType[t]) { byType[t] = []; order.push(t); }
            byType[t].push(b);
        }
        order.sort(function (x, y) { return x - y; });
        var out = [];
        for (var j = 0; j < order.length; j++) {
            var type = order[j];
            out.push(guard(function () { return typeRecord(type, byType[type]); }));
        }
        return out;
    }

    function resolves(name) {
        return guard(function () { return !!S.core.army.unitBase(name); });
    }

    function unitsByTier() {
        var data = game.def('MilitarySystem::cMilitaryUnitData');
        var out = {};
        for (var i = 0; i < TIERS.length; i++) {
            var tier = TIERS[i];
            out[tier] = guard(function () {
                var vec = toArray(data.GetAllUnitDataByTier(true, tier));
                var names = [];
                for (var k = 0; k < vec.length; k++) {
                    var n = vec[k].GetProductionName_string();
                    names.push({ name: n, resolves: resolves(n) });
                }
                return names;
            });
        }
        return out;
    }

    function unitDescriptions() {
        var vec = toArray(game.def('MilitarySystem::cMilitaryUnitDescription').GetAllUnitDescriptions(true));
        var out = [];
        for (var i = 0; i < vec.length; i++) {
            var u = vec[i];
            out.push(guard(function () {
                var n = u.GetProductionName_string();
                return {
                    elite:    !!u.GetIsElite(),
                    prodName: n,
                    resolves: resolves(n)
                };
            }));
        }
        return out;
    }

    function skillPoints() {
        var vec = toArray(hostGlobal().skillPoints_vector);
        var out = [];
        for (var i = 0; i < vec.length; i++) {
            var sp = vec[i];
            out.push(guard(function () {
                var id = sp.id_string;
                var lv = toArray(sp.levels_vector);
                var levels = [];
                for (var k = 0; k < lv.length; k++) {
                    var l = lv[k];
                    levels.push({
                        amountProduced: guard(function () { return l.amountProduced; }),
                        costs:          costLines(l)
                    });
                }
                return {
                    id:       id,
                    levels:   levels,
                    produced: guard(function () {
                        return game.getResources().GetPlayerResource(id).producedAmount;
                    })
                };
            }));
        }
        return out;
    }

    function produceableBuffs() {
        var defs = game.def('BuffSystem::cBuff').GetProduceableBuffDefinitions(game.gi);
        var vec = toArray(defs);
        var out = [];
        for (var i = 0; i < vec.length; i++) {
            var d = vec[i];
            out.push(guard(function () {
                var name = d.GetName_string();
                return {
                    name:  name,
                    group: guard(function () { return d.GetGroup_string(); }),
                    yield: guard(function () { return d.GetProductionAmount(); }),
                    stock: guard(function () { return S.core.buffs.stock(name, ''); }),
                    costs: costLines(d)
                };
            }));
        }
        return out;
    }

    // The whole document. The building snapshot is dropped first because the
    // scheduler may be paused and the per-tick snapshot would be stale.
    function record() {
        try { S.core.buildings.invalidate(); } catch (e) { /* the reads below report it */ }
        return {
            zoneId:           guard(function () { return S.core.zone.id(); }),
            home:             guard(function () { return S.core.zone.isHome(); }),
            types:            guard(queueTypeRecords),
            unitsByTier:      guard(unitsByTier),
            unitDescriptions: guard(unitDescriptions),
            skillPoints:      guard(skillPoints),
            produceableBuffs: guard(produceableBuffs)
        };
    }

    // Logs the document in pieces, one header per section, for a dump that
    // has no file to go to.
    function logChunks(cat, doc) {
        var parts = [];
        var keys = ['zoneId', 'home', 'unitsByTier', 'unitDescriptions', 'skillPoints', 'produceableBuffs'];
        for (var k = 0; k < keys.length; k++) parts.push([keys[k], doc[keys[k]]]);
        var types = (doc.types && typeof doc.types.length === 'number') ? doc.types : [doc.types];
        for (var i = 0; i < types.length; i++) {
            var t = types[i];
            parts.push(['type ' + ((t && t.type !== undefined) ? t.type : i), t]);
        }
        for (var p = 0; p < parts.length; p++) {
            var text;
            try { text = JSON.stringify(parts[p][1]); }
            catch (e) { text = '[unprintable]'; }
            if (text === undefined) text = 'undefined';
            var n = Math.max(1, Math.ceil(text.length / CHUNK_LEN));
            for (var c = 0; c < n; c++) {
                S.kernel.log(cat, parts[p][0] + ' ' + (c + 1) + '/' + n + ': ' +
                                  text.substr(c * CHUNK_LEN, CHUNK_LEN));
            }
        }
    }

    function dump() {
        var cat = 'diag:production';
        S.kernel.log(cat, '--- production ---');
        var doc = record();
        var text = null;
        try { text = JSON.stringify(doc, null, 2); }
        catch (e) { text = null; }

        var army = S.modules.diagnostics.army;
        var w = (text !== null)
            ? army.writeDump(army.dumpFileName('production', doc.zoneId), text) : null;
        if (w && w.ok) {
            S.kernel.log(cat, 'production written to ' + w.path);
            notify('Production dumped to ' + w.path + '.');
        } else {
            S.kernel.warn(cat, w && w.path ? 'write failed: ' + w.message
                                           : 'no writable dumps folder, logging the document');
            logChunks(cat, doc);
            notify('Production dumped to log (category ' + cat + ').');
        }
        S.kernel.log(cat, '--- end production ---');
    }

    S.modules.diagnostics.production = { dump: dump, record: record };

}(Steward));
