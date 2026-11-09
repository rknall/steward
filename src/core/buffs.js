/*
 * Buff inventory and buff actions.
 *
 * Reads the star-menu buff stock (including adventure maps) and the buff
 * definitions, and builds the action defs that apply a buff (speed, camp,
 * population, building production buffs) or start an adventure map. A def is run with
 * S.core.actions.attempt. Adventure items (a buff applied to a grid on the
 * island) and the quest targets of a buff are here too. Every reader reports an unreadable host as null, and
 * a def treats null as not observed: an unreadable stock never counts as
 * "the stock dropped".
 */

(function (S) {

    // The only place the speed-buff name prefix exists.
    var SPEED_BUFF_PREFIX = 'GeneralSpeedBuff_';

    // Star-menu type of adventure maps; the entry's resource is the adventure
    // name. The only place this type name exists.
    var ADVENTURE_MAP_TYPE = 'Adventure';

    // Wire values of the buff action (61): the player's own island grid, the
    // zone-wide target of a speed buff, and the star-menu type that carries the
    // population buff. 8825 and 0 are what the client's own buff UI sends; they
    // exist only here. The population resource name is read from
    // S.core.resources.POPULATION at call time, since that file loads after
    // this one.
    var PLAYER_GRID = 8825;
    var ZONE_GRID = 0;
    var POPULATION_TYPE = 'AddResource';

    var BUFF_TIMEOUT_MS = 15000;

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
    // is not taken for an empty stock.
    function readEntries() {
        try {
            if (typeof game === 'undefined' || !game.gi || !game.gi.mCurrentPlayer ||
                typeof game.gi.mCurrentPlayer.getAvailableBuffs_vector !== 'function') {
                return null;
            }
            var vec = game.gi.mCurrentPlayer.getAvailableBuffs_vector();
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

    function inventory() {
        var raw = readEntries();
        var out = [];
        if (!raw) return out;
        for (var i = 0; i < raw.length; i++) {
            var key = '';
            try { key = raw[i].uid.toKeyString(); } catch (e) { /* leave default */ }
            out.push({ type: raw[i].type, resource: raw[i].resource, amount: raw[i].amount, uid: key });
        }
        return out;
    }

    // The same as entryAtLeast with no minimum, so empty entries are skipped.
    function entry(type, resource) {
        return entryAtLeast(type, resource, 0);
    }

    // Stock of exactly this type and resource ('' = not bound to a resource):
    // a number, or null when the menu cannot be read. The map stock of an
    // adventure is stock(ADVENTURE_MAP_TYPE, name).
    function stock(type, resource) {
        var raw = readEntries();
        if (!raw) return null;
        var res = resource || '';
        var sum = 0;
        for (var i = 0; i < raw.length; i++) {
            // An entry that could not be read fully may be this stock; report
            // unreadable rather than a sum that silently misses it.
            if (raw[i].bad && (raw[i].typeBad || raw[i].type === type)) return null;
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
        if (!raw) return null;
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
    // 0 when the menu cannot be read.
    function amount(type) {
        var n = stock(type, '');
        return typeof n === 'number' ? n : 0;
    }

    // Adventure maps per adventure name. Runs on the menu's status tick, so
    // it stays silent while the game is not loaded.
    function mapCounts() {
        try {
            if (typeof game === 'undefined' || !game.gi || !game.gi.mCurrentPlayer) return {};
        } catch (e) {
            return {};
        }
        var out = {};
        var inv = inventory();
        for (var i = 0; i < inv.length; i++) {
            if (inv[i].type !== ADVENTURE_MAP_TYPE || !inv[i].resource) continue;
            var name = inv[i].resource;
            out[name] = (out[name] || 0) + (inv[i].amount || 0);
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

    function effectText(name) {
        var t = S.core.locale.text('DES', name);
        var cut = t.indexOf('Target');
        if (cut !== -1) t = t.substring(0, cut);
        return t.replace(/^\s+|\s+$/g, '');
    }

    function speedBuffs() {
        var names = definedNames(SPEED_BUFF_PREFIX);
        var inv = inventory();
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

    function isNum(v) { return typeof v === 'number' && !isNaN(v); }

    // The host's population resource name, owned by core/resources.js.
    function populationResource() { return S.core.resources.POPULATION; }

    // Speed buff: zone-wide, so it targets grid 0. Verified by the buff running
    // or by the stock dropping below the baseline.
    function speed(name) {
        return {
            label:     'speed buff ' + name,
            category:  'buffs',
            timeoutMs: BUFF_TIMEOUT_MS,
            precheck: function () {
                if (!isSpeedBuff(name)) return 'not a speed buff';
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

    // Camp buff: sent to the grid of the camp it is meant for, never to the
    // player grid. Verified by the stock dropping below the baseline.
    function camp(name, grid) {
        return {
            label:     'camp buff ' + name + ' -> ' + grid,
            category:  'buffs',
            timeoutMs: BUFF_TIMEOUT_MS,
            precheck: function () {
                if (!isNum(grid) || !(grid > 0)) return 'no target grid';
                var n = stock(name, '');
                if (!isNum(n)) return 'buff stock unreadable';
                if (!(n > 0)) return 'no buff in stock';
                S.core.buildings.invalidate();
                var b = S.core.buildings.byGrid(grid);
                if (!b || !S.core.buildings.isEnemy(b)) return 'no enemy building at grid';
                return null;
            },
            baseline: function () { return { stock: stock(name, '') }; },
            send: function () { return send(name, '', grid, 0); },
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

    // Every buff whose definition targets this building: by name, through the
    // Workyard token (only when the building is a workyard) or through its
    // target group. Each entry says whether it is offered and, if not, why.
    // Inventory types without a definition are skipped, since their targets
    // cannot be checked.
    function buildingBuffCandidates(buildingName, workyard) {
        var names = definedNames('');
        var inv = inventory();
        var i;
        for (i = 0; i < inv.length; i++) {
            if (inv[i].type && names.indexOf(inv[i].type) === -1) names.push(inv[i].type);
        }
        var out = [];
        for (i = 0; i < names.length; i++) {
            var nm = names[i];
            if (!defOf(nm)) continue;
            var targets = targetsOf(nm);
            var group = groupOf(nm);
            var via = null;
            if (targets.indexOf(buildingName) !== -1) via = 'name';
            else if (workyard && targets.indexOf(WORKYARD_TARGET) !== -1) via = 'workyard';
            else if (groupContains(group, buildingName)) via = 'group';
            if (!via) continue;
            var type = buffTypeOf(nm);
            var offered = type === PRODUCTION_BUFF_TYPE;
            out.push({
                name:     nm,
                label:    S.core.locale.res(nm),
                amount:   amount(nm),
                buffType: type,
                targets:  targets,
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

    // The candidates that may be applied to this building.
    function buildingBuffs(buildingName, workyard) {
        var all = buildingBuffCandidates(buildingName, workyard);
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i].offered) out.push(all[i]);
        }
        return out;
    }

    // Whether this buff is offered for this building.
    function buildingBuffMatch(name, buildingName, workyard) {
        var list = buildingBuffs(buildingName, workyard);
        for (var i = 0; i < list.length; i++) {
            if (list[i].name === name) return true;
        }
        return false;
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
                if (S.core.zone.isHome() !== true) return 'not on the home island';
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

    // Adventure item: one buff of this name applied to a grid on the island, in
    // the amount given. Verified by the stock dropping below the baseline.
    // The game takes at most what the grid still needs, so the drop can be
    // smaller than the amount sent; dropped() reports what the verifying check
    // saw, which the caller uses to tell a full grid from a stock-capped send.
    function adventureItem(name, grid, amount) {
        var drop = null;
        return {
            label:     'item ' + name + ' x' + amount + ' -> ' + grid,
            category:  'buffs',
            timeoutMs: BUFF_TIMEOUT_MS,
            precheck: function () {
                if (!isNum(grid) || !(grid > 0)) return 'no target grid';
                if (!isNum(amount) || amount !== Math.floor(amount) || !(amount > 0)) return 'invalid amount';
                if (S.core.zone.isAdventure() !== true) return 'not on an adventure';
                var n = stock(name, '');
                if (!isNum(n)) return 'buff stock unreadable';
                if (n < amount) return 'not enough in stock';
                return null;
            },
            baseline: function () { return { stock: stock(name, '') }; },
            send: function () { return send(name, '', grid, amount); },
            check: function (base) {
                var n = stock(name, '');
                if (!!base && isNum(base.stock) && isNum(n) && n < base.stock) {
                    drop = base.stock - n;
                    return true;
                }
                return false;
            },
            describe: function (base) {
                return 'stock ' + (base ? base.stock : '?') + ' -> ' + stock(name, '');
            },
            dropped: function () { return drop; }
        };
    }

    // Population buff stock: { total, largest } over the population entries,
    // or null when the menu cannot be read. largest is the biggest amount one
    // buff action can send.
    function populationStock() {
        var raw = readEntries();
        if (!raw) return null;
        var res = populationResource();
        var total = 0;
        var largest = 0;
        for (var i = 0; i < raw.length; i++) {
            if (raw[i].type !== POPULATION_TYPE || (raw[i].resource || '') !== res) continue;
            var a = raw[i].amount || 0;
            total += a;
            if (a > largest) largest = a;
        }
        return { total: total, largest: largest };
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
                var n = stock(POPULATION_TYPE, populationResource());
                if (!isNum(n)) return 'buff stock unreadable';
                if (n < amount) return 'not enough in stock';
                if (!entryAtLeast(POPULATION_TYPE, populationResource(), amount)) return 'no single stack of ' + amount;
                if (!isNum(S.core.resources.freePopulation())) return 'free population unreadable';
                return null;
            },
            baseline: function () {
                return {
                    free:  S.core.resources.freePopulation(),
                    stock: stock(POPULATION_TYPE, populationResource())
                };
            },
            send: function () {
                return sendEntry(entryAtLeast(POPULATION_TYPE, populationResource(), amount), PLAYER_GRID, amount);
            },
            check: function (base) {
                if (!base) return false;
                var free = S.core.resources.freePopulation();
                if (isNum(free) && isNum(base.free) && free >= base.free + amount) return true;
                var n = stock(POPULATION_TYPE, populationResource());
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

    // Starts an adventure map from the star menu; only on the home island.
    // Verified by one more open adventure of that name or the map stock
    // dropping below the baseline.
    function map(name) {
        return {
            label:     'start map ' + name,
            category:  'buffs',
            timeoutMs: MAP_TIMEOUT_MS,
            precheck: function () {
                if (S.core.zone.isHome() !== true) return 'not on the home island';
                var n = stock(ADVENTURE_MAP_TYPE, name);
                if (!isNum(n)) return 'map stock unreadable';
                if (!(n > 0)) return 'no map in stock';
                if (!S.core.adventures.own()) return 'adventures unreadable';
                return null;
            },
            baseline: function () {
                var list = S.core.adventures.own();
                return {
                    open:  list ? countOpen(list, name) : null,
                    stock: stock(ADVENTURE_MAP_TYPE, name)
                };
            },
            send: function () { return send(ADVENTURE_MAP_TYPE, name, PLAYER_GRID, 0); },
            check: function (base) {
                if (!base) return false;
                var list = S.core.adventures.own();
                if (list && isNum(base.open) && countOpen(list, name) > base.open) return true;
                var n = stock(ADVENTURE_MAP_TYPE, name);
                return isNum(n) && isNum(base.stock) && n < base.stock;
            }
        };
    }

    S.core.buffs = {
        SPEED_BUFF_PREFIX: SPEED_BUFF_PREFIX,
        PLAYER_GRID:   PLAYER_GRID,
        ZONE_GRID:     ZONE_GRID,
        inventory:     inventory,
        entry:         entry,
        stock:         stock,
        isRunning:     isRunning,
        send:          send,
        amount:        amount,
        speed:         speed,
        camp:          camp,
        adventureItem: adventureItem,
        targetsOf:     targetsOf,
        buffTypeOf:    buffTypeOf,
        buildingBuffCandidates: buildingBuffCandidates,
        buildingBuffs: buildingBuffs,
        buildingBuffMatch: buildingBuffMatch,
        building:      building,
        PRODUCTION_BUFF_TYPE: PRODUCTION_BUFF_TYPE,
        WORKYARD_TARGET: WORKYARD_TARGET,
        population:    population,
        populationStock: populationStock,
        map:          map,
        mapCounts:     mapCounts,
        definedNames:  definedNames,
        isSpeedBuff:   isSpeedBuff,
        effectText:    effectText,
        speedBuffs:    speedBuffs
    };

}(Steward));
