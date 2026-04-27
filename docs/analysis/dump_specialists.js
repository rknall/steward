/*
 * Standalone TSO userscript — Dump Specialists.
 *
 * Drop this file into your TSO_CompanionExtension scripts folder
 * (alongside autoTSO / Steward) and reload the AIR client. A new
 * "Dump Specialists" entry appears under the host's Tools menu;
 * clicking it walks every player-owned specialist on the current
 * zone (explorers, geologists, generals/carriers/admirals) and
 * writes a single JSON file under the AIR application directory:
 *
 *     <tso_portable>/specialists/specialists-YYYYMMDD-HHMMSS.json
 *
 * The file is sharable with guild members so they can run the same
 * dump on their account and pool the data — every special trait,
 * skill tree level, and description bonus the host exposes is
 * captured.
 *
 * Schema v2 (2026-04-27): captures EVERY player-owned specialist on
 * the current zone regardless of state (idle, working, traveling,
 * returning). v1 deduped by GetType and silently dropped working
 * specimens; v2 includes all individuals plus a stable `uniqueID`
 * per spec so multiple specimens of the same GetType (e.g. several
 * Bewitching Explorers) are distinguishable.
 *
 * Independent of Steward / autoTSO. Uses only host globals (`game`,
 * `air`, `mainSettings`, `showGameAlert`) and the AIR file API.
 *
 * Tested on Adobe AIR 32 / Settlers Online TSO_CompanionExtension.
 */

/* eslint-disable no-undef */
/* global game, air, loca, mainSettings, showGameAlert */

(function () {
    'use strict';

    var SCRIPT_NAME    = 'dump_specialists';
    var SCHEMA_VERSION = 'tso.specialists.v2';
    var OUTPUT_SUBDIR  = 'specialists';

    // --- logging -----------------------------------------------------
    // Mirror Steward's "[LOG] [timestamp] [tag] message" format so the
    // output blends into the existing console.log if Steward is also
    // installed. When Steward isn't around we fall back to plain
    // console.log; AIR's WebKit console is the host trace channel.

    function pad2(n) { return n < 10 ? '0' + n : String(n); }
    function timestamp() {
        var d = new Date();
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
               ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }
    function timestampSlug() {
        var d = new Date();
        return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
               '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    }

    function log(msg) {
        try { console.log('[LOG] [' + timestamp() + '] [' + SCRIPT_NAME + '] ' + msg); }
        catch (e) { /* ignore */ }
    }
    function warn(msg) {
        try { console.warn('[WARN] [' + timestamp() + '] [' + SCRIPT_NAME + '] ' + msg); }
        catch (e) { /* ignore */ }
    }
    function notify(msg) {
        try {
            if (typeof showGameAlert === 'function') showGameAlert('Dump Specialists: ' + msg);
        } catch (e) { /* ignore */ }
    }

    // --- specialist enumeration --------------------------------------
    // The host exposes all specialists on the current zone via
    // `game.gi.mCurrentPlayerZone.GetSpecialists_vector()`. Each entry
    // is a cSpecialist instance carrying `GetType / GetBaseType /
    // getName / getPlayerID / getSkillTree / skills /
    // GetSpecialistDescription`.

    function currentZone() {
        try {
            if (typeof game === 'undefined' || !game || !game.gi) return null;
            return game.gi.mCurrentPlayerZone || null;
        } catch (e) { return null; }
    }

    function readSpecialistsVector(zone) {
        var out = [];
        if (!zone || typeof zone.GetSpecialists_vector !== 'function') return out;
        try {
            var v = zone.GetSpecialists_vector();
            if (!v) return out;
            var len = (typeof v.length === 'number') ? v.length : 0;
            for (var i = 0; i < len; i++) if (v[i]) out.push(v[i]);
        } catch (e) {
            warn('GetSpecialists_vector threw: ' + e);
        }
        return out;
    }

    // Skip foreign / NPC specialists. autoTSO and Steward both gate on
    // `getPlayerID() !== -1` to avoid the host's surrounding-scope ghost
    // entries that show up when reflectively walking the vector.
    function ownedByPlayer(spec) {
        try {
            if (typeof spec.getPlayerID === 'function') return spec.getPlayerID() !== -1;
        } catch (e) { /* fall through */ }
        return false;
    }

    // Map GetBaseType -> family label. Observed values:
    //   0 = general / carrier / admiral
    //   1 = explorer
    //   2 = geologist
    // We don't refine 0 further (carrier vs general) since the host
    // collapses them at the base level — `GetType` differentiates.
    function familyOf(spec) {
        try {
            if (typeof spec.GetBaseType === 'function') {
                var b = spec.GetBaseType();
                if (b === 0) return 'general';
                if (b === 1) return 'explorer';
                if (b === 2) return 'geologist';
                return 'baseType=' + b;
            }
        } catch (e) { /* fall through */ }
        return 'unknown';
    }

    // --- structural capture ------------------------------------------
    // AS3-backed objects expose data through non-enumerable getters, so
    // for..in skips them. We probe a curated list of property names
    // directly. The list mirrors what Steward's diagnostics dump uses,
    // which we know covers every observed trait shape.

    var EFFECT_PROP_NAMES = [
        'type_string', 'taskType_string', 'modifier_string',
        'multiplier', 'adder', 'value',
        'name_string', 'id', '_id',
        'duration', 'duration_int', 'cooldown', 'cooldown_int',
        'requiredLevel_int', 'requiredLevel',
        'chance', 'rarity'
    ];
    var SKILL_DEF_PROP_NAMES = [
        'name_string', 'id', '_id',
        'description_string', 'descriptionShort_string',
        'requiredLevel_int', 'maxLevel_int',
        'icon_string', 'iconID', 'iconID_int',
        'category_string', 'category_int', 'tier_int'
    ];
    var DESCRIPTION_PROP_NAMES = [
        'name_string', 'GetTimeBonus', 'getTimeBonus',
        'isTransportGeneral', 'getBaseType', 'GetType'
    ];

    // Pull primitive props (string/number/boolean/null) only. Drops
    // objects to keep the JSON sharable.
    function plainProps(obj, names) {
        var out = {};
        if (!obj) return out;
        for (var i = 0; i < names.length; i++) {
            var n = names[i];
            try {
                var v = obj[n];
                var t = typeof v;
                if (v === null) { out[n] = null; continue; }
                if (t === 'undefined' || t === 'function') continue;
                if (t === 'string' || t === 'number' || t === 'boolean') out[n] = v;
            } catch (e) { /* skip */ }
        }
        return out;
    }

    // Try a list of method names in order; return first primitive call
    // result. Used to surface getters like GetTimeBonus that the AS3
    // host exposes as methods rather than properties.
    function callFirst(obj, names) {
        if (!obj) return null;
        for (var i = 0; i < names.length; i++) {
            try {
                if (typeof obj[names[i]] !== 'function') continue;
                var v = obj[names[i]]();
                var t = typeof v;
                if (t === 'string' || t === 'number' || t === 'boolean') return v;
            } catch (e) { /* try next */ }
        }
        return null;
    }

    function captureEffect(eff) { return plainProps(eff, EFFECT_PROP_NAMES); }

    function captureSkill(skill, slotIdx) {
        var out = { slot: slotIdx };
        if (!skill) return out;
        try { if (typeof skill.getId === 'function')    out.id = skill.getId(); }
        catch (e) { /* skip */ }
        try { if (typeof skill.getLevel === 'function') out.level = skill.getLevel(); }
        catch (e) { /* skip */ }

        var def = null;
        try { if (typeof skill.getDefinition === 'function') def = skill.getDefinition(); }
        catch (e) { /* skip */ }
        if (def) {
            var defProps = plainProps(def, SKILL_DEF_PROP_NAMES);
            if (typeof defProps.name_string       !== 'undefined') out.name_string   = defProps.name_string;
            if (typeof defProps.icon_string       !== 'undefined') out.icon_string   = defProps.icon_string;
            if (typeof defProps.maxLevel_int      !== 'undefined') out.maxLevel      = defProps.maxLevel_int;
            if (typeof defProps.requiredLevel_int !== 'undefined') out.requiredLevel = defProps.requiredLevel_int;

            // Capture only the active level's effect vector (level-1,
            // matching how autoTSO reads modifiers). Unlearned skills
            // (level 0) still expose level_vector[0] so the prospective
            // effect is preserved.
            try {
                var lvl = (typeof out.level === 'number') ? out.level : 0;
                var idx = lvl > 0 ? lvl - 1 : 0;
                if (def.level_vector && def.level_vector[idx]) {
                    var effs = def.level_vector[idx];
                    var elen = (typeof effs.length === 'number') ? effs.length : 0;
                    out.effectsLevelIndex = idx;
                    out.effects = [];
                    for (var i = 0; i < elen; i++) out.effects.push(captureEffect(effs[i]));
                }
            } catch (e) { /* skip */ }
        }
        return out;
    }

    function captureSkillVector(spec, accessorName) {
        var holder = null;
        try {
            var fn = spec[accessorName];
            if (typeof fn === 'function') {
                holder = fn.call(spec);
            } else if (accessorName === 'skills' && spec.skills &&
                       typeof spec.skills.getItems_vector === 'function') {
                holder = spec.skills;
            }
        } catch (e) { /* skip */ }
        if (!holder || typeof holder.getItems_vector !== 'function') return [];

        var out = [];
        try {
            var items = holder.getItems_vector();
            var ilen = (typeof items.length === 'number') ? items.length : 0;
            for (var i = 0; i < ilen; i++) out.push(captureSkill(items[i], i));
        } catch (e) { /* skip */ }
        return out;
    }

    function stripHtml(s) {
        if (typeof s !== 'string') return String(s || '');
        return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    // Resolve a specialist's display name. spec.getName() works for explorers
    // and generals but returns '' for geologists. Fall back to the description
    // path autoTSO uses: desc.getName_string() yields a loca key like
    // 'GEO_STONE_COLD' that loca.GetText('SPE', key) resolves to a localized
    // display name. The host exposes getName_string() as a non-enumerable
    // method, so it has to be invoked directly rather than read via for..in.
    function cleanName(spec) {
        try {
            if (typeof spec.getName === 'function') {
                var raw = spec.getName();
                var direct = stripHtml(raw);
                if (direct) return direct;
            }
        } catch (e) { /* fall through */ }
        try {
            if (typeof spec.GetSpecialistDescription === 'function') {
                var desc = spec.GetSpecialistDescription();
                if (desc && typeof desc.getName_string === 'function') {
                    var key = desc.getName_string();
                    if (typeof key === 'string' && key) {
                        if (typeof loca !== 'undefined' && loca &&
                            typeof loca.GetText === 'function') {
                            try {
                                var localized = loca.GetText('SPE', key);
                                if (typeof localized === 'string' && localized) {
                                    return stripHtml(localized);
                                }
                            } catch (e2) { /* fall through */ }
                        }
                        return key;
                    }
                }
            }
        } catch (e) { /* fall through */ }
        return '';
    }

    // Stable per-instance key. Two specimens of the same GetType (e.g.
    // multiple Bewitching Explorers, GetType=51) are otherwise
    // indistinguishable in the JSON.
    function uniqueIdKey(spec) {
        try {
            if (typeof spec.GetUniqueID === 'function') {
                var uid = spec.GetUniqueID();
                if (uid && typeof uid.toKeyString === 'function') return uid.toKeyString();
            }
        } catch (e) { /* fall through */ }
        return null;
    }

    function captureSpec(spec) {
        var out = { family: familyOf(spec) };

        try { if (typeof spec.GetType     === 'function') out.GetType     = spec.GetType(); }
        catch (e) { /* skip */ }
        try { if (typeof spec.GetBaseType === 'function') out.GetBaseType = spec.GetBaseType(); }
        catch (e) { /* skip */ }
        var uid = uniqueIdKey(spec);
        if (uid) out.uniqueID = uid;
        out.name = cleanName(spec);

        try {
            if (typeof spec.GetSpecialistDescription === 'function') {
                var desc = spec.GetSpecialistDescription();
                if (desc) {
                    out.description = plainProps(desc, DESCRIPTION_PROP_NAMES);
                    var bonus = callFirst(desc, ['GetTimeBonus', 'getTimeBonus']);
                    if (bonus !== null) out.description.GetTimeBonus = bonus;
                    var nameKey = callFirst(desc, ['getName_string']);
                    if (nameKey !== null) out.description.name_string = nameKey;
                }
            }
        } catch (e) { /* skip */ }

        out.skillTree   = captureSkillVector(spec, 'getSkillTree');
        out.traitSkills = captureSkillVector(spec, 'skills');
        return out;
    }

    // --- file output --------------------------------------------------
    // Round-trip the relative path through .nativePath so AIR treats the
    // resulting File as writable application content (resolvePath alone
    // returns a read-only handle that fails on FileStream open).

    function applicationDirRoundTrip(relPath) {
        try {
            var resolved = air.File.applicationDirectory.resolvePath(relPath);
            if (!resolved || !resolved.nativePath) return null;
            return new air.File(resolved.nativePath);
        } catch (e) {
            warn('applicationDirRoundTrip threw for ' + relPath + ': ' + e);
            return null;
        }
    }

    // air.File.createDirectory does NOT recurse. Walk down the parent
    // chain so each segment is created on demand.
    function ensureDirRecursive(dir) {
        if (!dir) return false;
        if (dir.exists) return true;
        try {
            if (dir.parent && !dir.parent.exists) {
                if (!ensureDirRecursive(dir.parent)) return false;
            }
            dir.createDirectory();
            return dir.exists;
        } catch (e) {
            warn('createDirectory failed for ' + (dir.nativePath || '?') + ': ' + e);
            return false;
        }
    }

    function writeJsonFile(relPath, json) {
        var file = applicationDirRoundTrip(relPath);
        if (!file) return null;
        if (file.parent && !ensureDirRecursive(file.parent)) return null;
        try {
            var stream = new air.FileStream();
            stream.open(file, air.FileMode.WRITE);
            stream.writeUTFBytes(json);
            stream.close();
            return file.nativePath;
        } catch (e) {
            warn('FileStream write failed for ' + (file.nativePath || '?') + ': ' + e);
            return null;
        }
    }

    // --- entry point --------------------------------------------------

    function dumpSpecialists() {
        var zone = currentZone();
        if (!zone) {
            notify('No current zone — open one first.');
            return;
        }
        var specs = readSpecialistsVector(zone);
        if (!specs.length) {
            notify('No specialists on the current zone.');
            return;
        }

        // Capture every player-owned specialist on the current zone
        // regardless of state. v1 deduped by GetType which silently
        // dropped working specimens — analysis needs every individual so
        // per-instance skill-tree investments and traits all surface.
        var skippedForeign = 0;
        var playerID = null;
        var counts = { explorer: 0, geologist: 0, general: 0, unknown: 0 };
        var uniqueTypes = {};
        var collected = [];
        for (var i = 0; i < specs.length; i++) {
            var s = specs[i];
            if (!ownedByPlayer(s)) { skippedForeign++; continue; }
            if (playerID === null) {
                try { if (typeof s.getPlayerID === 'function') playerID = s.getPlayerID(); }
                catch (e) { /* skip */ }
            }
            var entry;
            try { entry = captureSpec(s); }
            catch (e) {
                var dbg = '?';
                try { if (typeof s.GetType === 'function') dbg = String(s.GetType()); }
                catch (e2) { /* skip */ }
                warn('captureSpec threw for GetType=' + dbg + ': ' + e);
                continue;
            }
            var fam = entry.family || 'unknown';
            counts[fam] = (counts[fam] || 0) + 1;
            if (typeof entry.GetType !== 'undefined') uniqueTypes[entry.GetType] = true;
            collected.push(entry);
        }
        var uniqueTypeCount = 0;
        for (var u in uniqueTypes) if (uniqueTypes.hasOwnProperty(u)) uniqueTypeCount++;

        var meta = {
            schema:           SCHEMA_VERSION,
            exportedAt:       new Date().toISOString(),
            counts:           counts,
            uniqueGetTypes:   uniqueTypeCount,
            skippedForeign:   skippedForeign,
            totalCaptured:    collected.length
        };
        if (playerID !== null) meta.playerID = playerID;
        try {
            if (zone.getName) meta.zoneName = String(zone.getName()).replace(/<[^>]+>/g, '');
        } catch (e) { /* skip */ }
        try {
            if (typeof mainSettings !== 'undefined' && mainSettings && mainSettings.scriptName) {
                meta.hostScriptName = mainSettings.scriptName;
            }
        } catch (e) { /* skip */ }

        var json;
        try { json = JSON.stringify({ meta: meta, specialists: collected }, null, 2); }
        catch (e) {
            warn('JSON.stringify threw: ' + e);
            notify('JSON serialise failed — see log.');
            return;
        }

        var fname = 'specialists-' + timestampSlug() + '.json';
        var rel   = OUTPUT_SUBDIR + '/' + fname;
        var written = writeJsonFile(rel, json);
        var summary = collected.length + ' specialists' +
                      ' (explorers=' + counts.explorer +
                      ', geologists=' + counts.geologist +
                      ', generals=' + counts.general + ')';

        if (written) {
            log('wrote ' + summary + ' → ' + written);
            notify(summary + ' → ' + rel);
        } else {
            warn('write failed; ' + summary + ' captured but not persisted');
            notify(summary + ' — file write failed, see log');
        }
    }

    // --- menu integration --------------------------------------------
    // Add a single entry under the AIR native menu. Mirrors how
    // autoTSO / Steward attach their own roots: try the host's "Tools"
    // submenu first, fall back to the menu bar root.

    function findToolsSubmenu(rootMenu) {
        try {
            if (rootMenu && typeof rootMenu.getItemByName === 'function') {
                var t = rootMenu.getItemByName('Tools');
                if (t && t.submenu) return t.submenu;
            }
        } catch (e) { /* fall through */ }
        return null;
    }

    function alreadyInstalled(container, name) {
        try {
            if (container && typeof container.getItemByName === 'function') {
                return !!container.getItemByName(name);
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    function installMenuItem() {
        try {
            if (!window.nativeWindow || !window.nativeWindow.menu) {
                warn('nativeWindow.menu unavailable; menu entry not added. Call dumpSpecialists() from the console instead.');
                return;
            }
            var rootMenu  = window.nativeWindow.menu;
            var container = findToolsSubmenu(rootMenu) || rootMenu;
            var entryName = 'DumpSpecialists';
            if (alreadyInstalled(container, entryName)) return;

            var item = new air.NativeMenuItem('Dump Specialists');
            item.name = entryName;
            try { item.addEventListener(air.Event.SELECT, dumpSpecialists); }
            catch (e) { warn('addEventListener threw: ' + e); }
            container.addItem(item);
            log('menu entry installed (under ' +
                (container === rootMenu ? 'menu root' : 'Tools') + ')');
        } catch (e) {
            warn('installMenuItem threw: ' + e);
        }
    }

    // Expose as a global so it can also be triggered from the dev
    // console (`dumpSpecialists()`) — useful when the menu integration
    // isn't available (alternate AIR shell, headless boot, etc.).
    try { window.dumpSpecialists = dumpSpecialists; } catch (e) { /* ignore */ }

    // Install on next tick so the host menu has a chance to settle.
    try { setTimeout(installMenuItem, 0); }
    catch (e) { installMenuItem(); }

    log('loaded — call dumpSpecialists() or use Tools → Dump Specialists');
}());
