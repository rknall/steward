/*
 * Active events and their per-task modifiers.
 *
 * core/specialists.pickTask and pickDeposits consult these so modules don't
 * need event-awareness themselves. The data layer is in core/events/data.js;
 * this file is the API.
 *
 * v0.1 ships with no live event data. active() returns []; the rest of the
 * surface returns sensible defaults until data lands.
 */

(function (S) {

    function table() {
        return (S.core.events.data && S.core.events.data.events) || {};
    }

    function active() {
        var out = [];
        var t = table();
        var now = Date.now();
        var keys = Object.keys(t);
        for (var i = 0; i < keys.length; i++) {
            var ev = t[keys[i]];
            if (!ev) continue;
            // If start/end aren't specified, treat as "always active".
            var startOk = !ev.startTime || ev.startTime <= now;
            var endOk   = !ev.endTime   || ev.endTime   >= now;
            if (startOk && endOk) {
                out.push({
                    code:      keys[i],
                    name:      ev.name || keys[i],
                    category:  ev.category || null,
                    startTime: ev.startTime || null,
                    endTime:   ev.endTime   || null
                });
            }
        }
        return out;
    }

    function isActive(code) {
        var t = table();
        if (!t[code]) return false;
        var now = Date.now();
        var ev = t[code];
        if (ev.startTime && ev.startTime > now) return false;
        if (ev.endTime   && ev.endTime   < now) return false;
        return true;
    }

    function treasureValues(code) {
        var ev = table()[code];
        if (!ev || !ev.treasureValues) return [];
        return ev.treasureValues.slice();
    }

    function depositModifier(code, depositType) {
        var ev = table()[code];
        if (!ev || !ev.depositModifier) return 1;
        var v = ev.depositModifier[depositType];
        return typeof v === 'number' ? v : 1;
    }

    function byCategory(category) {
        var all = active();
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i].category === category) out.push(all[i]);
        }
        return out;
    }

    // Initialize the namespace if data.js loaded first.
    if (!S.core.events) S.core.events = {};

    S.core.events.active           = active;
    S.core.events.isActive         = isActive;
    S.core.events.treasureValues   = treasureValues;
    S.core.events.depositModifier  = depositModifier;
    S.core.events.byCategory       = byCategory;

}(Steward));
