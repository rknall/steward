/*
 * Event calculator module.
 *
 * Read-only. Renders inside the dashboard's Events tab as an "Event
 * calculator" section (explorer event-item estimate + refill calculator for
 * event fields) and adds an "Events" submenu to the native ~Steward~ menu.
 *
 * Never enqueues queue work. Never calls SendServerAction. All game reads
 * go through S.core.*; this module only formats them. Safe to leave
 * registered in production (diagnostics precedent).
 */

(function (S) {

    if (!S.modules.eventcalc) S.modules.eventcalc = {};

    function isReady() { return false; }    // a calculator never enqueues work
    function plan()    { /* no-op */ }

    // Seed defaults eagerly so the dashboard buffer starts from a complete
    // object and Save persists both keys even if only one was edited.
    function boot() {
        if (!S.kernel.settings.read('eventcalc')) {
            S.kernel.settings.write('eventcalc', S.modules.eventcalc.defaultSettings);
        }
    }

    S.kernel.register({
        id:       'eventcalc',
        priority: S.Priority.Idle,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        // Late-binding refs — ui.js loads after this file.
        ui: {
            tab: 'events',
            section: {
                id:    'eventcalc',
                title: 'Event calculator',
                icon:  '⚑',
                render: function ($body, h) {
                    if (S.modules.eventcalc.renderSection) {
                        return S.modules.eventcalc.renderSection($body, h);
                    }
                }
            }
        },
        menu: {
            title: 'Events',
            items: [
                {
                    label: 'Event calculator…',
                    onSelect: function () {
                        // A fresh open re-reads the fields instead of
                        // showing edits from an earlier session.
                        if (S.modules.eventcalc.resetSession) {
                            S.modules.eventcalc.resetSession();
                        }
                        S.kernel.ui.openDashboard('events');
                    }
                },
                {
                    label: 'Estimate event items',
                    onSelect: function () {
                        if (S.modules.eventcalc.showEstimateAlert) {
                            S.modules.eventcalc.showEstimateAlert();
                        }
                    }
                }
            ]
        }
    });

}(Steward));
