/*
 * Production queues by type: profiles, readers and the completion def.
 *
 * Every timed production type has one queue on the home zone, but the types
 * do not share one queue model. A profile, derived only from the type id and
 * the host enum name and never from a list of building names, says what a
 * queue accepts and how its entries read. The readers return null when the
 * host cannot be read, never an empty value.
 *
 * Host facts, kept here only:
 *   - queues are per type, not per building: an order goes to
 *     GetProductionQueue(type) and the VO's buildingGrid picks the building;
 *     the highest-level building of a name is the one that produces, which
 *     producer(name) returns
 *   - the host enum Enums::TIMED_PRODUCTION_TYPE names a type id
 *   - units: queue 0 (barracks) and 8 (elite barracks) take any number of
 *     stacked orders; queue 7 (tier-3 units) is not confirmed live
 *   - buffs: queues 1, 6 and 11 by buff group, stacked like units; one run
 *     yields GetProductionAmount() items
 *   - books (queue 2, the Bookbinder): the items are the skill point ids, one
 *     book per order with no stack setting, and the price is the level whose
 *     amountProduced the player's producedAmount of that book has reached;
 *     a finished head entry (VO producedItems 1) waits for message 141 with
 *     the type as data
 *   - the culture building has a cooldown (getRemainingCooldown on the queue's
 *     productionBuilding), not a queue, and cannot be ordered into
 *   - any other type with a productionQueue is a timed workshop whose items
 *     are global.timedProductions_vector[type]
 *   - a VO's amount is items per stack and stacks the stack count; the 1-25
 *     stack limit is only the client UI's ceiling, and the SiegeWorkshop and
 *     Bookbinder have no stack setting
 *   - an entry's GetAmount() is summed for in-progress counts without
 *     subtracting GetProducedItems(); time left is
 *     ((amount - produced) * productionTime - collectedTime) / timeBonus
 *   - no queue capacity is known for any type, and event and special
 *     buildings have no known rules, so they read as unconfirmed workshops
 *
 * Unconfirmed profiles (confirmed false) order with retries 0 and at most one
 * entry in the queue, so a wrong assumption costs one order, not a loop.
 *
 * queueOf, queueTypes, entries and itemsOf memoize inside a read pass
 * (S.kernel.hostRead.pass), so one render or planning pass reads each queue
 * and the building list once. Outside a pass they read live. The action defs
 * (orderIn, complete) never run inside a pass, so their verification reads
 * always see the host as it is now.
 *
 * Bundle slot: core, under core/production/ and, like every file there,
 * before production.js. Every S.core.production.* reference happens at call
 * time; the top level only adds properties to S.core.production.
 */

(function (S) {

    if (!S.core.production) S.core.production = {};

    var COMPLETE_TIMEOUT_MS = 15000;
    var MESSAGE_COMPLETE    = 141;
    var KEEP_UNBOUNDED      = 9999;
    var ENUM_TYPES          = 'Enums::TIMED_PRODUCTION_TYPE';
    var CULTURE_ENUM        = 'culturebuilding';

    function P() { return S.core.production; }

    // A host vector as a plain array, or null when it is not array-like.
    function toArray(vec) {
        if (!vec || typeof vec.length !== 'number') return null;
        var out = [];
        for (var i = 0; i < vec.length; i++) out.push(vec[i]);
        return out;
    }

    function hostGlobal() {
        try { return game.def('global') || null; }
        catch (e) { return null; }
    }

    function num(v) {
        return (typeof v === 'number' && !isNaN(v)) ? v : null;
    }

    // Enum names read once per type. A failed read is not kept, so a later
    // readable name wins.
    var typeNames = {};

    function typeName(type) {
        if (typeof type !== 'number') return null;
        if (typeNames.hasOwnProperty(type)) return typeNames[type];
        try {
            if (typeof swmmo === 'undefined' || !swmmo || typeof swmmo.getDefinitionByName !== 'function') return null;
            var en = swmmo.getDefinitionByName(ENUM_TYPES);
            if (!en || typeof en.toString !== 'function') return null;
            var name = en.toString(type);
            if (typeof name !== 'string' || !name) return null;
            typeNames[type] = name;
            return name;
        } catch (e) {
            return null;
        }
    }

    function readQueue(type) {
        try {
            var zone = S.core.zone.current();
            if (!zone || typeof zone.GetProductionQueue !== 'function') return null;
            return zone.GetProductionQueue(type) || null;
        } catch (e) {
            S.kernel.warn('production', 'GetProductionQueue threw:', e);
            return null;
        }
    }

    function queueOf(type) {
        if (typeof type !== 'number') return null;
        return S.kernel.hostRead.cached('production.queueOf|' + type, function () { return readQueue(type); });
    }

    function isBuffQueue(type) {
        var list = P().BUFF_QUEUES;
        for (var i = 0; i < list.length; i++) if (list[i] === type) return true;
        return false;
    }

    function hasCooldown(type) {
        try {
            var q = queueOf(type);
            return !!(q && q.productionBuilding && typeof q.productionBuilding.getRemainingCooldown === 'function');
        } catch (e) {
            return false;
        }
    }

    function makeProfile(type, kind, enumName, o) {
        return {
            type:          type,
            kind:          kind,
            enumName:      enumName,
            orderable:     o.orderable !== false,
            perOrderMax:   typeof o.perOrderMax === 'number' ? o.perOrderMax : null,
            maxEntries:    typeof o.maxEntries === 'number' ? o.maxEntries : null,
            needsComplete: !!o.needsComplete,
            confirmed:     !!o.confirmed,
            stackable:     !!o.stackable
        };
    }

    // What a production type accepts, or null for a non-number. Built fresh
    // on every call, so a culture building first seen without its enum name
    // is reclassified once the name reads.
    function profile(type) {
        if (typeof type !== 'number') return null;
        var p = P();
        var K = S.ProductionKind;
        var en = typeName(type);
        if (type === p.QUEUE_BARRACKS || type === p.QUEUE_ELITE) {
            return makeProfile(type, K.Units, en, { confirmed: true, stackable: true });
        }
        if (type === p.QUEUE_TIER3) return makeProfile(type, K.Units, en, { maxEntries: 1 });
        if (isBuffQueue(type)) return makeProfile(type, K.Buffs, en, { confirmed: true, stackable: true });
        if (type === p.QUEUE_BOOKS) {
            return makeProfile(type, K.Books, en, { perOrderMax: 1, maxEntries: 1, needsComplete: true });
        }
        var culture = en !== null ? String(en).toLowerCase() === CULTURE_ENUM : hasCooldown(type);
        if (culture) return makeProfile(type, K.Cooldown, en, { orderable: false, maxEntries: 0 });
        return makeProfile(type, K.Timed, en, { maxEntries: 1 });
    }

    // The largest standing amount a type can hold: runs per order times the
    // entries the queue takes, or KEEP_UNBOUNDED when either is unlimited.
    function keepMax(type) {
        var pr = profile(type);
        if (!pr) return null;
        if (typeof pr.perOrderMax === 'number' && typeof pr.maxEntries === 'number') {
            return pr.perOrderMax * pr.maxEntries;
        }
        return KEEP_UNBOUNDED;
    }

    // The queue type a building feeds: its queue's mProductionType, else the
    // building's own productionType.
    function buildingType(b) {
        var q = b.productionQueue;
        var t = q ? q.mProductionType : undefined;
        if (typeof t !== 'number') t = b.productionType;
        return typeof t === 'number' ? t : null;
    }

    // Every production type of the home zone with its buildings, highest
    // level first: [{ type, enumName, kind, buildings: [{ name, grid, level }] }],
    // sorted by type. [] off the home zone, null when the building list
    // cannot be read.
    function queueTypes() {
        return S.kernel.hostRead.cached('production.queueTypes', readQueueTypes);
    }

    function readQueueTypes() {
        if (S.core.zone.isHome() !== true) return [];
        var all;
        try { all = S.core.buildings.list(); }
        catch (e) {
            S.kernel.warn('production', 'buildings.list threw:', e);
            return null;
        }
        if (!all || typeof all.length !== 'number') return null;
        var bl = S.core.buildings;
        var byType = {};
        var types = [];
        for (var i = 0; i < all.length; i++) {
            var b = all[i];
            var t;
            try {
                if (!b || !b.productionQueue) continue;
                t = buildingType(b);
            } catch (e2) { continue; }
            if (t === null) continue;
            if (!byType.hasOwnProperty(t)) {
                byType[t] = [];
                types.push(t);
            }
            byType[t].push({ name: bl.name(b), grid: bl.grid(b), level: bl.level(b) });
        }
        types.sort(function (a, c) { return a - c; });
        var out = [];
        for (var j = 0; j < types.length; j++) {
            var list = byType[types[j]];
            list.sort(producerOrder);
            var pr = profile(types[j]);
            out.push({ type: types[j], enumName: pr.enumName, kind: pr.kind, buildings: list });
        }
        return out;
    }

    // Producer order over { level, grid }: level descending, then grid
    // ascending. The one comparator for "which building of a name produces".
    function producerOrder(x, y) {
        var lx = x.level || 0, ly = y.level || 0;
        if (lx !== ly) return ly - lx;
        return (x.grid || 0) - (y.grid || 0);
    }

    // The one building of a name that produces: the host queue is per type
    // and runs at one building, and autoTSO orders into and buffs the
    // highest-level one. Returns the host building, or null.
    function producer(name) {
        var list;
        try { list = S.core.buildings.byName(name); }
        catch (e) {
            S.kernel.warn('production', 'byName threw for', name, ':', e);
            return null;
        }
        var bl = S.core.buildings;
        var best = null, bestKey = null;
        for (var i = 0; i < (list ? list.length : 0); i++) {
            var b = list[i];
            var g = b ? bl.grid(b) : null;
            if (typeof g !== 'number') continue;
            var key = { level: bl.level(b), grid: g };
            if (!best || producerOrder(key, bestKey) < 0) {
                best = b;
                bestKey = key;
            }
        }
        return best;
    }

    function call(o, method) {
        return S.kernel.hostRead.call(o, method);
    }

    // The VO's producedItems of an entry, or null when the host has none.
    function voProduced(e) {
        try {
            var order = call(e, 'GetProductionOrder');
            var vo = call(order, 'GetProductionVO');
            return vo ? num(vo.producedItems) : null;
        } catch (err) {
            return null;
        }
    }

    function timeBonus(e) {
        try { return num(call(call(e, 'GetProductionOrder'), 'GetTimeBonus')); }
        catch (err) { return null; }
    }

    // One entry as plain values, or null when its item or amount cannot be
    // read. Time fields the host does not offer read as null, and so does a
    // time left that depends on them.
    function entryOf(e, books) {
        if (!e) return null;
        var item = P().entryType(e);
        var a = call(e, 'GetAmount');
        var amount = num(a === undefined ? e.amount : a);
        if (typeof item !== 'string' || amount === null) return null;
        var produced = num(call(e, 'GetProducedItems'));
        var timeMs = num(call(e, 'GetProductionTime'));
        var collectedMs = num(call(e, 'GetCollectedTime'));
        var bonus = timeBonus(e);
        var producedItems = voProduced(e);
        var remaining = null;
        if (produced !== null && timeMs !== null && collectedMs !== null && bonus !== null && bonus > 0) {
            remaining = Math.max(0, ((amount - produced) * timeMs - collectedMs) / bonus);
        }
        return {
            item:          item,
            amount:        amount,
            produced:      produced,
            timeMs:        timeMs,
            collectedMs:   collectedMs,
            bonus:         bonus,
            remainingMs:   remaining,
            finished:      books ? producedItems === 1 : (produced !== null && produced >= amount),
            producedItems: producedItems
        };
    }

    // One read of a type's entries: { list } on success, { missing: true }
    // when the type has no queue, { failed, threw } when the vector or an
    // entry cannot be read or the read throws.
    function readEntriesOnce(type) {
        try {
            var q = queueOf(type);
            if (!q) return { missing: true };
            var vec = toArray(q.mTimedProductions_vector);
            if (vec === null) return { failed: 'vector unreadable', threw: false };
            var pr = profile(type);
            var books = !!pr && pr.kind === S.ProductionKind.Books;
            var out = [];
            for (var i = 0; i < vec.length; i++) {
                var rec = entryOf(vec[i], books);
                if (rec === null) return { failed: 'entry ' + i + ' unreadable', threw: false };
                out.push(rec);
            }
            return { list: out };
        } catch (e) {
            return { failed: e, threw: true };
        }
    }

    // Types whose unreadable entry was already logged this session.
    var unreadableSaid = {};

    // A failed read is tried once more: the bridge can drop a member for one
    // read and serve it on the next, and a whole queue shown as unreadable
    // over one such read would hide every entry in it.
    function readEntries(type) {
        var first = readEntriesOnce(type);
        if (first.list) return first.list;
        if (first.missing) return null;
        var second = readEntriesOnce(type);
        if (second.list) {
            S.kernel.log('production', 'entries(' + type + ') recovered on retry:', first.failed);
            return second.list;
        }
        if (second.missing) return null;
        if (second.threw) {
            S.kernel.warn('production', 'entries(' + type + ') threw:', second.failed);
        } else if (!unreadableSaid[type]) {
            unreadableSaid[type] = true;
            S.kernel.debug('production', 'entries(' + type + ') has an unreadable entry');
        }
        return null;
    }

    // The entries of a type's queue in queue order, or null when the queue,
    // its vector or any entry cannot be read.
    function entries(type) {
        return S.kernel.hostRead.cached('production.entries|' + type, function () { return readEntries(type); });
    }

    // Time left on the whole queue, or null when any part is unreadable.
    function remainingMs(type) {
        var list = entries(type);
        if (list === null) return null;
        var sum = 0;
        for (var i = 0; i < list.length; i++) {
            if (list[i].remainingMs === null) return null;
            sum += list[i].remainingMs;
        }
        return sum;
    }

    function cooldownMs(type) {
        try {
            var q = queueOf(type);
            var pb = q && q.productionBuilding;
            if (!pb) return null;
            return num(call(pb, 'getRemainingCooldown'));
        } catch (e) {
            return null;
        }
    }

    function label(name) {
        try {
            var t = S.core.locale.res(name);
            return (typeof t === 'string' && t) ? t : name;
        } catch (e) {
            return name;
        }
    }

    // Unit names that no unit base resolves, logged once each.
    var unitSkipLogged = {};

    // Keeps a unit name only when the unit base resolves it: the order VO
    // carries that name, and the base matches the type the host accepts.
    function pushUnit(out, name) {
        if (typeof name !== 'string' || !name) return;
        if (!S.core.army.unitBase(name)) {
            if (!unitSkipLogged[name]) {
                unitSkipLogged[name] = true;
                S.kernel.debug('production', 'unit item ' + name + ' does not resolve — skipped');
            }
            return;
        }
        out.push({ name: name, label: label(name) });
    }

    function unitItems(type) {
        var out = [];
        var p = P();
        var vec;
        if (type === p.QUEUE_TIER3) {
            vec = toArray(game.def('MilitarySystem::cMilitaryUnitData').GetAllUnitDataByTier(true, 3));
            if (vec === null) return null;
            for (var i = 0; i < vec.length; i++) pushUnit(out, vec[i].GetProductionName_string());
            return out;
        }
        var elite = type === p.QUEUE_ELITE;
        vec = toArray(game.def('MilitarySystem::cMilitaryUnitDescription').GetAllUnitDescriptions(true));
        if (vec === null) return null;
        for (var j = 0; j < vec.length; j++) {
            if (!!vec[j].GetIsElite() !== elite) continue;
            pushUnit(out, vec[j].GetProductionName_string());
        }
        return out;
    }

    // The buffs a buff queue makes, straight from the buff table: a buff is
    // made in the queue of its group, so no per-definition host call is
    // needed here.
    function buffItems(type) {
        var t = P().buffTable();
        if (t === null) return null;
        var out = [];
        for (var i = 0; i < t.list.length; i++) {
            var rec = t.list[i];
            if (rec.queue === type) out.push({ name: rec.name, label: label(rec.name) });
        }
        return out;
    }

    function bookDefs() {
        var g = hostGlobal();
        return g ? toArray(g.skillPoints_vector) : null;
    }

    function timedDefs(type) {
        var g = hostGlobal();
        if (!g || !g.timedProductions_vector) return null;
        return toArray(g.timedProductions_vector[type]);
    }

    function namedItems(vec, key) {
        if (vec === null) return null;
        var out = [];
        for (var i = 0; i < vec.length; i++) {
            var name = vec[i] ? vec[i][key] : null;
            if (typeof name === 'string' && name) out.push({ name: name, label: label(name) });
        }
        return out;
    }

    // The items a type's queue can make, [{ name, label }], or null when the
    // list cannot be read. A cooldown building makes nothing to order.
    function itemsOf(type) {
        return S.kernel.hostRead.cached('production.itemsOf|' + type, function () { return readItems(type); });
    }

    function readItems(type) {
        var pr = profile(type);
        if (!pr) return null;
        var K = S.ProductionKind;
        try {
            if (pr.kind === K.Units) return unitItems(type);
            if (pr.kind === K.Buffs) return buffItems(type);
            if (pr.kind === K.Books) return namedItems(bookDefs(), 'id_string');
            if (pr.kind === K.Cooldown) return [];
            return namedItems(timedDefs(type), 'name_string');
        } catch (e) {
            S.kernel.warn('production', 'itemsOf(' + type + ') threw:', e);
            return null;
        }
    }

    // The price of the next book: the highest level whose amountProduced the
    // player's producedAmount has reached. level is the index into
    // levels_vector. null when unreadable or when no level is reached.
    function bookInfo(item) {
        try {
            var defs = bookDefs();
            if (defs === null) return null;
            var book = null;
            for (var i = 0; i < defs.length; i++) {
                if (defs[i] && defs[i].id_string === item) { book = defs[i]; break; }
            }
            if (!book) return null;
            var levels = toArray(book.levels_vector);
            var produced = num(game.getResources().GetPlayerResource(item).producedAmount);
            if (levels === null || produced === null) return null;
            var at = -1;
            for (var k = 0; k < levels.length; k++) {
                if (levels[k] && num(levels[k].amountProduced) !== null && levels[k].amountProduced <= produced) at = k;
            }
            if (at < 0) return null;
            var costsVec = levels[at].costs;
            // A level holds its cost vector as a field; costLines reads it
            // through the same accessor every other cost holder offers.
            var lines = P().costLines({ GetCosts_vector: function () { return costsVec; } });
            return { level: at, produced: produced, costs: lines };
        } catch (e) {
            S.kernel.warn('production', 'bookInfo(' + item + ') threw:', e);
            return null;
        }
    }

    function timedInfo(type, item) {
        var vec = timedDefs(type);
        if (vec === null) return null;
        for (var i = 0; i < vec.length; i++) {
            if (!vec[i] || vec[i].name_string !== item) continue;
            var y = num(vec[i].GetProductionAmount());
            return { costs: P().costLines(vec[i]), yield: (y !== null && y >= 1) ? y : null };
        }
        return null;
    }

    // { costs, yield } of one item in a type's queue (costs per run), or
    // null when the item is unknown there or unreadable.
    function itemInfo(type, item) {
        var pr = profile(type);
        if (!pr || typeof item !== 'string' || !item) return null;
        var K = S.ProductionKind;
        try {
            if (pr.kind === K.Units) return { costs: P().costs(item), yield: 1 };
            if (pr.kind === K.Buffs) return { costs: P().costs(item), yield: P().yieldOf(item) };
            if (pr.kind === K.Books) {
                var b = bookInfo(item);
                return b ? { costs: b.costs, yield: 1 } : null;
            }
            if (pr.kind === K.Timed) return timedInfo(type, item);
            return null;
        } catch (e) {
            S.kernel.warn('production', 'itemInfo(' + type + ', ' + item + ') threw:', e);
            return null;
        }
    }

    function yieldIn(type, item) {
        var info = itemInfo(type, item);
        return (info && typeof info.yield === 'number') ? info.yield : null;
    }

    // Items of this kind in stock: star buffs for a buff, the resource
    // amount for anything else, null for units (not shown).
    function stockOf(type, item) {
        var pr = profile(type);
        if (!pr) return null;
        var K = S.ProductionKind;
        if (pr.kind === K.Units) return null;
        if (pr.kind === K.Buffs) return S.core.buffs.stock(item, '');
        return S.core.resources.amount(item);
    }

    // Queue capacity is not known for any type: neither the host nor the
    // reference scripts expose a limit. Always null until one is found.
    function capacity() {
        return null;
    }

    // Finish the head entry of a queue that waits for completion (message
    // 141 with the type). Verified once the queue holds fewer entries than
    // before or the item's stock grew. Never retried: what 141 does to a
    // queue is not confirmed live.
    function complete(type) {
        function head() {
            var list = entries(type);
            return (list && list.length) ? list[0] : null;
        }

        return {
            label:     'complete queue ' + type,
            category:  'production',
            timeoutMs: COMPLETE_TIMEOUT_MS,
            retries:   0,

            precheck: function () {
                if (!S.core.zone.isHome()) return 'not on the home zone';
                var pr = profile(type);
                if (!pr || !pr.needsComplete) return 'not completable';
                var list = entries(type);
                if (list === null) return 'production queue unreadable';
                if (list.length === 0) return 'queue empty';
                if (!list[0].finished) return 'head entry not finished';
                return null;
            },

            baseline: function () {
                var list = entries(type);
                var h = head();
                return {
                    count: list ? list.length : null,
                    stock: h ? S.core.resources.amount(h.item) : null,
                    item:  h ? h.item : null
                };
            },

            send: function () {
                return S.core.packets.sendMessage(MESSAGE_COMPLETE, type);
            },

            check: function (base) {
                if (!base) return false;
                var list = entries(type);
                if (list !== null && typeof base.count === 'number' && list.length < base.count) return true;
                if (typeof base.stock !== 'number' || !base.item) return false;
                var now = S.core.resources.amount(base.item);
                return typeof now === 'number' && now > base.stock;
            },

            describe: function (base) {
                var list = entries(type);
                var now = base && base.item ? S.core.resources.amount(base.item) : null;
                return 'entries ' + (base ? base.count : null) + ' -> ' + (list ? list.length : null) +
                    ', stock ' + (base ? base.stock : null) + ' -> ' + now;
            }
        };
    }

    var P0 = S.core.production;
    P0.profile     = profile;
    P0.keepMax     = keepMax;
    P0.typeName    = typeName;
    P0.queueOf     = queueOf;
    P0.queueTypes  = queueTypes;
    P0.producer    = producer;
    P0.entries     = entries;
    P0.remainingMs = remainingMs;
    P0.cooldownMs  = cooldownMs;
    P0.itemsOf     = itemsOf;
    P0.itemInfo    = itemInfo;
    P0.yieldIn     = yieldIn;
    P0.bookInfo    = bookInfo;
    P0.stockOf     = stockOf;
    P0.capacity    = capacity;
    P0.complete    = complete;

}(Steward));
