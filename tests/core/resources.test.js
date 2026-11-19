'use strict';

var t = require('../runner');
var harness = require('../harness');

function withResources(H, methods) {
    H.host.game.getResources = function () { return methods; };
}

function warnsFor(H, category) {
    return H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === category;
    });
}

t.test('amount and freePopulation read the host', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var seen = [];
    withResources(H, {
        GetResourceAmount: function (name) { seen.push(name); return 42; },
        // The host method takes no parameter and the bridge throws on any.
        GetFree:           function () { if (arguments.length) throw new Error('#1063'); return 7; }
    });

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount('StripedEggs'), 42);
    t.assert.strictEqual(R.freePopulation(), 7);
    t.assert.deepStrictEqual(seen, ['StripedEggs']);
});

t.test('GetFree is called with no argument', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, {
        GetFree: function () { if (arguments.length) throw new Error('#1063'); return 7; }
    });

    t.assert.strictEqual(H.Steward.core.resources.freePopulation(), 7);
    t.assert.strictEqual(warnsFor(H, 'resources').length, 0);
});

t.test('zero is a real reading, not a failure', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, {
        GetResourceAmount: function () { return 0; },
        GetFree:           function () { return 0; }
    });

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount('Gold'), 0);
    t.assert.strictEqual(R.freePopulation(), 0);
});

t.test('missing host returns null and is silent', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    H.host.game.getResources = undefined;

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount('Gold'), null);
    t.assert.strictEqual(R.freePopulation(), null);
    t.assert.strictEqual(warnsFor(H, 'resources').length, 0);
});

t.test('missing method returns null', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, { GetFree: function () { return 3; } });

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount('Gold'), null);
    t.assert.strictEqual(R.freePopulation(), 3);
});

t.test('a non-number result returns null', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, {
        GetResourceAmount: function () { return undefined; },
        GetFree:           function () { return NaN; }
    });

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount('Gold'), null);
    t.assert.strictEqual(R.freePopulation(), null);
});

t.test('amount refuses a missing resource name without reading the host', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var calls = 0;
    withResources(H, { GetResourceAmount: function () { calls++; return 1; } });

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount(''), null);
    t.assert.strictEqual(R.amount(undefined), null);
    t.assert.strictEqual(calls, 0);
});

t.test('a throwing getter returns null and warns once', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, {
        GetResourceAmount: function () { throw new Error('boom'); },
        GetFree:           function () { throw new Error('boom'); }
    });

    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.amount('Gold'), null);
    t.assert.strictEqual(R.amount('Gold'), null);
    t.assert.strictEqual(R.freePopulation(), null);
    t.assert.strictEqual(warnsFor(H, 'resources').length, 1);
});

t.test('a reload resets the throw warning', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, { GetResourceAmount: function () { throw new Error('boom'); } });
    H.Steward.core.resources.amount('Gold');
    t.assert.strictEqual(warnsFor(H, 'resources').length, 1);

    var H2 = harness.reload(H);
    H2.host.game.getResources = function () {
        return { GetResourceAmount: function () { throw new Error('boom'); } };
    };
    var before = warnsFor(H2, 'resources').length;
    H2.Steward.core.resources.amount('Gold');
    H2.Steward.core.resources.amount('Gold');
    t.assert.strictEqual(warnsFor(H2, 'resources').length - before, 1);
});

t.test('POPULATION names the host population resource', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    t.assert.strictEqual(H.Steward.core.resources.POPULATION, 'Population');
});

t.test('events.eventResourceAmount reuses the resource reader', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, { GetResourceAmount: function (name) { return name === 'ChristmasResource' ? 5 : null; } });

    var E = H.Steward.core.events;
    t.assert.strictEqual(E.eventResourceAmount('XMAS'), 5);
    t.assert.strictEqual(E.eventResourceAmount('NoSuchEvent'), null);
});

// ---- uncategorized: the mayor's house items ----------------------------------

// list: [name, amount, category]; a category of undefined has no definition.
function withInventory(H, list) {
    var cats = {};
    var vec = [];
    for (var i = 0; i < list.length; i++) {
        vec.push({ name_string: list[i][0], amount: list[i][1] });
        cats[list[i][0]] = list[i][2];
    }
    withResources(H, { GetPlayerResources_vector: function () { return vec; } });
    H.host.game.def = function (name) {
        if (name !== 'ServerState::gEconomics') return null;
        return {
            GetResourcesDefaultDefinition: function (n) {
                return typeof cats[n] === 'string' ? { category_string: cats[n] } : null;
            }
        };
    };
}

t.test('uncategorized lists held resources without a storehouse category', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withInventory(H, [
        ['CollectibleWineBarrel', 7515, ''],
        ['Wood', 448126, 'Intermediates'],
        ['CollectibleGrainSacks', 150, ''],
        ['CollectibleKettle', 0, ''],
        ['Mystery', 4, undefined]
    ]);
    var names = { CollectibleWineBarrel: 'Barrel', CollectibleGrainSacks: 'Grain Sacks' };
    H.host.loca.GetText = function (cat, key) {
        return cat === 'RES' ? names[key] : '';
    };

    var list = H.Steward.core.resources.uncategorized();
    t.assert.deepStrictEqual(JSON.parse(JSON.stringify(list)), [
        { name: 'CollectibleWineBarrel', label: 'Barrel', amount: 7515 },
        { name: 'CollectibleGrainSacks', label: 'Grain Sacks', amount: 150 }
    ]);
});

t.test('uncategorized is null when the host lists cannot be read', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.uncategorized(), null);

    withInventory(H, [['CollectibleWineBarrel', 1, '']]);
    H.host.game.getResources = function () { return {}; };
    t.assert.strictEqual(R.uncategorized(), null);

    withInventory(H, [['CollectibleWineBarrel', 1, '']]);
    H.host.game.def = function () { throw new Error('boom'); };
    t.assert.strictEqual(R.uncategorized(), null);
});

t.test('listRead is partial when an item has no name', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, {
        GetPlayerResources_vector: function () {
            return [{ name_string: 'Wood', amount: 5 }, { amount: 1 }, null];
        }
    });

    var r = H.Steward.core.resources.listRead();
    t.assert.strictEqual(r.state, 'partial');
    t.assert.strictEqual(r.lost, 2);
    t.assert.deepStrictEqual(JSON.parse(JSON.stringify(r.value)), [{ name: 'Wood', amount: 5 }]);
});

t.test('list keeps the readable entries', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, {
        GetPlayerResources_vector: function () {
            return [{ name_string: 'Wood', amount: 5 }, { name_string: '', amount: 1 }, { name_string: 'Gold', amount: 'x' }];
        }
    });

    var R = H.Steward.core.resources;
    t.assert.deepStrictEqual(JSON.parse(JSON.stringify(R.list())), [
        { name: 'Wood', amount: 5 },
        { name: 'Gold', amount: null }
    ]);
    t.assert.strictEqual(R.listRead().state, 'partial');
});

t.test('listRead is ok when every item is readable and unreadable without the host list', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.listRead().state, 'unreadable');
    t.assert.strictEqual(R.list(), null);

    withResources(H, { GetPlayerResources_vector: function () { return []; } });
    t.assert.strictEqual(R.listRead().state, 'ok');
    t.assert.strictEqual(JSON.stringify(R.list()), '[]');
});

// ---- warehouse capacity and storehouse category ------------------------------

t.test('capacity reads the warehouse cap with no argument', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, {
        GetWareHouseCapacity: function () { if (arguments.length) throw new Error('#1063'); return 2500; }
    });
    t.assert.strictEqual(H.Steward.core.resources.capacity(), 2500);
    t.assert.strictEqual(warnsFor(H, 'resources').length, 0);
});

t.test('capacity is null on a missing host, a missing method or a non-number', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var R = H.Steward.core.resources;
    H.host.game.getResources = undefined;
    t.assert.strictEqual(R.capacity(), null);
    withResources(H, {});
    t.assert.strictEqual(R.capacity(), null);
    withResources(H, { GetWareHouseCapacity: function () { return 'x'; } });
    t.assert.strictEqual(R.capacity(), null);
    t.assert.strictEqual(warnsFor(H, 'resources').length, 0);
});

t.test('a throwing capacity read returns null and warns once', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withResources(H, { GetWareHouseCapacity: function () { throw new Error('boom'); } });
    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.capacity(), null);
    t.assert.strictEqual(R.capacity(), null);
    t.assert.strictEqual(warnsFor(H, 'resources').length, 1);
});

t.test('categoryOf gives the storehouse category, empty for none, null when unreadable', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withInventory(H, [['Wood', 1, 'Intermediates'], ['CollectibleWineBarrel', 1, '']]);
    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.categoryOf('Wood'), 'Intermediates');
    t.assert.strictEqual(R.categoryOf('CollectibleWineBarrel'), '');
    t.assert.strictEqual(R.categoryOf('Mystery'), null);
    t.assert.strictEqual(R.categoryOf(''), null);
    H.host.game.def = function () { throw new Error('boom'); };
    t.assert.strictEqual(R.categoryOf('Wood'), null);
});

t.test('categoryOf is empty when the definition has no category string', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    H.host.game.def = function () {
        return { GetResourcesDefaultDefinition: function () { return { category_string: 5 }; } };
    };
    t.assert.strictEqual(H.Steward.core.resources.categoryOf('Wood'), '');
});

function withGroups(H, groups) {
    H.host.game.def = function (name) {
        if (name !== 'ServerState::gEconomics') return null;
        return {
            GetResourcesDefaultDefinition: function (n) {
                if (n === 'Odd') return { group_string: 7 };
                if (n === 'NoGroup') return {};
                return typeof groups[n] === 'string' ? { group_string: groups[n] } : null;
            }
        };
    };
}

t.test('groupOf gives the group, empty when absent, null when unreadable', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withGroups(H, { Wood: 'CL1', Barrel: '' });
    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.groupOf('Wood'), 'CL1');
    t.assert.strictEqual(R.groupOf('Barrel'), '');
    t.assert.strictEqual(R.groupOf('NoGroup'), '');
    t.assert.strictEqual(R.groupOf('Odd'), '');
    t.assert.strictEqual(R.groupOf('Mystery'), null);
    t.assert.strictEqual(R.groupOf(''), null);
});

t.test('tabOfGroup maps through the host global', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.tabOfGroup(''), 'WarehouseTab7');
    t.assert.strictEqual(R.tabOfGroup('CL5'), null);
    H.ctx.ResourceGroupToWarehouseTab = { CL5: 'WarehouseTab8', Event: 'WarehouseTab6' };
    t.assert.strictEqual(R.tabOfGroup('CL5'), 'WarehouseTab8');
    t.assert.strictEqual(R.tabOfGroup(''), 'WarehouseTab7');
    t.assert.strictEqual(R.tabOfGroup('DEF_MODE'), null);
    t.assert.strictEqual(R.tabOfGroup(null), null);
});

t.test('tabOf chains the group and the tab', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    withGroups(H, { Wood: 'CL1', Barrel: '', Def: 'DEF_MODE' });
    H.ctx.ResourceGroupToWarehouseTab = { CL1: 'WarehouseTab1' };
    var R = H.Steward.core.resources;
    t.assert.strictEqual(R.tabOf('Wood'), 'WarehouseTab1');
    t.assert.strictEqual(R.tabOf('Barrel'), 'WarehouseTab7');
    t.assert.strictEqual(R.tabOf('Def'), null);
    t.assert.strictEqual(R.tabOf('Mystery'), null);
});

t.test('tabs lists the seven tabs in order with loca labels', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    H.host.loca.GetText = function (cat, key) { return cat === 'LAB' ? 'L:' + key : ''; };
    var list = JSON.parse(JSON.stringify(H.Steward.core.resources.tabs()));
    t.assert.deepStrictEqual(list.map(function (x) { return x.key; }), [
        'WarehouseTab1', 'WarehouseTab2', 'WarehouseTab3', 'WarehouseTab4',
        'WarehouseTab8', 'WarehouseTab6', 'WarehouseTab7'
    ]);
    t.assert.strictEqual(list[4].label, 'L:WarehouseTab8');
});
