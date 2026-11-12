'use strict';

var t = require('../runner');
var harness = require('../harness');

var EVENT_OF = {
    HalloweenResource:    'HW2017plus_Shop',
    StripedEggs:          'EasterEvent_Shop_Easter',
    AdventureRelics:      'AdventureSeasonMercenary',
    Wood:                 ''
};

function boot(vector) {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    H.host.game.getResources = function () {
        var o = {};
        if (vector) o.GetPlayerResources_vector = function () { return vector; };
        return o;
    };
    H.host.game.def = function (name) {
        if (name !== 'ServerState::gEconomics') return null;
        return {
            GetResourcesDefaultDefinition: function (r) {
                return Object.prototype.hasOwnProperty.call(EVENT_OF, r)
                    ? { requiredEventName_string: EVENT_OF[r] } : null;
            }
        };
    };
    return H;
}

function warnsFor(H, category) {
    return H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === category;
    });
}

function codes(rows) {
    return rows.map(function (r) { return r.resource + ':' + r.code; }).join(',');
}

t.test('resources.list maps the vector and nulls a non-number amount', function () {
    var H = boot([
        { name_string: 'Wood', amount: 5 },
        { name_string: 'StripedEggs', amount: 'x' },
        { amount: 3 }
    ]);
    // Compared as JSON: the sandbox's arrays have another prototype.
    t.assert.strictEqual(JSON.stringify(H.Steward.core.resources.list()),
        JSON.stringify([{ name: 'Wood', amount: 5 }, { name: 'StripedEggs', amount: null }]));
});

t.test('resources.list is null when the method is missing or throws', function () {
    var H = boot(null);
    t.assert.strictEqual(H.Steward.core.resources.list(), null);

    H.host.game.getResources = function () {
        return { GetPlayerResources_vector: function () { throw new Error('boom'); } };
    };
    t.assert.strictEqual(H.Steward.core.resources.list(), null);
    t.assert.strictEqual(H.Steward.core.resources.list(), null);
    t.assert.ok(warnsFor(H, 'resources').length <= 1);
});

t.test('resources.eventName gives the string, empty or null', function () {
    var H = boot([]);
    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.eventName('HalloweenResource'), 'HW2017plus_Shop');
    t.assert.strictEqual(R.eventName('Wood'), '');
    t.assert.strictEqual(R.eventName('Unknown'), null);
    H.host.game.def = function () { return null; };
    t.assert.strictEqual(R.eventName('Wood'), null);
});

t.test('heldResources host path keeps event resources only', function () {
    var H = boot([
        { name_string: 'AdventureRelics', amount: 9 },
        { name_string: 'Wood', amount: 100 },
        { name_string: 'HalloweenResource', amount: 0 },
        { name_string: 'StripedEggs', amount: 12 }
    ]);
    var r = H.Steward.core.events.heldResources();
    t.assert.strictEqual(r.source, 'host');
    t.assert.strictEqual(codes(r.rows),
        'StripedEggs:Easter,HalloweenResource:HW,AdventureRelics:null');
    var hw = r.rows[1];
    t.assert.strictEqual(hw.amount, 0);
    t.assert.strictEqual(hw.eventName, 'HW2017plus_Shop');
    t.assert.strictEqual(hw.live, false);
});

t.test('heldResources marks the live event', function () {
    var H = boot([{ name_string: 'HalloweenResource', amount: 4 }, { name_string: 'StripedEggs', amount: 1 }]);
    var em = H.host.game.gi.mEventManager;
    em.GetActiveEventNames = function () { return ['HW2017plus_Content', 'HW2017plus_Shop']; };
    var rows = H.Steward.core.events.heldResources().rows;
    var live = {};
    rows.forEach(function (x) { live[x.resource] = x.live; });
    t.assert.strictEqual(live.HalloweenResource, true);
    t.assert.strictEqual(live.StripedEggs, false);
});

t.test('heldResources data path falls back to the data table', function () {
    var H = boot(null);
    H.host.game.getResources = function () {
        return { GetResourceAmount: function (n) { return n === 'StripedEggs' ? 7 : undefined; } };
    };
    var r = H.Steward.core.events.heldResources();
    t.assert.strictEqual(r.source, 'data');
    t.assert.ok(r.rows.length > 0);
    var egg = r.rows.filter(function (x) { return x.resource === 'StripedEggs'; })[0];
    t.assert.strictEqual(egg.amount, 7);
    t.assert.strictEqual(egg.eventName, null);
    var hw = r.rows.filter(function (x) { return x.resource === 'HalloweenResource'; })[0];
    t.assert.strictEqual(hw.amount, null);
});

t.test('heldResources never throws', function () {
    var H = boot([{ name_string: 'HalloweenResource', amount: 1 }]);
    H.host.game.def = function () { throw new Error('boom'); };
    t.assert.doesNotThrow(function () { H.Steward.core.events.heldResources(); });

    H.host.game.getResources = undefined;
    var r = H.Steward.core.events.heldResources();
    t.assert.strictEqual(r.source, 'data');
});
