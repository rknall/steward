'use strict';

var t = require('../runner');
var harness = require('../harness');

// Settings helper: only the named deposit is enabled. Others stay defined
// (defaults' enabled:true would otherwise leak through the deep-merge in
// modules/geologists/ui.js readSettings).
function onlyEnable(depositName, max) {
    var names = ['Stone', 'BronzeOre', 'Marble', 'IronOre', 'GoldOre',
                 'Coal', 'Granite', 'TitaniumOre', 'Salpeter'];
    var deposits = {};
    for (var i = 0; i < names.length; i++) {
        deposits[names[i]] = (names[i] === depositName)
            ? { enabled: true,  max: max }
            : { enabled: false, max: 0 };
    }
    return { enabled: true, dispatchDelay: 0, deposits: deposits };
}

t.test('plan enqueues one dispatch per wanted slot when an idle geologist exists', function () {
    var H = harness.boot();
    var z = H.zone.zone()
        .deposits('IronOre', [])  // 0 on map, max=1 → wanted=1
        .specialists([
            H.specs.geologist({ name: 'irongut', uid: 'g1' })
        ])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    H.settings.write('geologists', onlyEnable('IronOre', 1));

    var mod = H.module('geologists');
    t.assert.ok(mod, 'geologists module should be registered');
    mod.plan({ zone: { isHome: true } });

    var q = H.queued();
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].name, 'geologists.dispatch');
    t.assert.strictEqual(q[0].params[2], 'IronOre');
});

t.test('plan enqueues nothing when no idle geologists are available', function () {
    var H = harness.boot();
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists([])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    H.settings.write('geologists', onlyEnable('IronOre', 1));

    H.module('geologists').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});

t.test('plan enqueues nothing when wanted slots are already filled (deposits on map)', function () {
    var H = harness.boot();
    var existing = H.zone.deposit({ name: 'IronOre', grid: 5 });
    var z = H.zone.zone()
        .deposits('IronOre', [existing])
        .specialists([H.specs.geologist({ name: 'irongut', uid: 'g1' })])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    H.settings.write('geologists', onlyEnable('IronOre', 1));   // 1 on map, max 1 → wanted 0

    H.module('geologists').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});
