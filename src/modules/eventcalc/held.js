/*
 * Held event resources for the eventcalc module's Events tab.
 *
 * heldCard(h) draws one flat table (Resource, Event, Amount) of the event
 * resources the player holds, whether or not an event is live: the live
 * event's row carries a Live badge, a zero amount is greyed, an unreadable
 * amount shows a muted dash (never 0). Only resources that belong to a
 * known event (a base code in the data table) are listed; the host also flags
 * relics and collectibles, which are not event currencies the player refills.
 * heldTile() is the Overview tile hook; the Overview shows no tile for held
 * resources, so it answers null.
 *
 * All game reads go through S.core.*; nothing here touches `game`.
 *
 * Bundle slot: modules load in name order per directory, so this file loads
 * before module.js, settings.js and ui.js. It only assigns on
 * S.modules.eventcalc at load; ui.js calls it at render time.
 */

(function (S) {

    if (!S.modules.eventcalc) S.modules.eventcalc = {};

    function held() {
        try {
            var res = S.core.events.heldResources();
            return (res && res.rows) || [];
        } catch (e) {
            S.kernel.warn('eventcalc', 'heldResources threw:', e);
            return [];
        }
    }

    function resLabel(resource) {
        try { return S.core.locale.res(resource) || resource; }
        catch (e) { return resource; }
    }

    function eventLabel(row) {
        var ev = S.core.events.data && S.core.events.data.events;
        var entry = ev && row.code ? ev[row.code] : null;
        return (entry && entry.name) || row.code || '';
    }

    // Rows the card lists: a resource tied to a known event only.
    function shownRows() {
        var all = held();
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i] && all[i].code) out.push(all[i]);
        }
        return out;
    }

    function muted(text) {
        return $('<span>', { 'class': 'steward-muted' }).text(text);
    }

    function heldCard(h) {
        var $card = h.card({ title: 'Event resources' });
        var rows = shownRows();
        if (!rows.length) return $card.append(h.empty('No event resources held.'));

        var body = [];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var known = typeof r.amount === 'number' && !isNaN(r.amount);
            var zero = known && r.amount === 0;
            var name = resLabel(r.resource);
            var $ev = $('<span>').text(eventLabel(r));
            if (r.live) $ev.append(' ').append(h.badge('ok', 'Live'));
            body.push([
                { $: zero ? muted(name) : $('<span>').text(name), title: name },
                $ev,
                { $: known ? (zero ? muted('0') : $('<span>').text(String(r.amount)))
                           : muted('—') }
            ]);
        }
        return $card.append(h.table({
            cols: [
                { label: 'Resource' },
                { label: 'Event' },
                { label: 'Amount', cls: 'steward-num' }
            ],
            rows: body
        }));
    }

    function heldTile() {
        return null;
    }

    S.modules.eventcalc.heldCard = heldCard;
    S.modules.eventcalc.heldTile = heldTile;

}(Steward));
