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

    // Every resource the player holds, as [{ name, amount }]. An amount the
    // host does not give as a number is null, never 0. Returns null when the
    // host, the method or the vector is missing, or the call threw.
    function list() {
        try {
            if (typeof game === 'undefined' || !game || typeof game.getResources !== 'function') return null;
            var resources = game.getResources();
            if (!resources) return null;
            var fn = resources.GetPlayerResources_vector;
            if (typeof fn !== 'function') return null;
            var vec = fn.call(resources, '');
            if (!vec || typeof vec.length !== 'number') return null;
            var out = [];
            for (var i = 0; i < vec.length; i++) {
                var item = vec[i];
                if (!item) continue;
                var name = item.name_string;
                if (typeof name !== 'string' || !name) continue;
                var amt = item.amount;
                out.push({ name: name, amount: (typeof amt === 'number' && !isNaN(amt)) ? amt : null });
            }
            return out;
        } catch (e) {
            if (!warnedThrow) {
                warnedThrow = true;
                S.kernel.warn('resources', 'GetPlayerResources_vector threw:', e);
            }
            return null;
        }
    }

    // The event a resource belongs to, from the host's economy definition:
    // a non-empty string for an event resource, '' for a plain one, null when
    // the definition cannot be read.
    function eventName(resName) {
        if (typeof resName !== 'string' || !resName) return null;
        try {
            if (typeof game === 'undefined' || !game || typeof game.def !== 'function') return null;
            var econ = game.def('ServerState::gEconomics');
            if (!econ) return null;
            var fn = econ.GetResourcesDefaultDefinition;
            if (typeof fn !== 'function') return null;
            var def = fn.call(econ, resName);
            if (!def) return null;
            var ev = def.requiredEventName_string;
            return typeof ev === 'string' ? ev : null;
        } catch (e) {
            if (!warnedThrow) {
                warnedThrow = true;
                S.kernel.warn('resources', 'GetResourcesDefaultDefinition threw:', e);
            }
            return null;
        }
    }

    if (!S.core.resources) S.core.resources = {};

    S.core.resources.amount         = amount;
    S.core.resources.freePopulation = freePopulation;
    S.core.resources.POPULATION     = POPULATION;
    S.core.resources.list           = list;
    S.core.resources.eventName      = eventName;

}(Steward));
