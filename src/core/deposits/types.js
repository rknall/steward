/*
 * Curated deposit-type enum.
 *
 * The value stored in S.Deposit.<Name> is the host's internal deposit name
 * (matches what `mDepositContainer[i].GetName_string()` returns and what
 * `mStreetDataMap.getDeposits_vectorByType(name)` accepts). Same convention
 * as core/buildings/types.js.
 *
 * Ordering matters here. The index in TYPE_ORDER is the `subTaskId` the
 * host expects when dispatching a geologist to search for that deposit
 * (server action 95, taskId=0). The order mirrors autoTSO's
 * `aSettings.defaults.Deposits.data` (user_auto.js:1086-1095) which
 * fixed this convention by being shipped against the live host:
 *
 *   0=Stone, 1=BronzeOre, 2=Marble, 3=IronOre, 4=GoldOre,
 *   5=Coal, 6=Granite, 7=TitaniumOre, 8=Salpeter
 *
 * The matching trait `type_string` for skill scoring is
 * 'FindDeposit' + name (e.g. 'FindDepositIronOre'). Use
 * S.core.deposits.depositTypeStringFor(name) rather than concatenating
 * inline.
 */

(function (S) {

    var TYPE_ORDER = [
        'Stone',
        'BronzeOre',
        'Marble',
        'IronOre',
        'GoldOre',
        'Coal',
        'Granite',
        'TitaniumOre',
        'Salpeter'
    ];

    for (var i = 0; i < TYPE_ORDER.length; i++) {
        S.Deposit[TYPE_ORDER[i]] = TYPE_ORDER[i];
    }

    // Cache the type-table so callers can iterate without rebuilding.
    var TABLE = [];
    for (var j = 0; j < TYPE_ORDER.length; j++) {
        TABLE.push({
            name:     TYPE_ORDER[j],
            enumVal:  TYPE_ORDER[j],
            index:    j,
            typeString: 'FindDeposit' + TYPE_ORDER[j]
        });
    }

    var INDEX_BY_NAME = {};
    for (var k = 0; k < TABLE.length; k++) {
        INDEX_BY_NAME[TABLE[k].name] = TABLE[k].index;
    }

    if (!S.core.deposits) S.core.deposits = {};

    // Ordered list of deposit metadata. Callers iterating in subTaskId
    // order should use this rather than Object.keys(S.Deposit) (which
    // is order-insensitive).
    S.core.deposits.types = function () { return TABLE.slice(); };

    // Name → 0..8 subTaskId. Returns -1 for unknown names.
    S.core.deposits.indexOf = function (depositName) {
        if (typeof depositName !== 'string') return -1;
        var idx = INDEX_BY_NAME[depositName];
        return (typeof idx === 'number') ? idx : -1;
    };

    // 'IronOre' → 'FindDepositIronOre'. The `type_string` field on
    // skill effects uses this form.
    S.core.deposits.depositTypeStringFor = function (depositName) {
        if (typeof depositName !== 'string' || !depositName) return '';
        return 'FindDeposit' + depositName;
    };

}(Steward));
