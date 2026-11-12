/*
 * Production demand ledger: who wants which production items, and who holds
 * a kind or an item back from everyone else.
 *
 * Several owners order into the same host queues: standing orders, adventure
 * runs and quests. The ledger is where each states what it needs, so the
 * planner can price every need against one resource pool in priority order
 * instead of each owner spending the warehouse on its own.
 *
 * Three kinds of entry:
 *   - needs:     put(owner, key, need), stamped with clock(). A requester
 *                re-puts every pass; an entry not re-put within TTL_MS is
 *                gone, so an owner that stops running stops reserving.
 *   - holds:     hold(owner, key, h), with the same TTL. A hold names a
 *                production kind (S.ProductionKind) or one item that other
 *                owners must not order while it is live.
 *   - providers: provide(owner, fn) is pulled on every read. State that
 *                persists elsewhere (a paused run whose module plan does not
 *                run) is reported through it without any re-put.
 *
 * need = { label, type, item, items, basis, priority }: `items` is a positive
 * integer count of items, `basis` is one value of S.DemandBasis (Queue: keep N
 * queued, Stock: have N in stock) and `priority` one value of S.ProductionPriority.
 *
 * Every read returns copies, so a caller cannot change the stored entries.
 * The ledger knows nothing about queues or buildings; isHeld takes the
 * profile kind from its caller.
 *
 * State is memory only and built fresh each time this file runs, so a script
 * reload empties every need, hold and provider; owners re-put on their next
 * pass and re-register at load.
 *
 * Bundle slot: core, under core/production/ and, like every file there,
 * before production.js. The top level only assigns
 * S.core.production.demand; S.ProductionPriority (kernel) is read at call
 * time.
 */

(function (S) {

    if (!S.core.production) S.core.production = {};

    // Two plan passes of slack: one late pass must not drop a live need.
    var TTL_MS = 120000;

    var CATEGORY = 'production';

    var needs     = {};   // owner -> key -> stored need
    var holdMap   = {};   // owner -> key -> stored hold
    var providers = {};   // owner -> fn
    var warned    = {};   // owner -> true once its provider failure was logged

    var api = {};

    function has(o, k) {
        return Object.prototype.hasOwnProperty.call(o, k);
    }

    function missing(v) {
        return v === null || v === undefined || v === '';
    }

    function isPriority(p) {
        var all = S.ProductionPriority;
        if (!all || typeof p !== 'number') return false;
        for (var k in all) {
            if (has(all, k) && all[k] === p) return true;
        }
        return false;
    }

    function isBasis(v) {
        var all = S.DemandBasis;
        if (!all) return false;
        for (var k in all) {
            if (has(all, k) && all[k] === v) return true;
        }
        return false;
    }

    // null when the need is usable, else the reason it is not.
    function needProblem(owner, key, n) {
        if (missing(owner) || missing(key)) return 'missing owner or key';
        if (!n || typeof n !== 'object') return 'no need';
        if (typeof n.items !== 'number' || !isFinite(n.items) ||
            Math.floor(n.items) !== n.items || n.items <= 0) {
            return 'items ' + n.items + ' is not a positive integer';
        }
        if (!isPriority(n.priority)) return 'priority ' + n.priority + ' is unknown';
        if (!isBasis(n.basis)) return 'basis ' + n.basis + ' is unknown';
        return null;
    }

    function holdProblem(owner, key, h) {
        if (missing(owner) || missing(key)) return 'missing owner or key';
        if (!h || typeof h !== 'object') return 'no hold';
        if (missing(h.kind) && missing(h.item)) return 'hold names neither kind nor item';
        return null;
    }

    function needRow(owner, key, n) {
        return {
            owner:    String(owner),
            key:      String(key),
            label:    n.label,
            type:     n.type,
            item:     n.item,
            items:    n.items,
            basis:    n.basis,
            priority: n.priority
        };
    }

    function holdRow(owner, key, h) {
        return {
            owner: String(owner),
            key:   String(key),
            label: h.label,
            kind:  missing(h.kind) ? null : h.kind,
            item:  missing(h.item) ? null : h.item
        };
    }

    function put(owner, key, need) {
        var why = needProblem(owner, key, need);
        if (why) {
            S.kernel.warn(CATEGORY, 'demand put ' + owner + '/' + key + ' ignored: ' + why);
            return false;
        }
        var row = needRow(owner, key, need);
        row.at = api.clock();
        if (!has(needs, row.owner)) needs[row.owner] = {};
        needs[row.owner][row.key] = row;
        return true;
    }

    function hold(owner, key, h) {
        var why = holdProblem(owner, key, h);
        if (why) {
            S.kernel.warn(CATEGORY, 'demand hold ' + owner + '/' + key + ' ignored: ' + why);
            return false;
        }
        var row = holdRow(owner, key, h);
        row.at = api.clock();
        if (!has(holdMap, row.owner)) holdMap[row.owner] = {};
        holdMap[row.owner][row.key] = row;
        return true;
    }

    function drop(owner, key) {
        owner = String(owner);
        if (has(needs, owner)) delete needs[owner][String(key)];
    }

    // The provider stays registered: it reports state the owner keeps
    // elsewhere and is removed only through provide(owner, null).
    function dropOwner(owner) {
        owner = String(owner);
        delete needs[owner];
        delete holdMap[owner];
    }

    function provide(owner, fn) {
        if (missing(owner)) return;
        owner = String(owner);
        delete warned[owner];
        if (typeof fn === 'function') providers[owner] = fn;
        else delete providers[owner];
    }

    // Live stored rows of one map as copies; expired rows are pruned here.
    function liveRows(map, copy) {
        var now = api.clock();
        var out = [];
        for (var owner in map) {
            if (!has(map, owner)) continue;
            var byKey = map[owner];
            var left = 0;
            for (var key in byKey) {
                if (!has(byKey, key)) continue;
                var r = byKey[key];
                if (now - r.at >= TTL_MS) {
                    delete byKey[key];
                    continue;
                }
                left++;
                out.push(copy(r));
            }
            if (!left) delete map[owner];
        }
        return out;
    }

    function warnOnce(owner, what) {
        if (warned[owner]) return;
        warned[owner] = true;
        S.kernel.warn(CATEGORY, 'demand provider ' + owner + ' ' + what);
    }

    // One pull of every provider: { owner: { needs, holds } } with only valid
    // entries. A provider that throws or returns bad entries is logged once
    // and contributes nothing it cannot back.
    function pull(field) {
        var out = [];
        for (var owner in providers) {
            if (!has(providers, owner)) continue;
            var got;
            try {
                got = providers[owner]();
            } catch (e) {
                warnOnce(owner, 'threw: ' + e);
                continue;
            }
            var list = got && got[field];
            if (!list) continue;
            if (typeof list.length !== 'number') {
                warnOnce(owner, 'returned ' + field + ' that is not a list');
                continue;
            }
            for (var i = 0; i < list.length; i++) {
                var e2 = list[i];
                var key = e2 && e2.key;
                var why = field === 'needs' ? needProblem(owner, key, e2) : holdProblem(owner, key, e2);
                if (why) {
                    warnOnce(owner, 'returned a bad entry: ' + why);
                    continue;
                }
                out.push(field === 'needs' ? needRow(owner, key, e2) : holdRow(owner, key, e2));
            }
        }
        return out;
    }

    function byOwnerKey(a, b) {
        if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1;
        if (a.key !== b.key) return a.key < b.key ? -1 : 1;
        return 0;
    }

    function copyNeed(r) { return needRow(r.owner, r.key, r); }
    function copyHold(r) { return holdRow(r.owner, r.key, r); }

    // Live needs, most urgent first: the planner prices them in this order.
    function list() {
        var out = liveRows(needs, copyNeed).concat(pull('needs'));
        out.sort(function (a, b) {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return byOwnerKey(a, b);
        });
        return out;
    }

    function holds() {
        var out = liveRows(holdMap, copyHold).concat(pull('holds'));
        out.sort(byOwnerKey);
        return out;
    }

    // The first live hold of another owner that covers this item or kind, or
    // null. An owner never blocks itself: its own holds guard its own work.
    function isHeld(kind, item, exceptOwner) {
        var all = holds();
        var except = missing(exceptOwner) ? null : String(exceptOwner);
        for (var i = 0; i < all.length; i++) {
            var h = all[i];
            if (except !== null && h.owner === except) continue;
            if (h.item !== null && !missing(item) && h.item === item) return h;
            if (h.kind !== null && !missing(kind) && h.kind === kind) return h;
        }
        return null;
    }

    api.TTL_MS    = TTL_MS;
    // Overridable so tests can move time; read at every call.
    api.clock     = function () { return Date.now(); };
    api.put       = put;
    api.drop      = drop;
    api.dropOwner = dropOwner;
    api.hold      = hold;
    api.provide   = provide;
    api.list      = list;
    api.holds     = holds;
    api.isHeld    = isHeld;

    S.core.production.demand = api;

}(Steward));
