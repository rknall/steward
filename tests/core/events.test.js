'use strict';

var t = require('../runner');
var harness = require('../harness');

var TREASURE_END = 1794819600000;
var SHOP_END     = 1795381200000;

function stubEvents(H, names, stops) {
    var em = H.host.game.gi.mEventManager;
    em.GetActiveEventNames = function () { return names; };
    em.GetEventStopDate    = function (n) {
        return Object.prototype.hasOwnProperty.call(stops, n) ? stops[n] : null;
    };
}

function bothPhases() {
    var stops = {};
    stops['HW2017plus_Content'] = TREASURE_END;
    stops['HW2017plus_Shop']    = SHOP_END;
    return stops;
}

t.test('active() reports the latest stop date per category and overall', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    stubEvents(H, ['HW2017plus_Content', 'HW2017plus_Shop'], bothPhases());

    var list = H.Steward.core.events.active();
    t.assert.strictEqual(list.length, 1);
    var ev = list[0];
    t.assert.strictEqual(ev.code, 'HW');
    t.assert.strictEqual(ev.endTimes.treasure, TREASURE_END);
    t.assert.strictEqual(ev.endTimes.shop, SHOP_END);
    t.assert.strictEqual(ev.endTimes.other, null);
    t.assert.strictEqual(ev.endTime, SHOP_END);
});

t.test('active() keeps categories unchanged', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    stubEvents(H, ['HW2017plus_Content', 'HW2017plus_Shop'], bothPhases());

    var ev = H.Steward.core.events.active()[0];
    t.assert.strictEqual(ev.categories.treasure, true);
    t.assert.strictEqual(ev.categories.shop, true);
    t.assert.strictEqual(ev.categoryList.length, 2);
    t.assert.strictEqual(ev.category, 'treasure');
});

t.test('active() leaves endTimes null for categories without a stop date', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    stubEvents(H, ['HW2017plus_Shop'], {});

    var ev = H.Steward.core.events.active()[0];
    t.assert.strictEqual(ev.endTimes.treasure, null);
    t.assert.strictEqual(ev.endTimes.shop, null);
    t.assert.strictEqual(ev.endTime, null);
});

t.test('HW depositInfo is data-driven and has no depositsPerRefill', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });
    var info = H.Steward.core.events.data.events.HW.depositInfo;
    t.assert.strictEqual(info.buildings.length, 3);
    t.assert.strictEqual(info.fieldsPerType, 3);
    t.assert.strictEqual(typeof info.depositsPerRefill, 'undefined');
});
