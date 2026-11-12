/*
 * Adventure definitions, open adventures and closing.
 *
 * Reads the adventure definition map, the AdventureManager and the player's
 * own open adventures (with their zone ids), and builds the action def that
 * closes one. Starting a map lives in core/buffs.js. The list offers attack
 * adventures only, sorted by label, matching autoTSO's template maker.
 * The folder rules (type, event, campaign, Other fallback) live here too, so
 * the menu and the diagnostics dump share one answer to where an adventure
 * belongs.
 */

(function (S) {

    // autoTSO skips these groups in its template maker. A group is the type
    // when the adventure has no campaign.
    var HIDDEN_TYPES = ['Scenario', 'Coop'];

    // The host class whose singleton lists the open adventures.
    var ADVENTURE_MANAGER = 'com.bluebyte.tso.adventure.logic::AdventureManager';

    function str(fn) {
        try { return fn(); } catch (e) { return ''; }
    }

    function describe(d) {
        var name = str(function () { return d.mName_string; });
        // A definition without a name cannot be started or labelled.
        if (typeof name !== 'string' || name === '') return null;
        var diff = 0;
        var req = false;
        try { diff = d.GetDifficulty(); } catch (e1) { /* default */ }
        try { req = !!d.GetRequiresEvent(); } catch (e2) { /* default */ }
        return {
            name:          name,
            label:         S.core.locale.adn(name),
            type:          str(function () { return d.GetType_string(); }),
            campaign:      str(function () { return d.GetCampaign_string(); }),
            difficulty:    diff,
            requiresEvent: req
        };
    }

    // Host type value -> menu folder label, in menu order. The keys are host
    // GetType_string values taken from autoTSO ('Coop') and the wiki's
    // data-type values, so they are provisional: 'Dump adventure and buff
    // definitions' lists the real ones. Keyed by host enum string, never by
    // adventure.
    var TYPE_FOLDERS = [
        { label: 'Missions',      types: ['Mission'] },
        { label: 'Mini-missions', types: ['MiniMission'] },
        { label: 'Co-op missions', types: ['Coop', 'CoopMission'] },
        { label: 'Ventures',      types: ['Venture'] }
    ];
    var EVENTS_FOLDER = 'Events';
    var OTHER_FOLDER = 'Other';
    var SCENARIOS_FOLDER = 'Scenarios';

    // Top-level folder order, derived so it is never written twice.
    function folderOrder() {
        var out = [];
        for (var i = 0; i < TYPE_FOLDERS.length; i++) out.push(TYPE_FOLDERS[i].label);
        out.push(EVENTS_FOLDER, OTHER_FOLDER, SCENARIOS_FOLDER);
        return out;
    }

    // A host type or folder label reduced to lower-case letters and digits,
    // without a plural s: 'MiniMission', 'Mini_Missions' and 'Mini-missions'
    // all read 'minimission'. The host spelling of a type is not confirmed
    // (see above), so a folder takes every spelling of its types and of its
    // own label, and only a type matching none falls to Other.
    function typeKey(v) {
        return String(v).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
    }

    function typeFolder(type) {
        if (type === null || type === undefined || type === '') return null;
        var key = typeKey(type);
        for (var i = 0; i < TYPE_FOLDERS.length; i++) {
            var f = TYPE_FOLDERS[i];
            if (typeKey(f.label) === key) return f.label;
            for (var j = 0; j < f.types.length; j++) {
                if (typeKey(f.types[j]) === key) return f.label;
            }
        }
        return null;
    }

    // The host's localised campaign name; an unknown key comes back unchanged,
    // so the raw value is split at case changes and digits instead.
    function campaignLabel(raw) {
        var key = 'Campaign_' + raw;
        var text = S.core.locale.lab(key);
        if (typeof text === 'string' && text !== '' && text !== key) return text;
        return String(raw)
            .replace(/_/g, ' ')
            .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
            .replace(/([0-9])([A-Za-z])/g, '$1 $2');
    }

    // Folder labels from the top down for one adventure. A def of null is an
    // adventure missing from the definitions.
    function folderPath(def, scenario) {
        var tail = (def && hasCampaign(def)) ? [campaignLabel(def.campaign)] : [];
        if (scenario === true) return [SCENARIOS_FOLDER].concat(tail);
        if (!def) return [OTHER_FOLDER];
        if (def.requiresEvent) return [EVENTS_FOLDER].concat(tail);
        var label = typeFolder(def.type);
        if (label) return [label].concat(tail);
        return [OTHER_FOLDER, def.type ? String(def.type) : '(no type)'].concat(tail);
    }

    function byName(defs) {
        var out = {};
        if (!defs) return out;
        for (var i = 0; i < defs.length; i++) {
            if (defs[i] && typeof defs[i].name === 'string') out[defs[i].name] = defs[i];
        }
        return out;
    }

    // quiet skips the warnings, for callers that probe on a periodic tick.
    function definitions(quiet) {
        var out = [];
        var skipped = 0;
        try {
            var map = game.def('AdventureSystem::cAdventureDefinition').map_AdventureName_AdventureDefinition;
            var raw = [];
            var i;
            if (map && typeof map.valueSet === 'function') {
                var vs = map.valueSet();
                if (vs && typeof vs.length === 'number') {
                    for (i = 0; i < vs.length; i++) raw.push(vs[i]);
                } else if (vs) {
                    for (var k in vs) raw.push(vs[k]);
                }
            } else if (map) {
                for (var key in map) raw.push(map[key]);
            }
            for (i = 0; i < raw.length; i++) {
                if (!raw[i]) continue;
                var d = describe(raw[i]);
                if (d) out.push(d);
                else skipped++;
            }
            if (skipped > 0 && quiet !== true) S.kernel.warn('adventures', 'skipped ' + skipped + ' adventure definition(s) without a name');
        } catch (e) {
            if (quiet !== true) S.kernel.warn('adventures', 'definitions() threw:', e);
            return [];
        }
        return out;
    }

    function hasCampaign(def) {
        return !!(def.campaign && def.campaign !== 'None');
    }

    function isSelectable(def) {
        if (!def || typeof def.name !== 'string' || !def.name) return false;
        if (def.requiresEvent) return false;
        if (def.name.indexOf('Expedition') !== -1) return false;
        if (typeof def.label !== 'string' || !def.label || def.label.indexOf('undefined') !== -1) return false;
        if (!hasCampaign(def) && HIDDEN_TYPES.indexOf(def.type) !== -1) return false;
        return true;
    }

    // One flat list of the attack adventures, sorted by the label the player
    // reads (ties by name) so the order matches what the dropdown shows.
    function selectable(defs) {
        var list = [];
        var i;
        for (i = 0; i < defs.length; i++) {
            if (isSelectable(defs[i])) list.push(defs[i]);
        }
        list.sort(function (a, b) {
            var c = String(a.label).localeCompare(String(b.label));
            if (c !== 0) return c;
            return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        });
        return list;
    }

    function label(name) {
        return S.core.locale.adn(name);
    }

    // Returns the host AdventureManager instance, or null. Silent because it
    // runs on the menu tick; callers decide whether a missing manager is worth logging.
    function manager() {
        try {
            var cls = game.def(ADVENTURE_MANAGER);
            return (cls && cls.getInstance()) || null;
        } catch (e) {
            return null;
        }
    }

    // The player's own open adventures as [{ name, zoneId }]. [] means the
    // manager read fine and none is open; null means it could not be read, so
    // callers never mistake an unreadable manager for "nothing open". This
    // assumes the manager gives an empty vector when nothing is open, so a list
    // with no length is a failed read. A bad entry fails the whole read too: a
    // skipped entry could be the very adventure the caller looks for, and would
    // read as closed. Runs on the menu's status tick, so it never logs.
    function own() {
        var out = [];
        try {
            var mgr = manager();
            if (!mgr) return null;
            var advs = mgr.getAdventures();
            try {
                if (advs && typeof advs.toArray === 'function') {
                    var arr = advs.toArray();
                    if (arr && typeof arr.length === 'number') advs = arr;
                }
            } catch (e1) { /* fall back to the index walk */ }
            if (!advs || typeof advs.length !== 'number') return null;
            for (var i = 0; i < advs.length; i++) {
                var adv = advs[i];
                if (mgr.isMyAdventure(adv)) out.push({ name: String(adv.adventureName), zoneId: adv.zoneID });
            }
        } catch (e) {
            return null;
        }
        return out;
    }

    // Names of the own open adventures; an unreadable manager means "none".
    function ownOpen() {
        var list = own();
        var out = [];
        if (!list) return out;
        for (var i = 0; i < list.length; i++) out.push(list[i].name);
        return out;
    }

    function entryOf(list, name) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].name === name) return list[i];
        }
        return null;
    }

    // Zone id of an open own adventure; null when unreadable or not open.
    function zoneIdOf(name) {
        var list = own();
        var e = list ? entryOf(list, name) : null;
        return (e && typeof e.zoneId === 'number') ? e.zoneId : null;
    }

    // Action def that closes an own open adventure. No "already satisfied": a
    // name that is not open is a refusal, since success must be seen as the
    // adventure leaving a list that was read successfully. The caller visits
    // the home island itself.
    function close(name) {
        return {
            label:     'close ' + name,
            category:  'adventures',
            timeoutMs: 30000,
            precheck: function () {
                var list = own();
                if (!list) return 'adventures unreadable';
                if (!entryOf(list, name)) return 'adventure not open';
                if (zoneIdOf(name) === null) return 'adventure zone id unreadable';
                var mgr = manager();
                if (!mgr || typeof mgr.removeAdventure !== 'function') return 'removeAdventure missing';
                return null;
            },
            baseline: function () {
                return { zoneId: zoneIdOf(name) };
            },
            send: function (base) {
                var mgr = manager();
                if (!mgr || !base || typeof base.zoneId !== 'number') return false;
                mgr.removeAdventure(base.zoneId);
                return true;
            },
            check: function (base) {
                var list = own();
                // Without a numeric baseline zone id nothing was sent and
                // absence proves nothing.
                if (!list || !base || typeof base.zoneId !== 'number') return false;
                for (var i = 0; i < list.length; i++) {
                    if (list[i].zoneId === base.zoneId) return false;
                }
                return true;
            }
        };
    }

    S.core.adventures = {
        HIDDEN_TYPES: HIDDEN_TYPES,
        TYPE_FOLDERS: TYPE_FOLDERS,
        EVENTS_FOLDER: EVENTS_FOLDER,
        OTHER_FOLDER: OTHER_FOLDER,
        SCENARIOS_FOLDER: SCENARIOS_FOLDER,
        folderOrder:  folderOrder,
        campaignLabel: campaignLabel,
        folderPath:   folderPath,
        byName:       byName,
        hasCampaign:  hasCampaign,
        definitions:  definitions,
        isSelectable: isSelectable,
        selectable:   selectable,
        label:        label,
        manager:      manager,
        own:          own,
        ownOpen:      ownOpen,
        zoneIdOf:     zoneIdOf,
        close:        close
    };

}(Steward));
