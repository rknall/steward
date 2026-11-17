/*
 * Player resource reads (read-only).
 *
 * The current amount of a named resource and the free population, taken from
 * the host's resource object. A number is a real reading. null means the host,
 * the method or the value is missing, or the call threw. Callers that verify
 * an effect must treat null as "not observed", never as zero: a failed read
 * must not look like an empty stock. This is the failure contract of the
 * action runner in core/actions.js.
 *
 * It also names the population resource, which unit costs and the population
 * star buff both refer to.
 *
 * Enumeration: list() returns every resource the player holds, and
 * eventName(name) reads the host's own event flag of one resource (a
 * non-empty string for an event resource), so callers never keep a list of
 * event resources themselves. Both answer null when the host cannot be read.
 * uncategorized() lists the held resources the storehouse does not show: the
 * ones whose economy default definition names no category. These are what
 * the mayor's house holds (collectibles such as Barrel or Grain Sacks, star
 * coins, manuscripts). The split is the game's own category, not a list kept
 * here.
 *
 * Bundle slot: core, after packets.js and before specialists.js (core files
 * load in name order). Nothing here calls another core at load time; the top
 * level only assigns S.core.resources.
 */

(function (S) {

    // The host's resource name for population. It is the only copy: unit costs
    // and the population star buff read it from here at call time.
    var POPULATION = 'Population';

    // The UI status updater reads resource amounts on every refresh, so a
    // persistent host throw would flood the log. The first throw per load is
    // logged; a reload re-runs this file and resets the flag.
    var warnedThrow = false;

    function read(method, arg) {
        try {
            if (typeof game === 'undefined' || !game || typeof game.getResources !== 'function') return null;
            var resources = game.getResources();
            if (!resources || typeof resources[method] !== 'function') return null;
            // A method called without an argument gets none: the AS3 bridge throws
            // on an extra argument, even undefined, when the host method takes none.
            var n = arguments.length > 1 ? resources[method](arg) : resources[method]();
            return (typeof n === 'number' && !isNaN(n)) ? n : null;
        } catch (e) {
            if (!warnedThrow) {
                warnedThrow = true;
                S.kernel.warn('resources', method + ' threw:', e);
            }
            return null;
        }
    }

    // Amount of one resource by its host name, e.g. 'StripedEggs'.
    function amount(resName) {
        if (typeof resName !== 'string' || !resName) return null;
        return read('GetResourceAmount', resName);
    }

    // Free population: the host's GetFree() value. The host method takes no
    // parameter, so it is read with no argument at all (see read).
    function freePopulation() {
        return read('GetFree');
    }

    // One read of the player's resources: ok with [{ name, amount }] when every
    // item is readable, partial when some item has no name (lost counts them,
    // so a missing resource is not proof the player lacks it), unreadable when
    // the host, the method or the vector is missing or the call threw. An
    // amount the host does not give as a number is null, never 0.
    function readList() {
        try {
            if (typeof game === 'undefined' || !game || typeof game.getResources !== 'function') {
                return S.kernel.read.unreadable('no resources host');
            }
            var resources = game.getResources();
            if (!resources) return S.kernel.read.unreadable('no resources');
            var fn = resources.GetPlayerResources_vector;
            if (typeof fn !== 'function') return S.kernel.read.unreadable('no resource list method');
            var vec = fn.call(resources, '');
            if (!vec || typeof vec.length !== 'number') return S.kernel.read.unreadable('no resource list');
            var out = [];
            var lost = 0;
            for (var i = 0; i < vec.length; i++) {
                var item = vec[i];
                if (!item) { lost++; continue; }
                var name = item.name_string;
                if (typeof name !== 'string' || !name) { lost++; continue; }
                var amt = item.amount;
                out.push({ name: name, amount: (typeof amt === 'number' && !isNaN(amt)) ? amt : null });
            }
            return lost ? S.kernel.read.partial(out, lost, 'unnamed resource') : S.kernel.read.ok(out);
        } catch (e) {
            if (!warnedThrow) {
                warnedThrow = true;
                S.kernel.warn('resources', 'GetPlayerResources_vector threw:', e);
            }
            return S.kernel.read.unreadable('threw: ' + ((e && e.message) ? e.message : String(e)));
        }
    }

    S.kernel.read.source('resources.list', { read: readList, scope: 'pass' });

    // The list read as a Result; opts as for S.kernel.read.get.
    function listRead(opts) {
        return S.kernel.read.get('resources.list', undefined, opts);
    }

    // Every resource the player holds, as [{ name, amount }]: the readable
    // entries, also when some were lost. null when the list cannot be read.
    function list() {
        var r = listRead();
        return S.kernel.read.has(r) ? r.value : null;
    }

    // The economy default definition of one resource, or null when it cannot
    // be read. The one host read behind eventName and categoryOf.
    function defaultDefinition(resName) {
        if (typeof resName !== 'string' || !resName) return null;
        try {
            if (typeof game === 'undefined' || !game || typeof game.def !== 'function') return null;
            var econ = game.def('ServerState::gEconomics');
            if (!econ) return null;
            var fn = econ.GetResourcesDefaultDefinition;
            if (typeof fn !== 'function') return null;
            return fn.call(econ, resName) || null;
        } catch (e) {
            if (!warnedThrow) {
                warnedThrow = true;
                S.kernel.warn('resources', 'GetResourcesDefaultDefinition threw:', e);
            }
            return null;
        }
    }

    // The event a resource belongs to, from the host's economy definition:
    // a non-empty string for an event resource, '' for a plain one, null when
    // the definition cannot be read.
    function eventName(resName) {
        var def = defaultDefinition(resName);
        if (!def) return null;
        try {
            var ev = def.requiredEventName_string;
            return typeof ev === 'string' ? ev : null;
        } catch (e) {
            return null;
        }
    }

    // The storehouse category of a resource: '' for none, null when the
    // definition cannot be read.
    function categoryOf(resName) {
        var def = defaultDefinition(resName);
        if (!def) return null;
        try {
            var c = def.category_string;
            return typeof c === 'string' ? c : '';
        } catch (e) {
            return null;
        }
    }

    // Held resources without a storehouse category, as
    // [{ name, label, amount }] sorted by label. Only amounts above zero; a
    // resource whose definition cannot be read is left out. null when the
    // resource list or every held resource's definition cannot be read, so
    // a host hiccup does not look like an empty mayor's house.
    function uncategorized() {
        var held = list();
        if (!held) return null;
        var out = [];
        var readable = false;
        for (var i = 0; i < held.length; i++) {
            var cat = categoryOf(held[i].name);
            if (cat === null) continue;
            readable = true;
            var n = held[i].amount;
            if (cat !== '' || n === null || n <= 0) continue;
            out.push({ name: held[i].name, label: S.core.locale.res(held[i].name), amount: n });
        }
        out.sort(function (a, b) {
            var x = a.label.toLowerCase();
            var y = b.label.toLowerCase();
            return x < y ? -1 : (x > y ? 1 : 0);
        });
        return (readable || !held.length) ? out : null;
    }

    if (!S.core.resources) S.core.resources = {};

    S.core.resources.amount         = amount;
    S.core.resources.freePopulation = freePopulation;
    S.core.resources.POPULATION     = POPULATION;
    S.core.resources.list           = list;
    S.core.resources.listRead       = listRead;
    S.core.resources.eventName      = eventName;
    S.core.resources.uncategorized  = uncategorized;

}(Steward));
