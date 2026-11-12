'use strict';

var t = require('../runner');
var harness = require('../harness');

// Kernel only, with the harness's inert timers, so the deferred auto-boot
// never fires and each test calls boot() itself.
function setup() {
    return harness.boot({ sections: ['kernel'] });
}

function lifecycleLines(H, level) {
    var out = [];
    var logs = H.logs();
    for (var i = 0; i < logs.length; i++) {
        if (logs[i].category === 'lifecycle' && logs[i].level === level) {
            out.push({ index: i, text: logs[i].args.join(' ') });
        }
    }
    return out;
}

function bootLines(H) {
    var all = lifecycleLines(H, 'log');
    var out = [];
    for (var i = 0; i < all.length; i++) {
        if (/^boot complete/.test(all[i].text)) out.push(all[i]);
    }
    return out;
}

function atBootWarns(H) {
    var all = lifecycleLines(H, 'warn');
    var out = [];
    for (var i = 0; i < all.length; i++) {
        if (/visible at boot/.test(all[i].text)) out.push(all[i]);
    }
    return out;
}

t.test('boot line carries the build label, modules and no dialogs', function () {
    var H = setup();
    H.Steward.kernel.lifecycle.boot();

    var lines = bootLines(H);
    t.assert.strictEqual(lines.length, 1);
    var text = lines[0].text;
    t.assert.ok(text.indexOf(H.Steward.kernel.buildLabel()) >= 0, text);
    t.assert.ok(text.indexOf('modules:') >= 0, text);
    t.assert.ok(/dialogs visible: none$/.test(text), text);
    t.assert.strictEqual(atBootWarns(H).length, 0);
});

t.test('a dialog visible at boot is named and warned about first', function () {
    var H = setup();
    H.Steward.kernel.queue.visibleDialogs = function () { return ['StewardProduction']; };
    H.Steward.kernel.lifecycle.boot();

    var lines = bootLines(H);
    t.assert.strictEqual(lines.length, 1);
    t.assert.ok(/dialogs visible: #StewardProduction$/.test(lines[0].text), lines[0].text);

    var warns = atBootWarns(H);
    t.assert.strictEqual(warns.length, 1);
    t.assert.strictEqual(warns[0].text,
        '1 dialog(s) visible at boot: #StewardProduction; queued actions wait until they close');
    t.assert.ok(warns[0].index < lines[0].index);
});

t.test('a throwing dialog probe still writes the boot line', function () {
    var H = setup();
    H.Steward.kernel.queue.visibleDialogs = function () { throw new Error('probe'); };
    H.Steward.kernel.lifecycle.boot();

    var lines = bootLines(H);
    t.assert.strictEqual(lines.length, 1);
    t.assert.ok(/dialogs visible: \?$/.test(lines[0].text), lines[0].text);
    t.assert.strictEqual(atBootWarns(H).length, 0);
});
