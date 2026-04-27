/*
 * Test harness.
 *
 * boot(opts) returns a fresh Steward instance with stubbed host globals.
 * Source files load via vm.runInContext in build order from tests/load-order.js,
 * so the bundled AIR runtime and the Node test environment see the same code
 * with the same load sequence.
 *
 * Per-test isolation: each boot() call creates a brand-new vm context. State
 * does not leak between tests (no shared Steward, no shared host globals).
 *
 * Usage:
 *   var H = harness.boot();                 // kernel + core + modules
 *   var H = harness.boot({ sections: ['kernel'] });   // partial
 *   H.settings.write('mining', { enabled: true });
 *   H.module('mining').plan({ zone: { isHome: true } });
 *   assert(H.queued().length === 1);
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var vm   = require('vm');

var hostStubs   = require('./stubs/host');
var zoneStubs   = require('./stubs/zone');
var specStubs   = require('./stubs/specialists');
var kernelStubs = require('./stubs/kernel');
var loadOrder   = require('./load-order');

var REPO_ROOT = path.resolve(__dirname, '..');

function readSource(rel) {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function boot(opts) {
    opts = opts || {};
    var sections = opts.sections || ['kernel', 'core', 'modules'];

    var host = hostStubs.make(opts.host || {});

    var ctx = {
        // Node stdlib that source files might touch (defensive).
        setTimeout:   function () { return 0; },
        clearTimeout: function () {},
        setInterval:  function () { return 0; },
        clearInterval: function () {},
        Date:    Date,
        Math:    Math,
        JSON:    JSON,
        Object:  Object,
        Array:   Array,
        String:  String,
        Number:  Number,
        Boolean: Boolean,
        Error:   Error,
        RegExp:  RegExp,
        console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },

        // Steward-namespace placeholder. kernel/00_namespace.js seeds it; its
        // `var Steward = (typeof Steward !== 'undefined' && Steward) || {};`
        // means a pre-set value would be reused, so we leave it undefined.
        Steward: undefined,

        // Host globals.
        loca:           host.loca,
        air:            host.air,
        settings:       host.settings,
        mainSettings:   host.mainSettings,
        $:              host.$,
        globalFlash:    host.globalFlash,
        getImageTag:    host.getImageTag,
        showGameAlert:  host.showGameAlert,
        debug:          host.debug,
        game:           host.game,
        swmmo:          host.swmmo
    };
    vm.createContext(ctx);

    var files = loadOrder.collect(sections, REPO_ROOT);
    for (var i = 0; i < files.length; i++) {
        var rel = files[i];
        var body = readSource(rel);
        try {
            vm.runInContext(body, ctx, { filename: rel });
        } catch (e) {
            throw new Error('Failed loading ' + rel + ': ' + (e.stack || e.message));
        }
    }

    var Steward = ctx.Steward;
    if (!Steward) {
        throw new Error('Bootstrap failed — Steward global not set after loading ' + files.length + ' files');
    }

    var caps = kernelStubs.attachCaptures(Steward);

    return {
        Steward:    Steward,
        ctx:        ctx,
        host:       host,
        zone:       zoneStubs,
        specs:      specStubs,
        logs:       caps.logs,
        queued:     caps.queued,
        clearLogs:  caps.clearLogs,
        clearQueued: caps.clearQueued,
        settings:   {
            read:  function (id)      { return Steward.kernel.settings.read(id); },
            write: function (id, val) { return Steward.kernel.settings.write(id, val); },
            store: caps.settingsStore
        },
        installZone: function (zoneFluent) {
            host.game.gi.mCurrentPlayer = host.game.gi.mCurrentPlayer || {};
            host.game.gi.mCurrentPlayerZone = zoneFluent.zone;
            zoneFluent.mountOnPlayer(host.game.gi.mCurrentPlayer);
            return zoneFluent;
        },
        module: function (id) {
            if (!Steward.kernel.registry || typeof Steward.kernel.registry.get !== 'function') {
                return null;
            }
            return Steward.kernel.registry.get(id);
        }
    };
}

function noop() {}

module.exports = { boot: boot };
