/*
 * Updater module.
 *
 * Registers the "Updates" Settings section (misc tab) and the ~Steward~ >
 * Updates submenu. It never enqueues queue work: the check and the install
 * run from the check-on-start in boot, from the buttons and from the menu.
 *
 * Every label and notification text comes from S.modules.updater.text at call
 * time. Only the registry metadata (section and menu titles) is literal here,
 * because register() runs at bundle load, before texts.js has loaded.
 *
 * Output goes to category 'updater' in the standard log file.
 */

(function (S) {

    if (!S.modules.updater) S.modules.updater = {};

    function isReady() { return false; }    // the updater never enqueues; boot, buttons and menu drive it
    function plan()    { /* no-op */ }

    // Each step in its own try: a failing seed must not skip the start check.
    function boot() {
        var U = S.modules.updater;
        try { U.seed(); }
        catch (e) { S.kernel.warn('updater', 'seed failed', e && e.message ? e.message : e); }
        try { U.check.onBoot(); }
        catch (e2) { S.kernel.warn('updater', 'boot check failed', e2 && e2.message ? e2.message : e2); }
    }

    function menuStatusLabel() {
        var U = S.modules.updater;
        return U.text.menuStatus(U.check.status());
    }

    function menuCheckLabel() {
        return S.modules.updater.text.menuCheck();
    }

    function menuOpenLabel() {
        var U = S.modules.updater;
        return U.text.menuOpen(U.check.status());
    }

    function onCheck() {
        var U = S.modules.updater;
        U.check.run({ manual: true }, function (status) {
            S.kernel.ui.notify(U.text.checkResult(status));
        });
    }

    function onOpen() {
        S.kernel.ui.openSettings('updater');
    }

    S.kernel.register({
        id:       'updater',
        priority: S.Priority.Idle,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        // Late-binding refs: ui.js and texts.js load after this file.
        ui: {
            tab: 'misc',
            section: {
                id:      'updater',
                title:   'Updates',
                heading: 'Updates',
                icon:    '⟳',
                render: function ($body, h) {
                    if (S.modules.updater.renderSection) {
                        return S.modules.updater.renderSection($body, h);
                    }
                },
                summary: function () {
                    return S.modules.updater.summary
                        ? S.modules.updater.summary()
                        : '';
                }
            }
        },
        menu: {
            title: 'Updates',
            items: [
                { label: menuStatusLabel, enabled: false },
                { label: menuCheckLabel,  onSelect: onCheck },
                { label: menuOpenLabel,   onSelect: onOpen }
            ]
        }
    });

}(Steward));
