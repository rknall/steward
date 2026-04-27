'use strict';

var t = require('../runner');
var harness = require('../harness');

t.test('plan enqueues only collectibles whose name matches a pattern', function () {
    var H = harness.boot();

    var match    = H.zone.building({ name: 'BuildingStripedEggs', grid: 1 });
    match._collect = true;
    var nonMatch = H.zone.building({ name: 'BuildingCharcoal',    grid: 2 });
    nonMatch._collect = true;

    var z = H.zone.zone()
        .building(match)
        .building(nonMatch)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    // Patch isCollectible: in production the host's CollectionsManager flags
    // collectibles. In tests we shortcut by tagging buildings with _collect.
    H.Steward.core.buildings.isCollectible = function (b) { return !!(b && b._collect); };

    H.settings.write('collect', {
        enabled:      true,
        namePatterns: ['StripedEggs']
    });

    H.module('collect').plan({ zone: { isHome: true } });

    var q = H.queued();
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].name, 'collect');
    t.assert.strictEqual(q[0].params[0], 1);
});

t.test('plan enqueues nothing when no patterns match', function () {
    var H = harness.boot();
    var b = H.zone.building({ name: 'BuildingCharcoal', grid: 7 });
    b._collect = true;
    var z = H.zone.zone()
        .building(b)
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    H.Steward.core.buildings.isCollectible = function (b) { return !!(b && b._collect); };

    H.settings.write('collect', {
        enabled:      true,
        namePatterns: ['NonexistentResource']
    });

    H.module('collect').plan({ zone: { isHome: true } });
    t.assert.strictEqual(H.queued().length, 0);
});
