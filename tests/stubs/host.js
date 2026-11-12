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
    var host = {
        settings: store,
        // Counts persist calls, as the host's save() flushes the buffer.
        saves: 0,
        save:  function () { host.saves++; },
        // Host's read/write signature: (default, namespace).
        read:  function (defaultValue, ns) {
            return Object.prototype.hasOwnProperty.call(store, ns)
                ? store[ns]
                : (typeof defaultValue !== 'undefined' ? defaultValue : null);
        },
        store: function (val, ns) { store[ns] = val; },
        _all:  function () { return store; }
    };
    return host;
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

// Host Modal and document stand-ins, in two modes.
//
// Default: without the jq fake, Body() has no length, so the render
// functions return early; its visibility is the test's switch (`rig.visible`)
// either way. With the jq fake, Body() and Footer() are real elements, one
// pair per modal, and `rig.made[i].modal` is the instance. create, show and
// hide do nothing. In this mode `rig.visible` is also what
// `S.kernel.ui.isModalShown` reads, through a bare element carrying a
// `bs.modal` state.
//
// `{ host: true }` (needs jq.install(H) first) models the host Modal
// (0-common.js:567-611) and Bootstrap 3.4.1 `Modal.prototype.hide` closely
// enough to reproduce the stage swap wedge:
//   - every show and hide event swaps the game and HTML stage layers, so
//     `rig.swaps` counts them and an odd count means the HTML layer is on top;
//   - Bootstrap 3 triggers the show and hide events before it tests
//     `isShown`, so a hide of an already hidden modal still swaps;
//   - a hidden modal stays displayed (fading) until `rig.flushFades()`, and
//     the host's `show` hides every other displayed dialog, a fading one
//     included, then shows its own only when it is not displayed;
//   - `create()` does nothing while an element for the id exists, and a
//     closable modal removes its element on `hidden.bs.modal`.
// The style element already lists the dashboard, settings and adventures
// scopes and the current rule checksum, so ensureStyle returns at once.
function installModal(H, opts) {
    opts = opts || {};
    var host = opts.host === true;
    if (host && !jqInstalled(H)) {
        throw new Error('installModal({ host: true }) needs jq.install(H) first');
    }
    var rig = { made: [], visible: false };
    var order = [];

    function Modal(id, title, closable) {
        this._rig = { id: id, title: title, closable: closable, modal: this };
        this.id = '#' + id;
        this.rawId = id;
        this.removeHiding = closable !== false;
        rig.made.push(this._rig);
        if (!host && jqInstalled(H)) {
            var $ = H.ctx.$;
            // No role and no modal class, so the queue's dialog walk and
            // settleFading never see this element.
            if (!$(this.id).length) {
                var st = {};
                Object.defineProperty(st, 'isShown', {
                    get: function () { return rig.visible === true; },
                    enumerable: true
                });
                var $el = $('<div>', { id: id });
                $el.data('bs.modal', st);
                $('body').append($el);
            }
        }
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

    if (host) {
        rig.swaps = 0;
        rig.live = {};
        rig.pending = [];

        var bsShow = function (rec) {
            rec.$el.trigger('show.bs.modal');
            if (rec.state.isShown === true) return;
            rec.state.isShown = true;
            rec.displayed = true;
            rec.$el[0].style.display = '';
            rec.$el.addClass('in');
            var at = rig.pending.indexOf(rec);
            if (at >= 0) rig.pending.splice(at, 1);
        };
        var bsHide = function (rec) {
            rec.$el.trigger('hide.bs.modal');
            if (rec.state.isShown !== true) return;
            rec.state.isShown = false;
            rec.$el.removeClass('in');
            if (rig.pending.indexOf(rec) < 0) rig.pending.push(rec);
        };
        var drop = function (rec) {
            rec.$el.remove();
            delete rig.live[rec.rawId];
            var o = order.indexOf(rec);
            if (o >= 0) order.splice(o, 1);
            var p = rig.pending.indexOf(rec);
            if (p >= 0) rig.pending.splice(p, 1);
        };

        Modal.prototype.create = function () {
            if (rig.live[this.rawId]) return;
            var $ = H.ctx.$;
            var $el = $('<div>', { id: this.rawId, role: 'dialog', 'class': 'modal fade' });
            var rec = { rawId: this.rawId, $el: $el, state: { isShown: null }, displayed: false };
            rec.$body = $('<div>');
            rec.$footer = $('<div>');
            $el.append(rec.$body).append(rec.$footer);
            $el.data('bs.modal', rec.state);
            $el[0].visible = function () {
                return rec.displayed && $el[0].style.display !== 'none';
            };
            rec.$body[0].visible = function () { return $el[0].visible(); };
            $('body').append($el);
            $el.on('show.bs.modal hide.bs.modal', function () { rig.swaps++; });
            if (this.removeHiding) {
                $el.on('hidden.bs.modal', function () { drop(rec); });
            }
            rig.live[this.rawId] = rec;
            order.push(rec);
        };
        Modal.prototype.Body = function () {
            var rec = rig.live[this.rawId];
            return rec ? rec.$body : H.ctx.$('#' + this.rawId + '-none');
        };
        Modal.prototype.Footer = function () {
            var rec = rig.live[this.rawId];
            return rec ? rec.$footer : H.ctx.$('#' + this.rawId + '-none');
        };
        Modal.prototype.show = function () {
            var own = rig.live[this.rawId];
            var others = order.slice();
            for (var i = 0; i < others.length; i++) {
                if (others[i] !== own && others[i].$el.is(':visible')) bsHide(others[i]);
            }
            if (own && !own.$el.is(':visible')) bsShow(own);
        };
        Modal.prototype.hide = function () {
            var own = rig.live[this.rawId];
            if (own) bsHide(own);
        };

        rig.flushFades = function () {
            var list = rig.pending.slice();
            rig.pending = [];
            for (var i = 0; i < list.length; i++) {
                list[i].displayed = false;
                list[i].$el.trigger('hidden.bs.modal');
            }
        };
        rig.dismiss = function (rawId) {
            if (rig.live[rawId]) bsHide(rig.live[rawId]);
        };
        rig.isShown = function (rawId) {
            return !!rig.live[rawId] && rig.live[rawId].state.isShown === true;
        };
        rig.shownIds = function () {
            var out = [];
            for (var i = 0; i < order.length; i++) {
                if (order[i].state.isShown === true) out.push(order[i].rawId);
            }
            return out;
        };
        rig.htmlOnTop = function () { return rig.swaps % 2 === 1; };
        rig.balanced = function () {
            return rig.htmlOnTop() === (rig.shownIds().length > 0);
        };
        rig.element = function (rawId) {
            return rig.live[rawId] ? rig.live[rawId].$el : null;
        };
    }

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
