/*
 * Shells: reads of a depleted well or field and of its rebuild.
 *
 * An exhausted well or field leaves a separate building type on its grid (a
 * depleted shell, TSO_API.md "Depleted mines"). The caller owns the shell and
 * building names and passes the shell name in; this file only judges a grid's
 * building against it, so a plan and the check that follows a send apply one
 * rule.
 *
 * Verify rule: a rebuild is seen on the grid when the occupant is no longer
 * the shell, is under construction, or the street map no longer calls it
 * depleted. An emptied grid or an unreadable one does not count, since a
 * building that merely failed to read would otherwise look rebuilt, and the
 * build queue is not used because its count lags the grid. unchanged() is the
 * opposite proof: the grid positively still shows the idle shell.
 *
 * Reads that cannot be answered are null or a read refusal, never a guess.
 * snapshot() and describe() only feed a log line and never decide anything.
 *
 * Bundle slot: core, after resources.js and before sound.js (core files load
 * in name order); the top level only assigns S.core.shells; buildings, zone
 * and read are used at call time.
 */

(function (S) {

    var R = S.kernel.read;

    var CONSTRUCTION_UNREADABLE = R.readRefusal('construction state unreadable');
    var DEPLETED_UNREADABLE     = R.readRefusal('depleted state unreadable');

    // Whether the building is under construction: true or false from
    // IsInConstructionMode(), null when that cannot be read or there is no
    // building. A host without the method gives false, as it does for every
    // optional buff blocker.
    function constructing(b) {
        var st = S.core.buildings.buffState(b);
        if (!st || !st.blockers) return null;
        for (var i = 0; i < st.blockers.length; i++) {
            var bl = st.blockers[i];
            if (bl && bl.method === 'IsInConstructionMode') {
                if (bl.present === false) return false;
                return (bl.value === true || bl.value === false) ? bl.value : null;
            }
        }
        return null;
    }

    // Null when b is the idle shell a rebuild may start on, else the reason.
    function ready(b, shellName) {
        if (S.core.buildings.name(b) !== shellName) return 'shell gone';
        var c = constructing(b);
        if (c === null) return CONSTRUCTION_UNREADABLE;
        if (c) return 'under construction';
        var d = S.core.buildings.depletedRead(b);
        if (d && d.present) {
            if (d.value === null) return DEPLETED_UNREADABLE;
            if (d.value === false) return 'not depleted';
        }
        return null;
    }

    // True only on a positive sign that the rebuild reached the grid.
    function changed(b, shellName) {
        if (!b) return false;
        var nm = S.core.buildings.name(b);
        if (nm && nm !== shellName) return true;
        if (constructing(b) === true) return true;
        var d = S.core.buildings.depletedRead(b);
        return !!d && d.present === true && d.value === false;
    }

    // True only when the grid positively still shows the idle shell.
    function unchanged(b, shellName) {
        return ready(b, shellName) === null && constructing(b) === false;
    }

    function safe(fn) {
        try {
            var v = fn();
            return v === undefined ? '?' : v;
        } catch (e) { return '?'; }
    }

    // Facts about the grid for the log line of a rebuild. buildingName only
    // feeds the id lookup, which is recorded and never sent.
    function snapshot(grid, buildingName) {
        var b = null;
        try { b = S.core.buildings.byGrid(grid); } catch (e) { b = null; }
        var out = {};
        out.name = safe(function () { return b ? S.core.buildings.name(b) : 'none'; });
        out.c = safe(function () { return constructing(b); });
        out.d = safe(function () {
            var d = S.core.buildings.depletedRead(b);
            return d && d.present ? d.value : null;
        });
        out.level = safe(function () { return S.core.buildings.level(b); });
        out.preplace = safe(function () {
            var sdm = S.core.zone.current().mStreetDataMap;
            return typeof sdm.SetPrePlaceBuildingGridPos === 'function' ? 'yes' : 'no';
        });
        out.nr = safe(function () {
            var g = game.def('global');
            if (!g) return '?';
            return g.buildingGroup.GetNrFromName(buildingName);
        });
        return out;
    }

    function describe(a, b) {
        var x = a || {};
        var y = b || {};
        function f(o, k) { return o[k] === undefined ? '?' : o[k]; }
        return 'grid ' + f(x, 'name') + ' -> ' + f(y, 'name') +
            ', constructing ' + f(x, 'c') + ' -> ' + f(y, 'c') +
            ', depleted ' + f(x, 'd') + ' -> ' + f(y, 'd') +
            ', level ' + f(x, 'level') + ' -> ' + f(y, 'level') +
            ', preplace ' + f(y, 'preplace') +
            ', lookup ' + f(y, 'nr');
    }

    S.core.shells = {
        CONSTRUCTION_UNREADABLE: CONSTRUCTION_UNREADABLE,
        DEPLETED_UNREADABLE:     DEPLETED_UNREADABLE,
        constructing:            constructing,
        ready:                   ready,
        changed:                 changed,
        unchanged:               unchanged,
        snapshot:                snapshot,
        describe:                describe
    };

}(Steward));
