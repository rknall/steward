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

// "Ghost" specialist: classifies as a Geologist (GetType returns geo
// type) and reports Idle (no task, not in use), but lacks GetUniqueID.
// Live host returns these in GetSpecialists_vector under conditions we
// haven't pinned down — likely transient state or unloaded data. We
// must filter them at the idle-pool stage to avoid the dispatch loop
// re-picking the same null-uid spec wanted-many times.
function ghostGeologist() {
    return {
        GetType:    function () { return 2; },                        // GEOLOGIST type
        GetTask:    function () { return null; },
        IsInUse:    function () { return false; },
        getName:    function () { return ''; },
        GetName:    function () { return ''; },
        GetName_string: function () { return ''; },
        GetSkills_vector: function () { return []; },
        skills:     { getItems_vector: function () { return []; } },
        GetSpecialistDescription: function () {
            return { getBaseType: function () { return 2; },
                     isTransportGeneral: function () { return false; } };
        }
        // GetUniqueID intentionally absent.
    };
}

t.test('plan ignores ghost specialists that lack a uniqueID', function () {
    var H = harness.boot();
    var realGeo = H.specs.geologist({ name: 'irongut', uid: 'g1' });
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists([ghostGeologist(), realGeo])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    H.settings.write('geologists', onlyEnable('IronOre', 1));
    H.module('geologists').plan({ zone: { isHome: true } });

    var q = H.queued();
    t.assert.strictEqual(q.length, 1);
    t.assert.strictEqual(q[0].params[0], 'g1');         // dispatch went to the real geo

    var warns = H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === 'geologists';
    });
    var ghostWarns = warns.filter(function (l) {
        return l.args && l.args.length && /no uniqueID|ghost/i.test(String(l.args[0]));
    });
    // No "best candidate has no uniqueID" noise when ghosts are filtered.
    t.assert.strictEqual(ghostWarns.length, 0);
});

t.test('plan with only ghost geologists enqueues nothing and stays quiet', function () {
    var H = harness.boot();
    var z = H.zone.zone()
        .deposits('IronOre', [])
        .specialists([ghostGeologist(), ghostGeologist(), ghostGeologist()])
        .mountOnPlayer((H.host.game.gi.mCurrentPlayer = {}));
    H.host.game.gi.mCurrentPlayerZone = z.zone;

    H.settings.write('geologists', onlyEnable('IronOre', 5));
    H.module('geologists').plan({ zone: { isHome: true } });

    t.assert.strictEqual(H.queued().length, 0);
    var ghostWarns = H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === 'geologists' &&
               l.args && /no uniqueID/.test(String(l.args[0]));
    });
    t.assert.strictEqual(ghostWarns.length, 0);
});
