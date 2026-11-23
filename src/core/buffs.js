/*
 * Buff inventory and buff actions.
 *
 * Reads the star-menu buff stock (including adventure maps) and the buff
 * definitions, and builds the action defs that apply a buff (speed, camp,
 * population, building production buffs) or start an adventure map. A def is run with
 * S.core.actions.attempt. Adventure items (a buff applied to a grid on the
 * island) and the quest targets of a buff are here too. Every reader reports an unreadable host as null, and
 * a def treats null as not observed: an unreadable stock never counts as
 * "the stock dropped". Inside a host-read pass (S.kernel.hostRead) the star
 * menu and the target table are read once; buildingBuffCandidates and
 * speedBuffs read them once per call even outside a pass, and the action defs
 * always read live, except that an adventure item sends the entry its
 * precheck read.
 */

(function (S) {

    // The only place the speed-buff name prefix exists.
    var SPEED_BUFF_PREFIX = 'GeneralSpeedBuff_';

    // Zone-wide buffs a template may apply when an adventure starts, besides a
    // horseshoe: the one list, in the order the dialog offers them. Each is
    // sent like a speed buff (grid 0) and only when it is in stock. A new
    // entry here is all it takes to offer another buff.
    var START_BUFFS = [
        { name: 'PropagationBuff_AdventureZoneTravelBoost_BlackTree', label: 'Black Vortex' },
        { name: 'PropagationBuff_AdventureZoneTravelBoost_DoggyBag', label: 'Doggy Bag' }
    ];

    // Star-menu type of adventure maps; the entry's resource is the adventure
    // name. The only place this type name exists.
    var ADVENTURE_MAP_TYPE = 'Adventure';

    // Wire values of the buff action (61): the player's own island grid and the
    // zone-wide target of a speed buff. 8825 and 0 are what the client's own buff
    // UI sends; they exist only here. The population resource name is read from
    // S.core.resources.POPULATION at call time, since that file loads after
    // this one.
    var PLAYER_GRID = 8825;
    var ZONE_GRID = 0;
    // Star-menu type of every resource-adding item, population included: the
    // stack carries any resource, so this is not a population-only type. The
    // only copy of the literal; other files read it from S.core.buffs.
    var ADD_RESOURCE_TYPE = 'AddResource';

    var BUFF_TIMEOUT_MS = 15000;
    // A camp buff has no retry, so it gets the window of a send and a retry.
    var CAMP_TIMEOUT_MS = 2 * BUFF_TIMEOUT_MS;

    // GetBuffType() of a buff that boosts the production of one building.
    // Zone (8), skin (4) and military (1) buffs also name buildings as their
    // target but are not production buffs, so only this type is offered.
    var PRODUCTION_BUFF_TYPE = 0;

    // Target-description token that stands for every non-epic workyard, which
    // covers every mine and mason.
    var WORKYARD_TARGET = 'Workyard';

    // Host definition that resolves a buff's target group to building names.
    var TARGET_GROUPS_DEF = 'BuffSystem.cBuffDefinition';
    var MAP_TIMEOUT_MS = 30000;

    // Raw star-menu entries { type, resource, amount, uid } where uid is the
    // host's unique-id object, which the buff action needs as it is. null means
    // the player or the menu could not be read, so callers can tell "no buffs"
    // from "unreadable". An item whose type or amount read failed carries
    // bad = true (typeBad when it was the type), so an entry caught mid-update
    // is not taken for an empty stock. Inside a host-read pass the menu is
    // read once and the list is shared, so no caller may change it or its
    // items.
    function readEntries() {
        return S.kernel.hostRead.cached('buffs.readEntries', readEntriesNow);
    }

    function readEntriesNow() {
        try {
            if (typeof game === 'undefined' || !game.gi || !game.gi.mCurrentPlayer) return null;
            // One read of the member: the bridge can show it as a function and
            // then as undefined on the next read.
            var vec = S.kernel.hostRead.call(game.gi.mCurrentPlayer, 'getAvailableBuffs_vector');
            if (!vec) return null;
            var out = [];
            var n = vec.length || 0;
            for (var i = 0; i < n; i++) {
                var b = vec[i];
                var item = { type: '', resource: '', amount: 0, uid: null, bad: false, typeBad: false };
                try {
                    var ty = b.GetType();
                    if (typeof ty === 'string') item.type = ty; else item.typeBad = true;
                } catch (e1) { item.typeBad = true; }
                try { item.resource = b.GetResourceName_string(); } catch (e2) { /* leave default */ }
                try {
                    var am = b.amount;
                    if (typeof am === 'number' && isFinite(am)) item.amount = am; else item.bad = true;
                } catch (e3) { item.bad = true; }
                if (item.typeBad) item.bad = true;
                try { item.uid = b.GetUniqueId(); } catch (e4) { /* leave default */ }
                out.push(item);
            }
            return out;
        } catch (e) {
            S.kernel.warn('buffs', 'inventory() threw:', e);
            return null;
        }
    }

    // null while the star menu cannot be read, so an unreadable menu never
    // looks like an empty stock.
    function inventory() {
        var raw = readEntries();
        if (!raw) return null;
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var key = '';
            try { key = raw[i].uid.toKeyString(); } catch (e) { /* leave default */ }
            // bad is passed on, so a consumer never takes an entry caught
            // mid-update for a real amount.
            out.push({ type: raw[i].type, resource: raw[i].resource, amount: raw[i].amount, uid: key, bad: raw[i].bad });
        }
        return out;
    }

    // The same as entryAtLeast with no minimum, so empty entries are skipped.
    function entry(type, resource) {
        return entryAtLeast(type, resource, 0);
    }

    // Whether an entry read for the given type makes the result unknown: it
    // could not be read fully, and either its type is unknown or it is this
    // type. Readers return null then, rather than a value that silently
    // misses it.
    function unreadableAs(e, type) {
        return e.bad && (e.typeBad || e.type === type);
    }

    // Stock of exactly this type and resource ('' = not bound to a resource):
    // a number, or null when the menu cannot be read. The map stock of an
    // adventure is stock(ADVENTURE_MAP_TYPE, name).
    function stock(type, resource) {
        var raw = readEntries();
        return raw ? stockIn(raw, type, resource) : null;
    }

    // stock() over a list already read, so a caller that needs the stock and
    // an entry can take both from one read.
    function stockIn(raw, type, resource) {
        var res = resource || '';
        var sum = 0;
        for (var i = 0; i < raw.length; i++) {
            if (unreadableAs(raw[i], type)) return null;
            if (raw[i].type === type && (raw[i].resource || '') === res) sum += (raw[i].amount || 0);
        }
        return sum;
    }

    // Whether the zone buff manager says this buff is running; null when the
    // manager is missing or the call throws.
    function isRunning(name) {
        try {
            var mgr = game.gi.mZoneBuffManager;
            if (!mgr || typeof mgr.isBuffRunning !== 'function') return null;
            return !!mgr.isBuffRunning(name);
        } catch (e) {
            return null;
        }
    }

    // First in-stock entry of exactly this type and resource ('' = not bound
    // to a resource) holding at least `amount`; null when there is none or the
    // menu cannot be read. One buff action spends one entry, so a split stock
    // cannot cover a larger amount. The entry is returned with its uid object.
    function entryAtLeast(type, resource, amount) {
        var raw = readEntries();
        return raw ? entryIn(raw, type, resource, amount) : null;
    }

    // entryAtLeast() over a list already read.
    function entryIn(raw, type, resource, amount) {
        var res = resource || '';
        for (var i = 0; i < raw.length; i++) {
            if (!raw[i].bad && raw[i].type === type && (raw[i].resource || '') === res &&
                raw[i].amount > 0 && raw[i].amount >= amount) return raw[i];
        }
        return null;
    }

    // The one place the buff packet is sent; false when there is no entry or
    // the packet could not be sent.
    function sendEntry(e, grid, amount) {
        if (!e || !e.uid) return false;
        return S.core.packets.sendAction(61, 0, grid, amount, e.uid) === true;
    }

    // Sends one buff of this type and resource to a grid; false when none is
    // in stock or the packet could not be sent.
    function send(type, resource, grid, amount) {
        return sendEntry(entry(type, resource), grid, amount);
    }

    // Plain buffs only: entries bound to a resource are a different stock.
    // A number, or null when the menu or an entry that may be this stock
    // cannot be read, so a view can show unknown instead of an empty stock.
    function amount(type) {
        return stock(type, '');
    }

    // Adventure maps per adventure name. Runs on the menu's status tick, so
    // it stays silent ({}) while the game is not loaded. null means the menu
    // or an entry that may be a map cannot be read, never "no maps".
    function mapCounts() {
        try {
            if (typeof game === 'undefined' || !game.gi || !game.gi.mCurrentPlayer) return {};
        } catch (e) {
            return {};
        }
        var raw = readEntries();
        if (!raw) return null;
        var out = {};
        for (var i = 0; i < raw.length; i++) {
            if (unreadableAs(raw[i], ADVENTURE_MAP_TYPE)) return null;
            if (raw[i].type !== ADVENTURE_MAP_TYPE || !raw[i].resource) continue;
            var name = raw[i].resource;
            out[name] = (out[name] || 0) + (raw[i].amount || 0);
        }
        return out;
    }

    function definedNames(prefix) {
        var out = [];
        try {
            var map = game.def('global').map_BuffName_BuffDefinition;
            if (map) {
                for (var k in map) {
                    if (typeof k === 'string' && k.indexOf(prefix) === 0) out.push(k);
                }
            }
        } catch (e) { /* not enumerable */ }
        return out;
    }

    function isSpeedBuff(name) {
        return typeof name === 'string' && name.indexOf(SPEED_BUFF_PREFIX) === 0;
    }

    function isStartBuff(name) {
        for (var i = 0; i < START_BUFFS.length; i++) {
            if (START_BUFFS[i].name === name) return true;
        }
        return false;
    }

    // The start buffs with their stock (null when unreadable) and label.
    function startBuffs() {
        return S.kernel.hostRead.pass(function () {
            var out = [];
            for (var i = 0; i < START_BUFFS.length; i++) {
                var name = START_BUFFS[i].name;
                var shown = S.core.locale.known('RES', name);
                out.push({
                    name:   name,
                    amount: amount(name),
                    label:  shown || START_BUFFS[i].label
                });
            }
            return out;
        });
    }

    function effectText(name) {
        var t = S.core.locale.text('DES', name);
        var cut = t.indexOf('Target');
        if (cut !== -1) t = t.substring(0, cut);
        return t.replace(/^\s+|\s+$/g, '');
    }

    // Every defined or stocked speed buff with its amount (null when
    // unreadable). One read pass per call, so all amounts come from the same
    // star-menu read.
    function speedBuffs() {
        return S.kernel.hostRead.pass(speedBuffsNow);
    }

    function speedBuffsNow() {
        var names = definedNames(SPEED_BUFF_PREFIX);
        // An unreadable menu still lists the defined names; amount() then
        // reports each as null.
        var inv = inventory() || [];
        var i;
        for (i = 0; i < inv.length; i++) {
            if (isSpeedBuff(inv[i].type) && names.indexOf(inv[i].type) === -1) names.push(inv[i].type);
        }
        names.sort();
        var out = [];
        for (i = 0; i < names.length; i++) {
            out.push({
                name:   names[i],
                amount: amount(names[i]),
                label:  S.core.locale.res(names[i]),
                effect: effectText(names[i])
            });
        }
        return out;
    }

    function isNum(v) { return S.kernel.is.num(v); }

    // The host's population resource name, owned by core/resources.js.
    function populationResource() { return S.core.resources.POPULATION; }

    // A zone-wide buff, so it targets grid 0. Verified by the buff running or
    // by the stock dropping below the baseline.
    function zoneWide(name, kind, allowed, refusal) {
        return {
            label:     kind + ' ' + name,
            category:  'buffs',
            timeoutMs: BUFF_TIMEOUT_MS,
            precheck: function () {
                if (!allowed(name)) return refusal;
                var n = stock(name, '');
                if (!isNum(n)) return 'buff stock unreadable';
                if (!(n > 0)) return 'no buff in stock';
                if (isRunning(name) === true) return 'buff already running';
                return null;
            },
            baseline: function () { return { stock: stock(name, '') }; },
            send: function () { return send(name, '', ZONE_GRID, 0); },
            check: function (base) {
                if (isRunning(name) === true) return true;
                var n = stock(name, '');
                return !!base && isNum(base.stock) && isNum(n) && n < base.stock;
            }
        };
    }

    function speed(name) {
        return zoneWide(name, 'speed buff', isSpeedBuff, 'not a speed buff');
    }

    // Start buff: a zone-wide buff of START_BUFFS, applied like a speed buff.
    function startBuff(name) {
        return zoneWide(name, 'start buff', isStartBuff, 'not a start buff');
    }

    // Camp buff: sent to the grid of the camp it is meant for, never to the
    // player grid. Verified by the stock dropping below the baseline.
    // Never sent twice: a second buff on a camp the first one already hit
    // makes the client fail and close (#63). In place of a retry the stock is
    // watched for CAMP_TIMEOUT_MS, the time a send and its retry had. The
    // camp is checked in the precheck, right before the only send. As with
    // an adventure item, the star menu is read once in the precheck and the
    // send uses that entry; with no usable entry nothing goes out (NOT_SENT).
    function camp(name, grid) {
        var found = null;
        return {
            label:     'camp buff ' + name + ' -> ' + grid,
            category:  'buffs',
            timeoutMs: CAMP_TIMEOUT_MS,
            retries:   0,
            precheck: function () {
                if (!isNum(grid) || !(grid > 0)) return 'no target grid';
                found = null;
                var raw = readEntries();
                var n = raw ? stockIn(raw, name, '') : null;
                if (!isNum(n)) return 'buff stock unreadable';
                if (!(n > 0)) return 'no buff in stock';
                S.core.buildings.invalidate();
                var b = S.core.buildings.byGrid(grid);
                if (!b || !S.core.buildings.isEnemy(b)) return 'no enemy building at grid';
                found = entryIn(raw, name, '', 0);
                return null;
            },
            baseline: function () { return { stock: stock(name, '') }; },
            send: function () {
                var e = found;
                found = null;
                if (!e || !e.uid) {
                    S.kernel.warn('buffs', 'camp buff ' + name + ' -> ' + grid + ': not sent, no usable star-menu entry');
                    return S.core.actions.NOT_SENT;
                }
                return sendEntry(e, grid, 0);
            },
            check: function (base) {
                var n = stock(name, '');
                return !!base && isNum(base.stock) && isNum(n) && n < base.stock;
            }
        };
    }

    // Host definition of a buff name, or null when it is missing or the
    // definition map cannot be read.
    function defOf(name) {
        try {
            var map = game.def('global').map_BuffName_BuffDefinition;
            return (map && map[name]) || null;
        } catch (e) { return null; }
    }

    // Quest target names of a buff definition (its target description is a
    // comma list). Targets only widen the quest match, so any failure is [].
    function targetsOf(name) {
        var out = [];
        try {
            var text = defOf(name).GetTargetDescription_string();
            var parts = String(text).split(',');
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i].replace(/^\s+|\s+$/g, '');
                if (p) out.push(p);
            }
        } catch (e) { return []; }
        return out;
    }

    // Target group of a buff definition, trimmed; '' when it has none or it
    // cannot be read.
    function groupOf(name) {
        try {
            var g = defOf(name).GetTargetGroup_string();
            return typeof g === 'string' ? g.replace(/^\s+|\s+$/g, '') : '';
        } catch (e) { return ''; }
    }

    // Whether the host puts this building in the target group. Any failure is
    // no match, so an unreadable group never widens what a buff may target.
    function groupContains(group, buildingName) {
        if (!group) return false;
        try {
            return !!game.def(TARGET_GROUPS_DEF).targetGroups.groupContains(group, buildingName);
        } catch (e) { return false; }
    }

    // GetBuffType() of a buff definition as a number; null when the
    // definition or the method is missing or throws. The only reader of it.
    function buffTypeOf(name) {
        try {
            var d = defOf(name);
            if (!d || typeof d.GetBuffType !== 'function') return null;
            var v = d.GetBuffType();
            return isNum(v) ? v : null;
        } catch (e) { return null; }
    }

    // Every defined buff and every inventory type with a definition, each as
    // { name, targets, group }. Inventory types without a definition are left
    // out, since their targets cannot be checked. Reading the target
    // description of every definition is the costly part of a candidate
    // lookup, so inside a host-read pass it is done once for all buildings;
    // the table is shared and must not be changed.
    function targetTable() {
        return S.kernel.hostRead.cached('buffs.targetTable', targetTableNow);
    }

    function targetTableNow() {
        var names = definedNames('');
        var inv = inventory() || [];
        var i;
        for (i = 0; i < inv.length; i++) {
            if (inv[i].type && names.indexOf(inv[i].type) === -1) names.push(inv[i].type);
        }
        var out = [];
        for (i = 0; i < names.length; i++) {
            if (!defOf(names[i])) continue;
            out.push({ name: names[i], targets: targetsOf(names[i]), group: groupOf(names[i]) });
        }
        return out;
    }

    // groupContains, shared across the buildings of one host-read pass.
    function groupHas(group, buildingName) {
        return S.kernel.hostRead.cached('buffs.groupContains|' + group + '|' + buildingName, function () {
            return groupContains(group, buildingName);
        });
    }

    // How a buff's definition reaches this building: 'name', 'workyard' (the
    // Workyard token, only for a workyard), 'group' or null. The one place
    // this rule exists, shared by the candidate scan and the single-name match.
    function viaOf(targets, group, buildingName, workyard) {
        if (targets.indexOf(buildingName) !== -1) return 'name';
        if (workyard && targets.indexOf(WORKYARD_TARGET) !== -1) return 'workyard';
        if (groupHas(group, buildingName)) return 'group';
        return null;
    }

    // Every buff whose definition targets this building: by name, through the
    // Workyard token (only when the building is a workyard) or through its
    // target group. Each entry says whether it is offered and, if not, why.
    function buildingBuffCandidates(buildingName, workyard) {
        var table = targetTable();
        var out = [];
        for (var i = 0; i < table.length; i++) {
            var nm = table[i].name;
            var targets = table[i].targets;
            var group = table[i].group;
            var via = viaOf(targets, group, buildingName, workyard);
            if (!via) continue;
            var type = buffTypeOf(nm);
            var offered = type === PRODUCTION_BUFF_TYPE;
            out.push({
                name:     nm,
                label:    S.core.locale.res(nm),
                effect:   effectText(nm),
                amount:   amount(nm),
                buffType: type,
                // A copy, so a caller cannot change the shared table.
                targets:  targets.slice(),
                group:    group,
                via:      via,
                offered:  offered,
                reason:   offered ? '' : (type === null ? 'buff type unreadable' : 'buff type ' + type)
            });
        }
        out.sort(function (a, b) {
            var la = String(a.label);
            var lb = String(b.label);
            if (la !== lb) return la < lb ? -1 : 1;
            if (a.name === b.name) return 0;
            return a.name < b.name ? -1 : 1;
        });
        return out;
    }

    // One star-menu read and one target table per call, also outside a pass,
    // so every amount of one call comes from the same list.
    function candidatesOnce(buildingName, workyard) {
        return S.kernel.hostRead.pass(function () { return buildingBuffCandidates(buildingName, workyard); });
    }

    // The candidates that may be applied to this building.
    function buildingBuffs(buildingName, workyard) {
        var all = candidatesOnce(buildingName, workyard);
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i].offered) out.push(all[i]);
        }
        return out;
    }

    // Whether this buff is offered for this building: the same answer as the
    // candidate scan for one name, read live, so a queued apply's precheck
    // costs a handful of host calls instead of a scan of every definition.
    function buildingBuffMatch(name, buildingName, workyard) {
        if (!defOf(name)) return false;
        return viaOf(targetsOf(name), groupOf(name), buildingName, workyard) !== null &&
            buffTypeOf(name) === PRODUCTION_BUFF_TYPE;
    }

    // Applies of one buff name that are in flight (open) and how many have
    // started (seq). Applies of the same buff interleave their steps, so a
    // baseline read after another apply's send and a describe read after its
    // spend would print a before/after pair that is not this apply's change.
    // Such a pair is printed only for an apply that had the stock to itself;
    // the others print the current stock. An attempt dropped without finishing
    // (queue reset without a script reload) leaves open raised, so later lines
    // use the overlap text until reload. Text only; no decision reads this.
    var buildingRuns = {};

    function runsOf(name) {
        if (!buildingRuns[name]) buildingRuns[name] = { open: 0, seq: 0 };
        return buildingRuns[name];
    }

    function fmtStock(n) {
        return typeof n === 'number' ? String(n) : 'unreadable';
    }

    // Precheck of a def that only acts on the home island: the zone's own
    // read refusal while the zone view is not ok (loading or unreadable), so a
    // failed read is retried rather than taken for "not home"; the plain
    // refusal when the zone is known and is not home; null when home.
    function homeRefusal() {
        var v = S.core.zone.view();
        if (!S.kernel.read.isOk(v)) return S.core.zone.UNREADABLE;
        if (!v.value || v.value.home !== true) return 'not on the home island';
        return null;
    }

    // Production buff on one building of the home island, sent to that
    // building's grid. Verified only by the building showing a running
    // production buff: a stock drop alone does not say the buff landed on this
    // building. No retry, since a second send could spend a second buff when
    // the first one applied without being seen.
    function building(name, grid, buildingName, workyard) {
        return {
            label:     'building buff ' + name + ' -> ' + buildingName + ' ' + grid,
            category:  'buffs',
            timeoutMs: BUFF_TIMEOUT_MS,
            retries:   0,
            precheck: function () {
                var off = homeRefusal();
                if (off) return off;
                if (!isNum(grid) || !(grid > 0)) return 'no target grid';
                if (!buildingBuffMatch(name, buildingName, workyard)) return 'buff does not target ' + buildingName;
                var n = stock(name, '');
                if (!isNum(n)) return 'buff stock unreadable';
                if (!(n > 0)) return 'no buff in stock';
                S.core.buildings.invalidate();
                var b = S.core.buildings.byGrid(grid);
                if (S.core.buildings.name(b) !== buildingName) return 'building changed';
                return S.core.buildings.buffBlock(b);
            },
            baseline: function () {
                var r = runsOf(name);
                var base = { stock: stock(name, ''), overlap: r.open > 0, seq: ++r.seq };
                r.open++;
                return base;
            },
            send: function () { return send(name, '', grid, 0); },
            check: function () {
                return S.core.buildings.hasProductionBuff(S.core.buildings.byGrid(grid)) === true;
            },
            describe: function (base) {
                if (!base || typeof base.seq !== 'number') return '';
                var r = runsOf(name);
                r.open = Math.max(0, r.open - 1);
                var now = stock(name, '');
                var alone = !base.overlap && r.seq === base.seq;
                if (alone) return 'stock ' + fmtStock(base.stock) + ' -> ' + fmtStock(now);
                return 'stock ' + fmtStock(now) + ' now (other applies of this buff overlapped)';
            }
        };
    }

    // HH:MM:SS.mmm of a ms time, for the burst line: the packets of a burst
    // are ms apart, so the logger's second stamp cannot tell them apart.
    function clockMs(ms) {
        return S.kernel.text.clock(new Date(ms), { seconds: true, ms: true });
    }

    function uidText(e) {
        try {
            if (e && e.uid && typeof e.uid.toKeyString === 'function') return String(e.uid.toKeyString());
        } catch (err) { /* left as unknown */ }
        return '?';
    }

    function isArray(v) { return S.kernel.is.array(v); }

    function gridsText(grids) {
        return isArray(grids) ? grids.join(',') : String(grids);
    }

    // Buffs on the building at each grid ('<grid>:<count>', '?' when there is
    // no building or no readable list). A count that grew while the stock did
    // not drop points at client lag; both unchanged point at a server refusal.
    function gridBuffs(grids) {
        var out = [];
        for (var i = 0; i < grids.length; i++) {
            var c = null;
            try {
                var st = S.core.buildings.buffState(S.core.buildings.byGrid(grids[i]));
                c = st ? st.buffsVector : null;
            } catch (e) { c = null; }
            out.push(grids[i] + ':' + (isNum(c) ? c : '?'));
        }
        return out.join(',');
    }

    // Adventure item burst: one buff of this name applied to every grid in
    // `grids`, each offered `amount`, as one action whose single send issues
    // one packet per grid back to back. No queue step, poll, read or log sits
    // between two packets, so the server gets the whole item at once, as the
    // client's own multi-target apply does. Every packet spends the one
    // star-menu entry the precheck chose: the AIR bridge can miss the menu on
    // a re-read within the same step, and one stack holding opts.need (what
    // the whole burst may take, default amount) means no packet finds it
    // empty. The game takes at most what each grid still needs, so the stock
    // drop can be smaller than the offer; dropped() reports the drop of the
    // whole burst, since the takes of single grids are not known.
    // opts.quietMs holds the check back for that long after the send, so the
    // burst is read only once the server has reacted to it; the verify window
    // runs on top of it. The baseline is the stock the precheck read, so a
    // missed re-read cannot leave the burst unverifiable.
    // opts.buildings (parallel to grids, '' for an empty grid) are the
    // buildings the caller saw when it chose to send. The action may run later
    // than that read, so the precheck reads every grid again before the first
    // packet; when any grid shows another building, the whole burst is a
    // NOT_SENT: nothing goes out and the caller decides again on a fresh read.
    // Without it no building is read. A send with no usable entry is a
    // NOT_SENT too, so it can be tried again later; only a packet that could
    // not be sent is a failure, and the burst stops at that grid, so no later
    // grid is sent.
    function adventureBurst(name, grids, amount, opts) {
        var drop = null;
        var found = null;
        var moved = null;
        var pre = null;
        var need = opts && opts.need !== undefined && opts.need !== null ? opts.need : amount;
        var expected = opts && isArray(opts.buildings) ? opts.buildings : null;
        var quietMs = opts && isNum(opts.quietMs) && opts.quietMs > 0 ? opts.quietMs : 0;
        var def = {
            label:     'item ' + name + ' x' + amount + ' -> ' + gridsText(grids),
            category:  'buffs',
            timeoutMs: quietMs + BUFF_TIMEOUT_MS,
            precheck: function () {
                if (!isArray(grids) || grids.length === 0) return 'no target grid';
                for (var g = 0; g < grids.length; g++) {
                    if (!isNum(grids[g]) || !(grids[g] > 0)) return 'no target grid';
                }
                if (!isNum(amount) || amount !== Math.floor(amount) || !(amount > 0)) return 'invalid amount';
                if (S.core.zone.isAdventure() !== true) return 'not on an adventure';
                found = null;
                moved = null;
                pre = null;
                var raw = readEntries();
                var n = raw ? stockIn(raw, name, '') : null;
                if (!isNum(n)) return 'buff stock unreadable';
                if (!isNum(need) || need !== Math.floor(need) || need < amount) return 'invalid amount';
                if (n < need) return 'not enough in stock';
                found = entryIn(raw, name, '', need);
                if (!found) return 'no single stack of ' + need;
                pre = n;
                if (expected !== null) {
                    var list = [];
                    try { S.core.buildings.invalidate(); } catch (e) { /* the reads below still run */ }
                    for (var i = 0; i < grids.length; i++) {
                        if (typeof expected[i] !== 'string') continue;
                        var nm = '';
                        try {
                            nm = S.core.buildings.name(S.core.buildings.byGrid(grids[i]));
                            if (typeof nm !== 'string') nm = '';
                        } catch (e2) { nm = ''; }
                        if (nm !== expected[i]) {
                            list.push(grids[i] + ' (was ' + (expected[i] || 'none') + ', now ' + (nm || 'none') + ')');
                        }
                    }
                    if (list.length) {
                        moved = 'the building at the grid changed since the target was chosen: ' + list.join(', ');
                    }
                }
                return null;
            },
            baseline: function () { return { stock: isNum(pre) ? pre : stock(name, '') }; },
            send: function () {
                var e = found;
                var m = moved;
                found = null;
                moved = null;
                var why = m || (!e ? 'no star-menu entry' : (!e.uid ? 'its star-menu entry has no unique id' : null));
                if (why) {
                    S.kernel.warn('buffs', 'item ' + name + ' -> ' + gridsText(grids) + ': not sent, ' + why);
                    return S.core.actions.NOT_SENT;
                }
                var t0 = new Date().getTime();
                var went = [];
                var failed = -1;
                for (var i = 0; i < grids.length; i++) {
                    if (sendEntry(e, grids[i], amount) === false) {
                        failed = i;
                        break;
                    }
                    went.push(grids[i] + '@+' + (new Date().getTime() - t0));
                }
                // Written after the loop, so no log call delays a packet.
                var text = 'item ' + name + ' burst x' + amount + ' -> ' + grids.length + ' grid(s): ' +
                    (went.length ? went.join(', ') : 'none');
                if (failed >= 0) {
                    text += '; ' + grids[failed] + ' failed';
                    if (failed + 1 < grids.length) text += '; not sent ' + grids.slice(failed + 1).join(',');
                }
                text += ' (stack ' + e.amount + '[' + uidText(e) + '], stock ' + fmtStock(pre) +
                    ', need ' + need + ', first at ' + clockMs(t0) + ')';
                S.kernel.log('buffs', text);
                return failed < 0;
            },
            check: function (base) {
                var n = stock(name, '');
                if (!!base && isNum(base.stock) && isNum(n) && n < base.stock) {
                    drop = base.stock - n;
                    return true;
                }
                return false;
            },
            // The buffs per grid are read only when the caller named the
            // buildings: without them the action reads no building at all.
            describe: function (base) {
                var text = 'stock ' + (base ? base.stock : '?') + ' -> ' + stock(name, '');
                if (expected !== null && isArray(grids)) text += '; buffs ' + gridBuffs(grids);
                return text;
            },
            dropped: function () { return drop; }
        };
        if (quietMs > 0) def.checkAfterMs = quietMs;
        return def;
    }

    // Adventure item on one grid: a burst of one, so a single send and a
    // burst share one implementation. opts.building (a string, '' for an empty
    // grid) is the building the caller saw at the grid, checked as in the
    // burst; without it no building is read.
    function adventureItem(name, grid, amount, opts) {
        return adventureBurst(name, [grid], amount, {
            buildings: opts && typeof opts.building === 'string' ? [opts.building] : null
        });
    }

    // How the definition of an adventure item relates to the building at a
    // grid, for the diagnostic line of a send: { targets, group, via }. via is
    // null when no building stands (buildingName ''), else what viaOf says
    // ('name', 'group', or null when the definition does not reach it). Text
    // only: no send decision reads it.
    function adventureTarget(name, buildingName) {
        var targets = targetsOf(name);
        var group = groupOf(name);
        var via = null;
        if (buildingName) {
            try { via = viaOf(targets, group, buildingName, false); } catch (e) { via = null; }
        }
        return { targets: targets, group: group, via: via };
    }

    // Stock of exactly this type and resource: { total, largest } over its
    // entries, or null when the menu or an entry that may be this stock cannot
    // be read. largest is the biggest amount one buff action can send.
    function stack(type, resource) {
        var raw = readEntries();
        if (!raw) return null;
        var res = resource || '';
        var total = 0;
        var largest = 0;
        for (var i = 0; i < raw.length; i++) {
            if (unreadableAs(raw[i], type)) return null;
            if (raw[i].type !== type || (raw[i].resource || '') !== res) continue;
            var a = raw[i].amount || 0;
            total += a;
            if (a > largest) largest = a;
        }
        return { total: total, largest: largest };
    }

    // Population buff stock: stack() of the population entries.
    function populationStock() {
        return stack(ADD_RESOURCE_TYPE, populationResource());
    }

    // Population buff: the exact amount the caller asks for, sent from a
    // single stack that holds at least that amount. Verified by the free
    // population rising by that amount or the stock dropping by it.
    function population(amount) {
        return {
            label:     'population buff ' + amount,
            category:  'buffs',
            timeoutMs: BUFF_TIMEOUT_MS,
            precheck: function () {
                if (!isNum(amount) || amount !== Math.floor(amount) || !(amount > 0)) return 'invalid amount';
                var n = stock(ADD_RESOURCE_TYPE, populationResource());
                if (!isNum(n)) return 'buff stock unreadable';
                if (n < amount) return 'not enough in stock';
                if (!entryAtLeast(ADD_RESOURCE_TYPE, populationResource(), amount)) return 'no single stack of ' + amount;
                if (!isNum(S.core.resources.freePopulation())) return 'free population unreadable';
                return null;
            },
            baseline: function () {
                return {
                    free:  S.core.resources.freePopulation(),
                    stock: stock(ADD_RESOURCE_TYPE, populationResource())
                };
            },
            send: function () {
                return sendEntry(entryAtLeast(ADD_RESOURCE_TYPE, populationResource(), amount), PLAYER_GRID, amount);
            },
            check: function (base) {
                if (!base) return false;
                var free = S.core.resources.freePopulation();
                if (isNum(free) && isNum(base.free) && free >= base.free + amount) return true;
                var n = stock(ADD_RESOURCE_TYPE, populationResource());
                return isNum(n) && isNum(base.stock) && n <= base.stock - amount;
            },
            describe: function (base) {
                return 'free population ' + (base ? base.free : '?') + ' -> ' + S.core.resources.freePopulation();
            }
        };
    }

    function countOpen(list, name) {
        var c = 0;
        for (var i = 0; i < list.length; i++) {
            if (list[i].name === name) c++;
        }
        return c;
    }

    // Precheck refusals of a map start that only say a read failed: nothing
    // went out, and a later look may read.
    var MAP_STOCK_UNREADABLE = 'map stock unreadable';
    var ADVENTURES_UNREADABLE = 'adventures unreadable';

    // The read a map-start refusal names ('zone', 'map stock', 'adventure list'), or
    // null when the refusal is no failed read.
    function mapReadRefusal(reason) {
        if (reason === S.core.zone.UNREADABLE) return 'zone';
        if (reason === MAP_STOCK_UNREADABLE) return 'map stock';
        if (reason === ADVENTURES_UNREADABLE) return 'adventure list';
        return null;
    }

    // Map stock of one adventure: a number, or null when the star menu
    // cannot be read.
    function mapStock(name) {
        return stock(ADVENTURE_MAP_TYPE, name);
    }

    // Starts an adventure map from the star menu; only on the home island.
    // Verified by one more open adventure of that name or the map stock
    // dropping below the baseline. The star menu is read once, in the
    // precheck, and the send uses that entry (see adventureItem); with no
    // usable entry nothing goes out (NOT_SENT). The final log line names the
    // stock and open count before and after, so an unseen start shows what the
    // game did.
    function map(name) {
        var found = null;
        return {
            label:     'start map ' + name,
            category:  'buffs',
            timeoutMs: MAP_TIMEOUT_MS,
            precheck: function () {
                found = null;
                var off = homeRefusal();
                if (off) return off;
                var raw = readEntries();
                var n = raw ? stockIn(raw, ADVENTURE_MAP_TYPE, name) : null;
                if (!isNum(n)) return MAP_STOCK_UNREADABLE;
                if (!(n > 0)) return 'no map in stock';
                if (!S.core.adventures.own()) return ADVENTURES_UNREADABLE;
                found = entryIn(raw, ADVENTURE_MAP_TYPE, name, 0);
                return null;
            },
            baseline: function () {
                var list = S.core.adventures.own();
                return {
                    open:  list ? countOpen(list, name) : null,
                    stock: stock(ADVENTURE_MAP_TYPE, name)
                };
            },
            send: function () {
                var e = found;
                found = null;
                if (!e || !e.uid) {
                    S.kernel.warn('buffs', 'start map ' + name + ': not sent, no usable star-menu entry');
                    return S.core.actions.NOT_SENT;
                }
                return sendEntry(e, PLAYER_GRID, 0);
            },
            check: function (base) {
                if (!base) return false;
                var list = S.core.adventures.own();
                if (list && isNum(base.open) && countOpen(list, name) > base.open) return true;
                var n = stock(ADVENTURE_MAP_TYPE, name);
                return isNum(n) && isNum(base.stock) && n < base.stock;
            },
            describe: function (base) {
                var list = S.core.adventures.own();
                var n = stock(ADVENTURE_MAP_TYPE, name);
                return 'stock ' + (base && isNum(base.stock) ? base.stock : '?') + ' -> ' + (isNum(n) ? n : '?') +
                    ', open ' + (base && isNum(base.open) ? base.open : '?') + ' -> ' + (list ? countOpen(list, name) : '?');
            }
        };
    }

    S.core.buffs = {
        SPEED_BUFF_PREFIX: SPEED_BUFF_PREFIX,
        PLAYER_GRID:   PLAYER_GRID,
        ZONE_GRID:     ZONE_GRID,
        ADD_RESOURCE_TYPE: ADD_RESOURCE_TYPE,
        inventory:     inventory,
        entry:         entry,
        stock:         stock,
        stack:         stack,
        isRunning:     isRunning,
        send:          send,
        amount:        amount,
        speed:         speed,
        camp:          camp,
        adventureItem: adventureItem,
        adventureBurst: adventureBurst,
        targetsOf:     targetsOf,
        adventureTarget: adventureTarget,
        buffTypeOf:    buffTypeOf,
        buildingBuffCandidates: candidatesOnce,
        buildingBuffs: buildingBuffs,
        buildingBuffMatch: buildingBuffMatch,
        building:      building,
        PRODUCTION_BUFF_TYPE: PRODUCTION_BUFF_TYPE,
        WORKYARD_TARGET: WORKYARD_TARGET,
        population:    population,
        populationStock: populationStock,
        map:           map,
        mapStock:      mapStock,
        mapReadRefusal: mapReadRefusal,
        mapCounts:     mapCounts,
        definedNames:  definedNames,
        isSpeedBuff:   isSpeedBuff,
        isStartBuff:   isStartBuff,
        isRunning:     isRunning,
        startBuffs:    startBuffs,
        startBuff:     startBuff,
        effectText:    effectText,
        speedBuffs:    speedBuffs
    };

}(Steward));
