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
    var g = {
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
        getResources: function () { return {}; },
        player:       { GetPlayerLevel: function () { return 60; } }
    };
    // game.zone delegates to the mounted player zone where the fluent
    // builder has wired real lookups (deposits, buildings, resources).
    // Mirrors the AIR host where game.zone is the current zone.
    g.zone = {
        ScrollToGrid: noop,
        GetBuildingFromGridPosition: function (gridId) {
            var z = g.gi.mCurrentPlayerZone;
            if (z && typeof z.GetBuildingFromGridPosition === 'function') {
                return z.GetBuildingFromGridPosition(gridId);
            }
            return null;
        },
        GetResources: function (player) {
            var z = g.gi.mCurrentPlayerZone;
            if (z && typeof z.GetResources === 'function') {
                return z.GetResources(player);
            }
            return { CanPlayerAffordBuilding: function () { return true; } };
        },
        mStreetDataMap: {
            getDeposits_vectorByType: function (typeName) {
                var z = g.gi.mCurrentPlayerZone;
                if (z && z.mStreetDataMap &&
                    typeof z.mStreetDataMap.getDeposits_vectorByType === 'function') {
                    return z.mStreetDataMap.getDeposits_vectorByType(typeName);
                }
                return [];
            },
            GetBuildings_vector: function () {
                var z = g.gi.mCurrentPlayerZone;
                if (z && z.mStreetDataMap &&
                    typeof z.mStreetDataMap.GetBuildings_vector === 'function') {
                    return z.mStreetDataMap.GetBuildings_vector();
                }
                return [];
            },
            getBuildingsByName_vector: function (name) {
                var z = g.gi.mCurrentPlayerZone;
                if (z && z.mStreetDataMap &&
                    typeof z.mStreetDataMap.getBuildingsByName_vector === 'function') {
                    return z.mStreetDataMap.getBuildingsByName_vector(name);
                }
                return [];
            }
        }
    };
    return g;
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

// The one document fake. jq.install and installModal both go through this,
// so whichever runs second adds to the first one's document and neither
// replaces H.ctx.document. `head` is a plain appendChild holder until the
// jq fake upgrades it to an element; `_byId` answers getElementById first
// and the jq fake's tree search (`_search`, set by jq.install) second.
function ensureDocument(H) {
    var existing = H.ctx.document;
    if (existing && existing._stewardFake) return existing;
    var doc = {
        _stewardFake: true,
        _byId: {},
        _search: null,
        head: {
            children: [],
            appendChild: function (c) { this.children.push(c); return c; }
        },
        createTextNode: function (data) {
            return { nodeType: 3, data: String(data), parent: null, children: [] };
        },
        getElementById: function (id) {
            if (Object.prototype.hasOwnProperty.call(doc._byId, id)) return doc._byId[id];
            return doc._search ? doc._search(id) : null;
        }
    };
    H.ctx.document = doc;
    return doc;
}

function jqInstalled(H) {
    return !!(H.ctx.$ && H.ctx.$._jqFake);
}

// Host Modal and document stand-ins. Without the jq fake, Body() has no
// length, so the render functions return early; its visibility is the
// test's switch (`rig.visible`) either way. With the jq fake, Body() and
// Footer() are real elements, one pair per modal, and `rig.made[i].modal`
// is the instance. The style element already lists the dashboard, settings
// and adventures scopes and the
// current rule checksum, so ensureStyle returns at once.
function installModal(H) {
    var rig = { made: [], visible: false };
    function Modal(id, title, closable) {
        this._rig = { id: id, title: title, closable: closable, modal: this };
        rig.made.push(this._rig);
    }
    Modal.prototype.create = noop;
    Modal.prototype.show = noop;
    Modal.prototype.hide = noop;
    Modal.prototype.Body = function () {
        if (jqInstalled(H)) {
            if (!this._body) {
                this._body = H.ctx.$('<div>');
                this._body[0].visible = function () { return rig.visible; };
            }
            return this._body;
        }
        return { length: 0, is: function () { return rig.visible; } };
    };
    Modal.prototype.Footer = function () {
        if (jqInstalled(H)) {
            if (!this._footer) this._footer = H.ctx.$('<div>');
            return this._footer;
        }
        return { length: 0 };
    };
    H.ctx.Modal = Modal;
    var doc = ensureDocument(H);
    doc._byId['steward-dashboard-style'] = {
        getAttribute: function (name) {
            if (name === 'data-scopes') return 'StewardDashboard,StewardSettings,StewardAdventures';
            if (name === 'data-rules') return H.ctx.Steward.kernel.ui.styleChecksum;
            return null;
        },
        setAttribute: noop
    };
    return rig;
}

module.exports = {
    make:               make,
    makeSettingsHost:   makeSettingsHost,
    makeGame:           makeGame,
    installModal:       installModal,
    ensureDocument:     ensureDocument
};
