/*
 * Economy module.
 *
 * Keeps the storehouse supplied from the star menu. The player selects
 * resource items in the Economy manager grid (settings.items); every
 * selected item is moved from the star menu into the storehouse on its own,
 * one star entry per send, until the storehouse takes no more of it.
 *
 * Each plan pass queues at most PER_PASS transfers, ACTION_GAP_MS apart,
 * one per selected item, in name order. An item is skipped while:
 *
 *   - its required event is not live (S.core.events.resourceLive is not
 *     true), so an event item outside its event is never sent;
 *   - its send ledger key is blocked: one key per item means one transfer
 *     per item in flight, so two sends never count on the same room, while
 *     different items keep their own room;
 *   - S.core.buffs.storeNext names a reason: nothing in the star menu, the
 *     warehouse cap reached ('warehouse full'), a stack that came back to
 *     the star menu earlier (item full, see core/buffs.js), or a read that
 *     failed. A failed read is said once per item and reason at debug level
 *     and is waited on, never taken as "nothing to do".
 *
 * The transfer itself is S.core.buffs.toStore through the send ledger
 * (S.core.ledger.attempt): its entry is on disk before the host call, so a
 * transfer the server answers late never goes out twice, across ticks,
 * script reloads and client restarts. Each pass first settles the entries
 * left over from earlier sends (settle). A stack the storehouse turns down
 * comes back to the star menu; core reads that as a refusal, frees the key
 * and marks the item full with no breaker miss. A transfer that is never
 * seen counts a miss on this module's ledger breaker, and five in a row
 * pause the transfers until a probe lands or the user resets the breaker.
 *
 * Guards: a queued transfer re-checks the module switch, the selection and
 * the event liveness when it runs, because any of them may have changed
 * since the pass queued it. Off (enabled false) cancels this module's
 * queued transfers at once (applySettings); a send already in flight runs
 * to its end under the ledger.
 *
 * The dashboard section and the ~Steward~ submenu are registered here in
 * full and delegate to ui.js and menu.js at call time, because those files
 * load after this one; until they exist the delegates return safe empties.
 *
 * Bundle slot: modules, economy/ in name order (menu, model, module,
 * settings, ui, views, window). Every cross-file reference happens at call
 * time.
 */

(function (S) {

    if (!S.modules.economy) S.modules.economy = {};

    var R = S.kernel.read;

    var OWNER = 'economy';

    // Most transfers queued by one plan pass, so one pass never floods the
    // kernel queue; the rest follow on later passes.
    var PER_PASS = 3;
    // Gap between the transfers one pass queues, so the server answers one
    // send before the next goes out.
    var ACTION_GAP_MS = 1500;
    // An unseen transfer is judged failed only after this long, well above
    // the time the server needs to land or return a stack.
    var RESOLVE_AFTER_MS = 60000;
    // How many recent transfers the dashboard can list.
    var MOVED_MAX = 20;

    var moved    = [];      // [{ name, amount, at }], newest last
    var lastPass = null;    // { at, queued, names } of the last pass that ran
    var said     = {};      // 'name|reason' -> true, debug lines already written

    function clock() {
        return S.core.ledger.clock();
    }

    function readSettings() {
        var stored = S.kernel.settings.read(OWNER) || {};
        var defaults = S.modules.economy.defaultSettings || {};
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        // The selection is read as booleans, so only a stored true selects.
        var items = {};
        var src = stored.items && typeof stored.items === 'object' ? stored.items : {};
        for (key in src) {
            if (Object.prototype.hasOwnProperty.call(src, key)) items[key] = src[key] === true;
        }
        merged.items = items;
        merged.enabled = merged.enabled === true;
        return merged;
    }

    // The selected names, sorted, so passes run in a stable order.
    function selectedNames(s) {
        var out = [];
        for (var n in s.items) {
            if (Object.prototype.hasOwnProperty.call(s.items, n) && s.items[n] === true) out.push(n);
        }
        out.sort();
        return out;
    }

    function key(name) {
        return S.core.ledger.key('store', 'home', name);
    }

    function defFor(name) {
        return S.core.buffs.toStore(name, { category: OWNER });
    }

    function debugOnce(name, reason) {
        var k = name + '|' + reason;
        if (said[k]) return;
        said[k] = true;
        S.kernel.debug(OWNER, name + ' skipped: ' + reason);
    }

    // A name that reads again may say its next refusal once more.
    function forgetSaid(name) {
        var p = name + '|';
        for (var k in said) {
            if (Object.prototype.hasOwnProperty.call(said, k) && k.indexOf(p) === 0) delete said[k];
        }
    }

    function isReady(ctx) {
        var s = readSettings();
        return !!(s.enabled && ctx && ctx.zone && ctx.zone.isHome);
    }

    // Settles ledger entries from earlier sends: a stack that now shows in
    // the store or stayed out of the star menu clears its entry, and one
    // still in the star menu after the settle time frees its key.
    function settle() {
        var items = S.core.ledger.snapshot(OWNER);
        for (var i = 0; i < items.length; i++) {
            if (typeof items[i].name !== 'string' || !items[i].name) continue;
            S.core.ledger.reread(items[i].key, defFor(items[i].name));
        }
    }

    function plan() {
        var s = readSettings();
        if (!s.enabled) return;
        if (!S.core.ledger.usable()) {
            S.kernel.debug(OWNER, 'send ledger unusable, no transfers');
            return;
        }

        settle();

        var names = selectedNames(s);
        var queued = [];
        for (var i = 0; i < names.length && queued.length < PER_PASS; i++) {
            var n = names[i];
            if (S.core.events.resourceLive(n) !== true) continue;
            if (S.core.ledger.blocked(key(n)) !== null) continue;
            var p = S.core.buffs.storeNext(n);
            if (p.reason) {
                if (R.isReadRefusal(p.reason)) debugOnce(n, p.reason);
                continue;
            }
            forgetSaid(n);
            if (!S.core.ledger.admit(OWNER)) break;
            S.kernel.queue.add('economy.transfer', [n], queued.length * ACTION_GAP_MS);
            queued.push(n);
        }
        lastPass = { at: clock(), queued: queued.length, names: queued };
        if (queued.length) S.kernel.log(OWNER, 'queued transfers of ' + queued.join(', '));
    }

    function remember(name, amount) {
        moved.push({ name: name, amount: amount, at: clock() });
        while (moved.length > MOVED_MAX) moved.shift();
    }

    function transferAction(params) {
        var name = params && params[0];
        var s = readSettings();
        if (!s.enabled) {
            S.kernel.debug(OWNER, 'module is off, transfer of ' + name + ' skipped');
            return;
        }
        if (typeof name !== 'string' || s.items[name] !== true) {
            S.kernel.debug(OWNER, name + ' is no longer selected, transfer skipped');
            return;
        }
        if (S.core.events.resourceLive(name) !== true) {
            S.kernel.debug(OWNER, name + ' is not live, transfer skipped');
            return;
        }
        var def = defFor(name);
        var ok = S.core.ledger.attempt(def, {
            key:            key(name),
            owner:          OWNER,
            name:           name,
            resolveAfterMs: RESOLVE_AFTER_MS
        }, function (r) {
            var A = S.ActionResult;
            if (r.status === A.Verified && r.sends > 0) {
                var amount = def.sent();
                remember(name, amount);
                S.kernel.log(OWNER, 'moved ' + amount + ' ' + name + ' to the storehouse');
            } else if (r.status === A.Failed && r.refuted === true) {
                // Core and the ledger have logged the refusal and the full mark.
                S.kernel.debug(OWNER, name + ' came back: ' + r.reason);
            } else if (r.status === A.Refused) {
                S.kernel.debug(OWNER, 'transfer of ' + name + ' refused: ' + r.reason);
            }
        });
        if (ok !== true) {
            S.kernel.error(OWNER, 'transfer of ' + name + ' not started');
        }
    }

    function boot() {
        if (!S.kernel.settings.read(OWNER)) {
            S.kernel.settings.write(OWNER, S.modules.economy.defaultSettings);
        }
        S.core.ledger.register(OWNER, {
            category: 'economy',
            breaker: {
                label:      'transfer breaker',
                missText:   'star-to-store transfers in a row were not seen',
                pausedText: 'star-to-store transfers are paused',
                resumeText: 'transfers resume'
            }
        });
        S.core.ledger.load();
        S.kernel.queue.action('economy.transfer', transferAction);
    }

    // The one off path, called after a dashboard Save, a submenu flip and a
    // tile click. The module off stops its queued transfers at once; a
    // deselected item needs no cancel, since its queued transfer re-checks
    // the selection when it runs.
    function applySettings() {
        var s = readSettings();
        if (!s.enabled && S.kernel.queue && S.kernel.queue.cancelByModule) {
            S.kernel.queue.cancelByModule(OWNER);
        }
    }

    if (S.kernel.lifecycle && S.kernel.lifecycle.applySettings) {
        S.kernel.lifecycle.applySettings.economy = applySettings;
    }

    // Flips the selection of one item. Writes only that key, so nothing else
    // in the stored settings is touched, and applies at once (no draft).
    function toggle(name) {
        if (typeof name !== 'string' || !name) return false;
        var on = readSettings().items[name] !== true;
        var items = {};
        items[name] = on;
        S.kernel.settings.write(OWNER, { items: items });
        S.kernel.log(OWNER, name + (on ? ' selected' : ' deselected'));
        applySettings();
        return on;
    }

    var E = S.modules.economy;
    E.OWNER        = OWNER;
    E.readSettings = readSettings;
    E.toggle       = toggle;
    E.key          = key;
    E.moved        = function () { return moved.slice(); };
    E.lastPass     = function () { return lastPass; };

    var ui = {
        tab: 'economy',
        section: {
            id:    'economy',
            title: 'Economy',
            icon:  '⚖',
            side: function ($side, h) {
                var U = S.modules.economy.ui;
                if (U && U.side) return U.side($side, h);
            },
            render: function ($main, h) {
                var U = S.modules.economy.ui;
                if (U && U.render) return U.render($main, h);
            },
            summary: function (h) {
                var U = S.modules.economy.ui;
                return U && U.summary ? U.summary(h) : '';
            },
            tiles: function (h) {
                var U = S.modules.economy.ui;
                return U && U.tiles ? U.tiles(h) : [];
            }
        }
    };
    // The dashboard category exists only where the economy dashboard is
    // built; elsewhere the section stays on the general dashboard.
    if (S.Dashboard && S.Dashboard.Economy) ui.dashboard = S.Dashboard.Economy;

    S.kernel.register({
        id:       'economy',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        ui:       ui,
        menu: {
            title: 'Economy',
            items: function () {
                return S.modules.economy.menu ? S.modules.economy.menu.items() : [];
            }
        }
    });

}(Steward));
