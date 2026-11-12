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
 *   buildings()     one row per listed queue building name (mines and
 *                   masons left out), describing its producer, the
 *                   highest-level one.
 *   queues()        one row per listed production type with its entries,
 *                   the same entries grouped into lines, times, whether it
 *                   is producing and its automatic queue, if any.
 *   isManaged(cfg)  whether a saved row holds an item or a buff.
 *   status(maxAge)  the only count of queues, entries, the next completion
 *                   and buffed buildings, plus the last plan pass and the
 *                   breaker snapshots. The host part is reused when it is at
 *                   most maxAge ms old; without maxAge it is read fresh.
 *                   readAt is when that part was read. standing,
 *                   standingCovered and standingHeld count only this
 *                   module's rows.
 *   snapshot()      status(SNAPSHOT_MAX_AGE_MS), for the passive surfaces
 *                   (menu label, dashboard tab, tile). One status object per
 *                   read pass, so a dashboard draw shows one set of numbers.
 *   emptyStatus()   the status shape with nothing read, for a view that has
 *                   no model yet.
 *   groupEntries()  queue entries folded into display lines.
 *
 * The listing rule, stated once (buildings() and queues() share one row set
 * per read pass):
 *   building row    listed when its profile is orderable and either its
 *                   item list does not read, or some item is producible
 *                   (not false), or its saved row is managed (a saved
 *                   choice stays even when nothing is producible now).
 *   queue type      listed when one of its names' rows is listed, or when
 *                   its profile is orderable and its entries read non-empty,
 *                   so a busy building with nothing to order still shows
 *                   what it produces. A cooldown type is never orderable.
 *                   An unreadable entry list does not list a type that way.
 *   hidden by name  a name in HIDDEN_NAMES is never listed. A type whose
 *                   names are all hidden is not listed and not counted.
 *                   The production module reads the same list, so a hidden
 *                   name is never ordered or buffed either.
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
 *   bookbinder      the head item of the first counted queue of kind Books
 *                   with at least one entry (booksItem), and now +
 *                   head.remainingMs when that is numeric (booksDoneAt, an
 *                   absolute time so a reused part stays right). Both are
 *                   null when there is no such queue or its entries do not
 *                   read, so the line follows the Queues count's scope.
 *   buffed N of M   island-wide: M is every home building with a production
 *                   queue or a numeric production state (mines, sawmills and
 *                   other continuous producers included), N those of them
 *                   with a running production buff. The settings do not
 *                   enter it.
 *
 * Bundle slot: module, loads before module.js and settings.js (name
 * order); every S.modules.production.* reference happens at call time.
 */

(function (S) {

    if (!S.modules.production) S.modules.production = {};

    var OWNER = 'production';

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

    // The signature of the last excluded-types debug line.
    var excludedSaid = null;

    // The counted queues among the scoped rows. The types dropped on the
    // way are logged once per changed set, so a count that looks wrong can
    // be traced to its types.
    function counted(list, mining, names) {
        var out = [];
        var why = [];
        for (var m = 0; m < (mining ? mining.length : 0); m++) why.push(mining[m] + ' (mining)');
        for (var i = 0; i < list.length; i++) {
            var t = list[i];
            if (t.kind === S.ProductionKind.Cooldown) { why.push(t.type + ' (cooldown)'); continue; }
            if (names && hiddenType(t, names)) { why.push(t.type + ' (hidden)'); continue; }
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

    function grid(b) {
        return b ? safe(function () { return S.core.buildings.grid(b); }, null) : null;
    }

    function level(b) {
        return b ? safe(function () { return S.core.buildings.level(b); }, null) : null;
    }

    function isManaged(cfg) {
        return !!(cfg && (cfg.item || cfg.buff));
    }

    // One predicate for both listing rules: a type that cannot take an
    // order (a cooldown building, an unreadable profile) is never listed.
    function orderable(pr) {
        return !!pr && pr.orderable !== false;
    }

    // Buildings hidden by name: buff buildings the listing rule below does
    // not catch yet. A stopgap, to be replaced by a generic rule.
    var HIDDEN_NAMES = { StarfallAirship: true };

    function hiddenByName(name) {
        return typeof name === 'string' && has(HIDDEN_NAMES, name);
    }

    // A type whose every scoped name is hidden by name. A type with no
    // scoped name at all is not hidden.
    function hiddenType(t, names) {
        var bs = t.buildings || [];
        var any = false;
        for (var i = 0; i < bs.length; i++) {
            var n = bs[i] && bs[i].name;
            if (typeof n !== 'string' || !has(names, n) || String(names[n]) !== String(t.type)) continue;
            any = true;
            if (!hiddenByName(n)) return false;
        }
        return any;
    }

    function listedBuilding(r) {
        if (hiddenByName(r.name)) return false;
        if (!orderable(r.profile)) return false;
        if (r.items === null) return true;
        for (var i = 0; i < r.items.length; i++) {
            if (r.items[i] && r.items[i].producible !== false) return true;
        }
        return r.managed;
    }

    // The signature of the last hidden-names debug line.
    var hiddenSaid = null;

    // Every row is built, then filtered, so the hidden names are logged once
    // per changed set and can be traced to their reason.
    function buildRows() {
        var all = [];
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
                all.push(seen[name]);
            }
        }
        var shown = [];
        var why = [];
        for (var k = 0; k < all.length; k++) {
            if (listedBuilding(all[k])) shown.push(all[k]);
            else {
                why.push(all[k].name + ' (' +
                    (hiddenByName(all[k].name) ? 'hidden by name' :
                        orderable(all[k].profile) ? 'nothing producible' : 'not orderable') + ')');
            }
        }
        var sig = why.join(', ');
        if (sig !== hiddenSaid) {
            hiddenSaid = sig;
            if (sig) S.kernel.debug('production', 'manager hides: ' + sig);
        }
        return { shown: shown, names: names, kept: list };
    }

    // The row set of this read pass, shared by buildings() and queues().
    function rowSet() {
        return S.kernel.hostRead.cached('production.rows', buildRows);
    }

    function buildings() {
        return pass(function () { return rowSet().shown; });
    }

    function row(name, t) {
        var b = safe(function () { return M().highest(name); }, null);
        var type = t.type;
        var cfg = cfgOf(name);
        return {
            name:    name,
            label:   bui(name),
            count:   1,
            level:   level(b),
            grid:    grid(b),
            type:    type,
            kind:    t.kind,
            profile: safe(function () { return P().profile(type); }, null),
            items:   safe(function () { return P().itemsOf(type); }, null),
            cfg:     cfg,
            managed: isManaged(cfg),
            // The cost of one order of `items` runs; one run when items is
            // not a positive number.
            costText: function (item, items) {
                var info = safe(function () { return P().itemInfo(type, item); }, null);
                if (!info || !info.costs || !info.costs.length) return '';
                var mult = typeof items === 'number' && items > 0 ? items : 1;
                var parts = [];
                for (var k = 0; k < info.costs.length; k++) {
                    parts.push((info.costs[k].amount * mult) + ' ' + res(info.costs[k].name));
                }
                return parts.join(', ') + ' per order';
            },
            buffs:   safe(function () { return S.core.buffs.buildingBuffCandidates(name, false); }, [])
        };
    }

    // The listed types: through a listed building name, or orderable with
    // entries on the queue.
    function queues() {
        return pass(function () {
            var set = rowSet();
            var listedType = {};
            for (var r = 0; r < set.shown.length; r++) listedType[String(set.shown[r].type)] = true;
            var out = [];
            var now = Date.now();
            for (var i = 0; i < set.kept.length; i++) {
                var t = set.kept[i];
                var es = safe(function () { return P().entries(t.type); }, null);
                if (!has(listedType, String(t.type))) {
                    if (hiddenType(t, set.names)) continue;
                    var pr = es && es.length ? safe(function () { return P().profile(t.type); }, null) : null;
                    if (!orderable(pr)) continue;
                }
                out.push(queueRow(t, now, es, set.names));
            }
            return out;
        });
    }

    // The first name of a type, in queueNames() order, whose saved row is
    // enabled and has an item.
    function autoOf(type, names) {
        for (var n in names) {
            if (!has(names, n) || String(names[n]) !== String(type)) continue;
            var cfg = cfgOf(n);
            if (cfg.enabled === true && cfg.item) return { name: n, item: cfg.item, label: res(cfg.item) };
        }
        return null;
    }

    function queueRow(t, now, es, names) {
        var type = t.type;
        var first = t.buildings && t.buildings.length ? t.buildings[0] : null;
        var b = first ? safe(function () { return M().highest(first.name); }, null) : null;
        var rem = safe(function () { return P().remainingMs(type); }, null);
        return {
            type:        type,
            kind:        t.kind,
            label:       first ? bui(first.name) : String(type),
            level:       b ? level(b) : (first ? first.level : null),
            count:       t.buildings ? t.buildings.length : 0,
            entries:     es,
            lines:       groupEntries(es),
            producing:   !!es && es.length > 0,
            auto:        autoOf(type, names),
            remainingMs: rem,
            doneAt:      typeof rem === 'number' ? now + rem : null,
            cooldownMs:  safe(function () { return P().cooldownMs(type); }, null),
            buff:        b ? safe(function () { return S.core.buildings.productionBuffInfo(b); }, null) : null,
            // Entries this module placed this session read as automatic
            // queues; anything else (the user, an adventure run) as Other.
            source: function (entry) {
                var placed = !!entry && safe(function () { return M().isPlaced(type, entry.item); }, false);
                return placed ? 'Automatic queue' : 'Other';
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
            var list = counted(sc.kept, sc.mining, sc.names);
            var running = 0, unreadable = 0, entryCount = 0, nextDoneAt = null, nextItem = null;
            var booksItem = null, booksDoneAt = null, booksFound = false;
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
                if (list[i].kind === S.ProductionKind.Books && booksFound === false) {
                    booksFound = true;
                    booksItem = head.item === undefined ? null : head.item;
                    booksDoneAt = num(head.remainingMs) ? now + head.remainingMs : null;
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
                booksItem:  booksItem,
                booksDoneAt: booksDoneAt,
                buffed:     bc.buffed,
                buffable:   bc.buffable
            };
        });
    }

    // The last host part and when it was read.
    var cache = null;

    function emptyPart() {
        return { types: 0, queues: 0, unreadable: 0, entries: 0,
                 nextDoneAt: null, nextItem: null, booksItem: null, booksDoneAt: null,
                 buffed: 0, buffable: 0 };
    }

    function zeroCounts() {
        return { standing: 0, standingCovered: 0, standingHeld: 0 };
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
            booksItem:       part.booksItem,
            booksDoneAt:     part.booksDoneAt,
            standing:       counts.standing,
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
            if (rows[r].owner !== OWNER) continue;
            counts.standing++;
            if (rows[r].status === D.Covered) counts.standingCovered++;
            else if (rows[r].status === D.Held) counts.standingHeld++;
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

    S.modules.production.model = {
        buildings:    buildings,
        queues:       queues,
        isManaged:    isManaged,
        status:       status,
        snapshot:     snapshot,
        emptyStatus:  emptyStatus,
        SNAPSHOT_MAX_AGE_MS: SNAPSHOT_MAX_AGE_MS,
        groupEntries: groupEntries,
        hiddenByName: hiddenByName
    };

}(Steward));
