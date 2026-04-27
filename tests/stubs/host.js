/*
 * Host-global stubs.
 *
 * Adobe AIR / TSO host objects that source files reach for: game, loca, air,
 * jQuery $, settings, etc. Defaults are no-ops or null sentinels so an
 * accidental host call from code under test surfaces as a loud failure
 * rather than a silent zero.
 *
 * Tests construct a host bundle via `make()` and override fields as needed.
 * The harness installs these on the vm context's global before loading any
 * source file.
 */

'use strict';

function noop() {}

function makeSettingsHost() {
    var store = {};
    return {
        settings: store,
        // Host's read/write signature: (default, namespace).
        read:  function (defaultValue, ns) {
            return Object.prototype.hasOwnProperty.call(store, ns)
                ? store[ns]
                : (typeof defaultValue !== 'undefined' ? defaultValue : null);
        },
        store: function (val, ns) { store[ns] = val; },
        _all:  function () { return store; }
    };
}

function makeAir() {
    function FileCtor() {
        this.exists = false;
        this.nativePath = '/dev/null';
    }
    FileCtor.applicationDirectory        = { resolvePath: function () { return new FileCtor(); } };
    FileCtor.applicationStorageDirectory = { resolvePath: function () { return new FileCtor(); } };
    FileCtor.documentsDirectory          = { resolvePath: function () { return new FileCtor(); } };

    function FileStream() {
        this.open           = noop;
        this.writeUTFBytes  = noop;
        this.readUTFBytes   = function () { return ''; };
        this.close          = noop;
    }

    return {
        File:       FileCtor,
        FileMode:   { READ: 'read', WRITE: 'write', APPEND: 'append' },
        FileStream: FileStream,
        Introspector: {
            Console: { log: noop, warn: noop, error: noop }
        },
        ui: {
            Menu: function () {
                this.addItem    = noop;
                this.addSubmenu = function () { return new air.ui.Menu(); };
            }
        }
    };
}

function makeGame() {
    return {
        gi: {
            mCurrentPlayer:        null,
            mCurrentPlayerZone:    null,
            mCurrentViewedZoneID:  null,
            mHomePlayer:           null,
            mEventManager:         {
                GetActiveEventNames: function () { return []; },
                GetEventStopDate:    function () { return null; }
            },
            isOnHomzone:      function () { return true; },
            visitZone:        noop,
            SelectBuilding:   noop,
            SendServerAction: noop,
            mClientMessages: {
                SendMessagetoServer: noop
            }
        },
        def:          function () { return null; },
        zone:         {
            ScrollToGrid:                 noop,
            GetBuildingFromGridPosition:  function () { return null; },
            GetResources:                 function () { return { CanPlayerAffordBuilding: function () { return true; } }; },
            mStreetDataMap: {
                getDeposits_vectorByType: function () { return []; },
                GetBuildings_vector:      function () { return []; },
                getBuildingsByName_vector:function () { return []; }
            }
        },
        getResources: function () { return {}; },
        player:       { GetPlayerLevel: function () { return 60; } }
    };
}

function makeJQuery() {
    function $() { return $.fn; }
    $.fn = {
        length: 0,
        on:     function () { return $.fn; },
        off:    function () { return $.fn; },
        find:   function () { return $.fn; },
        append: function () { return $.fn; },
        html:   function () { return $.fn; },
        text:   function () { return $.fn; },
        val:    function () { return ''; },
        attr:   function () { return ''; },
        css:    function () { return $.fn; },
        is:     function () { return false; },
        each:   function () { return $.fn; },
        remove: function () { return $.fn; }
    };
    return $;
}

function make(opts) {
    opts = opts || {};
    return {
        loca: opts.loca || {
            GetText:        function (cat, key) { return key; },
            FormatDuration: function (ms)        { return String(ms); }
        },
        air:           opts.air      || makeAir(),
        settings:      opts.settings || makeSettingsHost(),
        $:             opts.$        || makeJQuery(),
        globalFlash:   opts.globalFlash || {
            gui: {
                UpdateGuiOnZoneLoad: noop,
                mMailWindow:         { Show: noop, Hide: noop },
                mQuestBook:          { Show: noop, Hide: noop, SetPreselectedQuest: noop }
            }
        },
        getImageTag:   opts.getImageTag   || function () { return ''; },
        showGameAlert: opts.showGameAlert || noop,
        debug:         opts.debug         || noop,
        mainSettings:  (typeof opts.mainSettings !== 'undefined') ? opts.mainSettings : {},
        game:          opts.game || makeGame(),
        swmmo:         opts.swmmo || null
    };
}

module.exports = {
    make:               make,
    makeSettingsHost:   makeSettingsHost,
    makeGame:           makeGame
};
