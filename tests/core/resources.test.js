'use strict';

var t = require('../runner');
var harness = require('../harness');
var zoneStubs = require('../stubs/zone');
var resource = zoneStubs.resource;

// Stage `inv` (object keyed by internal name) on the host before booting
// core. core/resources reads via game.getResources() so we install the
// inventory map and let the stub close over it.
function bootWithInventory(inv) {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    H.host.game._resourceInventory = inv || {};
    return H;
}

t.test('list() returns all resources from GetPlayerResources_vector', function () {
    var H = bootWithInventory({
        Leather:       resource({ name: 'Leather',       amount: 5 }),
        BronzeCauldron: resource({ name: 'BronzeCauldron', amount: 12 })
    });
    var all = H.Steward.core.resources.list();
    t.assert.strictEqual(all.length, 2);
});

t.test('byName(name) returns the matching resource, null otherwise', function () {
    var H = bootWithInventory({
        Banner: resource({ name: 'Banner', amount: 3 })
    });
    var r = H.Steward.core.resources.byName('Banner');
    t.assert.ok(r);
    t.assert.strictEqual(r.name_string, 'Banner');
    t.assert.strictEqual(H.Steward.core.resources.amount(r), 3);
    t.assert.strictEqual(H.Steward.core.resources.byName('Nope'), null);
});

t.test('amount(name) does a per-name host lookup (covers items with amount 0)', function () {
    var H = bootWithInventory({
        Kettle: resource({ name: 'Kettle', amount: 0 })
    });
    t.assert.strictEqual(H.Steward.core.resources.amount('Kettle'), 0);
});

t.test('amount(name) returns 0 when host has no record', function () {
    var H = bootWithInventory({});
    t.assert.strictEqual(H.Steward.core.resources.amount('NeverSeen'), 0);
});

t.test('amount(obj) accepts a raw resource object', function () {
    var H = bootWithInventory({});
    var r = resource({ name: 'Leather', amount: 7 });
    t.assert.strictEqual(H.Steward.core.resources.amount(r), 7);
});

t.test('displayName() returns localized text from loca.GetText("RES", name)', function () {
    var H = harness.boot({
        sections: ['kernel', 'core'],
        host: {
            loca: {
                GetText: function (cat, key) {
                    if (cat === 'RES' && key === 'Leather') return 'Leather Hide';
                    return key;
                }
            }
        }
    });
    H.host.game._resourceInventory = {
        Leather: resource({ name: 'Leather', amount: 5 })
    };
    t.assert.strictEqual(H.Steward.core.resources.displayName('Leather'), 'Leather Hide');
});

t.test('displayName() falls back to internal name when loca returns falsy', function () {
    var H = harness.boot({
        sections: ['kernel', 'core'],
        host: { loca: { GetText: function () { return ''; } } }
    });
    t.assert.strictEqual(H.Steward.core.resources.displayName('Leather'), 'Leather');
});

t.test('invalidate() forces a fresh inventory read', function () {
    var H = bootWithInventory({
        Leather: resource({ name: 'Leather', amount: 5 })
    });
    t.assert.strictEqual(H.Steward.core.resources.list().length, 1);
    // Swap the underlying map. Without invalidate(), the cached snapshot
    // still reports the old length.
    H.host.game._resourceInventory = {};
    t.assert.strictEqual(H.Steward.core.resources.list().length, 1);  // cached
    H.Steward.core.resources.invalidate();
    t.assert.strictEqual(H.Steward.core.resources.list().length, 0);
});
