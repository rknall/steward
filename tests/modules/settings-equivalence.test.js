'use strict';

// Every module settings reader now goes through S.kernel.settings.merged. The
// readers they replaced are kept below as source strings, word for word, and
// compiled into the same booted context, so for each stored fixture the old and
// the new reader can be compared on values and key order. The derived defaults
// (deposit rows from the deposit types, delays from the queue gap) are checked
// against the literals they replaced.

var vm = require('vm');
var t = require('../runner');
var harness = require('../harness');

var assert = t.assert;

// Values built in the vm realm have other prototypes than the test's own.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

// ---- The readers as they were -------------------------------------------------

var OLD = {
    collect: [
        'function readSettings() {',
        '    var stored = S.kernel.settings.read(\'collect\') || {};',
        '    var defaults = S.modules.collect.defaultSettings || {};',
        '    var merged = {};',
        '    var key;',
        '    for (key in defaults) merged[key] = defaults[key];',
        '    for (key in stored)   merged[key] = stored[key];',
        '    return merged;',
        '}'
    ],
    explorers: [
        'function readSettings() {',
        '    var stored = S.kernel.settings.read(\'explorers\') || {};',
        '    var defaults = S.modules.explorers.defaultSettings || {};',
        '    var merged = {};',
        '    var key;',
        '    for (key in defaults) merged[key] = defaults[key];',
        '    for (key in stored)   merged[key] = stored[key];',
        '    return merged;',
        '}'
    ],
    geologists: [
        'function readSettings() {',
        '    var stored = S.kernel.settings.read(\'geologists\') || {};',
        '    var defaults = S.modules.geologists.defaultSettings || {};',
        '    var merged = {};',
        '    var key;',
        '    for (key in defaults) merged[key] = defaults[key];',
        '    for (key in stored)   merged[key] = stored[key];',
        '    var depMerged = {};',
        '    var defaultDeps = defaults.deposits || {};',
        '    var storedDeps  = stored.deposits  || {};',
        '    for (key in defaultDeps) depMerged[key] = defaultDeps[key];',
        '    for (key in storedDeps)  depMerged[key] = storedDeps[key];',
        '    merged.deposits = depMerged;',
        '    return merged;',
        '}'
    ],
    mining: [
        'function readSettings() {',
        '    var stored = S.kernel.settings.read(\'mining\') || {};',
        '    var defaults = S.modules.mining.defaultSettings || {};',
        '    var merged = {};',
        '    var key;',
        '    var field;',
        '    for (key in defaults) merged[key] = defaults[key];',
        '    for (key in stored)   merged[key] = stored[key];',
        '    var depMerged = {};',
        '    var defaultDeps = defaults.deposits || {};',
        '    var storedDeps  = stored.deposits  || {};',
        '    for (key in defaultDeps) {',
        '        var row = {};',
        '        var defRow = defaultDeps[key] || {};',
        '        var storedRow = storedDeps[key];',
        '        for (field in defRow) row[field] = defRow[field];',
        '        if (storedRow !== null && typeof storedRow === \'object\') {',
        '            for (field in storedRow) row[field] = storedRow[field];',
        '        }',
        '        depMerged[key] = row;',
        '    }',
        '    for (key in storedDeps) {',
        '        if (!Object.prototype.hasOwnProperty.call(defaultDeps, key)) {',
        '            depMerged[key] = storedDeps[key];',
        '        }',
        '    }',
        '    merged.deposits = depMerged;',
        '    return merged;',
        '}'
    ],
    production: [
        'function has(o, k) { return S.kernel.is.has(o, k); }',
        'function readSettings() {',
        '    var stored = S.kernel.settings.read(\'production\') || {};',
        '    var defaults = S.modules.production.defaultSettings || {};',
        '    var blank = S.modules.production.defaultBuilding || {};',
        '    var merged = {};',
        '    var key, f;',
        '    for (key in defaults) merged[key] = defaults[key];',
        '    for (key in stored)   merged[key] = stored[key];',
        '    var out = {};',
        '    var defaultMap = defaults.buildings || {};',
        '    var storedMap  = stored.buildings  || {};',
        '    var names = [];',
        '    for (key in defaultMap) if (has(defaultMap, key)) names.push(key);',
        '    for (key in storedMap)  if (has(storedMap, key) && !has(defaultMap, key)) names.push(key);',
        '    for (var i = 0; i < names.length; i++) {',
        '        var row = {};',
        '        for (f in blank) row[f] = blank[f];',
        '        var d = defaultMap[names[i]] || {};',
        '        var st = storedMap[names[i]] || {};',
        '        for (f in d)  row[f] = d[f];',
        '        for (f in st) row[f] = st[f];',
        '        out[names[i]] = row;',
        '    }',
        '    merged.buildings = out;',
        '    return merged;',
        '}'
    ],
    adventures: [
        'function readSettings() {',
        '    var defs = S.modules.adventures.defaultSettings || {};',
        '    var stored = S.kernel.settings.read(\'adventures\') || {};',
        '    var out = {};',
        '    for (var k in defs) {',
        '        if (!Object.prototype.hasOwnProperty.call(defs, k)) continue;',
        '        out[k] = Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : defs[k];',
        '    }',
        '    return out;',
        '}'
    ],
    updater: [
        'function readSettings() {',
        '    var defaults = S.modules.updater.defaultSettings;',
        '    var stored = S.kernel.settings.read(\'updater\') || {};',
        '    var out = {};',
        '    for (var key in defaults) {',
        '        if (!defaults.hasOwnProperty(key)) continue;',
        '        out[key] = (stored.hasOwnProperty(key) && typeof stored[key] === typeof defaults[key])',
        '            ? stored[key]',
        '            : defaults[key];',
        '    }',
        '    return out;',
        '}'
    ]
};

// The shown-value readers of the mining and geologists views as they were.
// `readSettings` is the module's current reader, as it was then too.
var OLD_SHOWN = {
    mining: [
        'function shownSettings(h) {',
        '    var base = S.modules.mining.readSettings();',
        '    var buf = h.settings(\'mining\') || {};',
        '    var out = {};',
        '    var key;',
        '    for (key in base) out[key] = base[key];',
        '    for (key in buf)  out[key] = buf[key];',
        '    var deps = {};',
        '    var baseDeps = base.deposits || {};',
        '    var bufDeps = buf.deposits || {};',
        '    var name, f;',
        '    for (name in baseDeps) deps[name] = baseDeps[name];',
        '    for (name in bufDeps) {',
        '        var row = {};',
        '        var under = baseDeps[name] || {};',
        '        for (f in under) row[f] = under[f];',
        '        for (f in bufDeps[name]) row[f] = bufDeps[name][f];',
        '        deps[name] = row;',
        '    }',
        '    out.deposits = deps;',
        '    return out;',
        '}'
    ],
    geologists: [
        'function depositRow(h, depositName) {',
        '    var deps = h.get(\'geologists\', \'deposits\');',
        '    if (deps && typeof deps === \'object\' && deps[depositName] &&',
        '        typeof deps[depositName] === \'object\') {',
        '        return deps[depositName];',
        '    }',
        '    var merged = S.modules.geologists.readSettings().deposits || {};',
        '    if (merged[depositName] && typeof merged[depositName] === \'object\') {',
        '        return merged[depositName];',
        '    }',
        '    return { enabled: false, max: 0 };',
        '}'
    ]
};

// The default deposit maps as literals, before they were derived.
var OLD_MINING_DEPOSITS = {
    Stone:       { enabled: true, buff: '', refill: '' },
    BronzeOre:   { enabled: true, build: true, upgrade: false, targetLevel: 3,
                   pause: false, buff: '', refill: '' },
    Marble:      { enabled: true, buff: '', refill: '' },
    IronOre:     { enabled: true, build: true, upgrade: false, targetLevel: 3,
                   pause: false, buff: '', refill: '' },
    GoldOre:     { enabled: true, build: true, upgrade: false, targetLevel: 3,
                   pause: false, buff: '', refill: '' },
    Coal:        { enabled: true, build: true, upgrade: false, targetLevel: 3,
                   pause: false, buff: '', refill: '' },
    Granite:     { enabled: true, buff: '', refill: '' },
    TitaniumOre: { enabled: true, build: true, upgrade: false, targetLevel: 3,
                   pause: false, buff: '', refill: '' },
    Salpeter:    { enabled: true, build: true, upgrade: false, targetLevel: 3,
                   pause: false, buff: '', refill: '' }
};

var OLD_GEOLOGISTS_DEPOSITS = {
    Stone:       { enabled: true, max:  8 },
    BronzeOre:   { enabled: true, max:  6 },
    Marble:      { enabled: true, max: 10 },
    IronOre:     { enabled: true, max: 19 },
    GoldOre:     { enabled: true, max:  9 },
    Coal:        { enabled: true, max:  6 },
    Granite:     { enabled: true, max:  6 },
    TitaniumOre: { enabled: true, max:  4 },
    Salpeter:    { enabled: true, max:  4 }
};

// Compiles one old function into the booted context, where `Steward` is the
// same instance the new readers use. The last function in the source wins.
function compile(H, lines) {
    var src = lines.join('\n');
    var heads = src.match(/^function \w+/mg);
    var name = heads[heads.length - 1].slice('function '.length);
    return vm.runInContext('(function (S) {\n' + src + '\nreturn ' + name + ';\n}(Steward))', H.ctx);
}

// The current reader of each module, looked up at call time.
var NEW = {
    collect:    function (S) { return S.modules.collect.readSettings(); },
    explorers:  function (S) { return S.modules.explorers.readSettings(); },
    geologists: function (S) { return S.modules.geologists.readSettings(); },
    mining:     function (S) { return S.modules.mining.readSettings(); },
    production: function (S) { return S.modules.production.readSettings(); },
    adventures: function (S) { return S.modules.adventures.templates.settings(); },
    updater:    function (S) { return S.modules.updater.config(); }
};

// A JSON value of another type than `v`.
function wrongType(v) {
    if (typeof v === 'number') return 'x';
    if (typeof v === 'string') return 7;
    if (typeof v === 'boolean') return 'x';
    return 'x';
}

function eachKey(defaults, fn) {
    var out = {};
    for (var k in defaults) out[k] = fn(defaults[k]);
    return out;
}

// The fixtures every module gets: nothing stored, an empty object, only an
// extra key, every default key with a wrong type, every default key null.
function commonFixtures(defaults) {
    return [
        ['nothing stored', undefined],
        ['empty object', {}],
        ['only an extra key', { extra: 1 }],
        ['every key a wrong type', eachKey(defaults, wrongType)],
        ['every key null', eachKey(defaults, function () { return null; })]
    ];
}

// Row fixtures of the deposit maps, shared by mining and geologists.
function depositFixtures() {
    return [
        ['partial default row', { deposits: { Stone: { enabled: false } } }],
        ['stored-only row', { deposits: { Unknown: { x: 1 } } }],
        ['string row', { deposits: { Stone: 'abc' } }],
        ['null row', { deposits: { Marble: null } }],
        ['number row', { deposits: { Coal: 5 } }],
        ['stored-only string row', { deposits: { Unknown: 'abc' } }],
        ['deposits null', { deposits: null }],
        ['every kind of row at once', {
            enabled: true,
            deposits: { Stone: { enabled: false }, Unknown: { x: 1 }, Marble: 'abc', Coal: null, IronOre: 5 }
        }]
    ];
}

function productionFixtures() {
    return [
        ['stored-only partial row', { buildings: { Bakery: { item: 'Bread' } } }],
        ['string row', { buildings: { Bakery: 'ab' } }],
        ['null row', { buildings: { Bakery: null } }],
        ['zero row', { buildings: { Bakery: 0 } }],
        ['buildings null', { buildings: null }],
        ['several rows', { buildings: { Bakery: { item: 'Bread', enabled: true }, Mill: 'ab', Well: null } }]
    ];
}

// Asserts that the old and the new reader agree on `stored`.
function assertSame(H, id, oldFn, label, stored) {
    if (typeof stored === 'undefined') delete H.settings.store[id];
    else H.Steward.kernel.settings.write(id, JSON.parse(JSON.stringify(stored)));
    var was = oldFn();
    var now = NEW[id](H.Steward);
    assert.strictEqual(JSON.stringify(now), JSON.stringify(was), id + ' / ' + label + ': values or key order differ');
    assert.deepStrictEqual(plain(now), plain(was), id + ' / ' + label);
}

function runFixtures(id, extra) {
    var H = harness.boot();
    var oldFn = compile(H, OLD[id]);
    var fixtures = commonFixtures(H.Steward.modules[id].defaultSettings).concat(extra || []);
    for (var i = 0; i < fixtures.length; i++) {
        assertSame(H, id, oldFn, fixtures[i][0], fixtures[i][1]);
    }
    return H;
}

// ---- Old and new readers agree ------------------------------------------------

t.test('collect reads every fixture as before', function () {
    runFixtures('collect');
});

t.test('explorers reads every fixture as before', function () {
    runFixtures('explorers', [['overrides and a delay', { overrides: { Snowy: 'T' }, dispatchDelay: 0 }]]);
});

t.test('geologists reads every fixture and deposit row as before', function () {
    runFixtures('geologists', depositFixtures());
});

t.test('mining reads every fixture and deposit row as before', function () {
    runFixtures('mining', depositFixtures());
});

t.test('production reads every fixture and building row as before', function () {
    runFixtures('production', productionFixtures());
});

t.test('production reads as before when the default map has a row of the stored name', function () {
    var H = harness.boot();
    // The shipped default map is empty; a default row shows the template,
    // default-row and stored-row layering for a name present in both.
    H.Steward.modules.production.defaultSettings.buildings = { Bakery: { item: 'Cake', items: 3 } };
    var oldFn = compile(H, OLD.production);
    var fixtures = productionFixtures().concat([
        ['row matching a default name', { buildings: { Bakery: { enabled: true } } }],
        ['nothing stored', undefined]
    ]);
    for (var i = 0; i < fixtures.length; i++) {
        assertSame(H, 'production', oldFn, fixtures[i][0], fixtures[i][1]);
    }
});

t.test('adventures reads every fixture as before', function () {
    runFixtures('adventures', [['lastDir and limit', { lastDir: 'C:/x', stuckMinutes: 0, retrain: true }]]);
});

t.test('updater reads every fixture as before', function () {
    runFixtures('updater', [['right types win', { checkOnStart: false, keepBackups: 3, extra: 'y' }]]);
});

// ---- Derived defaults ---------------------------------------------------------

t.test('mining and geologists default deposit maps equal the literals they replaced', function () {
    var H = harness.boot();
    var M = H.Steward.modules;
    assert.strictEqual(JSON.stringify(M.mining.defaultSettings.deposits), JSON.stringify(OLD_MINING_DEPOSITS));
    assert.strictEqual(JSON.stringify(M.geologists.defaultSettings.deposits), JSON.stringify(OLD_GEOLOGISTS_DEPOSITS));
});

t.test('every deposit type has a numeric geologists max', function () {
    var H = harness.boot();
    var types = H.Steward.core.deposits.types();
    var deps = H.Steward.modules.geologists.defaultSettings.deposits;
    assert.ok(types.length > 0);
    for (var i = 0; i < types.length; i++) {
        var row = deps[types[i].name];
        assert.ok(row, 'no default row for ' + types[i].name);
        assert.strictEqual(typeof row.max, 'number', types[i].name);
        assert.ok(isFinite(row.max), types[i].name);
    }
});

t.test('module delay defaults are the kernel queue gap', function () {
    var H = harness.boot();
    var S = H.Steward;
    var gap = S.kernel.TIMEOUTS.QUEUE_ACTION_GAP_MS;
    assert.strictEqual(typeof gap, 'number');
    assert.strictEqual(S.modules.explorers.defaultSettings.dispatchDelay, gap);
    assert.strictEqual(S.modules.geologists.defaultSettings.dispatchDelay, gap);
    assert.strictEqual(S.modules.mining.defaultSettings.actionDelay, gap);
    assert.strictEqual(S.modules.production.defaultSettings.actionDelay, gap);
});

// ---- Shown values over the buffer ---------------------------------------------

// The views' readers are private; each is one h.shown call over the module's
// reader, which is what is compared here.
function shownSetup(id, stored, buffered) {
    var H = harness.boot();
    if (stored) H.Steward.kernel.settings.write(id, JSON.parse(JSON.stringify(stored)));
    var h = H.Steward.kernel.ui.helpers;
    for (var path in buffered) h.set(id, path, JSON.parse(JSON.stringify(buffered[path])));
    return { H: H, h: h };
}

t.test('mining shown settings equal the old view reader for buffered object rows', function () {
    var cases = [
        ['no buffer', null, {}],
        ['partial buffered row', null, { 'deposits.Stone': { enabled: false } }],
        ['partial buffered row over a stored row', { deposits: { Coal: { pause: true } } },
            { 'deposits.Coal': { targetLevel: 5 }, actionDelay: 900 }],
        ['buffered stored-only row', null, { 'deposits.Unknown': { x: 1 } }]
    ];
    for (var i = 0; i < cases.length; i++) {
        var s = shownSetup('mining', cases[i][1], cases[i][2]);
        var was = compile(s.H, OLD_SHOWN.mining)(s.h);
        var now = s.h.shown('mining', s.H.Steward.modules.mining.readSettings(), { deposits: 'fields' });
        assert.strictEqual(JSON.stringify(now), JSON.stringify(was), cases[i][0]);
    }
});

t.test('mining shown settings ignore a buffered string row, which the old reader spread into index fields', function () {
    // No control writes a string row; the old reader for-in'd it into
    // '0', '1', ... fields, the new one keeps the base row.
    var s = shownSetup('mining', null, { 'deposits.Stone': 'ab' });
    var was = compile(s.H, OLD_SHOWN.mining)(s.h);
    var now = s.h.shown('mining', s.H.Steward.modules.mining.readSettings(), { deposits: 'fields' });
    assert.deepStrictEqual(plain(was.deposits.Stone), { enabled: true, buff: '', refill: '', 0: 'a', 1: 'b' });
    assert.deepStrictEqual(plain(now.deposits.Stone), { enabled: true, buff: '', refill: '' });
});

t.test('geologists deposit rows equal the old view reader', function () {
    var cases = [
        ['no buffer', null, {}],
        ['partial buffered row', null, { 'deposits.Stone': { max: 2 } }],
        ['string buffered row', null, { 'deposits.Stone': 'abc' }],
        ['stored string row, no buffer', { deposits: { Marble: 'abc' } }, {}],
        ['stored partial row, buffered null', { deposits: { Coal: { enabled: false } } }, { 'deposits.Coal': null }]
    ];
    for (var i = 0; i < cases.length; i++) {
        var s = shownSetup('geologists', cases[i][1], cases[i][2]);
        var oldRow = compile(s.H, OLD_SHOWN.geologists);
        var names = ['Stone', 'Marble', 'Coal', 'IronOre', 'Unknown'];
        for (var j = 0; j < names.length; j++) {
            var was = oldRow(s.h, names[j]);
            var shown = s.h.shown('geologists', s.H.Steward.modules.geologists.readSettings(), { deposits: 'replace' });
            var row = (shown.deposits || {})[names[j]];
            var now = (row && typeof row === 'object') ? row : { enabled: false, max: 0 };
            assert.strictEqual(JSON.stringify(now), JSON.stringify(was), cases[i][0] + ' / ' + names[j]);
        }
    }
});
