'use strict';

var t = require('../runner');
var harness = require('../harness');

// uniqueIdKey lives on S.core.specialists. We exercise it directly with
// hand-built minimal "specialist" stubs so we cover the two extraction
// paths independently:
//   1. Method-based — uid exposes toKeyString().
//   2. Field-based  — uid exposes only uniqueID1 / uniqueID2.
// Live host builds vary by locale; some specialist subtypes return uid
// VOs without toKeyString. Without the field-based fallback the planner
// queues null uids and re-find at action time fails (see investigation
// notes around 2026-04-29).

function bootCore() {
    return harness.boot({ sections: ['kernel', 'core'] });
}

function specWithUid(uidShape) {
    return {
        GetUniqueID: function () { return uidShape; }
    };
}

t.test('uniqueIdKey() uses toKeyString() when present', function () {
    var H = bootCore();
    var spec = specWithUid({
        toKeyString: function () { return '12345.7'; },
        uniqueID1: 12345,
        uniqueID2: 7
    });
    t.assert.strictEqual(H.Steward.core.specialists.uniqueIdKey(spec), '12345.7');
});

t.test('uniqueIdKey() falls back to uniqueID1.uniqueID2 when toKeyString is absent', function () {
    var H = bootCore();
    var spec = specWithUid({
        uniqueID1: 135415,
        uniqueID2: 0
    });
    // Same format toKeyString produces — exclude maps populated by either
    // path stay comparable.
    t.assert.strictEqual(H.Steward.core.specialists.uniqueIdKey(spec), '135415.0');
});

t.test('uniqueIdKey() falls back to fields when toKeyString throws', function () {
    var H = bootCore();
    var spec = specWithUid({
        toKeyString: function () { throw new Error('no'); },
        uniqueID1: 99,
        uniqueID2: 1
    });
    t.assert.strictEqual(H.Steward.core.specialists.uniqueIdKey(spec), '99.1');
});

t.test('uniqueIdKey() falls back to fields when toKeyString returns empty', function () {
    var H = bootCore();
    var spec = specWithUid({
        toKeyString: function () { return ''; },
        uniqueID1: 42,
        uniqueID2: 3
    });
    t.assert.strictEqual(H.Steward.core.specialists.uniqueIdKey(spec), '42.3');
});

t.test('uniqueIdKey() honours uniqueID2=0 — does not treat 0 as missing', function () {
    var H = bootCore();
    var spec = specWithUid({ uniqueID1: 7, uniqueID2: 0 });
    t.assert.strictEqual(H.Steward.core.specialists.uniqueIdKey(spec), '7.0');
});

t.test('uniqueIdKey() returns null when GetUniqueID returns null', function () {
    var H = bootCore();
    var spec = specWithUid(null);
    t.assert.strictEqual(H.Steward.core.specialists.uniqueIdKey(spec), null);
});

t.test('uniqueIdKey() returns null when uid has no toKeyString and no fields', function () {
    var H = bootCore();
    var spec = specWithUid({ /* empty VO */ });
    t.assert.strictEqual(H.Steward.core.specialists.uniqueIdKey(spec), null);
});

t.test('uniqueIdKey() returns null when GetUniqueID is missing', function () {
    var H = bootCore();
    t.assert.strictEqual(H.Steward.core.specialists.uniqueIdKey({}), null);
    t.assert.strictEqual(H.Steward.core.specialists.uniqueIdKey(null), null);
});
