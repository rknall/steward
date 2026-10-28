/*
 * Default settings for the eventcalc module.
 *
 * Stored under steward.eventcalc. Shape:
 *
 *   {
 *     routeSeconds: 6,
 *     unitsPerItem: 1
 *   }
 *
 * `routeSeconds` is the one-way walk in seconds between an event field and
 * the storehouse. Every produced unit costs a round trip on top of the
 * field's production time. 6 is the event wiki calculator's default.
 *
 * `unitsPerItem` is how many deposit units one "Fill up" item adds to a
 * field. The in-client buff text says 1; it stays editable in case an
 * event ships a bigger refill item.
 *
 * There is no `enabled` key: the module is a read-only calculator that
 * never runs on the scheduler tick, so it has nothing to switch on or off
 * and gets no quick toggle in the native menu.
 *
 * Remaining time and per-field deposit edits are deliberately not stored
 * here; they describe the current moment and are kept for the dashboard
 * session only.
 */

(function (S) {

    if (!S.modules.eventcalc) S.modules.eventcalc = {};

    S.modules.eventcalc.defaultSettings = {
        routeSeconds: 6,
        unitsPerItem: 1
    };

}(Steward));
