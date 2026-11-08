'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');
var t = require('../runner');
var scenarios = require('../../scripts/scenarios');

// Temp repo root with an optional scenarios/ folder holding the given files.
function tempRepo(files) {
    var root = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-scen-'));
    if (files) {
        fs.mkdirSync(path.join(root, 'scenarios'));
        Object.keys(files).forEach(function (name) {
            fs.writeFileSync(path.join(root, 'scenarios', name), files[name], 'utf8');
        });
    }
    return root;
}

t.test('collect returns files sorted by name with LF text', function () {
    var root = tempRepo({
        'b_two.json': '{"version":1,\r\n"label":"B"}',
        'a_one.json': '{"version":1}',
        'notes.txt': 'ignored'
    });
    var list = scenarios.collect(root);
    t.assert.deepStrictEqual(list.map(function (e) { return e.id; }), ['a_one', 'b_two']);
    t.assert.strictEqual(list[1].text, '{"version":1,\n"label":"B"}');
});

t.test('collect returns an empty list without a scenarios folder', function () {
    t.assert.deepStrictEqual(scenarios.collect(tempRepo(null)), []);
});

t.test('collect throws with the file name on invalid JSON', function () {
    var root = tempRepo({ 'good.json': '{}', 'bad.json': '{"a":' });
    t.assert.throws(function () { scenarios.collect(root); }, /scenarios\/bad\.json: /);
});

t.test('chunk evaluates to the id to text table', function () {
    var list = [
        { id: 'one', text: '{"a":"x\\"y"}\n' },
        { id: 'two', text: '{}\n' }
    ];
    var S = { modules: {} };
    vm.runInNewContext(scenarios.chunk(list), { Steward: S });
    var table = S.modules.adventures.builtinScenarios;
    t.assert.deepStrictEqual(Object.keys(table), ['one', 'two']);
    t.assert.strictEqual(table.one, '{"a":"x\\"y"}\n');
    t.assert.strictEqual(table.two, '{}\n');
});

t.test('chunk keeps an existing adventures object', function () {
    var S = { modules: { adventures: { keep: 1 } } };
    vm.runInNewContext(scenarios.chunk([{ id: 'x', text: '{}' }]), { Steward: S });
    t.assert.strictEqual(S.modules.adventures.keep, 1);
    t.assert.strictEqual(S.modules.adventures.builtinScenarios.x, '{}');
});
