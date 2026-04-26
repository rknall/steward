/*
 * Diagnostics module.
 *
 * Read-only. Exposes a "Steward → Diagnostics" submenu with one-shot
 * inspectors that dump kernel/host/specialist state to the standard logger.
 *
 * Never enqueues queue work. Never calls SendServerAction. Safe to leave
 * enabled in production.
 *
 * Output goes to category 'diag' in the standard log file.
 */

(function (S) {

    if (!S.modules.diagnostics) S.modules.diagnostics = {};

    function isReady() { return false; }    // diagnostics never enqueues — only the menu items do
    function plan()    { /* no-op */ }

    function boot() {
        if (S.modules.diagnostics.renderMenu) S.modules.diagnostics.renderMenu();
    }

    S.kernel.register({
        id:       'diagnostics',
        priority: S.Priority.Idle,
        boot:     boot,
        isReady:  isReady,
        plan:     plan
    });

}(Steward));
