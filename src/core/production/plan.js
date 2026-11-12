/*
 * Production planner: turns a list of needs into rows and orders.
 *
 * plan(needs, opts) matches each need against the live queue and stock and
 * says what to order for one owner (opts.actFor). Needs come from the demand
 * ledger's list(), already sorted by priority, so the planner walks them in
 * the order given and never sorts itself.
 *
 * Priced in priority order: every need, of any owner, reserves the runs it
 * still misses, and each later need is priced against what those
 * reservations leave. So a Standing order is short when a RunNow need of an
 * adventure run would be short with it, even though the stock alone would
 * pay for it. Another owner's runs are reserved even while they are short,
 * because higher-priority demand keeps its claim on the resources while it
 * waits for them. Only actFor's rows produce orders; another owner orders
 * its own items.
 *
 * Amounts are items. A queued run of a yield-y item counts as y items, and a
 * missing amount is ordered as whole runs, rounded up.
 *
 * Idle-only orders: when opts.orderRuns(need) gives a positive whole number
 * for an own need, that need is ordered only while its type's queue holds no
 * entry. It reads Covered while anything is queued there, of any item or
 * owner, and once the queue is empty it orders exactly that many runs, capped
 * by the profile's perOrderMax. At most one such order per type comes out of
 * one call: several building names can share one queue and the entry read is
 * memoized per pass, so a second name would see the same empty queue and
 * stack a second order on it. Only an Order claims the type; a Short,
 * Deferred or Unreadable need leaves it for the next own need of that type.
 * Any other result from orderRuns takes the amount path above.
 *
 * Pure over its read argument: every host fact comes through opts.read,
 * whose defaults bind at call time to S.core.production. Nothing is sent,
 * nothing is stored. A read that the need depends on and that comes back
 * null makes that row Unreadable, never Covered.
 *
 * Bundle slot: core, under core/production/ before production.js; every
 * S.core.production.* reference happens at call time.
 */

(function (S) {

    if (!S.core.production) S.core.production = {};

    var Status = S.DemandStatus;

    // The default host reads, each resolved when called so the core readers
    // that load after this file are the ones used.
    function call(name, args) {
        var fn = S.core.production[name];
        if (typeof fn !== 'function') return null;
        return fn.apply(null, args);
    }

    var DEFAULT_READ = {
        profile:         function (type) { return call('profile', [type]); },
        queuedIn:        function (type, item) { return call('queuedIn', [type, item]); },
        yieldIn:         function (type, item) { return call('yieldIn', [type, item]); },
        stockOf:         function (type, item) { return call('stockOf', [type, item]); },
        entryCount:      function (type) {
            var list = call('entries', [type]);
            return list === null || typeof list.length !== 'number' ? null : list.length;
        },
        jointShortfalls: function (orders) { return call('jointShortfalls', [orders]); }
    };

    // opts.read may name only some reads; the rest fall back to the core.
    function readsOf(given) {
        var out = {};
        for (var name in DEFAULT_READ) {
            if (!DEFAULT_READ.hasOwnProperty(name)) continue;
            out[name] = given && typeof given[name] === 'function' ? given[name] : DEFAULT_READ[name];
        }
        return out;
    }

    function defaultHeld(actFor) {
        return function (kind, item) {
            var demand = S.core.production.demand;
            if (!demand || typeof demand.isHeld !== 'function') return null;
            return demand.isHeld(kind, item, actFor);
        };
    }

    function isCount(n) {
        return typeof n === 'number' && n >= 0;
    }

    // A run count orderRuns may hand back: anything else means the need
    // takes the amount path.
    function isRuns(n) {
        return typeof n === 'number' && n > 0 && n < Infinity && Math.floor(n) === n;
    }

    // One result row. The first short resource is called shortfall, not
    // short: short is an ES3 reserved word that AIR 32 cannot parse as a key.
    function row(need) {
        return {
            owner:     need.owner,
            key:       need.key,
            label:     need.label,
            type:      need.type,
            item:      need.item,
            need:      need.items,
            stock:     null,
            // True when a stock applies to this kind but could not be read, so
            // the views can show ? instead of 0.
            stockUnknown: false,
            queued:    null,
            priority:  need.priority,
            status:    null,
            shortfall: null,
            reserved:  false,
            runs:      0
        };
    }

    function plan(needs, opts) {
        opts = opts || {};
        var read = readsOf(opts.read);
        var actFor = opts.actFor;
        var isHeld = typeof opts.isHeld === 'function' ? opts.isHeld : defaultHeld(actFor);
        var orderRuns = typeof opts.orderRuns === 'function' ? opts.orderRuns : null;
        var maxOrders = typeof opts.maxOrders === 'number' ? opts.maxOrders : Infinity;

        var rows = [];
        var orders = [];
        // Runs already claimed by the needs priced before, as
        // jointShortfalls orders.
        var taken = [];
        // Types that already got an idle-only order in this call (type ->
        // true). Call-local: the next pass reads the real entries again.
        var idleClaimed = {};

        // Prices own on top of what is taken. Sets the row's shortfall fields
        // and returns the shortfall list, or null when it cannot be priced.
        function price(r, own) {
            var s = read.jointShortfalls(taken.concat([own]));
            if (s === null || typeof s !== 'object' || typeof s.length !== 'number') return null;
            if (s.length > 0) {
                r.shortfall = s[0];
                // Short only because of the reservations: alone it would fit.
                var alone = taken.length > 0 ? read.jointShortfalls([own]) : s;
                r.reserved = !!alone && typeof alone.length === 'number' && alone.length === 0;
            }
            return s;
        }

        // Prices an own order and, when it fits and the order budget allows,
        // places it. Returns true when the row became an Order.
        function commit(need, r, own) {
            var s = price(r, own);
            if (s === null) { r.status = Status.Unreadable; return false; }
            if (s.length > 0) { r.status = Status.Short; return false; }
            if (orders.length >= maxOrders) { r.status = Status.Deferred; return false; }

            r.status = Status.Order;
            orders.push({ owner: need.owner, key: need.key, type: need.type, item: need.item, runs: own.count });
            taken.push(own);
            return true;
        }

        // An own need with an orderRuns count: it orders only into an idle
        // queue. The amount test and the entry limit do not apply, because a
        // queue holding anything already reads Covered.
        function idleOrder(need, r, p, n) {
            if (isHeld(p.kind, need.item)) { r.status = Status.Held; return; }
            // The claim is checked before the entry read, so it costs no read.
            if (idleClaimed[need.type] === true) { r.status = Status.Covered; return; }
            var count = read.entryCount(need.type);
            if (!isCount(count)) { r.status = Status.Unreadable; return; }
            if (count > 0) { r.status = Status.Covered; return; }

            var runs = n;
            if (typeof p.perOrderMax === 'number' && runs > p.perOrderMax) runs = p.perOrderMax;
            r.runs = runs;
            if (commit(need, r, { unit: need.item, count: runs, type: need.type })) {
                idleClaimed[need.type] = true;
            }
        }

        for (var i = 0; i < (needs ? needs.length : 0); i++) {
            var need = needs[i];
            var r = row(need);
            rows.push(r);

            var p = read.profile(need.type);
            if (!p) { r.status = Status.Unreadable; continue; }
            if (!p.orderable) { r.status = Status.NotOrderable; continue; }

            var y = read.yieldIn(need.type, need.item);
            var runsQueued = read.queuedIn(need.type, need.item);
            r.stock = read.stockOf(need.type, need.item);
            // Units have no stock by design, so a null there is not unknown.
            r.stockUnknown = p.kind !== S.ProductionKind.Units && !isCount(r.stock);
            if (typeof y !== 'number' || !(y > 0) || !isCount(runsQueued) ||
                    (need.basis === S.DemandBasis.Stock && !isCount(r.stock))) {
                r.status = Status.Unreadable;
                continue;
            }

            var q = runsQueued * y;
            r.queued = q;

            if (need.owner === actFor && orderRuns) {
                var n = orderRuns(need);
                if (isRuns(n)) {
                    idleOrder(need, r, p, n);
                    continue;
                }
            }

            if (need.basis === S.DemandBasis.Stock) {
                if (r.stock >= need.items) { r.status = Status.Covered; continue; }
                if (q + r.stock >= need.items) { r.status = Status.Waiting; continue; }
            } else if (q >= need.items) {
                r.status = Status.Covered;
                continue;
            }

            var have = q + (need.basis === S.DemandBasis.Stock ? r.stock : 0);
            var runs = Math.ceil((need.items - have) / y);
            var own = { unit: need.item, count: runs, type: need.type };
            var s;

            if (need.owner !== actFor) {
                r.runs = runs;
                s = price(r, own);
                if (s === null) {
                    // Unpriceable runs are not reserved: every later price
                    // would come back null with them.
                    r.status = Status.Unreadable;
                    continue;
                }
                r.status = s.length > 0 ? Status.Short : Status.Waiting;
                taken.push(own);
                continue;
            }

            if (isHeld(p.kind, need.item)) { r.status = Status.Held; continue; }

            if (p.maxEntries !== null && p.maxEntries !== undefined) {
                var count = read.entryCount(need.type);
                if (!isCount(count)) { r.status = Status.Unreadable; continue; }
                if (count >= p.maxEntries) { r.status = Status.QueueFull; continue; }
            }

            // One order carries at most what the profile's shape allows; the
            // rest follows on a later pass.
            if (typeof p.perOrderMax === 'number' && runs > p.perOrderMax) runs = p.perOrderMax;
            own.count = runs;
            r.runs = runs;
            commit(need, r, own);
        }

        return { rows: rows, orders: orders };
    }

    S.core.production.plan = plan;

}(Steward));
