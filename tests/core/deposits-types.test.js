'use strict';

var t = require('../runner');
var harness = require('../harness');

t.test('S.Deposit enum has nine entries', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    t.assert.strictEqual(Object.keys(H.Steward.Deposit).length, 9);
});

t.test('types() returns subTaskId index 0..8 in canonical order', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var rows = H.Steward.core.deposits.types();
    t.assert.strictEqual(rows.length, 9);
    t.assert.strictEqual(rows[0].name, 'Stone');
    t.assert.strictEqual(rows[0].index, 0);
    t.assert.strictEqual(rows[3].name, 'IronOre');
    t.assert.strictEqual(rows[3].index, 3);
    t.assert.strictEqual(rows[8].name, 'Salpeter');
});

t.test('indexOf returns -1 for unknown deposit name', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    t.assert.strictEqual(H.Steward.core.deposits.indexOf('Mythril'), -1);
    t.assert.strictEqual(H.Steward.core.deposits.indexOf('IronOre'), 3);
});

t.test('depositTypeStringFor prefixes FindDeposit', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    t.assert.strictEqual(
        H.Steward.core.deposits.depositTypeStringFor('IronOre'),
        'FindDepositIronOre');
    t.assert.strictEqual(
        H.Steward.core.deposits.depositTypeStringFor(''),
        '');
});

t.test('types() rows expose mineId / mineName / masonName fields', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var rows = H.Steward.core.deposits.types();

    var iron = rows[3];
    t.assert.strictEqual(iron.name, 'IronOre');
    t.assert.strictEqual(iron.mineId, 50);
    t.assert.strictEqual(iron.mineName, 'IronMine');
    t.assert.strictEqual(iron.masonName, null);

    var stone = rows[0];
    t.assert.strictEqual(stone.name, 'Stone');
    t.assert.strictEqual(stone.mineId, null);
    t.assert.strictEqual(stone.mineName, null);
    t.assert.strictEqual(stone.masonName, 'Mason');
});
