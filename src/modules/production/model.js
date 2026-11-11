/*
 * Read models of the production module for its dashboard tab, tile, menu
 * and window.
 *
 * Every function reads the host through the core readers at call time and
 * is null-safe: an unreadable part shows as null or an empty list, never
 * as a thrown error, so a view can always render. Nothing here sends,
 * enqueues or stores.
 *
 * Each model builds inside one read pass (S.kernel.hostRead.pass), so the
 * core readers it shares (queue types, queues, entries, items, the buff
 * tables) cross the bridge once per call however many rows it builds. A
 * pass never wraps an action; the closures on the rows run later, fresh.
 *
 *   buildings()     one row per queue building name (mines and masons left
 *                   out), describing its producer, the highest-level one.
 *   queues()        one row per production type with its entries, the same
 *                   entries grouped into lines, and times.
 *   status(maxAge)  the only count of queues, entries, the next completion
 *                   and buffed buildings, plus the last plan pass and the
 *                   breaker snapshots. The host part is reused when it is at
 *                   most maxAge ms old; without maxAge it is read fresh.
 *                   readAt is when that part was read. standingCovered and
 *                   standingHeld count only this module's rows; covered and
 *                   held count every owner's.
 *   snapshot()      status(SNAPSHOT_MAX_AGE_MS), for the passive surfaces
 *                   (menu label, dashboard tab, tile). One status object per
 *                   read pass, so a dashboard draw shows one set of numbers.
 *   emptyStatus()   the status shape with nothing read, for a view that has
 *                   no model yet.
 *   groupEntries()  queue entries folded into display lines.
 *   reservations()  what other owners' needs reserve, per resource.
 *   onOff()         { rows, counts }: stopped home buildings (capped), with
 *                   whether mining owns them, and the uncapped counts.
 *   books()         the Bookbinder queue.
 *
 * Definitions used by status, stated once:
 *   counted queue   a type from queueTypes() that queueNames() maps at
 *                   least one name to, not of kind Cooldown, whose queue
 *                   object reads. A culture building has no queue, mines and
 *                   masons are mining's, and a type without a readable queue
 *                   is not one the player can fill. status.types counts them.
 *   running         a counted queue whose entries read and hold at least one
 *                   entry (a finished head waiting for completion counts).
 *                   status.queues counts them; status.unreadable counts the
 *                   counted queues whose entries do not read.
 *   entries         the entries over running queues.
 *   next done       the earliest now + head.remainingMs over running queues
 *                   with a numeric head time (nextDoneAt), and that head's
 *                   item (nextItem).
 *   buffed N of M   island-wide: M is every home building with a production
 *                   queue or a numeric production state (mines, sawmills and
 *                   other continuous producers included), N those of them
 *                   with a running production buff. The settings do not
 *                   enter it.
 *
 * The count of short demand rows is called shortfall, not short: short is
 * an ES3 reserved word that AIR 32 cannot parse as a key.
 *
 * Bundle slot: module, loads before module.js and settings.js (name
 * order); every S.modules.production.* reference happens at call time.
 */

(function (S) {

    if (!S.modules.production) S.modules.production = {};

    var OWNER     = 'production';
    var ONOFF_MAX = 200;

    // How old a status host part the passive surfaces accept. A label or a
    // tile that re-reads every queue on each refresh is what stalled the
    // client; half a minute is fresh enough for counts that move by minutes.
    var SNAPSHOT_MAX_AGE_MS = 30000;

    function M() { return S.modules.production; }
    function P() { return S.core.production; }

    function has(o, k) {
        return Object.prototype.hasOwnProperty.call(o, k);
    }

    function safe(fn, fallback) {
        try {
            var v = fn();
            return v === undefined ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    function bui(name) {
        return safe(function () { return S.core.locale.bui(name) || name; }, name);
    }

    function res(name) {
        return safe(function () { return S.core.locale.res(name) || name; }, name);
    }

    function pass(fn) {
        return S.kernel.hostRead.pass(fn);
    }

    // The queueTypes() rows split into the module's scope and the types
    // left to mining. The managed set is decided by queueNames() alone, the
    // same map the plan pass manages, so a view never counts a type or a
    // name the module would not order into. A name listed under two types
    // belongs to the first, the one queueNames() maps it to. names is
    // returned too, so a caller in the same pass reads it once.
    function scope() {
        var names = safe(function () { return M().queueNames(); }, null) || {};
        var keep = {};
        for (var n in names) if (has(names, n)) keep[String(names[n])] = true;
        var all = safe(function () { return P().queueTypes(); }, null) || [];
        var out = { kept: [], mining: [], names: names };
        for (var i = 0; i < all.length; i++) {
            if (has(keep, String(all[i].type))) out.kept.push(all[i]);
            else out.mining.push(all[i].type);
        }
        return out;
    }

    function types() {
        return pass(function () { return scope().kept; });
    }

    // The signature of the last excluded-types debug line.
    var excludedSaid = null;

    // The counted queues among the scoped rows. The types dropped on the
    // way are logged once per changed set, so a count that looks wrong can
    // be traced to its types.
    function counted(list, mining) {
        var out = [];
        var why = [];
        for (var m = 0; m < (mining ? mining.length : 0); m++) why.push(mining[m] + ' (mining)');
        for (var i = 0; i < list.length; i++) {
            var t = list[i];
            if (t.kind === S.ProductionKind.Cooldown) { why.push(t.type + ' (cooldown)'); continue; }
            if (safe(function () { return P().queueOf(t.type); }, null) === null) {
                why.push(t.type + ' (no queue)');
                continue;
            }
            out.push(t);
        }
        var sig = why.join(', ');
        if (sig !== excludedSaid) {
            excludedSaid = sig;
            if (sig) S.kernel.debug('production', 'queue count leaves out: ' + sig);
        }
        return out;
    }

    function cfgOf(name) {
        var s = safe(function () { return M().readSettings(); }, null);
        var row = s && s.buildings ? s.buildings[name] : null;
        if (row) return row;
        var blank = M().defaultBuilding || {};
        var out = {};
        for (var f in blank) out[f] = blank[f];
        return out;
    }

    function stockOf(name) {
        return safe(function () {
            var r = S.core.resources;
            var v = name === r.POPULATION ? r.freePopulation() : r.amount(name);
            return typeof v === 'number' ? v : null;
        }, null);
    }

    function grid(b) {
        return b ? safe(function () { return S.core.buildings.grid(b); }, null) : null;
    }

    function level(b) {
        return b ? safe(function () { return S.core.buildings.level(b); }, null) : null;
    }

    function buildings() {
        return pass(buildRows);
    }

    function buildRows() {
        var out = [];
        var seen = {};
        var sc = scope();
        var names = sc.names;
        var list = sc.kept;
        for (var i = 0; i < list.length; i++) {
            var t = list[i];
            var bs = t.buildings || [];
            for (var j = 0; j < bs.length; j++) {
                var name = bs[j].name;
                if (typeof name !== 'string' || !name) continue;
                if (has(seen, name)) { seen[name].count++; continue; }
                if (!has(names, name)) continue;
                seen[name] = row(name, t);
                out.push(seen[name]);
            }
        }
        return out;
    }

    function row(name, t) {
        var b = safe(function () { return M().highest(name); }, null);
        var type = t.type;
        var pr = safe(function () { return P().profile(type); }, null);
        var books = !!pr && pr.kind === S.ProductionKind.Books;
        return {
            name:    name,
            label:   bui(name),
            count:   1,
            level:   level(b),
            grid:    grid(b),
            type:    type,
            kind:    t.kind,
            profile: pr,
            items:   safe(function () { return P().itemsOf(type); }, null),
            cfg:     cfgOf(name),
            // The cost of one order unit: a stack of the configured size,
            // or one book.
            costText: function (item) {
                var info = safe(function () { return P().itemInfo(type, item); }, null);
                if (!info || !info.costs || !info.costs.length) return '';
                var mult = books ? 1 : safe(function () { return M().stackFor(name, type); }, 1);
                var parts = [];
                for (var k = 0; k < info.costs.length; k++) {
                    parts.push((info.costs[k].amount * mult) + ' ' + res(info.costs[k].name));
                }
                return parts.join(', ') + (books ? ' per book' : ' per stack');
            },
            buffs:   safe(function () { return S.core.buffs.buildingBuffCandidates(name, false); }, [])
        };
    }

    function queues() {
        return pass(function () {
            var out = [];
            var list = types();
            var now = Date.now();
            for (var i = 0; i < list.length; i++) {
                out.push(queueRow(list[i], now));
            }
            return out;
        });
    }

    function queueRow(t, now) {
        var type = t.type;
        var first = t.buildings && t.buildings.length ? t.buildings[0] : null;
        var b = first ? safe(function () { return M().highest(first.name); }, null) : null;
        var rem = safe(function () { return P().remainingMs(type); }, null);
        var es = safe(function () { return P().entries(type); }, null);
        return {
            type:        type,
            kind:        t.kind,
            label:       first ? bui(first.name) : String(type),
            level:       b ? level(b) : (first ? first.level : null),
            count:       t.buildings ? t.buildings.length : 0,
            entries:     es,
            lines:       groupEntries(es),
            remainingMs: rem,
            doneAt:      typeof rem === 'number' ? now + rem : null,
            cooldownMs:  safe(function () { return P().cooldownMs(type); }, null),
            buff:        b ? safe(function () { return S.core.buildings.productionBuffInfo(b); }, null) : null,
            // Entries this module placed this session read as standing
            // orders; anything else (the user, an adventure run) as Other.
            source: function (entry) {
                var placed = !!entry && safe(function () { return M().isPlaced(type, entry.item); }, false);
                return placed ? 'Standing order' : 'Other';
            }
        };
    }

    function num(v) {
        return typeof v === 'number' && !isNaN(v);
    }

    // The sum of one field over a run, or null when any member's is not a
    // number: a partial sum would show a time or a count that is too low.
    function sumOf(run, field) {
        var sum = 0;
        for (var i = 0; i < run.length; i++) {
            if (!num(run[i][field])) return null;
            sum += run[i][field];
        }
        return sum;
    }

    // One display line from a run of entries. A single entry is copied; a
    // group sums its progress and time and is finished only when all are.
    function lineOf(run) {
        var e = run[0];
        var n = run.length;
        var finished = true;
        for (var i = 0; i < n; i++) if (!run[i].finished) finished = false;
        return {
            item:          e.item,
            amount:        e.amount,
            repeat:        n,
            total:         num(e.amount) ? e.amount * n : null,
            produced:      n === 1 ? e.produced : sumOf(run, 'produced'),
            remainingMs:   n === 1 ? e.remainingMs : sumOf(run, 'remainingMs'),
            finished:      finished,
            timeMs:        e.timeMs,
            bonus:         e.bonus,
            producedItems: n === 1 ? e.producedItems : null,
            entries:       run
        };
    }

    // Queue entries folded into display lines: a run of neighbours with the
    // same item and amount shows as one line of repeat x amount. The head
    // stays its own line, because it is the entry in production and the only
    // one with progress to show. Null for null.
    function groupEntries(list) {
        if (!list) return null;
        var runs = [];
        var run = null;
        for (var i = 0; i < list.length; i++) {
            var e = list[i] || {};
            // Only a run that did not start at the head may grow.
            var head = runs.length > 1 ? run[0] : null;
            if (head && e.item === head.item && e.amount === head.amount) {
                run.push(e);
                continue;
            }
            run = [e];
            runs.push(run);
        }
        var out = [];
        for (var j = 0; j < runs.length; j++) out.push(lineOf(runs[j]));
        return out;
    }

    // Buildings buffed, island-wide: one loop over the home building list.
    // A production building has a queue or a numeric production state, and
    // productionBuffInfo is the one buff reader.
    function buffCount() {
        var out = { buffed: 0, buffable: 0 };
        if (safe(function () { return S.core.zone.isHome(); }, false) !== true) return out;
        var B = S.core.buildings;
        var all = safe(function () { return B.list(); }, null) || [];
        for (var i = 0; i < all.length; i++) {
            var b = all[i];
            if (!b) continue;
            var q = safe(function () { return b.productionQueue; }, null);
            if (!q && !num(safe(function () { return B.productionState(b); }, null))) continue;
            out.buffable++;
            if (safe(function () { return B.productionBuffInfo(b); }, null)) out.buffed++;
        }
        return out;
    }

    // Everything status reads from the host, in one read pass.
    function hostPart() {
        return pass(function () {
            var sc = scope();
            var list = counted(sc.kept, sc.mining);
            var running = 0, unreadable = 0, entryCount = 0, nextDoneAt = null, nextItem = null;
            var now = Date.now();
            for (var i = 0; i < list.length; i++) {
                var es = safe(function () { return P().entries(list[i].type); }, null);
                if (es === null) { unreadable++; continue; }
                if (!es.length) continue;
                running++;
                entryCount += es.length;
                var head = es[0] || {};
                if (num(head.remainingMs) && (nextDoneAt === null || now + head.remainingMs < nextDoneAt)) {
                    nextDoneAt = now + head.remainingMs;
                    nextItem = head.item === undefined ? null : head.item;
                }
            }
            var bc = buffCount();
            return {
                types:      list.length,
                queues:     running,
                unreadable: unreadable,
                entries:    entryCount,
                nextDoneAt: nextDoneAt,
                nextItem:   nextItem,
                buffed:     bc.buffed,
                buffable:   bc.buffable
            };
        });
    }

    // The last host part and when it was read.
    var cache = null;

    function emptyPart() {
        return { types: 0, queues: 0, unreadable: 0, entries: 0,
                 nextDoneAt: null, nextItem: null, buffed: 0, buffable: 0 };
    }

    function zeroCounts() {
        return { standing: 0, covered: 0, waiting: 0, shortfall: 0, held: 0,
                 standingCovered: 0, standingHeld: 0 };
    }

    // The one builder of the status object, so status() and emptyStatus()
    // cannot drift apart in their fields.
    function shape(part, counts, enabled, orderBreaker, buffBreaker, readAt) {
        return {
            enabled:         enabled,
            types:           part.types,
            queues:          part.queues,
            unreadable:      part.unreadable,
            entries:         part.entries,
            nextDoneAt:      part.nextDoneAt,
            nextItem:        part.nextItem,
            standing:        counts.standing,
            covered:         counts.covered,
            waiting:         counts.waiting,
            shortfall:       counts.shortfall,
            held:            counts.held,
            standingCovered: counts.standingCovered,
            standingHeld:    counts.standingHeld,
            orderBreaker:    orderBreaker,
            buffBreaker:     buffBreaker,
            buffed:          part.buffed,
            buffable:        part.buffable,
            readAt:          readAt
        };
    }

    // The status of a view that has nothing read yet.
    function emptyStatus() {
        return shape(emptyPart(), zeroCounts(), false, null, null, null);
    }

    function status(maxAgeMs) {
        var now = Date.now();
        var part;
        if (typeof maxAgeMs === 'number' && cache && now >= cache.at && now - cache.at <= maxAgeMs) {
            part = cache.value;
        } else {
            try {
                part = hostPart();
                cache = { at: now, value: part };
            } catch (e) {
                // A throw keeps the last part instead of caching a blank one,
                // so a view still gets numbers.
                part = cache ? cache.value : emptyPart();
            }
        }
        // When the numbers were read: a kept part keeps its old time, and a
        // part never read has none.
        var readAt = cache ? cache.at : null;

        var s = safe(function () { return M().readSettings(); }, null) || {};
        var D = S.DemandStatus;
        var last = safe(function () { return M().lastPass(); }, null);
        var rows = last && last.rows ? last.rows : [];
        var counts = zeroCounts();
        for (var r = 0; r < rows.length; r++) {
            var own = rows[r].owner === OWNER;
            if (own) counts.standing++;
            if (rows[r].status === D.Covered) {
                counts.covered++;
                if (own) counts.standingCovered++;
            } else if (rows[r].status === D.Waiting) counts.waiting++;
            else if (rows[r].status === D.Short) counts.shortfall++;
            else if (rows[r].status === D.Held) {
                counts.held++;
                if (own) counts.standingHeld++;
            }
        }

        return shape(part, counts, !!s.enabled,
            safe(function () { return M().orderBreaker.snapshot(); }, null),
            safe(function () { return M().buffEngine.breaker.snapshot(); }, null),
            readAt);
    }

    // Memoized per read pass: every part of one dashboard draw gets the same
    // status object, even when the clock crosses the max age between them.
    function snapshot() {
        return S.kernel.hostRead.cached('production.status', function () {
            return status(SNAPSHOT_MAX_AGE_MS);
        });
    }

    // What the needs of other owners reserve: one line per need and
    // resource, each with the stock and what is free once every listed
    // reservation of that resource is taken. rows defaults to the last pass.
    function reservations(rows) {
        if (!rows) {
            var last = safe(function () { return M().lastPass(); }, null);
            rows = last && last.rows ? last.rows : [];
        }
        var out = [];
        var total = {};
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r || r.owner === OWNER || !(r.runs > 0)) continue;
            var info = safe(function () { return P().itemInfo(r.type, r.item); }, null);
            if (!info || !info.costs) continue;
            for (var k = 0; k < info.costs.length; k++) {
                var c = info.costs[k];
                var amount = c.amount * r.runs;
                total[c.name] = (total[c.name] || 0) + amount;
                out.push({ name: c.name, reserved: amount, stock: stockOf(c.name),
                           forLabel: r.label, priority: r.priority });
            }
        }
        for (var j = 0; j < out.length; j++) {
            out[j].free = out[j].stock === null ? null : out[j].stock - total[out[j].name];
        }
        return out;
    }

    // One scan of the home buildings: the stopped rows (capped) and the
    // uncapped counts.
    function scanOnOff() {
        var out = { rows: [], stopped: 0, miningOwned: 0 };
        if (safe(function () { return S.core.zone.isHome(); }, false) !== true) return out;
        var all = safe(function () { return S.core.buildings.list(); }, null) || [];
        for (var i = 0; i < all.length; i++) {
            var b = all[i];
            if (!b) continue;
            var active = safe(function () { return P().isActive(b); }, null);
            var state = safe(function () { return S.core.buildings.productionState(b); }, null);
            if (active !== false && state !== S.core.buildings.MISSING_INPUT_STATE) continue;
            var name = safe(function () { return S.core.buildings.name(b); }, null);
            var mining = safe(function () { return M().ownedByMining(name); }, false);
            out.stopped++;
            if (mining) out.miningOwned++;
            if (out.rows.length >= ONOFF_MAX) continue;
            out.rows.push({
                name:   name,
                label:  bui(name),
                grid:   grid(b),
                state:  state,
                active: active,
                // Who manages the building, not who turned it off: no
                // turn-off is attributed, since steward turns nothing off
                // here except mining's own pauses, which mining tracks.
                mining: !!mining
            });
        }
        return out;
    }

    // The capped rows and the uncapped counts come from the same scan, so a
    // view's list and its totals cannot disagree.
    function onOff() {
        var s = pass(scanOnOff);
        return { rows: s.rows, counts: { stopped: s.stopped, miningOwned: s.miningOwned } };
    }

    function books() {
        return pass(readBooks);
    }

    function readBooks() {
        var type = P().QUEUE_BOOKS;
        var list = types();
        var t = null;
        for (var i = 0; i < list.length; i++) if (list[i].type === type) { t = list[i]; break; }
        if (!t || !t.buildings || !t.buildings.length) return null;
        var name = t.buildings[0].name;
        var b = safe(function () { return M().highest(name); }, null);
        var es = safe(function () { return P().entries(type); }, null);
        var head = es && es.length ? es[0] : null;
        var cfg = cfgOf(name);
        return {
            level:    b ? level(b) : t.buildings[0].level,
            grid:     b ? grid(b) : t.buildings[0].grid,
            head:     head,
            info:     head ? safe(function () { return P().bookInfo(head.item); }, null) : null,
            finished: !!(head && head.finished),
            standing: (cfg.item && cfg.amount > 0) ? { item: cfg.item, amount: cfg.amount } : null
        };
    }

    S.modules.production.model = {
        buildings:    buildings,
        queues:       queues,
        status:       status,
        snapshot:     snapshot,
        emptyStatus:  emptyStatus,
        SNAPSHOT_MAX_AGE_MS: SNAPSHOT_MAX_AGE_MS,
        groupEntries: groupEntries,
        reservations: reservations,
        onOff:        onOff,
        books:        books
    };

}(Steward));
