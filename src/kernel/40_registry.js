/*
 * Module registry.
 *
 * Modules call Steward.kernel.register({...}) at IIFE time. The kernel walks
 * the registry on every scheduler tick.
 *
 * Validation: id must be unique and non-empty, priority must be one of the
 * declared tiers, isReady and plan must be functions. Bad specs are rejected
 * with an ERROR log; the offending module is simply not scheduled.
 */

(function (S) {

    var modules = [];                         // [{ id, priority, isReady, plan, boot }]
    var byId = {};

    function isFunction(x) { return typeof x === 'function'; }

    function register(spec) {
        if (!spec || typeof spec !== 'object') {
            S.kernel.error('registry', 'register called with non-object spec');
            return false;
        }
        if (!spec.id || typeof spec.id !== 'string') {
            S.kernel.error('registry', 'register: spec.id must be a non-empty string');
            return false;
        }
        if (byId[spec.id]) {
            S.kernel.warn('registry', 'register: duplicate id', spec.id, '— ignoring re-registration');
            return false;
        }
        if (!S.kernel.PRIORITY_VALID[spec.priority]) {
            S.kernel.error('registry', 'register:', spec.id, 'has invalid priority', spec.priority);
            return false;
        }
        if (!isFunction(spec.isReady)) {
            S.kernel.error('registry', 'register:', spec.id, 'missing isReady function');
            return false;
        }
        if (!isFunction(spec.plan)) {
            S.kernel.error('registry', 'register:', spec.id, 'missing plan function');
            return false;
        }

        // Experimental gate — modules flagged experimental only register when
        // the host has mainSettings.experimental enabled. This matches the
        // host convention (see HOST_INTEGRATION.md).
        if (spec.experimental === true) {
            if (!S.kernel.host || !S.kernel.host.experimental()) {
                S.kernel.log('registry', 'skipping experimental module', spec.id,
                             '(mainSettings.experimental is off)');
                return false;
            }
        }

        var entry = {
            id:           spec.id,
            priority:     spec.priority,
            isReady:      spec.isReady,
            plan:         spec.plan,
            boot:         isFunction(spec.boot) ? spec.boot : null,
            experimental: spec.experimental === true
        };
        modules.push(entry);
        byId[spec.id] = entry;
        S.kernel.log('registry', 'registered', spec.id, 'at', spec.priority);
        return true;
    }

    function list() { return modules.slice(); }

    function byTier(priority) {
        var out = [];
        for (var i = 0; i < modules.length; i++) {
            if (modules[i].priority === priority) out.push(modules[i]);
        }
        return out;
    }

    function get(id) { return byId[id] || null; }

    function count() { return modules.length; }

    S.kernel.register = register;
    S.kernel.registry = {
        list:    list,
        byTier:  byTier,
        get:     get,
        count:   count
    };

}(Steward));
