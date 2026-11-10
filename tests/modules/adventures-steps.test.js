'use strict';

// The step registry, its list helpers and sequence check, and the template
// store's handling of mixed lists (battle files and step entries).

var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');
var fs = require('fs');
var path = require('path');

var assert = t.assert;

var CONTRACT = ['kind', 'label', 'addLabel', 'help', 'inventory', 'longWait',
    'parse', 'validate', 'done', 'next', 'input', 'sendsHome', 'text', 'subject'];

function setup() {
    var afs = airfs.make();
    var H = harness.boot({ host: { air: afs.air } });
    var S = H.Steward;
    return { H: H, S: S, steps: S.modules.adventures.steps, tpl: S.modules.adventures.templates };
}

function same(a, b) {
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
}

function fileName(p) {
    return p.substring(p.lastIndexOf('/') + 1);
}

t.test('S.TemplateStep equals the step kinds and every row has the contract', function () {
    var s = setup();
    var kinds = s.steps.kinds();
    var fromEnum = [];
    var k;
    for (k in s.S.TemplateStep) {
        if (Object.prototype.hasOwnProperty.call(s.S.TemplateStep, k)) fromEnum.push(s.S.TemplateStep[k]);
    }
    var fromKinds = kinds.map(function (x) { return x.kind; });
    same(fromEnum.slice().sort(), fromKinds.slice().sort());
    assert.strictEqual(fromKinds.length, 4);
    for (var i = 0; i < fromKinds.length; i++) {
        var def = s.steps.byKind(fromKinds[i]);
        for (var j = 0; j < CONTRACT.length; j++) {
            assert.notStrictEqual(def[CONTRACT[j]], undefined, fromKinds[i] + ' lacks ' + CONTRACT[j]);
        }
        assert.strictEqual(typeof def.parse, 'function');
        assert.strictEqual(typeof def.validate, 'function');
        assert.strictEqual(typeof def.done, 'function');
        assert.strictEqual(typeof def.next, 'function');
    }
});

t.test('normItem parses each kind, drops duplicates, rejects unknown kinds', function () {
    var s = setup();
    same(s.steps.normItem({ step: 'unload', generals: ['1.1', '1.2', '1.1', '', 5] }),
        { step: 'unload', generals: ['1.1', '1.2'] });
    same(s.steps.normItem({ step: 'home', generals: ['2.1', '2.1'] }), { step: 'home', generals: ['2.1'] });
    same(s.steps.normItem({ step: 'pause', message: '  look  ' }), { step: 'pause', message: 'look' });
    same(s.steps.normItem({ step: 'pause' }), { step: 'pause', message: '' });
    same(s.steps.normItem({ step: 'wait', minutes: 5 }), { step: 'wait', minutes: 5 });
    assert.strictEqual(s.steps.normItem({ step: 'nope' }), null);
    assert.strictEqual(s.steps.normItem('C:/a.txt'), null);
    assert.strictEqual(s.steps.normItem(null), null);
    assert.strictEqual(s.steps.isItem({ step: 'wait' }), true);
    assert.strictEqual(s.steps.isItem({ step: 'nope' }), false);
});

t.test('itemProblems: no generals and bad minutes', function () {
    var s = setup();
    assert.strictEqual(s.steps.itemProblems({ step: 'unload', generals: [] }).length, 1);
    assert.strictEqual(s.steps.itemProblems({ step: 'home', generals: [] }).length, 1);
    assert.strictEqual(s.steps.itemProblems({ step: 'unload', generals: ['1.1'] }).length, 0);
    var minutes = [0, 121, 2.5, null];
    for (var i = 0; i < minutes.length; i++) {
        assert.strictEqual(s.steps.itemProblems({ step: 'wait', minutes: minutes[i] }).length, 1,
            'minutes ' + minutes[i]);
    }
    assert.strictEqual(s.steps.itemProblems({ step: 'wait', minutes: 1 }).length, 0);
    assert.strictEqual(s.steps.itemProblems({ step: 'wait', minutes: 120 }).length, 0);
    assert.strictEqual(s.steps.itemProblems({ step: 'pause', message: '' }).length, 0);
    same(s.steps.itemProblems({ step: 'nope' }), ['unknown step']);
});

t.test('list helpers on a mixed list', function () {
    var s = setup();
    var st = s.steps;
    var item = { step: 'pause', message: '' };
    var home = { step: 'home', generals: ['1.1'] };
    var wait = { step: 'wait', minutes: 5 };
    var list = [item, 'w1', home, 'w2', wait];
    assert.strictEqual(st.waveCount(list), 2);
    assert.strictEqual(st.waveNumber(list, 0), 0);
    assert.strictEqual(st.waveNumber(list, 1), 1);
    assert.strictEqual(st.waveNumber(list, 2), 1);
    assert.strictEqual(st.waveNumber(list, 3), 2);
    assert.strictEqual(st.indexOfWave(list, 1), 1);
    assert.strictEqual(st.indexOfWave(list, 2), 3);
    assert.strictEqual(st.indexOfWave(list, 3), -1);
    assert.strictEqual(st.startIndex([item, 'w1', item, 'w2'], 1), 0);
    assert.strictEqual(st.startIndex([item, 'w1', item, 'w2'], 2), 3);
    assert.strictEqual(st.rowLabel(list, 0), 'Pause before wave 1');
    assert.strictEqual(st.rowLabel(list, 1), 'wave 1');
    assert.strictEqual(st.rowLabel(list, 2), 'Send home after wave 1');
    assert.strictEqual(st.rowLabel(list, 4), 'Pause 5 min after wave 2');
    assert.strictEqual(st.nextText(list, 0), 'wave 1');
    assert.strictEqual(st.nextText(list, 1), 'Send home');
    assert.strictEqual(st.nextText(list, 3), 'Pause 5 min');
    assert.strictEqual(st.nextText(list, 4), 'the end of the map');
});

t.test('list helpers on a list of strings read as before', function () {
    var s = setup();
    var st = s.steps;
    var list = ['a', 'b', 'c'];
    assert.strictEqual(st.waveCount(list), 3);
    for (var i = 0; i < 3; i++) {
        assert.strictEqual(st.waveNumber(list, i), i + 1);
        assert.strictEqual(st.indexOfWave(list, i + 1), i);
        assert.strictEqual(st.rowLabel(list, i), 'wave ' + (i + 1));
        assert.strictEqual(st.startIndex(list, i + 1), i);
    }
    assert.strictEqual(st.nextText(list, 0), 'wave 2');
    assert.strictEqual(st.nextText(list, 2), 'the end of the map');
});

function check(list, loadout) {
    var s = setup();
    var keys = {};
    for (var i = 0; i < loadout.length; i++) keys[loadout[i]] = true;
    var waveKeys = {
        'C:/b/w1.txt': { '1.1': true },
        'C:/b/w2.txt': { '1.2': true }
    };
    return s.steps.checkSequence(list, {
        loadoutKeys: keys,
        names: { '1.1': 'Anna', '1.2': 'Bert' },
        waveKeys: function (i) { return waveKeys[list[i]] || null; },
        fileName: fileName
    });
}

t.test('checkSequence: a general missing from the loadout', function () {
    var out = check(['C:/b/w1.txt', { step: 'unload', generals: ['1.1', '9.9'] }], ['1.1']);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].index, 1);
    assert.strictEqual(out[0].key, '9.9');
    assert.strictEqual(out[0].fatal, true);
    assert.ok(/not in the loadout/.test(out[0].message));
});

t.test('checkSequence: unload after send home names the row', function () {
    var out = check(['C:/b/w1.txt', { step: 'home', generals: ['1.1'] }, { step: 'unload', generals: ['1.1'] }],
        ['1.1']);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].index, 2);
    assert.strictEqual(out[0].key, '1.1');
    assert.strictEqual(out[0].fatal, true);
    assert.ok(/Anna was sent home at row 2/.test(out[0].message), out[0].message);
});

t.test('checkSequence: a later wave naming a sent-home general', function () {
    var out = check(['C:/b/w1.txt', { step: 'home', generals: ['1.2'] }, 'C:/b/w2.txt'], ['1.1', '1.2']);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].index, 1);
    assert.strictEqual(out[0].key, '1.2');
    assert.strictEqual(out[0].fatal, true);
    assert.ok(/w2\.txt/.test(out[0].message) && /Bert/.test(out[0].message), out[0].message);
    // The first wave does not use him after the step, so a step after it is clean.
    assert.strictEqual(check(['C:/b/w2.txt', { step: 'home', generals: ['1.2'] }, 'C:/b/w1.txt'],
        ['1.1', '1.2']).length, 0);
});

t.test('checkSequence: unknown object and item problems carry fatal and a null key', function () {
    var out = check([{ step: 'nope' }, { step: 'unload', generals: [] }, { step: 'wait', minutes: 500 }],
        ['1.1']);
    assert.strictEqual(out.length, 3);
    for (var i = 0; i < out.length; i++) {
        assert.strictEqual(out[i].fatal, true);
        assert.strictEqual(out[i].key, null);
        assert.strictEqual(out[i].index, i);
    }
    assert.strictEqual(out[0].message, 'unknown step');
});

t.test('checkSequence: a clean list has no entries', function () {
    var out = check(['C:/b/w1.txt', { step: 'unload', generals: ['1.1'] }, { step: 'pause', message: 'x' },
        { step: 'wait', minutes: 3 }, 'C:/b/w2.txt'], ['1.1', '1.2']);
    assert.strictEqual(out.length, 0);
});

t.test('templates: normalize keeps items and drops unknown kinds', function () {
    var s = setup();
    var rec = s.tpl.normalize({ waves: ['a.txt', { step: 'nope' }, { step: 'wait', minutes: 4 }, 7, null] });
    same(rec.waves, ['a.txt', { step: 'wait', minutes: 4 }]);
    assert.strictEqual(rec.starAll, true);
});

t.test('templates: toFile and fromFile round trip items and starAll false', function () {
    var s = setup();
    var rec = s.tpl.normalize({
        label: 'L', adventure: 'adv', loadout: 'C:/b/l.txt', starAll: false,
        waves: ['C:/b/w1.txt', { step: 'unload', generals: ['1.1'] }, { step: 'pause', message: 'hi' },
            'C:/b/w2.txt', { step: 'wait', minutes: 2 }, { step: 'home', generals: ['1.1', '1.2'] }]
    });
    var back = s.tpl.fromFile('t1', 'p', s.tpl.toFile(rec));
    same(back.waves, rec.waves);
    assert.strictEqual(back.starAll, false);
    assert.strictEqual(back.id, 't1');
});

t.test('templates: a file without starAll reads true, unknown kinds are dropped', function () {
    var s = setup();
    var text = JSON.stringify({ version: 1, label: 'L', adventure: 'a', loadout: 'l',
        waves: ['w.txt', { step: 'bogus' }, { step: 'wait', minutes: 1 }] });
    var rec = s.tpl.fromFile('t2', 'p', text);
    assert.strictEqual(rec.starAll, true);
    same(rec.waves, ['w.txt', { step: 'wait', minutes: 1 }]);
});

t.test('templates: validate files steps under their own field', function () {
    var s = setup();
    var base = { label: 'L', adventure: 'a', loadout: 'l', speedBuff: s.S.SpeedBuffChoice.Default };
    function rec(waves) {
        var r = s.tpl.normalize(base);
        r.waves = waves;
        return r;
    }
    var onlyItems = s.tpl.validate(rec([{ step: 'wait', minutes: 3 }]));
    assert.ok(onlyItems.some(function (p) { return p.field === 'waves' && p.message === 'No wave files'; }));
    var bad = s.tpl.validate(rec(['w.txt', { step: 'unload', generals: [] }]));
    var steps = bad.filter(function (p) { return p.field === 'steps'; });
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].index, 1);
    assert.ok(/^Row 2 \(Unload\)/.test(steps[0].message), steps[0].message);
    assert.strictEqual(s.tpl.validate(rec(['w.txt', { step: 'wait', minutes: 3 }])).length, 0);
});

t.test('the built contract of the per-general kinds carries the whole row', function () {
    var s = setup();
    var whats = { unload: 'unload', home: 'send home' };
    for (var k in whats) {
        var row = s.steps.byKind(k);
        var def = s.steps.defOf({ step: k, generals: ['g1'] });
        for (var key in row) {
            if (!Object.prototype.hasOwnProperty.call(row, key) || key === 'build') continue;
            assert.notStrictEqual(def[key], undefined, k + ' built contract lacks ' + key);
        }
        assert.strictEqual(def.fail.what, whats[k]);
    }
});

t.test('sentBefore: the earliest send-home row per general, unload adds nothing', function () {
    var s = setup();
    var list = ['w1', { step: 'home', generals: ['g1'] }, { step: 'unload', generals: ['g2'] },
        { step: 'home', generals: ['g1', 'g2'] }, 'w2'];
    same(s.steps.sentBefore(list, 5), { g1: 1, g2: 3 });
    same(s.steps.sentBefore(list, 1), {});
    same(s.steps.sentBefore(list, 2), { g1: 1 });
    same(s.steps.sentBefore(list, 3), { g1: 1 });
});

t.test('titleOf, subject and itemText come from the rows', function () {
    var s = setup();
    var st = s.steps;
    assert.strictEqual(st.titleOf({ step: 'wait', minutes: 5 }), 'Pause 5 min');
    assert.strictEqual(st.titleOf({ step: 'wait', minutes: null }), 'Pause x min');
    assert.strictEqual(st.titleOf({ step: 'unload', generals: ['g1'] }), 'Unload');
    assert.strictEqual(st.titleOf({ step: 'home', generals: ['g1'] }), 'Send home');
    var home = { step: 'home', generals: ['g1'] };
    assert.strictEqual(st.subject(home, { g1: 'Alpha' }), 'Alpha');
    assert.strictEqual(st.subject(home, {}), 'g1');
    assert.strictEqual(st.subject({ step: 'pause', message: 'Heal up' }, {}), 'Heal up');
    assert.strictEqual(st.subject({ step: 'wait', minutes: 5 }, {}), '');
    same(st.itemText({ step: 'unload', generals: ['g1'] }, { g1: 'Alpha' }),
        { name: 'Unload Alpha', small: 'Troops back to the pool; he stays on his grid' });
    same(st.itemText(home, { g1: 'Alpha' }),
        { name: 'Send home Alpha', small: 'Travels home now; later rows cannot use him' });
    same(st.itemText({ step: 'pause', message: 'Heal up' }, {}),
        { name: 'Pause \u00b7 plays the pause sound', small: '"Heal up" \u00b7 Resume run goes on' });
    same(st.itemText({ step: 'pause', message: '' }, {}),
        { name: 'Pause \u00b7 plays the pause sound', small: 'Resume run goes on' });
    same(st.itemText({ step: 'wait', minutes: 5 }, {}),
        { name: 'Pause 5 min', small: 'Waits, then goes on by itself' });
});

t.test('templates: validate names the row by its title', function () {
    var s = setup();
    var base = { label: 'L', adventure: 'a', loadout: 'l', speedBuff: s.S.SpeedBuffChoice.Default };
    var r = s.tpl.normalize(base);
    r.waves = ['w1.txt', { step: 'wait', minutes: 121 }];
    var steps = s.tpl.validate(r).filter(function (p) { return p.field === 'steps'; });
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].message,
        'Row 2 (Pause 121 min): minutes must be a whole number from 1 to 120');
});

t.test('no per-kind code outside the step rows', function () {
    var s = setup();
    var dir = path.join(__dirname, '../../src/modules/adventures/');
    function code(name) {
        return fs.readFileSync(dir + name, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[\s;{}()])\/\/.*$/gm, '$1');
    }
    var steps = code('steps.js');
    assert.ok(!/case\s+'/.test(steps), 'steps.js switches on a kind');
    assert.ok(!/\.step\s*[!=]==\s*'/.test(steps), 'steps.js compares a kind');
    var values = [];
    for (var k in s.S.TemplateStep) {
        if (Object.prototype.hasOwnProperty.call(s.S.TemplateStep, k)) values.push(s.S.TemplateStep[k]);
    }
    assert.strictEqual(values.length, 4);
    ['dialog.js', 'templates.js', 'runmenu.js'].forEach(function (f) {
        var text = code(f);
        assert.ok(!/TemplateStep/.test(text), f + ' names TemplateStep');
        values.forEach(function (v) {
            assert.ok(!new RegExp('[\'"]' + v + '[\'"]').test(text), f + ' holds the kind ' + v);
        });
    });
});
