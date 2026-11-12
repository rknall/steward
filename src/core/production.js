/*
 * Production orders for troops and produceable buffs.
 *
 * Reads the home production queues (barracks, elite barracks and the buff
 * buildings), prices an order against the player's stock and population, and
 * builds the action def that orders it. An "item" is a unit or a produceable
 * buff; a name is tried as a unit first, then as a buff. Run the def with
 * S.core.actions.attempt. Which item to order and when stays with the caller.
 *
 * Host facts, kept here only:
 *   - queue 0 is the barracks, queue 8 the elite barracks; the unit definition
 *     (GetIsElite) picks which one a unit is trained in
 *   - queue 2 is the Bookbinder: one book per order, no stack setting
 *   - queue 7 trains tier-3 units, one message per order
 *   - a produceable buff (BuffSystem::cBuff GetProduceableBuffDefinitions) is
 *     made in the queue its group names: group '5' in queue 6, group '11' in
 *     queue 11, any other group in queue 1 (the provision house)
 *   - one production run of a buff yields GetProductionAmount() items, and
 *     its costs are per run; for a buff, queued() counts runs
 *   - an order is message 91 with a dTimedProductionVO, one message per stack
 *     shape (a count of full stacks, then the remainder)
 *   - the host's defines.MAX_PRODUCTION_AMOUNT (25) is the most the order
 *     panel allows per message; maxProductionAmount() reads it once and
 *     falls back to STACK_SIZE 25 only while it cannot be read
 *
 * The buff list is read through buffTable(), once per read pass.
 *
 * The other production types (books, workshops, cooldown buildings) and the
 * per-type profiles live in core/production/queues.js; orderIn, queuedIn and
 * a typed costs() serve every type through those profiles.
 *
 * Failure contract: queued() reports an unreadable queue as null, never as 0,
 * so a failed read cannot look like an empty queue or a finished order. A
 * null stock or population reading counts as unaffordable.
 *
 * Bundle slot: core, after packets and before quests, resources and
 * specialists (core files load in name order). The core/production/ folder
 * loads before this file, so the exports are added to the object it started
 * instead of replacing it. Nothing here calls another core at load time.
 */

(function (S) {

    var QUEUE_BARRACKS = 0;
    var QUEUE_BOOKS    = 2;
    var QUEUE_TIER3    = 7;
    var QUEUE_ELITE    = 8;
    var STACK_SIZE     = 25;

    var BUFF_QUEUE_DEFAULT = 1;
    var BUFF_GROUP_QUEUES  = { '5': 6, '11': 11 };

    // Every buff queue: the default one and each group's own, ascending.
    var BUFF_QUEUES = (function () {
        var out = [BUFF_QUEUE_DEFAULT];
        for (var g in BUFF_GROUP_QUEUES) {
            if (BUFF_GROUP_QUEUES.hasOwnProperty(g) && out.indexOf(BUFF_GROUP_QUEUES[g]) < 0) out.push(BUFF_GROUP_QUEUES[g]);
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }());

    var ORDER_TIMEOUT_MS = 15000;

    var MESSAGE_ORDER = 91;
    var VO_ORDER      = 'Communication.VO::dTimedProductionVO';

    // The produceable buff definitions as a plain array, or null when the
    // list cannot be read.
    function produceableDefs() {
        try {
            var defs = game.def('BuffSystem::cBuff');
            if (!defs || typeof defs.GetProduceableBuffDefinitions !== 'function') return null;
            var vec = defs.GetProduceableBuffDefinitions(game.gi);
            if (!vec || typeof vec.length !== 'number') return null;
            var out = [];
            for (var i = 0; i < vec.length; i++) out.push(vec[i]);
            return out;
        } catch (e) {
            S.kernel.warn('production', 'GetProduceableBuffDefinitions threw:', e);
            return null;
        }
    }

    function has(o, k) {
        return Object.prototype.hasOwnProperty.call(o, k);
    }

    // One member of a buff definition, or undefined when it is missing or
    // throws. Each member is read once, so a definition the bridge hands out
    // half-readable cannot pass the check and then fail the call.
    function defMember(def, member) {
        try {
            return S.kernel.hostRead.call(def, member);
        } catch (e) {
            return undefined;
        }
    }

    // Builds the buff table from one read of the produceable list: each
    // definition's name and group are read once, so every lookup after it is
    // free of host calls. A definition without a usable name cannot be ordered
    // or matched, so it is skipped and counted instead of failing the list.
    function readBuffTable() {
        var defs = produceableDefs();
        if (defs === null) return null;
        var list = [];
        var byName = {};
        var skipped = 0;
        for (var i = 0; i < defs.length; i++) {
            var def = defs[i];
            var name = defMember(def, 'GetName_string');
            if (typeof name !== 'string' || !name) {
                skipped++;
                continue;
            }
            if (has(byName, name)) continue;
            var g = defMember(def, 'GetGroup_string');
            var group = g === undefined ? null : String(g);
            var queue = group === null ? null
                : (has(BUFF_GROUP_QUEUES, group) ? BUFF_GROUP_QUEUES[group] : BUFF_QUEUE_DEFAULT);
            var rec = { name: name, def: def, group: group, queue: queue };
            list.push(rec);
            byName[name] = rec;
        }
        if (skipped > 0) {
            S.kernel.debug('production', skipped + ' produceable buff definition(s) unreadable - skipped');
        }
        return { list: list, byName: byName };
    }

    // The produceable buffs as { list: [rec], byName: { name: rec } } with
    // rec = { name, def, group, queue }; group and queue are null when the
    // group cannot be read. null when the list cannot be read. Read once per
    // read pass; the table is shared, so callers never change it.
    function buffTable() {
        return S.kernel.hostRead.cached('production.buffTable', readBuffTable);
    }

    // The buff table's record for a name, or null.
    function buffRec(name) {
        var t = buffTable();
        return (t && has(t.byName, name)) ? t.byName[name] : null;
    }

    // The produceable buff definition with this name, or null.
    function buffDef(name) {
        var rec = buffRec(name);
        return rec ? rec.def : null;
    }

    // true when the name is a produceable buff, false when the list reads and
    // lacks it, null when the list cannot be read. Units are not produceable
    // here.
    function isProduceable(name) {
        var t = buffTable();
        if (t === null) return null;
        return has(t.byName, name);
    }

    // Queue id for an item, or null when neither a unit nor a buff definition
    // knows it.
    function queueIdFor(name) {
        var elite = S.core.army.isElite(name);
        if (elite !== null && elite !== undefined) return elite ? QUEUE_ELITE : QUEUE_BARRACKS;
        var rec = buffRec(name);
        if (!rec) return null;
        if (rec.queue === null) {
            S.kernel.warn('production', 'GetGroup_string(' + name + ') unreadable');
            return null;
        }
        return rec.queue;
    }

    // Items one production run yields: 1 for a unit, the buff definition's
    // GetProductionAmount() for a buff, null when unreadable.
    function yieldOf(name) {
        if (S.core.army.unitBase(name)) return 1;
        var def = buffDef(name);
        if (!def) return null;
        try {
            var y = S.kernel.hostRead.call(def, 'GetProductionAmount');
            return (typeof y === 'number' && isFinite(y) && y >= 1) ? y : null;
        } catch (e) {
            S.kernel.warn('production', 'GetProductionAmount(' + name + ') threw:', e);
            return null;
        }
    }

    // Unit type of one queued entry, whichever accessor the host offers.
    function entryType(entry) {
        var v = S.kernel.hostRead.call(entry, 'GetType_string');
        if (v !== undefined) return v;
        v = S.kernel.hostRead.call(entry, 'GetType');
        if (v !== undefined) return v;
        return entry.type_string;
    }

    // Buffs whose queue entry was already logged this session.
    var entryLogged = {};

    // The amount of a buff entry is logged once so the first run can show
    // whether the host counts production runs or items there.
    function logEntry(name, amount) {
        if (entryLogged[name] || S.core.army.unitBase(name)) return;
        entryLogged[name] = true;
        S.kernel.log('production', 'queue entry ' + name + ': GetAmount ' + amount + ', yield ' + yieldOf(name));
    }

    // Amount of this item waiting in the queue of a production type (runs
    // for a buff, the entries' GetAmount summed without subtracting what is
    // already produced): a number, or null when the queue, its vector or an
    // entry cannot be read.
    function queuedInNow(type, item) {
        try {
            var q = S.core.production.queueOf(type);
            if (!q) return null;
            var vec = q.mTimedProductions_vector;
            if (!vec || typeof vec.length !== 'number') return null;
            var total = 0;
            for (var i = 0; i < vec.length; i++) {
                var e = vec[i];
                if (!e) return null;
                if (entryType(e) !== item) continue;
                var a = S.kernel.hostRead.call(e, 'GetAmount');
                var amount = a === undefined ? e.amount : a;
                if (typeof amount !== 'number' || isNaN(amount)) return null;
                logEntry(item, amount);
                total += amount;
            }
            return total;
        } catch (e2) {
            S.kernel.warn('production', 'queued(' + item + ') threw:', e2);
            return null;
        }
    }

    // Inside a plan pass the queue is read once per type and item; outside a
    // pass (the orderIn verification, which never runs in one) it reads live.
    function queuedIn(type, item) {
        return S.kernel.hostRead.cached('production.queuedIn|' + type + '|' + item, function () {
            return queuedInNow(type, item);
        });
    }

    // Items of this type waiting in the item's queue (production runs for a
    // buff): a number, or null when the item has no queue or it cannot be
    // read.
    function queued(unit) {
        var id = queueIdFor(unit);
        if (id === null) return null;
        return queuedIn(id, unit);
    }

    // Items waiting in the queue: queued runs times the yield of one run.
    // null when either is unreadable.
    function queuedItems(name) {
        var q = queued(name);
        var y = yieldOf(name);
        return (q === null || y === null) ? null : q * y;
    }

    // queuedItems for an item in the queue of a production type.
    function queuedItemsIn(type, item) {
        var q = queuedIn(type, item);
        var y = S.core.production.yieldIn(type, item);
        return (q === null || y === null) ? null : q * y;
    }

    // Cost lines [{ name, amount }] of a definition's GetCosts_vector, or null
    // when unreadable.
    function costLines(holder) {
        if (!holder || typeof holder.GetCosts_vector !== 'function') return null;
        var vec = holder.GetCosts_vector();
        if (!vec || typeof vec.length !== 'number') return null;
        var out = [];
        for (var i = 0; i < vec.length; i++) {
            var c = vec[i];
            if (!c || typeof c.name_string !== 'string' || typeof c.amount !== 'number') return null;
            out.push({ name: c.name_string, amount: c.amount });
        }
        return out;
    }

    // Cost lines [{ name, amount }] of one item (per production run for a
    // buff), or null when unreadable. With a production type whose items are
    // neither units nor buffs (books, workshops), the type's own item list
    // prices it instead.
    function costs(unit, type) {
        if (typeof type === 'number') {
            var pr = S.core.production.profile(type);
            var K = S.ProductionKind;
            if (pr && pr.kind !== K.Units && pr.kind !== K.Buffs) {
                var info = S.core.production.itemInfo(type, unit);
                return info ? info.costs : null;
            }
        }
        try {
            var ub = S.core.army.unitBase(unit);
            return costLines(ub || buffDef(unit));
        } catch (e) {
            S.kernel.warn('production', 'costs(' + unit + ') threw:', e);
            return null;
        }
    }

    var maxAmount = null;

    // The host's most items per order message, read once because it is a
    // static constant. An unreadable value answers STACK_SIZE and caches
    // nothing, so a later readable value still wins.
    function maxProductionAmount() {
        if (maxAmount !== null) return maxAmount;
        try {
            var d = game.def('defines');
            var v = d ? d.MAX_PRODUCTION_AMOUNT : null;
            if (typeof v === 'number' && v > 0 && v === Math.floor(v)) {
                maxAmount = v;
                return v;
            }
        } catch (e) { /* defines not readable yet */ }
        return STACK_SIZE;
    }

    // Splits n units into stack shapes: [{ amount, count }] with the full
    // stacks first and the remainder last. Each shape is one message.
    function stacks(n, size) {
        var out = [];
        if (typeof n !== 'number' || !(n > 0) || n !== Math.floor(n)) return out;
        var per = (typeof size === 'number' && size > 0) ? size : maxProductionAmount();
        var full = Math.floor(n / per);
        var rest = n - full * per;
        if (full > 0) out.push({ amount: per, count: full });
        if (rest > 0) out.push({ amount: rest, count: 1 });
        return out;
    }

    // Resources missing for n items: [{ name, need, have }]. have is null when
    // that reading failed, and a null reading counts as missing. null when the
    // item's costs cannot be read.
    function shortfalls(unit, n) {
        return jointShortfalls([{ unit: unit, count: n }]);
    }

    // Like shortfalls, for several orders paid from the same stock: the needs
    // are summed per resource over all orders, so two orders that fit alone
    // but not together are reported short. orders: [{ unit, count, type? }];
    // the field is called unit but holds any item name, and the optional type
    // is the production type that prices it (see costs). null when any item's
    // costs cannot be read.
    function jointShortfalls(orders) {
        var names = [];
        var needs = {};
        var i;
        for (i = 0; i < orders.length; i++) {
            var list = costs(orders[i].unit, orders[i].type);
            if (list === null) return null;
            for (var j = 0; j < list.length; j++) {
                var name = list[j].name;
                if (!needs.hasOwnProperty(name)) {
                    needs[name] = 0;
                    names.push(name);
                }
                needs[name] += list[j].amount * orders[i].count;
            }
        }
        var out = [];
        for (i = 0; i < names.length; i++) {
            var have = names[i] === S.core.resources.POPULATION
                ? S.core.resources.freePopulation()
                : S.core.resources.amount(names[i]);
            if (typeof have !== 'number' || have < needs[names[i]]) {
                out.push({ name: names[i], need: needs[names[i]], have: typeof have === 'number' ? have : null });
            }
        }
        return out;
    }

    function affordable(unit, n) {
        var missing = shortfalls(unit, n);
        return missing !== null && missing.length === 0;
    }

    // Population cost of one unit: a number (0 when the unit costs none), or
    // null when the costs cannot be read.
    function populationCost(unit) {
        var list = costs(unit);
        if (list === null) return null;
        for (var i = 0; i < list.length; i++) {
            if (list[i].name === S.core.resources.POPULATION) return list[i].amount;
        }
        return 0;
    }

    // Pure. orders: [{ population, count }], population being the per-unit
    // Population cost. Returns how much population is missing for all of them
    // together, floored at 0; null when an input is not a number.
    function populationShortfall(orders, free) {
        if (typeof free !== 'number' || isNaN(free)) return null;
        var sum = 0;
        for (var i = 0; i < orders.length; i++) {
            if (typeof orders[i].population !== 'number' || typeof orders[i].count !== 'number') return null;
            sum += orders[i].population * orders[i].count;
        }
        return Math.max(0, sum - free);
    }

    function buildingGrid(q) {
        try {
            var b = q.productionBuilding;
            if (!b || typeof b.GetGrid !== 'function') return null;
            var g = b.GetGrid();
            return typeof g === 'number' ? g : null;
        } catch (e) {
            return null;
        }
    }

    // Entries in a queue, of any item, or null when unreadable.
    function entryCount(q) {
        try {
            var vec = q.mTimedProductions_vector;
            return (vec && typeof vec.length === 'number') ? vec.length : null;
        } catch (e) {
            return null;
        }
    }

    // Order n of an item into the queue of a production type. opts:
    // { stack, grid }; stack is the items per message of a stackable type
    // (maxProductionAmount() by default), grid the producing building (the queue's own
    // building by default). Verified once the item's queued total has grown
    // by n over the total read just before the first send. A retry orders
    // only what is still missing, so a late first order is never doubled; a
    // type not confirmed live is never retried.
    function orderIn(type, item, n, opts) {
        opts = opts || {};
        var label = 'order ' + n + ' ' + item + ' (queue ' + type + ')';
        var pr = S.core.production.profile(type);

        function gridOf(q) {
            return typeof opts.grid === 'number' ? opts.grid : buildingGrid(q);
        }

        // Stackable types split an order into full stacks and a remainder;
        // every other type takes the whole order as one message.
        function shapesOf(remaining) {
            if (pr && pr.stackable) return stacks(remaining, opts.stack || maxProductionAmount());
            if (typeof remaining !== 'number' || !(remaining > 0) || remaining !== Math.floor(remaining)) return [];
            return [{ amount: remaining, count: 1 }];
        }

        function sendShapes(q, remaining) {
            var shapes = shapesOf(remaining);
            var grid = gridOf(q);
            if (shapes.length === 0 || grid === null) return false;
            for (var i = 0; i < shapes.length; i++) {
                var vo = game.def(VO_ORDER, true);
                if (!vo) return false;
                vo.productionType = q.mProductionType;
                vo.type_string = item;
                vo.amount = shapes[i].amount;
                vo.stacks = shapes[i].count;
                vo.buildingGrid = grid;
                if (!S.core.packets.sendMessage(MESSAGE_ORDER, vo)) return false;
            }
            return true;
        }

        var def = {
            label:     label,
            category:  'production',
            timeoutMs: ORDER_TIMEOUT_MS,

            precheck: function () {
                if (!S.core.zone.isHome()) return 'not on the home zone';
                if (typeof n !== 'number' || !(n > 0) || n !== Math.floor(n)) return 'invalid amount';
                if (!pr || !pr.orderable) return 'not orderable';
                if (typeof pr.perOrderMax === 'number' && n > pr.perOrderMax) return 'one run per order';
                var q = S.core.production.queueOf(type);
                if (!q) return 'production queue missing';
                if (gridOf(q) === null) return 'production building missing';
                if (typeof queuedIn(type, item) !== 'number') return 'production queue unreadable';
                if (pr.maxEntries !== null) {
                    var count = entryCount(q);
                    if (count === null) return 'production queue unreadable';
                    if (count >= pr.maxEntries) return 'queue full';
                }
                var missing = jointShortfalls([{ unit: item, count: n, type: type }]);
                if (missing === null) return 'unit costs unreadable';
                if (missing.length > 0) return 'cannot afford: ' + missing[0].name;
                return null;
            },

            baseline: function () { return queuedIn(type, item); },

            send: function (base) {
                var now = queuedIn(type, item);
                if (typeof now !== 'number' || typeof base !== 'number') return false;
                var remaining = base + n - now;
                if (!(remaining > 0)) return false;
                var q = S.core.production.queueOf(type);
                if (!q) return false;
                return sendShapes(q, remaining);
            },

            check: function (base) {
                var q = queuedIn(type, item);
                return typeof q === 'number' && typeof base === 'number' && q >= base + n;
            },

            describe: function (base) {
                return 'queued ' + base + ' -> ' + queuedIn(type, item);
            }
        };
        if (!pr || !pr.confirmed) def.retries = 0;
        return def;
    }

    // Order n items (production runs for a buff) into the item's own queue;
    // see orderIn. The label keeps the short form callers log.
    function order(unit, n) {
        var label = 'order ' + n + ' ' + unit;
        var id = queueIdFor(unit);
        if (id === null) {
            return {
                label:     label,
                category:  'production',
                timeoutMs: ORDER_TIMEOUT_MS,
                precheck:  function () {
                    if (!S.core.zone.isHome()) return 'not on the home zone';
                    if (typeof n !== 'number' || !(n > 0) || n !== Math.floor(n)) return 'invalid amount';
                    return 'unknown item';
                },
                send:      function () { return false; },
                check:     function () { return false; }
            };
        }
        var def = orderIn(id, unit, n);
        def.label = label;
        return def;
    }

    if (!S.core.production) S.core.production = {};
    var P = S.core.production;
    P.QUEUE_BARRACKS      = QUEUE_BARRACKS;
    P.QUEUE_BOOKS         = QUEUE_BOOKS;
    P.QUEUE_TIER3         = QUEUE_TIER3;
    P.QUEUE_ELITE         = QUEUE_ELITE;
    P.BUFF_QUEUES         = BUFF_QUEUES;
    P.STACK_SIZE          = STACK_SIZE;
    P.maxProductionAmount = maxProductionAmount;
    P.queueIdFor          = queueIdFor;
    P.queued              = queued;
    P.queuedIn            = queuedIn;
    P.isProduceable       = isProduceable;
    P.yieldOf             = yieldOf;
    P.queuedItems         = queuedItems;
    P.queuedItemsIn       = queuedItemsIn;
    P.costs               = costs;
    P.costLines           = costLines;
    P.stacks              = stacks;
    P.shortfalls          = shortfalls;
    P.jointShortfalls     = jointShortfalls;
    P.affordable          = affordable;
    P.populationCost      = populationCost;
    P.populationShortfall = populationShortfall;
    P.entryType           = entryType;
    P.produceableDefs     = produceableDefs;
    P.buffTable           = buffTable;
    P.buildingGrid        = buildingGrid;
    P.order               = order;
    P.orderIn             = orderIn;

}(Steward));
