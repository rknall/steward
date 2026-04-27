/*
 * Module registry.
 *
 * Modules call Steward.kernel.register({...}) at IIFE time. The kernel walks
 * the registry on every scheduler tick.
 *
 * Validation: id must be unique and non-empty, priority must be one of the
 * declared tiers, isReady and plan must be functions. Bad specs are rejected
 * with an ERROR log; the offending module is simply not scheduled.
 *
 * UI spec (optional): a module can declare where it appears in the dashboard
 * via a `ui` field:
 *
 *   ui: {
 *     tab: 'specialists',                    // one of TABS below
 *     section: {
 *       id:    'explorers',                  // unique; settings buffer key
 *       title: 'Explorers',                  // shown on the parchment band
 *       icon:  '⌖',                          // single character / emoji
 *       action: { label: 'Show overrides', onClick: function () {} },  // optional
 *       summary: function () { return '…'; },// shown on the Status tab
 *       render:  function ($body, h) { … }   // populates section-rows
 *     }
 *   }
 *
 * The Status tab is reserved (rendered by the kernel's UI shell, not by a
 * module). Mail/Trades is deliberately omitted until that subsystem ships.
 */

(function (S) {

    var TABS = {
        specialists: true,
        quests:      true,
        buildings:   true,
        tools:       true,
        misc:        true
    };

    var modules = [];                         // [{ id, priority, isReady, plan, boot, ui? }]
    var byId = {};

    function isFunction(x) { return typeof x === 'function'; }

    // Validate and normalise the optional ui spec. Returns null on any
    // problem (with a warning logged) so the module still registers and
    // runs — only its dashboard surface is dropped.
    function validateUi(moduleId, raw) {
        if (!raw || typeof raw !== 'object') return null;
        if (!TABS[raw.tab]) {
            S.kernel.warn('registry', moduleId, 'ui.tab is not a known tab:', raw.tab);
            return null;
        }
        var sec = raw.section;
        if (!sec || typeof sec !== 'object' || !sec.id || !sec.title || !isFunction(sec.render)) {
            S.kernel.warn('registry', moduleId, 'ui.section requires id, title, render');
            return null;
        }
        var action = null;
        if (sec.action && typeof sec.action === 'object' && sec.action.label && isFunction(sec.action.onClick)) {
            action = { label: String(sec.action.label), onClick: sec.action.onClick };
        }
        return {
            tab: raw.tab,
            section: {
                id:      String(sec.id),
                title:   String(sec.title),
                icon:    sec.icon ? String(sec.icon) : '',
                action:  action,
                summary: isFunction(sec.summary) ? sec.summary : null,
                render:  sec.render
            }
        };
    }

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
            experimental: spec.experimental === true,
            ui:           validateUi(spec.id, spec.ui)
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

    // Modules registered against `tab`, ordered by registration time (which
    // matches build-order). The dashboard renders sections in this order.
    function byTab(tab) {
        var out = [];
        for (var i = 0; i < modules.length; i++) {
            if (modules[i].ui && modules[i].ui.tab === tab) out.push(modules[i]);
        }
        return out;
    }

    function withUi() {
        var out = [];
        for (var i = 0; i < modules.length; i++) {
            if (modules[i].ui) out.push(modules[i]);
        }
        return out;
    }

    S.kernel.register = register;
    S.kernel.registry = {
        list:    list,
        byTier:  byTier,
        byTab:   byTab,
        withUi:  withUi,
        get:     get,
        count:   count,
        TABS:    TABS
    };

}(Steward));
