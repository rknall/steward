/*
 * Inspector primitives.
 *
 * Reflective dump of a live game-API object: walks property names, skips
 * functions and Flash-internals, formats values for the log. Used by the
 * specialist / building / zone inspectors that the diagnostics module's
 * menu wires up.
 *
 * Defensive throughout — every property access is wrapped, because game
 * objects sometimes throw on getters when the underlying state is not what
 * the engine expects.
 */

(function (S) {

    if (!S.modules.diagnostics) S.modules.diagnostics = {};

    var MAX_VALUE_LEN = 240;     // per-property string truncation
    var SKIP_PROP_PATTERNS = [   // case-insensitive; matched as substrings
        '__proto__',
        'constructor',
        'parentMostObject', 'parentObject',
        'mGOContainer', 'mGOComponent'
    ];

    function shouldSkip(key) {
        if (!key || typeof key !== 'string') return true;
        if (key.charAt(0) === '_' && key.charAt(1) === '_') return true;   // __anything__
        for (var i = 0; i < SKIP_PROP_PATTERNS.length; i++) {
            if (key === SKIP_PROP_PATTERNS[i]) return true;
        }
        return false;
    }

    function classify(v) {
        if (v === null) return 'null';
        if (v === undefined) return 'undef';
        var t = typeof v;
        if (t === 'function') return 'fn';
        if (t === 'object') {
            if (v && typeof v.length === 'number' && typeof v.splice !== 'function' && v.length > 0) {
                return 'vec[' + v.length + ']';
            }
            return 'obj';
        }
        return t;
    }

    function shortValue(v) {
        try {
            if (v === null) return 'null';
            if (v === undefined) return 'undefined';
            if (typeof v === 'function') return '[fn]';
            if (typeof v === 'object') {
                if (typeof v.length === 'number' && typeof v.splice !== 'function') {
                    return '[vector len=' + v.length + ']';
                }
                // Try a JSON dump but most game objects throw — fall back.
                try {
                    var s = JSON.stringify(v);
                    if (s && s.length <= MAX_VALUE_LEN) return s;
                    if (s) return s.substring(0, MAX_VALUE_LEN) + '…';
                } catch (e) { /* fall through */ }
                return '[object]';
            }
            var str = String(v);
            if (str.length > MAX_VALUE_LEN) return str.substring(0, MAX_VALUE_LEN) + '…';
            return str;
        } catch (e) {
            return '[threw: ' + e + ']';
        }
    }

    function callerOf(obj, methodName) {
        try {
            if (typeof obj[methodName] !== 'function') return null;
            var v = obj[methodName]();
            return shortValue(v);
        } catch (e) {
            return '[threw: ' + e + ']';
        }
    }

    // Walk every direct property + a curated set of common getters. Returns
    // an array of "key  type  value" strings, ready to log line-by-line.
    function describe(obj, label) {
        var lines = [];
        if (!obj) {
            lines.push('(null/undefined object)');
            return lines;
        }
        lines.push('=== ' + (label || 'object') + ' ===');

        // 1. Direct properties.
        var keys = [];
        try {
            for (var k in obj) {
                if (shouldSkip(k)) continue;
                keys.push(k);
            }
        } catch (e) {
            lines.push('(for..in threw: ' + e + ')');
        }
        keys.sort();

        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var val;
            try { val = obj[key]; } catch (e) { val = '[threw: ' + e + ']'; }
            // Skip pure functions in the property dump (we hit common ones below).
            if (typeof val === 'function') continue;
            lines.push('  ' + key + '  [' + classify(val) + ']  ' + shortValue(val));
        }

        // 2. Curated getter probes — these are functions, but the values they
        //    return are the interesting bits.
        var getters = [
            'GetType', 'GetBaseType', 'getName', 'GetName',
            'getPlayerID', 'GetPlayerID',
            'GetTask', 'GetUniqueID',
            'GetMaxTroops', 'getMaxTroops', 'GetTroopLimit',
            'GetCanAttack', 'canAttack',
            'GetGeneralState', 'GetState',
            'isTravelling', 'isTravellingAway', 'IsInUse',
            'HasUnits', 'GetGarrisonGridIdx',
            'GetGrid', 'GetUpgradeLevel', 'GetBuildingName_string',
            'GetSkills_vector'
        ];
        var getterLines = [];
        for (var j = 0; j < getters.length; j++) {
            var g = getters[j];
            if (typeof obj[g] !== 'function') continue;
            var rv = callerOf(obj, g);
            if (rv === null) continue;
            getterLines.push('  ' + g + '()  ' + rv);
        }
        if (getterLines.length) {
            lines.push('--- getters ---');
            for (var x = 0; x < getterLines.length; x++) lines.push(getterLines[x]);
        }

        // 3. If there's a current task, describe it inline.
        try {
            if (typeof obj.GetTask === 'function') {
                var task = obj.GetTask();
                if (task) {
                    lines.push('--- task ---');
                    var taskGetters = ['GetType', 'GetSubType', 'GetState', 'IsRunning'];
                    for (var y = 0; y < taskGetters.length; y++) {
                        var tg = taskGetters[y];
                        if (typeof task[tg] !== 'function') continue;
                        lines.push('  task.' + tg + '()  ' + callerOf(task, tg));
                    }
                    // direct fields on task
                    for (var tk in task) {
                        if (shouldSkip(tk)) continue;
                        var tv;
                        try { tv = task[tk]; } catch (e) { tv = '[threw]'; }
                        if (typeof tv === 'function') continue;
                        lines.push('  task.' + tk + '  ' + shortValue(tv));
                    }
                }
            }
        } catch (e) { lines.push('(task probe threw: ' + e + ')'); }

        return lines;
    }

    function logLines(category, lines) {
        for (var i = 0; i < lines.length; i++) S.kernel.log(category, lines[i]);
    }

    S.modules.diagnostics.inspect = {
        describe: describe,
        logLines: logLines,
        shortValue: shortValue
    };

}(Steward));
