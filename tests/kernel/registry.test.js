'use strict';

var t = require('../runner');
var harness = require('../harness');

function validSpec(id) {
    return {
        id:       id,
        priority: 'PriorityNormal',
        isReady:  function () { return true; },
        plan:     function () {}
    };
}

t.test('register accepts a valid spec', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var ok = H.Steward.kernel.register(validSpec('alpha'));
    t.assert.strictEqual(ok, true);
    t.assert.strictEqual(H.Steward.kernel.registry.count(), 1);
    t.assert.strictEqual(H.Steward.kernel.registry.get('alpha').id, 'alpha');
});

t.test('register rejects duplicate ids', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.register(validSpec('dup'));
    var second = H.Steward.kernel.register(validSpec('dup'));
    t.assert.strictEqual(second, false);
    t.assert.strictEqual(H.Steward.kernel.registry.count(), 1);
});

t.test('register rejects an invalid priority', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var spec = validSpec('bad');
    spec.priority = 'PriorityBogus';
    t.assert.strictEqual(H.Steward.kernel.register(spec), false);
    t.assert.strictEqual(H.Steward.kernel.registry.count(), 0);
});

t.test('register rejects spec missing isReady or plan', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var noReady = validSpec('noReady'); noReady.isReady = null;
    var noPlan  = validSpec('noPlan');  noPlan.plan    = null;
    t.assert.strictEqual(H.Steward.kernel.register(noReady), false);
    t.assert.strictEqual(H.Steward.kernel.register(noPlan),  false);
});

function menuSpec(id, items) {
    var s = validSpec(id);
    s.menu = { title: 'Events', items: items };
    return s;
}

t.test('a valid menu spec appears in withMenu()', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var fn = function () {};
    H.Steward.kernel.register(validSpec('plain'));
    H.Steward.kernel.register(menuSpec('withmenu', [{ label: 'Open', onSelect: fn }]));
    var list = H.Steward.kernel.registry.withMenu();
    t.assert.strictEqual(list.length, 1);
    t.assert.strictEqual(list[0].id, 'withmenu');
    t.assert.strictEqual(list[0].menu.title, 'Events');
    t.assert.strictEqual(list[0].menu.items.length, 1);
    t.assert.strictEqual(list[0].menu.items[0].label, 'Open');
    t.assert.strictEqual(list[0].menu.items[0].onSelect, fn);
});

t.test('a menu item without onSelect is dropped', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.register(menuSpec('m', [
        { label: 'Broken' },
        { label: 'Fine', onSelect: function () {} }
    ]));
    var items = H.Steward.kernel.registry.get('m').menu.items;
    t.assert.strictEqual(items.length, 1);
    t.assert.strictEqual(items[0].label, 'Fine');
});

t.test('a menu with no valid items is null but the module still registers', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var ok = H.Steward.kernel.register(menuSpec('m', [{ label: 'Broken' }, { onSelect: function () {} }]));
    t.assert.strictEqual(ok, true);
    t.assert.strictEqual(H.Steward.kernel.registry.get('m').menu, null);
    t.assert.strictEqual(H.Steward.kernel.registry.withMenu().length, 0);
});

t.test('a menu without a title is dropped', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var s = validSpec('m');
    s.menu = { items: [{ label: 'A', onSelect: function () {} }] };
    t.assert.strictEqual(H.Steward.kernel.register(s), true);
    t.assert.strictEqual(H.Steward.kernel.registry.get('m').menu, null);
});

t.test('ui.tab events is accepted', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var s = validSpec('ev');
    s.ui = { tab: 'events', section: { id: 'ev', title: 'Events', render: function () {} } };
    H.Steward.kernel.register(s);
    t.assert.ok(H.Steward.kernel.registry.get('ev').ui);
    t.assert.strictEqual(H.Steward.kernel.registry.byTab('events').length, 1);
});

t.test('ui.tab production is accepted', function () {
    var H = harness.boot({ sections: ['kernel'] });
    t.assert.strictEqual(H.Steward.kernel.register(uiSpec('pr', 'production')), true);
    t.assert.ok(H.Steward.kernel.registry.get('pr').ui);
    t.assert.strictEqual(H.Steward.kernel.registry.byTab('production').length, 1);
    t.assert.strictEqual(notKnownTabWarnings(H).length, 0);
});

t.test('ui.tab misc is accepted', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var s = validSpec('m');
    s.ui = { tab: 'misc', section: { id: 'm', title: 'Misc', render: function () {} } };
    H.Steward.kernel.register(s);
    t.assert.ok(H.Steward.kernel.registry.get('m').ui);
    t.assert.strictEqual(H.Steward.kernel.registry.byTab('misc').length, 1);
});

function uiSpec(id, tab, section) {
    var s = validSpec(id);
    var sec = { id: id, title: 'T', render: function () {} };
    for (var k in (section || {})) sec[k] = section[k];
    s.ui = { tab: tab, section: sec };
    return s;
}

function notKnownTabWarnings(H) {
    return H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === 'registry' &&
               /not a known tab/.test(l.args.join(' '));
    });
}

['tools', 'quests', 'overview'].forEach(function (tab) {
    t.test('ui.tab ' + tab + ' is rejected with a warning and the module still registers', function () {
        var H = harness.boot({ sections: ['kernel'] });
        t.assert.strictEqual(H.Steward.kernel.register(uiSpec('old', tab)), true);
        t.assert.strictEqual(H.Steward.kernel.registry.get('old').ui, null);
        t.assert.strictEqual(H.Steward.kernel.registry.byTab(tab).length, 0);
        t.assert.strictEqual(notKnownTabWarnings(H).length, 1);
    });
});

t.test('ui.tab mining is accepted', function () {
    var H = harness.boot({ sections: ['kernel'] });
    t.assert.strictEqual(H.Steward.kernel.register(uiSpec('mn', 'mining')), true);
    t.assert.ok(H.Steward.kernel.registry.get('mn').ui);
    t.assert.strictEqual(H.Steward.kernel.registry.byTab('mining').length, 1);
    t.assert.strictEqual(notKnownTabWarnings(H).length, 0);
});

t.test('ui section defaults: heading, icon, runsNow, wide, no side or tiles', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.register(uiSpec('d', 'misc'));
    var sec = H.Steward.kernel.registry.get('d').ui.section;
    t.assert.strictEqual(sec.heading, 'T');
    t.assert.strictEqual(sec.icon, '');
    t.assert.strictEqual(sec.runsNow, false);
    t.assert.strictEqual(sec.wide, false);
    t.assert.strictEqual(sec.side, null);
    t.assert.strictEqual(sec.tiles, null);
    t.assert.strictEqual(sec.summary, null);
});

t.test('ui section keeps heading, runsNow, wide and function side or tiles', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var side = function () {};
    var tiles = function () {};
    H.Steward.kernel.register(uiSpec('k', 'misc', {
        heading: 'Heading', runsNow: true, wide: true, side: side, tiles: tiles
    }));
    var sec = H.Steward.kernel.registry.get('k').ui.section;
    t.assert.strictEqual(sec.heading, 'Heading');
    t.assert.strictEqual(sec.runsNow, true);
    t.assert.strictEqual(sec.wide, true);
    t.assert.strictEqual(sec.side, side);
    t.assert.strictEqual(sec.tiles, tiles);
});

t.test('a non-function side or tiles is dropped and only === true sets the flags', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.register(uiSpec('n', 'misc', {
        side: 'x', tiles: {}, runsNow: 'yes', wide: 1
    }));
    var sec = H.Steward.kernel.registry.get('n').ui.section;
    t.assert.strictEqual(sec.side, null);
    t.assert.strictEqual(sec.tiles, null);
    t.assert.strictEqual(sec.runsNow, false);
    t.assert.strictEqual(sec.wide, false);
});

t.test('a section action is not carried over', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.register(uiSpec('a', 'misc', { action: function () {} }));
    var sec = H.Steward.kernel.registry.get('a').ui.section;
    t.assert.strictEqual(sec.action, undefined);
    t.assert.ok(!Object.prototype.hasOwnProperty.call(sec, 'action'));
});

t.test('diagnostics registers on misc and nothing registers on tools', function () {
    var H = harness.boot();
    var misc = H.Steward.kernel.registry.byTab('misc').map(function (m) { return m.id; });
    t.assert.ok(misc.indexOf('diagnostics') >= 0);
    t.assert.strictEqual(H.Steward.kernel.registry.byTab('tools').length, 0);
});

t.test('items as a function is kept', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var fn = function () { return [{ label: 'A', onSelect: function () {} }]; };
    H.Steward.kernel.register(menuSpec('m', fn));
    t.assert.strictEqual(H.Steward.kernel.registry.get('m').menu.items, fn);
    t.assert.strictEqual(H.Steward.kernel.registry.withMenu().length, 1);
});

t.test('separator and display-only items are accepted', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.register(menuSpec('m', [
        { separator: true },
        { label: 'Status', enabled: false },
        { label: 'Go', onSelect: function () {} }
    ]));
    var items = H.Steward.kernel.registry.get('m').menu.items;
    t.assert.strictEqual(items.length, 3);
    t.assert.strictEqual(items[0].separator, true);
    t.assert.strictEqual(items[1].enabled, false);
    t.assert.strictEqual(items[1].onSelect, null);
    t.assert.strictEqual(items[2].enabled, true);
});

t.test('a label function is accepted', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var lf = function () { return 'dyn'; };
    H.Steward.kernel.register(menuSpec('m', [{ label: lf, onSelect: function () {} }]));
    t.assert.strictEqual(H.Steward.kernel.registry.get('m').menu.items[0].label, lf);
});

t.test('menuItems drops an item without label', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var out = H.Steward.kernel.registry.menuItems('m', [
        { onSelect: function () {} },
        { label: '', onSelect: function () {} },
        { label: 'Ok', onSelect: function () {} }
    ]);
    t.assert.strictEqual(out.length, 1);
    t.assert.strictEqual(out[0].label, 'Ok');
});

function warnCount(H, re) {
    return H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === 'registry' && re.test(l.args.join(' '));
    }).length;
}

t.test('menuItems keeps a submenu with normalised children', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var fn = function () {};
    var lf = function () { return 'dyn'; };
    var out = H.Steward.kernel.registry.menuItems('m', [
        { label: 'Static', items: [
            { label: 'Act', onSelect: fn },
            { separator: true },
            { label: 'Info', enabled: false }
        ] },
        { label: lf, items: [ { label: 'One', onSelect: fn } ] }
    ]);
    t.assert.strictEqual(out.length, 2);
    t.assert.strictEqual(out[0].label, 'Static');
    t.assert.strictEqual(out[0].onSelect, null);
    t.assert.strictEqual(out[0].enabled, true);
    t.assert.strictEqual(out[0].items.length, 3);
    t.assert.strictEqual(out[0].items[0].label, 'Act');
    t.assert.strictEqual(out[0].items[0].onSelect, fn);
    t.assert.strictEqual(out[0].items[1].separator, true);
    t.assert.strictEqual(out[0].items[2].label, 'Info');
    t.assert.strictEqual(out[0].items[2].enabled, false);
    t.assert.strictEqual(out[1].label, lf);
    t.assert.strictEqual(out[1].onSelect, null);
    t.assert.strictEqual(out[1].enabled, true);
    t.assert.strictEqual(out[1].items.length, 1);
});

t.test('menuItems drops an invalid child inside a submenu', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var out = H.Steward.kernel.registry.menuItems('m', [
        { label: 'Before', onSelect: function () {} },
        { label: 'Group', items: [
            { label: 'Broken' },
            { label: 'Fine', onSelect: function () {} }
        ] },
        { label: 'After', onSelect: function () {} }
    ]);
    t.assert.strictEqual(out.length, 3);
    t.assert.strictEqual(out[1].items.length, 1);
    t.assert.strictEqual(out[1].items[0].label, 'Fine');
    t.assert.strictEqual(out[0].label, 'Before');
    t.assert.strictEqual(out[2].label, 'After');
});

t.test('menuItems drops an empty submenu with a warning', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var out = H.Steward.kernel.registry.menuItems('m', [
        { label: 'Empty', items: [] },
        { label: 'AllBad', items: [ { label: 'Broken' } ] },
        { label: 'Ok', onSelect: function () {} }
    ]);
    t.assert.strictEqual(out.length, 1);
    t.assert.strictEqual(out[0].label, 'Ok');
    t.assert.strictEqual(warnCount(H, /submenu has no valid items/), 2);
});

t.test('menuItems drops a submenu with onSelect with a warning', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var out = H.Steward.kernel.registry.menuItems('m', [
        { label: 'Group', onSelect: function () {}, items: [ { label: 'A', onSelect: function () {} } ] },
        { label: 'Ok', onSelect: function () {} }
    ]);
    t.assert.strictEqual(out.length, 1);
    t.assert.strictEqual(out[0].label, 'Ok');
    t.assert.strictEqual(warnCount(H, /submenu must not have onSelect/), 1);
});

t.test('a static menu with a submenu item registers', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var fn = function () {};
    H.Steward.kernel.register(menuSpec('m', [
        { label: 'Group', items: [ { label: 'Open', onSelect: fn } ] }
    ]));
    var list = H.Steward.kernel.registry.withMenu();
    t.assert.strictEqual(list.length, 1);
    var items = list[0].menu.items;
    t.assert.strictEqual(items.length, 1);
    t.assert.strictEqual(items[0].label, 'Group');
    t.assert.strictEqual(items[0].onSelect, null);
    t.assert.strictEqual(items[0].items.length, 1);
    t.assert.strictEqual(items[0].items[0].onSelect, fn);
});

function barSpec(id, items) {
    var s = validSpec(id);
    s.barMenu = { title: '~Run~', items: items };
    return s;
}

t.test('a valid barMenu appears in withBarMenu()', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var fn = function () {};
    H.Steward.kernel.register(validSpec('plain'));
    H.Steward.kernel.register(menuSpec('onlymenu', [{ label: 'Open', onSelect: fn }]));
    H.Steward.kernel.register(barSpec('withbar', [{ label: 'Open', onSelect: fn }]));
    var list = H.Steward.kernel.registry.withBarMenu();
    t.assert.strictEqual(list.length, 1);
    t.assert.strictEqual(list[0].id, 'withbar');
    t.assert.strictEqual(list[0].barMenu.title, '~Run~');
    t.assert.strictEqual(list[0].barMenu.items[0].onSelect, fn);
    t.assert.strictEqual(H.Steward.kernel.registry.withMenu().length, 1);
});

t.test('an invalid barMenu is dropped, the module registers', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var noTitle = validSpec('a');
    noTitle.barMenu = { items: [{ label: 'A', onSelect: function () {} }] };
    var noItems = barSpec('b', [{ label: 'Broken' }]);
    t.assert.strictEqual(H.Steward.kernel.register(noTitle), true);
    t.assert.strictEqual(H.Steward.kernel.register(noItems), true);
    t.assert.strictEqual(H.Steward.kernel.registry.get('a').barMenu, null);
    t.assert.strictEqual(H.Steward.kernel.registry.get('b').barMenu, null);
    t.assert.strictEqual(H.Steward.kernel.registry.withBarMenu().length, 0);
});

t.test('enabled function is kept and needs onSelect', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var live = function () { return true; };
    H.Steward.kernel.register(menuSpec('m', [
        { label: 'Live', enabled: live, onSelect: function () {} },
        { label: 'Live without select', enabled: live },
        { label: 'Static off', enabled: false }
    ]));
    var items = H.Steward.kernel.registry.get('m').menu.items;
    t.assert.strictEqual(items.length, 2);
    t.assert.strictEqual(items[0].enabled, live);
    t.assert.strictEqual(items[1].enabled, false);
});

t.test('visible is kept for static and function barMenu items', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var vis = function () { return true; };
    var a = barSpec('a', [{ label: 'A', onSelect: function () {} }]);
    a.barMenu.visible = vis;
    var b = validSpec('b');
    b.barMenu = { title: '~B~', items: function () { return []; }, visible: vis };
    H.Steward.kernel.register(a);
    H.Steward.kernel.register(b);
    t.assert.strictEqual(H.Steward.kernel.registry.get('a').barMenu.visible, vis);
    t.assert.strictEqual(H.Steward.kernel.registry.get('b').barMenu.visible, vis);
});

t.test('an absent visible is null', function () {
    var H = harness.boot({ sections: ['kernel'] });
    H.Steward.kernel.register(barSpec('a', [{ label: 'A', onSelect: function () {} }]));
    var b = validSpec('b');
    b.barMenu = { title: '~B~', items: function () { return []; } };
    H.Steward.kernel.register(b);
    t.assert.strictEqual(H.Steward.kernel.registry.get('a').barMenu.visible, null);
    t.assert.strictEqual(H.Steward.kernel.registry.get('b').barMenu.visible, null);
});

t.test('a non-function visible is dropped with a warning', function () {
    var H = harness.boot({ sections: ['kernel'] });
    var a = barSpec('a', [{ label: 'A', onSelect: function () {} }]);
    a.barMenu.visible = true;
    H.clearLogs();
    t.assert.strictEqual(H.Steward.kernel.register(a), true);
    var m = H.Steward.kernel.registry.get('a').barMenu;
    t.assert.ok(m);
    t.assert.strictEqual(m.visible, null);
    var warns = H.logs().filter(function (l) {
        return l.level === 'warn' && l.category === 'registry';
    });
    t.assert.strictEqual(warns.length, 1);
});
