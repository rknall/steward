/*
 * Event refill calculator (read-only).
 *
 * Event workyard fields (Halloween pumpkin fields, Valentine flower farms)
 * must be refilled with deposit units before the event's shop phase ends.
 * This file holds the arithmetic and the host reads that feed it; the
 * dashboard section in modules/eventcalc only renders the result. Nothing
 * here sends a server action or queues work.
 *
 * Formula (event wiki calculator, same totals as autoTSO
 * user_auto.js:4494-4522 calculateDeposits): one production cycle costs the
 * building's workTime seconds plus a round trip of 2 * route seconds to the
 * storehouse, so a field runs
 *   cycles = floor(remainingSeconds / (workTime + 2 * route))
 * cycles until the event shop closes. Each cycle removes one deposit unit
 * and delivers perCycle event resources (economy amountRemoved times the
 * building's base output factor). From that:
 *   - per 12 h  = 43200 / cycleSeconds * perCycle, the steady rate;
 *   - until end = cycles * perCycle, what the field yields if it is kept
 *     refilled until the shop closes;
 *   - refill    = max(0, cycles - deposit) in deposit units, because the
 *     current deposit already covers part of the cycles. A refill item adds
 *     unitsPerItem units; items are rounded up per field because every
 *     field is refilled on its own.
 * Buffed values use the host output factor (buffs included) instead of the
 * base factor: the rate while the buff holds, and until end with the extra
 * yield counted only for the cycles that fit into the buff's remaining
 * window. Buffs that change deposit consumption (input factor) are not
 * modelled, so the refill stays in unbuffed deposit units.
 *
 * Which buildings take part is data (core/events/data.js depositInfo). The
 * deposit is named like the event resource, and workTime comes from the
 * economy definition, so no placed field is needed to know the production
 * time. When the real fields cannot be read (friend island, host hiccup)
 * rows() returns editable template rows instead of failing.
 */

(function (S) {

    if (!S.core.events) S.core.events = {};

    function isNum(n) {
        return typeof n === 'number' && !isNaN(n);
    }

    function remainingSeconds(endMs, nowMs) {
        if (!isNum(endMs)) return null;
        var now = isNum(nowMs) ? nowMs : new Date().getTime();
        return Math.max(0, Math.floor((endMs - now) / 1000));
    }

    // Seconds in a 12 hour display window; a presentation constant, not game data.
    var HALF_DAY_SEC = 43200;

    function round2(x) {
        return Math.round(x * 100) / 100;
    }

    // Production cycles a field completes in remainingSec, or null when the
    // building's workTime is unknown.
    function cycles(remainingSec, workTime, routeSec) {
        if (!isNum(workTime) || workTime <= 0) return null;
        var t = isNum(remainingSec) ? remainingSec : 0;
        var route = isNum(routeSec) ? routeSec : 0;
        return Math.floor(t / (workTime + 2 * route));
    }

    function units(remainingSec, workTime, routeSec, deposit) {
        var c = cycles(remainingSec, workTime, routeSec);
        if (c === null) return null;
        var dep = isNum(deposit) ? deposit : 0;
        return Math.max(0, c - dep);
    }

    function items(unitCount, unitsPerItem) {
        if (!isNum(unitCount)) return null;
        var per = isNum(unitsPerItem) ? unitsPerItem : 1;
        return Math.ceil(unitCount / Math.max(1, per));
    }

    function depositInfoOf(code) {
        var ev = S.core.events.data && S.core.events.data.events &&
                 S.core.events.data.events[code];
        return (ev && ev.depositInfo) || null;
    }

    // The first live event that declares refillable buildings, or null.
    function depositEvent(nowMs) {
        var live;
        try { live = S.core.events.active(); }
        catch (e) { return null; }
        for (var i = 0; i < live.length; i++) {
            var info = depositInfoOf(live[i].code);
            if (!info || !info.buildings || !info.buildings.length) continue;
            var ends = live[i].endTimes || {};
            var end = ends.shop || live[i].endTime || null;
            return {
                code:         live[i].code,
                name:         live[i].name,
                resource:     S.core.events.eventResource(live[i].code),
                info:         info,
                endTime:      end,
                remainingSec: remainingSeconds(end, nowMs)
            };
        }
        return null;
    }

    function safeWorkTime(buildingName) {
        try { return S.core.buildings.workTime(buildingName); }
        catch (e) { return null; }
    }

    // Deposit units removed per cycle from the economy definition, default 1.
    function safeAmount(buildingName) {
        var a = null;
        try { a = S.core.buildings.amountPerCycle(buildingName); }
        catch (e) { a = null; }
        return (isNum(a) && a > 0) ? a : 1;
    }

    // Production fields of one placed building. The buff end is stored as an
    // absolute wall-clock time so a later redraw of the same rows (snapshot,
    // edited remaining time) still sees the window shrink correctly.
    function productionOf(amount, placed, readNow) {
        var base = null;
        var factor = null;
        var left = null;
        try { base = S.core.buildings.baseOutputFactor(placed); }
        catch (e) { base = null; }
        try { factor = S.core.buildings.outputFactor(placed); }
        catch (e2) { factor = null; }
        try { left = S.core.buildings.buffRemainingMs(placed); }
        catch (e3) { left = null; }
        if (!isNum(base) || base <= 0) base = 1;
        return {
            perCycle:       amount * base,
            buffedPerCycle: (isNum(factor) && factor > base) ? amount * factor : null,
            buffEndMs:      isNum(left) ? readNow + left : null
        };
    }

    // grid -> remaining deposit amount for the event resource.
    function depositMap(resource) {
        var map = {};
        var found = false;
        try {
            var list = S.core.deposits.byType(resource);
            for (var i = 0; i < list.length; i++) {
                var g = S.core.deposits.grid(list[i]);
                if (g === null || typeof g === 'undefined') continue;
                map[g] = S.core.deposits.amount(list[i]);
                found = true;
            }
        } catch (e) { /* no deposits readable: rows fall back to manual */ }
        return { map: map, found: found };
    }

    function gameRows(info, resource) {
        var dm = depositMap(resource);
        var readNow = new Date().getTime();
        var out = [];
        for (var b = 0; b < info.buildings.length; b++) {
            var name = info.buildings[b];
            var placed = [];
            try { placed = S.core.buildings.byName(name) || []; }
            catch (e) { placed = []; }
            var wt = safeWorkTime(name);
            var amount = safeAmount(name);
            var part = [];
            for (var i = 0; i < placed.length; i++) {
                var g = S.core.buildings.grid(placed[i]);
                if (g === null || typeof g === 'undefined') continue;
                var has = Object.prototype.hasOwnProperty.call(dm.map, g);
                // A field whose deposit is unreadable is still a real
                // building, so its buff is read all the same.
                var prod = productionOf(amount, placed[i], readNow);
                part.push({
                    key:            'g' + g,
                    building:       name,
                    grid:           g,
                    workTime:       wt,
                    deposit:        has ? dm.map[g] : 0,
                    source:         has ? 'game' : 'manual',
                    perCycle:       prod.perCycle,
                    buffedPerCycle: prod.buffedPerCycle,
                    buffEndMs:      prod.buffEndMs
                });
            }
            part.sort(function (x, y) { return x.grid - y.grid; });
            for (var p = 0; p < part.length; p++) out.push(part[p]);
        }
        return out;
    }

    function templateRows(info) {
        var per = info.fieldsPerType || 1;
        var out = [];
        for (var b = 0; b < info.buildings.length; b++) {
            var name = info.buildings[b];
            var wt = safeWorkTime(name);
            // No placed building: base factor 1 and no buff to read.
            var amount = safeAmount(name);
            for (var n = 1; n <= per; n++) {
                out.push({
                    key:            name + '#' + n,
                    building:       name,
                    grid:           null,
                    workTime:       wt,
                    deposit:        0,
                    source:         'manual',
                    perCycle:       amount,
                    buffedPerCycle: null,
                    buffEndMs:      null
                });
            }
        }
        return out;
    }

    // Rows for the calculator: one per placed field on the home island,
    // else editable template rows. Never throws.
    function rows(code) {
        var info = depositInfoOf(code);
        if (!info || !info.buildings || !info.buildings.length) {
            return { source: 'manual', rows: [] };
        }
        var list = [];
        try {
            if (S.core.zone.isHome()) {
                list = gameRows(info, S.core.events.eventResource(code));
            }
        } catch (e) {
            list = [];
        }
        if (!list.length) {
            try { list = templateRows(info); }
            catch (e2) { list = []; }
        }
        var source = 'manual';
        for (var i = 0; i < list.length; i++) {
            if (list[i].source === 'game') { source = 'game'; break; }
        }
        return { source: source, rows: list };
    }

    // Seconds the row's buff still covers within the remaining event time:
    // 0 when it has already ended, null when the row has no readable end.
    function buffWindowSec(buffEndMs, t, nowMs) {
        if (!isNum(buffEndMs)) return null;
        return Math.min(t, Math.max(0, Math.floor((buffEndMs - nowMs) / 1000)));
    }

    // Pure: copies each row and adds cycles, production (unbuffed and, when a
    // buff is active, buffed), units and items; input is not mutated.
    // nowMs (default now) dates the rows' absolute buff end.
    function compute(rowList, remainingSec, routeSec, unitsPerItem, nowMs) {
        var now = isNum(nowMs) ? nowMs : new Date().getTime();
        var t = isNum(remainingSec) ? remainingSec : 0;
        var route = isNum(routeSec) ? routeSec : 0;
        var out = [];
        var totalDeposit = 0;
        var totalUnits = 0;
        var totalItems = 0;
        var rateSum = 0;
        var rateBuffedSum = 0;
        var anyRateBuffed = false;
        var totalUntilEnd = 0;
        var untilEndBuffedSum = 0;
        var anyUntilEndBuffed = false;
        for (var i = 0; i < rowList.length; i++) {
            var copy = {};
            var src = rowList[i];
            for (var k in src) {
                if (Object.prototype.hasOwnProperty.call(src, k)) copy[k] = src[k];
            }
            var dep = isNum(src.deposit) ? src.deposit : 0;
            totalDeposit += dep;
            copy.cycles = cycles(t, src.workTime, route);
            copy.rate12h = null;
            copy.rate12hBuffed = null;
            copy.untilEnd = null;
            copy.untilEndBuffed = null;
            if (copy.cycles !== null) {
                var cycleSec = src.workTime + 2 * route;
                var per = isNum(src.perCycle) ? src.perCycle : 1;
                var rawRate = HALF_DAY_SEC / cycleSec * per;
                var rawBuffed = null;
                copy.rate12h = round2(rawRate);
                copy.untilEnd = copy.cycles * per;
                var bpc = src.buffedPerCycle;
                if (isNum(bpc) && bpc > per) {
                    var w = buffWindowSec(src.buffEndMs, t, now);
                    if (w === null) {
                        // Buffed, but no readable window: only the rate is known.
                        rawBuffed = HALF_DAY_SEC / cycleSec * bpc;
                    } else if (w > 0) {
                        rawBuffed = HALF_DAY_SEC / cycleSec * bpc;
                        var buffedCycles = Math.min(copy.cycles, Math.floor(w / cycleSec));
                        copy.untilEndBuffed = copy.untilEnd + buffedCycles * (bpc - per);
                    }
                    // w === 0: the buff ended since it was read; row is unbuffed.
                }
                if (rawBuffed !== null) {
                    copy.rate12hBuffed = round2(rawBuffed);
                    anyRateBuffed = true;
                }
                rateSum += rawRate;
                rateBuffedSum += rawBuffed !== null ? rawBuffed : rawRate;
                totalUntilEnd += copy.untilEnd;
                if (copy.untilEndBuffed !== null) anyUntilEndBuffed = true;
                untilEndBuffedSum += copy.untilEndBuffed !== null ?
                    copy.untilEndBuffed : copy.untilEnd;
            }
            copy.units = units(t, src.workTime, route, dep);
            copy.items = items(copy.units, unitsPerItem);
            if (copy.units !== null) {
                totalUnits += copy.units;
                totalItems += copy.items;
            }
            out.push(copy);
        }
        return {
            rows:                out,
            totalDeposit:        totalDeposit,
            totalRate12h:        round2(rateSum),
            totalRate12hBuffed:  anyRateBuffed ? round2(rateBuffedSum) : null,
            totalUntilEnd:       totalUntilEnd,
            totalUntilEndBuffed: anyUntilEndBuffed ? untilEndBuffedSum : null,
            totalUnits:          totalUnits,
            totalItems:          totalItems
        };
    }

    S.core.events.refill = {
        remainingSeconds: remainingSeconds,
        cycles:           cycles,
        units:            units,
        items:            items,
        depositEvent:     depositEvent,
        rows:             rows,
        compute:          compute
    };

}(Steward));
