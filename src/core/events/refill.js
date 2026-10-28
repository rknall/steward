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
 * user_auto.js:4494-4522 calculateDeposits): one produced unit costs the
 * building's workTime seconds plus a round trip of 2 * route seconds to the
 * storehouse, so a field yields
 *   floor(remainingSeconds / (workTime + 2 * route))
 * units until the event ends. The field's current deposit already covers
 * part of that, hence units = max(0, yield - deposit). A refill item adds
 * unitsPerItem units; items are rounded up per field because every field
 * is refilled on its own.
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

    function units(remainingSec, workTime, routeSec, deposit) {
        if (!isNum(workTime) || workTime <= 0) return null;
        var t = isNum(remainingSec) ? remainingSec : 0;
        var route = isNum(routeSec) ? routeSec : 0;
        var dep = isNum(deposit) ? deposit : 0;
        return Math.max(0, Math.floor(t / (workTime + 2 * route)) - dep);
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
        var out = [];
        for (var b = 0; b < info.buildings.length; b++) {
            var name = info.buildings[b];
            var placed = [];
            try { placed = S.core.buildings.byName(name) || []; }
            catch (e) { placed = []; }
            var wt = safeWorkTime(name);
            var part = [];
            for (var i = 0; i < placed.length; i++) {
                var g = S.core.buildings.grid(placed[i]);
                if (g === null || typeof g === 'undefined') continue;
                var has = Object.prototype.hasOwnProperty.call(dm.map, g);
                part.push({
                    key:      'g' + g,
                    building: name,
                    grid:     g,
                    workTime: wt,
                    deposit:  has ? dm.map[g] : 0,
                    source:   has ? 'game' : 'manual'
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
            for (var n = 1; n <= per; n++) {
                out.push({
                    key:      name + '#' + n,
                    building: name,
                    grid:     null,
                    workTime: wt,
                    deposit:  0,
                    source:   'manual'
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

    // Pure: copies each row and adds units and items; input is not mutated.
    function compute(rowList, remainingSec, routeSec, unitsPerItem) {
        var out = [];
        var totalUnits = 0;
        var totalItems = 0;
        for (var i = 0; i < rowList.length; i++) {
            var copy = {};
            var src = rowList[i];
            for (var k in src) {
                if (Object.prototype.hasOwnProperty.call(src, k)) copy[k] = src[k];
            }
            var dep = isNum(src.deposit) ? src.deposit : 0;
            copy.units = units(remainingSec, src.workTime, routeSec, dep);
            copy.items = items(copy.units, unitsPerItem);
            if (copy.units !== null) {
                totalUnits += copy.units;
                totalItems += copy.items;
            }
            out.push(copy);
        }
        return { rows: out, totalUnits: totalUnits, totalItems: totalItems };
    }

    S.core.events.refill = {
        remainingSeconds: remainingSeconds,
        units:            units,
        items:            items,
        depositEvent:     depositEvent,
        rows:             rows,
        compute:          compute
    };

}(Steward));
