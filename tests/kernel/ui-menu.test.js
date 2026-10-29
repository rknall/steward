'use strict';

var t = require('../runner');
var harness = require('../harness');

// Native menu stubs with construction counters, so a test can tell an
// in-place label update from a rebuild (which constructs new menus/items).
function installMenuStubs(H) {
    var air = H.ctx.air;
    var counts = { menus: 0, items: 0 };

    function NativeMenu() {
        counts.menus++;
        this.items = [];
    }
    NativeMenu.prototype.addItem = function (item) { this.items.push(item); return item; };
    NativeMenu.prototype.removeItem = function (item) {
        var i = this.items.indexOf(item);
        if (i >= 0) this.items.splice(i, 1);
        return item;
    };
    NativeMenu.prototype.getItemByName = function (name) {
        for (var i = 0; i < this.items.length; i++) {
            if (this.items[i].name === name) return this.items[i];
        }
        return null;
    };

    function NativeMenuItem(label, isSep) {
        counts.items++;
        this.label = label;
        this.isSeparator = !!isSep;
        this.name = '';
        this.enabled = true;
        this.submenu = null;
        this.onSelect = null;
    }
    NativeMenuItem.prototype.addEventListener = function (type, fn) {
        if (type === 'select') this.onSelect = fn;
    };

    air.NativeMenu = NativeMenu;
    air.NativeMenuItem = NativeMenuItem;
    air.Event = { SELECT: 'select' };

    var rootMenu = new NativeMenu();
    H.ctx.window = { nativeWindow: { menu: rootMenu } };
    counts.menus = 0;
    counts.items = 0;
    return { counts: counts, rootMenu: rootMenu };
}

function setup() {
    var H = harness.boot({ sections: ['kernel'] });
    var M = installMenuStubs(H);
    H.Steward.kernel.register({
        id:       'alpha',
        priority: 'PriorityNormal',
        isReady:  function () { return true; },
        plan:     function () {},
        ui: {
            tab: 'misc',
            section: { id: 'alpha', title: 'Alpha', render: function () {} }
        }
    });
    H.settings.write('alpha', { enabled: true });
    H.Steward.kernel.ui.init();
    return { H: H, counts: M.counts, rootMenu: M.rootMenu };
}

function toggleItem(rootMenu) {
    var root = rootMenu.getItemByName('StewardRoot');
    return root ? root.submenu.getItemByName('StewardModuleToggle_alpha') : null;
}

function snapshot(c) { return { menus: c.menus, items: c.items }; }

t.test('init builds the menu once with the module toggle', function () {
    var s = setup();
    var root = s.rootMenu.getItemByName('StewardRoot');
    t.assert.ok(root);
    var item = toggleItem(s.rootMenu);
    t.assert.ok(item);
    t.assert.strictEqual(item.label, '✓ Alpha');
});

t.test('status refresh never rebuilds the menu', function () {
    var s = setup();
    var root = s.rootMenu.getItemByName('StewardRoot');
    var before = snapshot(s.counts);
    for (var i = 0; i < 10; i++) s.H.Steward.kernel.ui.status.refresh();
    t.assert.deepStrictEqual(snapshot(s.counts), before);
    t.assert.strictEqual(s.rootMenu.getItemByName('StewardRoot'), root);
});

t.test('external enabled flip updates the label in place', function () {
    var s = setup();
    var item = toggleItem(s.rootMenu);
    var before = snapshot(s.counts);
    s.H.settings.write('alpha', { enabled: false });
    s.H.Steward.kernel.ui.status.refresh();
    t.assert.strictEqual(toggleItem(s.rootMenu), item);
    t.assert.strictEqual(item.label, '✕ Alpha');
    t.assert.deepStrictEqual(snapshot(s.counts), before);
});

t.test('quick-toggle click updates the label without a rebuild', function () {
    var s = setup();
    var item = toggleItem(s.rootMenu);
    var before = snapshot(s.counts);
    item.onSelect();
    t.assert.strictEqual(s.H.settings.read('alpha').enabled, false);
    t.assert.strictEqual(item.label, '✕ Alpha');
    t.assert.deepStrictEqual(snapshot(s.counts), before);
});

t.test('pause toggle updates its label in place', function () {
    var s = setup();
    var root = s.rootMenu.getItemByName('StewardRoot');
    var before = snapshot(s.counts);
    s.H.Steward.kernel.ui.toggle();
    t.assert.strictEqual(root.submenu.getItemByName('StewardPause').label, 'Steward: ✕ Paused');
    t.assert.deepStrictEqual(snapshot(s.counts), before);
});
