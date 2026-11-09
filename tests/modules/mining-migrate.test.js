'use strict';

// One-time clear of buff values stored before the buff UI existed.
// Seam: the stale object goes straight into the captured settings store,
// then the mining module's boot() is called again, as a script reload or
// client restart would run it against the stored settings.

var t = require('../runner');
var harness = require('../harness');
var A = require('../stubs/army');
var Z = require('../stubs/zone');

var assert = t.assert;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

var TYPES = ['Stone', 'BronzeOre', 'Marble', 'IronOre', 'GoldOre',
             'Coal', 'Granite', 'TitaniumOre', 'Salpeter'];
var MASONS = { Stone: true, Marble: true, Granite: true };

function bdef(targets) {
    return {
        GetBuffType:                 function () { return 0; },
        GetTargetDescription_string: function () { return targets; },
        GetTargetGroup_string:       function () { return ''; }
    };
}

// What the user's store held before this version: placeholder buff names
// and non-default values everywhere else, so a lost field shows up.
function stale() {
    var deposits = {};
    for (var i = 0; i < TYPES.length; i++) {
        var name = TYPES[i];
        var buff = name === 'Granite' ? 'ProductivityBuffHalloween1' : 'ProductivityBuffLvl23';
        deposits[name] = MASONS[name]
            ? { enabled: false, buff: buff, refill: 'R' + i }
            : { enabled: i % 2 === 0, build: false, upgrade: true, targetLevel: 5,
                pause: true, buff: buff, refill: 'R' + i };
    }
    return { enabled: true, actionDelay: 900, pauseThreshold: 7, deposits: deposits };
}

function bootWith(stored) {
    var H = harness.boot();
    if (stored) H.settings.store.mining = stored;
    H.clearLogs();
    H.module('mining').boot();
    return H;
}

function logsMatching(H, level, text) {
    return H.logs().filter(function (l) {
        return l.level === level && l.category === 'mining' &&
               l.args.join(' ').indexOf(text) >= 0;
    });
}

// A home island with one producing IronMine on grid 3 and MineBuff in stock.
function island(H) {
    A.install(H, {
        buffs:    [{ type: 'MineBuff', amount: 5, uid: 'u1' }],
        buffDefs: { MineBuff: bdef('Workyard') }
    });
    var z = H.zone.zone().buildQueue(0, 4);
    z.building(Z.building({ name: 'IronMine', grid: 3, productionState: 0 }));
    H.installZone(z);
}

function ironBuffSettings(marker) {
    var deposits = {};
    for (var i = 0; i < TYPES.length; i++) {
        deposits[TYPES[i]] = { enabled: false, build: false, upgrade: false, targetLevel: 3,
                               pause: false, buff: '', refill: '' };
    }
    deposits.IronOre.enabled = true;
    deposits.IronOre.buff = 'MineBuff';
    var s = { enabled: true, actionDelay: 0, pauseThreshold: 50, deposits: deposits };
    if (marker) s.buffVersion = 1;
    return s;
}

function buffQueued(H) {
    H.clearQueued();
    H.module('mining').plan({ zone: { isHome: true } });
    return H.queued().filter(function (q) { return q.name === 'mining.buffBuilding'; });
}

t.test('boot clears stored buff names without a marker and keeps every other field', function () {
    var before = stale();
    var H = bootWith(plain(before));
    var after = H.settings.read('mining');

    assert.strictEqual(after.buffVersion, 1);
    var expect = plain(before);
    for (var k in expect.deposits) {
        assert.strictEqual(after.deposits[k].buff, '', k);
        expect.deposits[k].buff = '';
    }
    expect.buffVersion = 1;
    assert.deepStrictEqual(plain(after), expect);

    var reset = logsMatching(H, 'log', 'buff settings reset once');
    assert.strictEqual(reset.length, 1);
    var line = reset[0].args.join(' ');
    assert.ok(line.indexOf('Granite=ProductivityBuffHalloween1') >= 0, line);
    assert.ok(line.indexOf('IronOre=ProductivityBuffLvl23') >= 0, line);
    assert.ok(line.indexOf('pick buffs in the Mining tab') >= 0, line);
});

t.test('the clear runs once: a buff picked after it survives the next boot', function () {
    var H = bootWith(stale());
    var picked = plain(H.settings.read('mining'));
    picked.deposits.Granite.buff = 'X';
    H.settings.write('mining', picked);

    H.clearLogs();
    H.module('mining').boot();
    assert.strictEqual(H.settings.read('mining').deposits.Granite.buff, 'X');
    assert.strictEqual(logsMatching(H, 'log', 'buff settings reset').length, 0);
    assert.strictEqual(logsMatching(H, 'log', 'marked current').length, 0);
});

t.test('a fresh install writes the marker and logs no reset', function () {
    var H = bootWith(null);
    var s = H.settings.read('mining');
    assert.strictEqual(s.buffVersion, 1);
    assert.strictEqual(s.buffVersion, H.Steward.modules.mining.defaultSettings.buffVersion);
    assert.strictEqual(logsMatching(H, 'log', 'buff settings').length, 0);
    assert.strictEqual(logsMatching(H, 'warn', 'buff settings').length, 0);
});

t.test('stored settings with the marker are not touched', function () {
    var s = stale();
    s.buffVersion = 1;
    var H = bootWith(s);
    var writes = 0;
    var write = H.Steward.kernel.settings.write;
    H.Steward.kernel.settings.write = function () { writes++; return write.apply(null, arguments); };
    H.module('mining').boot();
    assert.strictEqual(writes, 0);
    assert.strictEqual(H.settings.read('mining'), s);
    assert.strictEqual(H.settings.read('mining').deposits.Granite.buff,
                       'ProductivityBuffHalloween1');
    assert.strictEqual(logsMatching(H, 'log', 'buff settings').length, 0);
});

t.test('a stored object with no buff values is only marked', function () {
    // ironBuffSettings sets IronOre.buff; clear it to model an untouched store.
    var s = ironBuffSettings(false);
    s.deposits.IronOre.buff = '';
    var H = bootWith(s);
    assert.strictEqual(H.settings.read('mining').buffVersion, 1);
    assert.strictEqual(logsMatching(H, 'log', 'marked current, nothing to clear').length, 1);
    assert.strictEqual(logsMatching(H, 'log', 'reset once').length, 0);
});

t.test('a failed marker write leaves buffing off', function () {
    var H = harness.boot();
    island(H);
    H.settings.store.mining = ironBuffSettings(false);
    var write = H.Steward.kernel.settings.write;
    H.Steward.kernel.settings.write = function (id) {
        if (id === 'mining') return false;
        return write.apply(null, arguments);
    };
    H.clearLogs();
    H.module('mining').boot();

    assert.strictEqual(logsMatching(H, 'warn', 'could not be written').length, 1);
    assert.strictEqual(H.settings.read('mining').buffVersion, undefined);
    assert.strictEqual(H.settings.read('mining').deposits.IronOre.buff, 'MineBuff');
    assert.strictEqual(buffQueued(H).length, 0);

    // The next boot retries; once the write lands buffing may start.
    H.Steward.kernel.settings.write = write;
    H.module('mining').boot();
    assert.strictEqual(H.settings.read('mining').deposits.IronOre.buff, '');
    assert.strictEqual(buffQueued(H).length, 0);
});

t.test('without the marker the buff phase queues nothing even when a buff is set', function () {
    var H = harness.boot();
    island(H);
    H.settings.write('mining', ironBuffSettings(false));
    assert.strictEqual(buffQueued(H).length, 0);

    // Control: the same island and settings with the marker do buff.
    H.settings.write('mining', ironBuffSettings(true));
    assert.strictEqual(buffQueued(H).length, 1);
});
