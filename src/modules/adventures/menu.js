/*
 * Adventures submenu of the native ~Steward~ menu.
 *
 * Layout: "Run templates…", the run status line, "Pause run", "Resume
 * run", "End repetition", "Stop run", then one entry per readable template
 * labelled with the maps available for its adventure. Choosing a template
 * starts a run of it. Every row only changes run state; the
 * scheduler's plan() does the work. The list is flat instead of grouped by
 * adventure category: grouping needs the adventure definitions, which are
 * empty while the game is not loaded at menu build, so the groups would
 * change after load. Template labels are user-chosen and sorted, so a flat
 * list stays readable.
 *
 * Scenarios follow the templates after a separator, one row per scenario
 * with its map count, plus a disabled row per broken scenario file so the
 * user sees why it is missing. With no scenarios the list is the template
 * list alone.
 *
 * Rebuilding the submenu leaks native objects in AIR, so sync() rebuilds it
 * only when the set of templates or scenarios changed, and only user actions
 * (saving or deleting a template, opening the dialog) call it. Every call
 * into the other adventures parts is late-bound because a script reload may
 * replace them.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    // Signature of the templates and scenarios the last items() call listed.
    var lastSignature = null;

    function records() {
        var all = S.modules.adventures.templates.list();
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i].error === undefined) out.push(all[i]);
        }
        return out;
    }

    // Every scenario entry, broken ones included; empty when the store is not
    // loaded.
    function scenarioEntries() {
        var sc = S.modules.adventures.scenarios;
        return sc && sc.list ? sc.list() : [];
    }

    // recs: the readable templates; scens: the scenario entries, whose parts
    // are prefixed so a scenario never matches a template of the same id.
    function signature(recs, scens) {
        var parts = [];
        var i;
        for (i = 0; i < recs.length; i++) {
            parts.push(recs[i].id + '\t' + recs[i].label + '\t' + recs[i].adventure);
        }
        scens = scens || [];
        for (i = 0; i < scens.length; i++) {
            parts.push('s:' + scens[i].id + '\t' + (scens[i].error !== undefined ? '!'
                : scens[i].label + '\t' + scens[i].adventure));
        }
        return parts.join('\n');
    }

    // A function, so each entry captures its own rec (ES5 has no block scope).
    function templateItem(rec) {
        return {
            label: function (pass) {
                var run = S.modules.adventures.run;
                return rec.label + ' ×' + (run ? run.available(rec.adventure, pass) : 0);
            },
            onSelect: function () {
                var run = S.modules.adventures.run;
                if (run) run.start(rec.id);
            }
        };
    }

    // A broken scenario file is listed disabled, so the user sees it is there.
    function scenarioItem(rec) {
        if (rec.error !== undefined) return { label: rec.id + ': broken scenario file', enabled: false };
        return {
            label: function (pass) {
                var run = S.modules.adventures.run;
                return rec.label + ' ×' + (run ? run.available(rec.adventure, pass) : 0);
            },
            onSelect: function () {
                var run = S.modules.adventures.run;
                if (run) run.startScenario(rec.id);
            }
        };
    }

    // A row that calls one run command, looked up when chosen so a reloaded
    // run.js is the one called.
    function command(label, name) {
        return {
            label: label,
            onSelect: function () {
                var run = S.modules.adventures.run;
                if (run) run[name]();
            }
        };
    }

    // The run commands, in menu order. The one place their labels and run.js
    // names are written; the Adventures bar menu reads the same table.
    var COMMANDS = [
        { label: 'Pause run',      name: 'pause' },
        { label: 'Resume run',     name: 'resume' },
        { label: 'End repetition', name: 'endRepetition' },
        { label: 'Stop run',       name: 'stop' }
    ];

    function commandItems() {
        var out = [];
        for (var i = 0; i < COMMANDS.length; i++) out.push(command(COMMANDS[i].label, COMMANDS[i].name));
        return out;
    }

    function items() {
        var recs = records();
        var scens = scenarioEntries();
        lastSignature = signature(recs, scens);

        var list = [
            {
                label: 'Run templates…',
                onSelect: function () {
                    if (S.modules.adventures.dialog) S.modules.adventures.dialog.open();
                }
            },
            { separator: true },
            {
                label: function () {
                    var state = S.modules.adventures.state;
                    return state ? state.status() : '';
                },
                enabled: false
            },
            { separator: true }
        ];
        // After the status line (index 2), before the closing separator.
        list.splice.apply(list, [3, 0].concat(commandItems()));

        if (recs.length === 0) {
            list.push({ label: 'No templates yet', enabled: false });
        } else {
            for (var i = 0; i < recs.length; i++) list.push(templateItem(recs[i]));
        }
        if (scens.length) list.push({ separator: true });
        for (var n = 0; n < scens.length; n++) list.push(scenarioItem(scens[n]));
        return list;
    }

    // Rebuilds the submenu when the template or scenario set differs from the
    // last build.
    function sync() {
        if (signature(records(), scenarioEntries()) === lastSignature) return false;
        var ui = S.kernel.ui;
        return ui && ui.refreshModuleMenu ? ui.refreshModuleMenu('adventures') : false;
    }

    S.modules.adventures.menu = {
        items:     items,
        sync:      sync,
        signature: signature,
        command:   command,
        COMMANDS:  COMMANDS
    };

}(Steward));
