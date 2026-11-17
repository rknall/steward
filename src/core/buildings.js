/*
 * Building search, listing, and state predicates.
 *
 * Returns raw game objects — modules read fields via the helpers below or
 * via GetBuildingName_string() / GetGrid() directly.
 *
 * Buff eligibility: buffState reads every raw fact, buffBlock turns it into
 * null (eligible) or the first reason a production buff must not be applied.
 *
 * Cache: there is no snapshot across ticks. list, byPredicate, listMines,
 * collectiblesByName, readable and the byName/byGrid fallbacks read the
 * buildings.list source, which is memoized only inside a read pass and per
 * viewed zone id, so a zone switch or the next pass reads the host again and a
 * failed read is never kept as an empty list. Outside a pass every call reads
 * live. listRead() tells "no buildings" (ok, empty) from "could not read"
 * (unreadable) and "no zone yet" (notReady); falsy vector slots are skipped and
 * do not make the list partial, since nothing shows a hole hides a building.
 * opts.zone always reads that zone live. invalidate() drops the open pass's
 * building reads so a caller that just changed the map reads it fresh; outside
 * a pass it has nothing to drop. byName answers inside a pass from one name
 * index per zone.
 */

(function (S) {

    var R = S.kernel.read;
    var lastGapLog = {};     // last logged name-index gap per building name
    var lastIndexErr = {};   // last logged name-index error text per building name

    // GetProductionState() value of a building that is working. MISSING_INPUT_STATE,
    // 2 (warehouse full) and 5 (stopped) must not take a buff.
    var PRODUCING_STATE = 0;

    // switched on but an input is missing; such a building does not produce
    var MISSING_INPUT_STATE = 1;

    // Optional host methods that say a building cannot take a buff right now.
    // Feature-detected: buffState records whether each exists.
    var DESTRUCTION_METHOD = 'IsInDestruction';
    var BUFF_BLOCKERS = [
        { method: 'IsUpgradeInProgress', reason: 'upgrading' },
        { method: 'IsInConstructionMode', reason: 'under construction' },
        { method: DESTRUCTION_METHOD, reason: 'being destroyed' }
    ];

    // Whether a blocker method the build does not have blocks the building.
    // Off: production state 0 already excludes a building under construction.
    var MISSING_BLOCKER_BLOCKS = false;

    function currentZone(zoneOverride) {
        if (zoneOverride) return zoneOverride;
        return S.core.zone.current();
    }

    // The zone's buildings, or null when the list cannot be read: no street
    // map, no vector, a vector without a numeric length, or a throw. Falsy
    // slots are skipped.
    function readList(zone) {
        if (!zone) return null;
        try {
            var sdm = zone.mStreetDataMap;
            if (!sdm) return null;

            var src = null;
            if (typeof sdm.GetBuildings_vector === 'function') {
                src = sdm.GetBuildings_vector();
            } else if (sdm.mBuildingContainer) {
                src = sdm.mBuildingContainer;
            }
            if (!src || typeof src.length !== 'number') return null;

            var out = [];
            for (var i = 0; i < src.length; i++) {
                var b = src[i];
                if (b) out.push(b);
            }
            return out;
        } catch (e) {
            S.kernel.warn('buildings', 'readList threw:', e);
            return null;
        }
    }

    // Callers that only want an array keep their contract: a failure is [].
    function readAllFromZone(zone) {
        return readList(zone) || [];
    }

    R.source('buildings.list', {
        scope: 'zone',
        read: function (arg, ctx) {
            var z = ctx.zone || currentZone();
            if (!z) return R.notReady('no zone', ctx.zoneId);
            var l = readList(z);
            if (l === null) return R.unreadable('building list unreadable', ctx.zoneId);
            return R.ok(l, ctx.zoneId);
        }
    });

    function listRead(opts) {
        return R.get('buildings.list', undefined, opts);
    }

    // The array behind the listing helpers. A memoized value is shared for
    // the pass, so callers copy or filter it and never change it in place.
    function readAll(opts) {
        if (opts && opts.zone) return readAllFromZone(opts.zone);
        return listRead().value || [];
    }

    // Drops this pass's building reads (list and name index), so the next
    // read asks the host again. Outside a pass nothing is memoized.
    function invalidate() {
        S.kernel.hostRead.forget('read.buildings.');
        S.kernel.hostRead.forget('buildings.');
    }

    // True when the viewed zone's building list was read completely and holds
    // anything. byGrid returns null for a missing zone, so a building's absence
    // only means something on a non-empty list. The caller checks that the
    // viewed zone is the one it means.
    function readable() {
        var r = listRead();
        return R.isOk(r) && r.value.length > 0;
    }

    function name(b) {
        if (!b) return '';
        try {
            var v = S.kernel.hostRead.call(b, 'GetBuildingName_string');
            return v === undefined ? '' : v;
        } catch (e) { return ''; }
    }

    function grid(b) {
        if (!b) return null;
        try {
            var v = S.kernel.hostRead.call(b, 'GetGrid');
            return v === undefined ? null : v;
        } catch (e) { return null; }
    }

    function level(b) {
        if (!b) return 0;
        try {
            var v = S.kernel.hostRead.call(b, 'GetUpgradeLevel');
            return v === undefined ? 0 : v;
        } catch (e) { return 0; }
    }

    // The upgrade level, or null when it cannot be read, for a caller that
    // must not show an unread level as 0.
    function levelOf(b) {
        if (!b) return null;
        try {
            var v = S.kernel.hostRead.call(b, 'GetUpgradeLevel');
            return (typeof v === 'number' && isFinite(v)) ? v : null;
        } catch (e) { return null; }
    }

    function playerId(b) {
        if (!b) return null;
        try {
            var v = S.kernel.hostRead.call(b, 'getPlayerID');
            return v === undefined ? null : v;
        } catch (e) { return null; }
    }

    function goContainer(b) {
        if (!b) return null;
        try {
            var v = S.kernel.hostRead.call(b, 'GetGOContainer');
            return v === undefined ? null : v;
        } catch (e) { return null; }
    }

    // True while the host still lets the object be clicked. A clicked map
    // object drops this flag, so it is the positive sign that a click landed.
    function isSelectable(b) {
        if (!b) return false;
        try { return b.mIsSelectable === true; }
        catch (e) { return false; }
    }

    function isMine(b) { return playerId(b) === 0; }

    function isEnemy(b) {
        if (playerId(b) === -1) return true;
        var c = goContainer(b);
        return !!(c && c.ui === 'enemy');
    }

    function isAttackable(b) {
        var c = goContainer(b);
        return !!(c && c.mIsAttackable && !c.mIsLeaderCamp);
    }

    function hasArmy(b) {
        if (!b) return false;
        try {
            var a = S.kernel.hostRead.call(b, 'GetArmy');
            return !!(a && S.kernel.hostRead.call(a, 'HasUnits'));
        } catch (e) { return false; }
    }

    function isUpgradable(b) {
        if (!b) return false;
        try { return typeof b.IsUpgradeAllowed === 'function' && !!b.IsUpgradeAllowed(true); }
        catch (e) { return false; }
    }

    function isCollectible(b) {
        if (!b) return false;
        try {
            if (typeof game === 'undefined' || !game.def) return false;
            var cm = game.def('Collections::CollectionsManager');
            if (!cm) return false;
            var inst = typeof cm.getInstance === 'function' ? cm.getInstance() : cm;
            if (inst && typeof inst.getBuildingIsCollectible === 'function') {
                return !!inst.getBuildingIsCollectible(name(b));
            }
        } catch (e) { /* swallow */ }
        return false;
    }

    function matchesType(b, type) {
        // type may be either an internal building name (Steward.Building.Foo
        // value) or an array of names.
        var n = name(b);
        if (!n) return false;
        if (type && typeof type === 'string') return n === type;
        if (type && type.length) {
            for (var i = 0; i < type.length; i++) {
                if (n === type[i]) return true;
            }
        }
        return false;
    }

    function list(opts) {
        opts = opts || {};
        var src = readAll(opts);
        if (!opts.type) return src.slice();
        var out = [];
        for (var i = 0; i < src.length; i++) {
            if (matchesType(src[i], opts.type)) out.push(src[i]);
        }
        return out;
    }

    // Buildings of the zone named targetName. Inside a read pass byName scans
    // the zone once for all names and answers from that index; outside a pass
    // it filters a fresh read, so a caller without a pass sees no memo.
    function sameNamed(z, targetName) {
        if (!S.kernel.hostRead.inPass()) {
            var all = readAllFromZone(z);
            var out = [];
            for (var i = 0; i < all.length; i++) {
                if (name(all[i]) === targetName) out.push(all[i]);
            }
            return out;
        }
        // Keyed by zone id so a zone switch inside a pass never answers from
        // the index of the island viewed before.
        var index = S.kernel.hostRead.cached('buildings.nameIndex|' + S.core.zone.id(), function () {
            var map = {};
            var src = readAllFromZone(z);
            for (var j = 0; j < src.length; j++) {
                var n = name(src[j]);
                if (!n) continue;
                if (!Object.prototype.hasOwnProperty.call(map, n)) map[n] = [];
                map[n].push(src[j]);
            }
            return map;
        });
        return Object.prototype.hasOwnProperty.call(index, targetName) ? index[targetName] : [];
    }

    function byName(targetName, opts) {
        opts = opts || {};
        // Fast path: ask the host's named lookup, then merge in the building
        // list. Neither source is complete: the name index can omit a whole
        // type that GetBuildings_vector holds, and the building list omits
        // masons that the name index holds. The result is the union, deduped
        // by grid. The list comes from the same zone as the index: read live
        // outside a pass, from the pass's name index of that zone inside one.
        if (!opts.zone) {
            var z = null;
            try { z = S.core.zone.current(); } catch (e0) { z = null; }
            if (z && z.mStreetDataMap &&
                typeof z.mStreetDataMap.getBuildingsByName_vector === 'function') {
                var hits = [];
                try {
                    var v = z.mStreetDataMap.getBuildingsByName_vector(targetName);
                    if (v) {
                        var len = (typeof v.length === 'number') ? v.length : 0;
                        for (var i = 0; i < len; i++) {
                            if (v[i]) hits.push(v[i]);
                        }
                    }
                } catch (e) {
                    hits = [];
                    // Log a failing index only when its error text changes,
                    // so a render loop stays quiet.
                    try {
                        var msg = (e && e.message) ? e.message : String(e);
                        if (lastIndexErr[targetName] !== msg) {
                            lastIndexErr[targetName] = msg;
                            S.kernel.debug('buildings', 'byName ' + targetName +
                                ': name index threw: ' + msg);
                        }
                    } catch (e3) { /* logging never breaks the read */ }
                }

                var seen = {};
                for (var h = 0; h < hits.length; h++) {
                    var hg = grid(hits[h]);
                    if (hg !== null) seen[hg] = true;
                }
                var same = sameNamed(z, targetName);
                var extras = 0;
                for (var k = 0; k < same.length; k++) {
                    var b = same[k];
                    var bg = grid(b);
                    if (bg !== null) {
                        if (Object.prototype.hasOwnProperty.call(seen, bg)) continue;
                        seen[bg] = true;
                    } else if (hits.indexOf(b) !== -1) {
                        continue;
                    }
                    hits.push(b);
                    extras++;
                }
                // Log a gap only when it changes so a render loop stays quiet.
                try {
                    if (extras > 0) {
                        var sig = (hits.length - extras) + '/' + extras;
                        if (lastGapLog[targetName] !== sig) {
                            lastGapLog[targetName] = sig;
                            S.kernel.debug('buildings', 'byName ' + targetName +
                                ': name index returned ' + (hits.length - extras) +
                                ', building list added ' + extras);
                        }
                    } else {
                        delete lastGapLog[targetName];
                    }
                } catch (e2) { /* logging never breaks the read */ }
                return hits;
            }
        }
        var src = readAll(opts);
        var out = [];
        for (var j = 0; j < src.length; j++) {
            if (name(src[j]) === targetName) out.push(src[j]);
        }
        return out;
    }

    function byGrid(targetGrid, opts) {
        opts = opts || {};
        if (!opts.zone) {
            // Fast path: ask the game directly when on the current zone.
            try {
                var g = typeof game !== 'undefined' ? game : null;
                if (g && g.zone && typeof g.zone.GetBuildingFromGridPosition === 'function') {
                    return g.zone.GetBuildingFromGridPosition(targetGrid) || null;
                }
            } catch (e) { /* fall through */ }
        }
        var src = readAll(opts);
        for (var i = 0; i < src.length; i++) {
            if (grid(src[i]) === targetGrid) return src[i];
        }
        return null;
    }

    function byPredicate(fn, opts) {
        opts = opts || {};
        var src = readAll(opts);
        var out = [];
        for (var i = 0; i < src.length; i++) {
            try { if (fn(src[i])) out.push(src[i]); }
            catch (e) { /* skip */ }
        }
        return out;
    }

    function listMines(opts) {
        return byPredicate(function (b) {
            var n = name(b);
            return typeof n === 'string' && n.indexOf('Mine') > -1;
        }, opts);
    }

    // Group every collectible building on the zone by display name and
    // count occurrences. Returns [{ name, count }] sorted by count desc
    // then by name. Used by the dashboard's Collect Pickups section, but
    // intentionally lives here so any module ("how much is on the ground
    // right now") can consume the same query without re-implementing the
    // walk + filter + group.
    function collectiblesByName(opts) {
        opts = opts || {};
        var src = readAll(opts);
        var groups = {};
        for (var i = 0; i < src.length; i++) {
            if (!isCollectible(src[i])) continue;
            var n = name(src[i]);
            if (!n) continue;
            groups[n] = (groups[n] || 0) + 1;
        }
        var out = [];
        var keys = Object.keys(groups);
        for (var k = 0; k < keys.length; k++) {
            out.push({ name: keys[k], count: groups[keys[k]] });
        }
        out.sort(function (a, b) {
            if (b.count !== a.count) return b.count - a.count;
            return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        });
        return out;
    }

    // Resource-creation definition of a building type from the economy
    // definitions, or null when the host cannot answer. Shared by every
    // accessor that reads per-type production data, so there is one lookup path.
    function creationDef(buildingName) {
        try {
            if (typeof game === 'undefined' || !game.def) return null;
            var econ = game.def('ServerState::gEconomics');
            if (!econ || typeof econ.GetResourcesCreationDefinitionForBuilding !== 'function') return null;
            return econ.GetResourcesCreationDefinitionForBuilding(buildingName) || null;
        } catch (e) {
            return null;
        }
    }

    // Seconds per produced unit, read from the economy definition rather than
    // from a placed building, so it is available for any building type even when
    // none is on the current island. Mirrors how autoTSO derives production time.
    // Returns null when the host cannot answer, so callers can fall back safely.
    function workTime(buildingName) {
        var def = creationDef(buildingName);
        if (!def) return null;
        var wt = def.workTime;
        return (typeof wt === 'number' && wt > 0) ? wt : null;
    }

    // Units delivered per production cycle before any buff (amountRemoved),
    // or null when the definition is unavailable.
    function amountPerCycle(buildingName) {
        var def = creationDef(buildingName);
        if (!def) return null;
        var a = def.amountRemoved;
        return (typeof a === 'number' && a > 0) ? a : null;
    }

    // Factor the host applies to a delivery, buffs included. Null when missing.
    function outputFactor(b) {
        if (!b) return null;
        try {
            if (typeof b.GetResourceOutputFactor !== 'function') return null;
            var f = b.GetResourceOutputFactor();
            return (typeof f === 'number' && f > 0) ? f : null;
        } catch (e) { return null; }
    }

    // Unbuffed factor from the upgrade level. The host truncates it to an
    // integer before applying buffs, so do the same.
    function baseOutputFactor(b) {
        if (!b) return null;
        try {
            if (typeof b.GetExactOutputFactor !== 'function') return null;
            var f = Math.floor(b.GetExactOutputFactor());
            return (typeof f === 'number' && f > 0) ? f : null;
        } catch (e) { return null; }
    }

    // Host game clock. Same time base as buff start times; not epoch, so only
    // differences against it are meaningful.
    function clientTime() {
        try {
            if (typeof swmmo === 'undefined' || !swmmo) return null;
            var gi = swmmo.application && swmmo.application.mGameInterface;
            if (!gi || typeof gi.GetClientTime !== 'function') return null;
            var t = gi.GetClientTime();
            return typeof t === 'number' ? t : null;
        } catch (e) { return null; }
    }

    // knownDef spares a second read of the definition when the caller has it.
    // Milliseconds left on one buff appliance (duration minus elapsed time, as
    // the client's own time-left label does), or null when it has run out or
    // the host cannot answer.
    function applianceRemainingMs(a, now, knownDef) {
        try {
            if (!a) return null;
            var def = knownDef || S.kernel.hostRead.call(a, 'GetBuffDefinition');
            if (!def || typeof def.getDuration !== 'function' ||
                typeof a.GetApplicanceMode !== 'function' ||
                typeof a.GetStartTime !== 'function') return null;
            var left = def.getDuration(a.GetApplicanceMode()) - (now - a.GetStartTime());
            return (typeof left === 'number' && left > 0) ? left : null;
        } catch (e) { return null; }
    }

    // Milliseconds left on one buff appliance if it raises output, else null.
    function applianceOutputRemainingMs(a, now) {
        try {
            if (!a || typeof a.GetBuffDefinition !== 'function') return null;
            var def = a.GetBuffDefinition();
            if (!def || typeof def.getProductivityOutputPercent !== 'function') return null;
            if (!(def.getProductivityOutputPercent() > 100)) return null;
        } catch (e) { return null; }
        return applianceRemainingMs(a, now);
    }

    // Remaining milliseconds of the shortest active output buff on a building,
    // or null when none is running or the clock/host cannot answer.
    function buffRemainingMs(b) {
        if (!b) return null;
        var now = clientTime();
        if (now === null) return null;
        var best = null;
        var v = null;
        try { v = b.mBuffs_vector; } catch (e) { v = null; }
        var len = (v && typeof v.length === 'number') ? v.length : 0;
        for (var i = 0; i < len; i++) {
            var left = applianceOutputRemainingMs(v[i], now);
            if (left !== null && (best === null || left < best)) best = left;
        }
        if (best === null) {
            var single = null;
            try { single = b.productionBuff; } catch (e2) { single = null; }
            best = applianceOutputRemainingMs(single, now);
        }
        return best;
    }

    // The GetProductionState() number of a building, or null when there is no
    // building, a method is missing, a call throws or the value is not a number.
    function productionState(b) {
        if (!b) return null;
        try {
            var rc = S.kernel.hostRead.call(b, 'GetResourceCreation');
            if (!rc) return null;
            var ps = S.kernel.hostRead.call(rc, 'GetProductionState');
            return (typeof ps === 'number') ? ps : null;
        } catch (e) { return null; }
    }

    // Every raw read that decides whether a production buff may be applied.
    // Unknown facts are null; presence flags tell a missing optional method
    // from one that threw. Null for no building.
    function buffState(b) {
        if (!b) return null;
        var st = { productionBuff: null, buffsVector: null, productionState: null, blockers: [] };
        try { st.productionBuff = b.productionBuff ? true : false; }
        catch (e) { st.productionBuff = null; }
        try {
            var v = b.mBuffs_vector;
            st.buffsVector = (v && typeof v.length === 'number') ? v.length : null;
        } catch (e2) { st.buffsVector = null; }
        st.productionState = productionState(b);
        for (var i = 0; i < BUFF_BLOCKERS.length; i++) {
            var m = BUFF_BLOCKERS[i].method;
            var present = typeof b[m] === 'function';
            var value = null;
            if (present) {
                try { value = !!b[m](); } catch (e4) { value = null; }
            }
            st.blockers.push({ method: m, present: present, value: value });
        }
        return st;
    }

    // Null when the building may take a production buff, else the first reason
    // it may not.
    function buffBlock(b) {
        var st = buffState(b);
        if (!st) return 'no building';
        if (st.productionBuff === null) return 'buff state unreadable';
        if (st.productionBuff) return 'already buffed';
        if (st.productionState === null) return 'production state unreadable';
        if (st.productionState !== PRODUCING_STATE) {
            return 'not producing (state ' + st.productionState + ')';
        }
        for (var i = 0; i < st.blockers.length; i++) {
            var bl = st.blockers[i];
            if (bl.present) {
                if (bl.value === null) return bl.method + ' unreadable';
                if (bl.value) return BUFF_BLOCKERS[i].reason;
            } else if (MISSING_BLOCKER_BLOCKS) {
                return bl.method + ' missing';
            }
        }
        return null;
    }

    // True when the building is being destroyed, false when it is not or the host
    // has no such method, null when there is no building or the method is present
    // but its call fails. Callers log this; a destroyed building is not refused
    // on it, because a designed flow can send to a building that is coming down.
    function inDestruction(b) {
        var st = buffState(b);
        if (!st) return null;
        for (var i = 0; i < st.blockers.length; i++) {
            var bl = st.blockers[i];
            if (bl.method !== DESTRUCTION_METHOD) continue;
            if (!bl.present) return false;
            if (bl.value === null) return null;
            return bl.value ? true : false;
        }
        return false;
    }

    // True/false when the building shows a running production buff, null when
    // the host cannot answer.
    function hasProductionBuff(b) {
        var st = buffState(b);
        return st ? st.productionBuff : null;
    }

    // { name, remainingMs } of the running production buff, null without one.
    function productionBuffInfo(b) {
        if (!b) return null;
        var a = null;
        var def = null;
        try { a = b.productionBuff || null; } catch (e) { a = null; }
        if (!a) return null;
        var nm = null;
        try {
            def = S.kernel.hostRead.call(a, 'GetBuffDefinition') || null;
            if (def) {
                var readers = ['GetName_string', 'GetBuffName_string'];
                for (var i = 0; i < readers.length && nm === null; i++) {
                    var v = S.kernel.hostRead.call(def, readers[i]);
                    if (typeof v === 'string') nm = v;
                }
                if (nm === null && typeof def.name === 'string') nm = def.name;
            }
        } catch (e2) { /* name stays null */ }
        return { name: nm, remainingMs: applianceRemainingMs(a, clientTime(), def) };
    }

    S.core.buildings = {
        // listing
        list:               list,
        byName:             byName,
        byGrid:             byGrid,
        byPredicate:        byPredicate,
        listMines:          listMines,
        collectiblesByName: collectiblesByName,
        listRead:           listRead,
        invalidate:         invalidate,
        readable:           readable,

        // accessors
        name:         name,
        grid:         grid,
        level:        level,
        levelOf:      levelOf,
        playerId:     playerId,
        workTime:     workTime,
        amountPerCycle:    amountPerCycle,
        outputFactor:      outputFactor,
        baseOutputFactor:  baseOutputFactor,
        buffRemainingMs:   buffRemainingMs,
        buffState:         buffState,
        buffBlock:         buffBlock,
        inDestruction:     inDestruction,
        hasProductionBuff: hasProductionBuff,
        productionBuffInfo: productionBuffInfo,
        BUFF_BLOCKERS:     BUFF_BLOCKERS,
        PRODUCING_STATE:   PRODUCING_STATE,
        MISSING_INPUT_STATE: MISSING_INPUT_STATE,
        productionState:   productionState,
        isSelectable:      isSelectable,

        // state predicates
        isMine:       isMine,
        isEnemy:      isEnemy,
        isAttackable: isAttackable,
        hasArmy:      hasArmy,
        isUpgradable: isUpgradable,
        isCollectible:isCollectible
    };

}(Steward));
