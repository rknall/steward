/*
 * Adventures submenu of the native ~Steward~ menu.
 *
 * Layout: "Run templates…", the run status line, "Pause run", "Resume
 * run", "End repetition", "Stop run", then the templates in category
 * folders (Missions, Mini-missions, Co-op missions, Ventures, Events,
 * Other), a separator and one Scenarios folder. An adventure with a host
 * campaign gets a sub-folder named after it inside its folder, listed above
 * the loose entries. A folder exists only when it holds an entry. Choosing a
 * template or scenario starts a run of it. Every row only changes run state;
 * the scheduler's plan() does the work.
 *
 * Where an adventure belongs comes from S.core.adventures.folderPath (host
 * type, campaign and requiresEvent, with an Other fallback that names the
 * raw host type), so the menu restates no rule. Those values come from the
 * game's adventure definitions, which are empty while the game is still
 * loading at menu build. Until they are readable the menu shows one greyed
 * "Templates (loading…)" row and, after a separator, one greyed "Scenarios
 * (loading…)" row instead of folders that would move after load.
 *
 * Every template and scenario row is labelled with the maps available for
 * its adventure and is greyed when there is none. A pass where the star menu
 * cannot be read (×?) keeps the row's last readable state, so rows do not
 * flicker grey; a row never read yet is greyed. A click on a row that is
 * still enabled from an older reading ends in run.js's own notice. A
 * disabled row per broken scenario file sits last in Scenarios so the user
 * sees why it is missing.
 *
 * Rebuilding the submenu leaks native objects in AIR, so sync() rebuilds it
 * only when the set of templates or scenarios, or their folders, changed,
 * and user actions (saving or deleting a template, opening the dialog) call
 * it. The one rebuild not caused by a user action happens when a loading row
 * first finds the definitions readable: a single leak, guarded once per
 * bundle instance, never periodic, and deferred out of the status refresh
 * that is iterating the rows the rebuild replaces. Every call into the other
 * adventures parts and into S.core.adventures is late-bound because a script
 * reload may replace them.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    // Signature of the templates and scenarios the last items() call listed.
    var lastSignature = null;

    // Set once the menu has been built with folders or a loading row has
    // asked for the rebuild into them; never reset, so this bundle instance
    // rebuilds by itself at most once.
    var regrouped = false;

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

    // The game's adventure definitions, read quietly because the loading
    // rows probe them on every status tick before the game has loaded.
    function readDefinitions() {
        var core = S.core.adventures;
        return core && core.definitions ? core.definitions(true) : [];
    }

    // The definitions by name, or null while none are readable.
    function readIndex() {
        var defs = readDefinitions();
        return defs.length > 0 ? S.core.adventures.byName(defs) : null;
    }

    function defOf(index, adventure) {
        return index.hasOwnProperty(adventure) ? index[adventure] : null;
    }

    // Folder path of one adventure, '?' while the definitions are not
    // readable (index null), so the signature changes once they are.
    function pathKey(index, adventure, scenario) {
        if (!index) return '?';
        return S.core.adventures.folderPath(defOf(index, adventure), scenario).join('/');
    }

    // recs: the readable templates; scens: the scenario entries, whose parts
    // are prefixed so a scenario never matches a template of the same id;
    // index: the definitions by name, or null while they are not readable.
    function signature(recs, scens, index) {
        var parts = [];
        var i;
        index = index || null;
        for (i = 0; i < recs.length; i++) {
            parts.push(recs[i].id + '\t' + recs[i].label + '\t' + recs[i].adventure + '\t'
                + pathKey(index, recs[i].adventure, false));
        }
        scens = scens || [];
        for (i = 0; i < scens.length; i++) {
            parts.push('s:' + scens[i].id + '\t' + (scens[i].error !== undefined ? '!'
                : scens[i].label + '\t' + scens[i].adventure + '\t'
                    + pathKey(index, scens[i].adventure, true)));
        }
        return parts.join('\n');
    }

    // A map count of null means the star menu could not be read.
    function countText(n) {
        return n === null ? '?' : String(n);
    }

    function mapsOf(adventure, pass) {
        var run = S.modules.adventures.run;
        return run ? run.available(adventure, pass) : 0;
    }

    // A template or scenario row. Label and enabled read the same pass, so
    // one pass costs one star-menu read. `on` is the last readable state:
    // an unreadable pass leaves it, and a row never read yet stays greyed.
    // A function, so each row captures its own state (ES5 has no block scope).
    function mapRow(text, adventure, onSelect) {
        var on = false;
        return {
            label: function (pass) {
                return text + ' ×' + countText(mapsOf(adventure, pass));
            },
            enabled: function (pass) {
                var n = mapsOf(adventure, pass);
                if (n !== null) on = n > 0;
                return on;
            },
            onSelect: onSelect
        };
    }

    function templateItem(rec) {
        return mapRow(rec.label, rec.adventure, function () {
            var run = S.modules.adventures.run;
            if (run) run.start(rec.id);
        });
    }

    // A broken scenario file is listed disabled, so the user sees it is there.
    function scenarioItem(rec) {
        if (rec.error !== undefined) return { label: rec.id + ': broken scenario file', enabled: false };
        return mapRow(rec.label, rec.adventure, function () {
            var run = S.modules.adventures.run;
            if (run) run.startScenario(rec.id);
        });
    }

    // Turns [{ path, item }] into menu items. Nodes are made only on insert,
    // so no folder is ever empty. A node lists its sub-folders first, then
    // its entries in insertion order.
    function tree(rows) {
        var root = { label: '', folders: [], entries: [] };
        for (var i = 0; i < rows.length; i++) {
            var node = root;
            var path = rows[i].path;
            for (var p = 0; p < path.length; p++) node = childOf(node, path[p]);
            node.entries.push(rows[i].item);
        }
        return emit(root, 0);
    }

    function childOf(node, label) {
        for (var i = 0; i < node.folders.length; i++) {
            if (node.folders[i].label === label) return node.folders[i];
        }
        var child = { label: label, folders: [], entries: [] };
        node.folders.push(child);
        return child;
    }

    // Top-level folders keep the core's fixed order (labels it does not
    // know after them, by label); deeper folders sort by label.
    function emit(node, depth) {
        var order = depth === 0 ? S.core.adventures.folderOrder() : [];
        var folders = node.folders.slice();
        folders.sort(function (a, b) {
            var ia = order.indexOf(a.label);
            var ib = order.indexOf(b.label);
            if (ia === -1) ia = order.length;
            if (ib === -1) ib = order.length;
            if (ia !== ib) return ia - ib;
            return String(a.label).localeCompare(String(b.label));
        });
        var out = [];
        for (var i = 0; i < folders.length; i++) {
            out.push({ label: folders[i].label, items: emit(folders[i], depth + 1) });
        }
        for (var n = 0; n < node.entries.length; n++) out.push(node.entries[n]);
        return out;
    }

    // A greyed placeholder shown while the definitions are not readable. Its
    // label never changes, so the status tick writes nothing to it; the label
    // function only lets it watch for the definitions.
    function loadingRow(text) {
        return {
            label: function (pass) {
                watchLoad(pass);
                return text;
            },
            enabled: false
        };
    }

    // Probes the definitions once per pass (both loading rows share it) and,
    // the first time they are readable, asks for the rebuild into folders.
    function watchLoad(pass) {
        if (regrouped) return;
        pass = pass || {};
        if (pass.loadProbed) return;
        pass.loadProbed = true;
        if (readDefinitions().length === 0) return;
        regrouped = true;
        setTimeout(regroup, 0);
    }

    // Late-bound, so after a script reload the current menu decides by its
    // own signature whether the rebuild is still needed.
    function regroup() {
        var menu = S.modules.adventures.menu;
        if (menu && menu.sync && menu.sync()) {
            S.kernel.log('adventures', 'menu sorted into folders: adventure list readable');
        }
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

    function templateItems(recs, index) {
        if (recs.length === 0) return [{ label: 'No templates yet', enabled: false }];
        if (!index) return [loadingRow('Templates (loading…)')];
        var rows = [];
        for (var i = 0; i < recs.length; i++) {
            rows.push({
                path: S.core.adventures.folderPath(defOf(index, recs[i].adventure), false),
                item: templateItem(recs[i])
            });
        }
        return tree(rows);
    }

    // Broken files go in after the readable scenarios, so they sit last.
    function scenarioItems(scens, index) {
        if (!index) return [loadingRow('Scenarios (loading…)')];
        var core = S.core.adventures;
        var rows = [];
        var i;
        for (i = 0; i < scens.length; i++) {
            if (scens[i].error !== undefined) continue;
            rows.push({
                path: core.folderPath(defOf(index, scens[i].adventure), true),
                item: scenarioItem(scens[i])
            });
        }
        for (i = 0; i < scens.length; i++) {
            if (scens[i].error === undefined) continue;
            rows.push({ path: core.folderPath(null, true), item: scenarioItem(scens[i]) });
        }
        return tree(rows);
    }

    function items() {
        var recs = records();
        var scens = scenarioEntries();
        var index = readIndex();
        lastSignature = signature(recs, scens, index);
        if (index) regrouped = true;

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

        list = list.concat(templateItems(recs, index));
        if (scens.length) {
            list.push({ separator: true });
            list = list.concat(scenarioItems(scens, index));
        }
        return list;
    }

    // Rebuilds the submenu when the template or scenario set, or a folder,
    // differs from the last build.
    function sync() {
        if (signature(records(), scenarioEntries(), readIndex()) === lastSignature) return false;
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
