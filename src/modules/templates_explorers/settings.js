/*
 * Default settings for the templates_explorers module.
 *
 * Stores per-explorer task assignments under steward.templates_explorers.
 * The shape is:
 *
 *   {
 *     enabled:       true,
 *     overrides:     { '<explorer name>': 'TaskExplorerShort', ... },
 *     dispatchDelay: 5000      // ms between sends to the same explorer
 *   }
 *
 * Naming the override map by explorer NAME (not by GetType) is intentional:
 *   - The host's mainSettings.explDefTaskByType uses GetType keys, but
 *     names are friendlier for users editing settings.json by hand.
 *   - core/specialists.pickTask already consults the host's by-type map
 *     as the first precedence step. This module's by-name overrides are
 *     applied AFTER pickTask returns, before dispatch. So a user can
 *     either set defaults globally via the host's UI or override
 *     per-explorer here.
 */

(function (S) {

    if (!S.modules.templates_explorers) S.modules.templates_explorers = {};

    S.modules.templates_explorers.defaultSettings = {
        enabled:       false,        // off by default — must be explicitly turned on
        overrides:     {},           // { 'Snowy Explorer': 'TaskExplorerShort', ... }
        // Delay between dispatch actions. Match the kernel's default queue
        // gap so a roster of 300 explorers takes ~7-8 minutes rather than
        // 25. The kernel still pace-protects against server flooding.
        dispatchDelay: 1500
    };

}(Steward));
