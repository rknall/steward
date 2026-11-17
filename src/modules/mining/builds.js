/*
 * Mining build and upgrade sends: one per grid, verified on the grid.
 *
 * A mine placement or upgrade the client accepts is not visible on the grid
 * until the server answers, so a plan that re-derives its work from the
 * grid would send the same build or upgrade again every tick. This file
 * guards each send:
 *
 *   hold     before the host call a 30 min hold for the grid is written
 *            to the hold file; while it stands no second send goes out for
 *            that grid. A send that made no host call gives the hold back.
 *   verify   each send goes through S.core.actions with no retry and
 *            counts only once the mine (or its new level, or its upgrade
 *            in progress) is seen on the grid; that clears the hold.
 *   unseen   a send that was never seen keeps its hold for the full 30 min,
 *            because it may have landed unseen and a second one would be
 *            wasted or doubled; it also counts a miss on the build breaker.
 *   breaker  5 unseen sends in a row open it, which pauses mine building
 *            and upgrading except one probe every 5 min. The breaker is
 *            memory only, so a script reload resets it, like the buff
 *            breaker.
 *
 * Only positive reads change a hold early: an absent or unreadable building
 * never verifies, never fails and never lifts a hold. After a hold runs out,
 * one new send may go out once the def's precheck reads the grid ready (empty
 * for a build, not upgrading for an upgrade), and that send writes a new hold.
 *
 * The hold file is read back at boot, so a script reload or a client restart
 * keeps every hold that was written before its send. Without a writable
 * folder, or while the file cannot be read, nothing is sent: an unguarded
 * send is what this file exists to prevent.
 *
 * Storage: <steward folder>/mining/holds.json, written whole with
 * S.kernel.files.writeText (temp file, then move). File format:
 * JSON.stringify of { version, holds }, indented, where holds maps a key
 * ('build|<grid>' or 'upgrade|<grid>|<level>') to { until, sent, name }:
 * until and sent are wall clock ms, name is the mine's building name.
 *
 * Load order: under src/modules/mining/ before module.js (name order); the
 * top level only creates the breaker and assigns S.modules.mining.builds;
 * every core is used at call time.
 */

(function (S) {

    if (!S.modules.mining) S.modules.mining = {};

    // A placement or upgrade that was not seen may still land: the server
    // can take minutes to answer under load. 30 min outlasts any answer that
    // still arrives, so a second send never doubles one that did land. The
    // hold is persisted, unlike the buff hold of the same length.
    var HOLD_MS = 1800000;

    var SUBDIR       = 'mining';
    var FILE_NAME    = 'holds.json';
    var FILE_VERSION = 1;

    // A file that could not be read is tried again after this long, so a
    // passing read error neither blocks sends for good nor floods the log.
    var UNREAD_RETRY_MS = 10000;

    var holds       = {};       // key -> { until, sent, name }, ms on api.clock()
    var loaded      = false;
    var persist     = true;     // false: no writable folder, nothing is sent
    var unread      = false;    // the last read failed; retried at retryAt
    var retryAt     = 0;
    var warnedNoDir = false;
    var warnedUnread = false;

    var api = {};

    // Wall clock, because holds outlive the session in the file. Tests
    // replace it through S.modules.mining.builds.clock.
    api.clock = function () { return Date.now(); };

    var breaker = S.core.breaker.create({
        category:   'mining',
        label:      'build breaker',
        missText:   'mine builds or upgrades in a row were not seen on their grid',
        pausedText: 'mine building and upgrading is paused',
        resumeText: 'building and upgrading resume',
        clock:      function () { return api.clock(); }
    });

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    function buildKey(grid) {
        return 'build|' + grid;
    }

    function upgradeKey(grid, lvl) {
        return 'upgrade|' + grid + '|' + lvl;
    }

    function filePath() {
        var d = S.kernel.files.stewardDir(SUBDIR);
        if (!d || !d.dir) return null;
        try {
            return d.dir.resolvePath(FILE_NAME).nativePath;
        } catch (e) {
            S.kernel.warn('mining', 'cannot resolve the build hold path:', e);
            return null;
        }
    }

    // Writes the unexpired holds. False when nothing could be written.
    function write() {
        var path = filePath();
        if (!path) return false;
        var now = api.clock();
        var out = {};
        var key;
        for (key in holds) {
            if (has(holds, key) && holds[key].until > now) out[key] = holds[key];
        }
        var w;
        try {
            w = S.kernel.files.writeText(path,
                JSON.stringify({ version: FILE_VERSION, holds: out }, null, 2));
        } catch (e) {
            S.kernel.warn('mining', 'build hold file not written:', e);
            return false;
        }
        if (!w || !w.ok) {
            S.kernel.warn('mining', 'build hold file not written: ' +
                (w ? (w.message || w.error) : 'no result'));
            return false;
        }
        return true;
    }

    // Idempotent. True when the hold store may be used: read, missing, or
    // known to be unavailable (persist false). False while the file could
    // not be read; the read is retried after UNREAD_RETRY_MS.
    function load() {
        if (loaded) return true;
        var now = api.clock();
        if (unread && now < retryAt) return false;

        var path = filePath();
        if (!path) {
            persist = false;
            loaded = true;
            if (!warnedNoDir) {
                warnedNoDir = true;
                S.kernel.warn('mining', 'no writable steward/mining folder: mine builds and upgrades are not sent');
            }
            return true;
        }

        var r;
        try {
            r = S.kernel.files.readText(path);
        } catch (e) {
            r = { ok: false, error: S.FileError.Unreadable, message: String(e) };
        }
        if (!r.ok && r.error === S.FileError.Missing) {
            holds = {};
            loaded = true;
            unread = false;
            warnedUnread = false;
            return true;
        }
        if (!r.ok) {
            unread = true;
            retryAt = now + UNREAD_RETRY_MS;
            if (!warnedUnread) {
                warnedUnread = true;
                S.kernel.warn('mining', 'build hold file not read: ' + r.message +
                    '; mine builds and upgrades wait');
            }
            return false;
        }

        var data = null;
        try {
            data = JSON.parse(r.text);
        } catch (e) {
            data = null;
        }
        holds = {};
        loaded = true;
        unread = false;
        warnedUnread = false;
        if (!isPlainObject(data) || data.version !== FILE_VERSION || !isPlainObject(data.holds)) {
            // The next write replaces the file.
            S.kernel.warn('mining', 'build hold file is invalid, starting empty');
            return true;
        }

        var changed = false;
        var count = 0;
        var key, e1;
        for (key in data.holds) {
            if (!has(data.holds, key)) continue;
            e1 = data.holds[key];
            if (!isPlainObject(e1) || typeof e1.until !== 'number') {
                changed = true;
                continue;
            }
            if (e1.until <= now) {
                S.kernel.log('mining', 'build hold ' + key + ' (' + e1.name + ') expired');
                changed = true;
                continue;
            }
            var until = e1.until;
            // The clock moved back since the file was written: never hold
            // longer than one full hold from now.
            if (until > now + HOLD_MS) {
                until = now + HOLD_MS;
                changed = true;
            }
            holds[key] = {
                until: until,
                sent:  typeof e1.sent === 'number' ? e1.sent : now,
                name:  e1.name
            };
            count++;
        }
        if (count > 0) {
            S.kernel.log('mining', 'read back ' + count + ' build/upgrade hold(s) from ' +
                S.kernel.files.stewardPath(SUBDIR) + '/' + FILE_NAME);
        }
        if (changed) write();
        return true;
    }

    // Whether key may not be sent now. An unread store holds everything.
    function held(key) {
        if (!load()) return true;
        if (!has(holds, key)) return false;
        var h = holds[key];
        if (h.until > api.clock()) return true;
        delete holds[key];
        S.kernel.log('mining', 'build hold ' + key + ' (' + h.name + ') expired after 30 min; ' +
            'one new send may go out once the grid reads ready');
        write();
        return false;
    }

    // Writes a fresh hold. False (and no hold in memory) when it could not
    // be written, so no send goes out unguarded.
    function put(key, name) {
        if (!loaded || !persist) return false;
        var now = api.clock();
        var prev = has(holds, key) ? holds[key] : null;
        holds[key] = { until: now + HOLD_MS, sent: now, name: name };
        if (!write()) {
            if (prev) holds[key] = prev;
            else delete holds[key];
            return false;
        }
        return true;
    }

    function drop(key) {
        if (!has(holds, key)) return false;
        delete holds[key];
        write();
        return true;
    }

    // A positive late observation of the effect: the hold for key (expired
    // or not) is cleared and the breaker closes. False when there was none.
    function seen(key, what) {
        load();
        if (!has(holds, key)) return false;
        drop(key);
        breaker.verify(what);
        S.kernel.log('mining', what + ' seen, build hold cleared');
        return true;
    }

    // Copy of the unexpired holds.
    function entries() {
        var now = api.clock();
        var out = {};
        var key;
        for (key in holds) {
            if (!has(holds, key) || !(holds[key].until > now)) continue;
            out[key] = { until: holds[key].until, sent: holds[key].sent, name: holds[key].name };
        }
        return out;
    }

    // Whether the build breaker lets one more send out now. Spends the
    // probe while it is open, so callers ask only right before queuing.
    function admit() {
        return breaker.admit(1) > 0;
    }

    function run(def, key, grid, name, sentLine, okLine, unseenLine) {
        var orig = def.send;
        var label = def.label;
        def.category = 'mining';
        def.retries = 0;

        // The hold goes to the file before the host call, so a reload right
        // after the send still finds it.
        def.send = function (base) {
            load();
            if (!loaded || !persist) {
                S.kernel.debug('mining', 'build hold store unavailable, nothing sent');
                return S.core.actions.NOT_SENT;
            }
            if (held(key)) {
                S.kernel.log('mining', key + ' is held, nothing sent');
                return S.core.actions.NOT_SENT;
            }
            if (!put(key, name)) {
                S.kernel.warn('mining', 'could not write the build hold for ' + key + ', nothing sent');
                return S.core.actions.NOT_SENT;
            }
            var res = orig(base);
            if (res === S.core.actions.NOT_SENT) drop(key);
            else if (res === true) S.kernel.log('mining', sentLine);
            return res;
        };

        function onDone(r) {
            var R = S.ActionResult;
            if (r.status === R.Verified && r.sends > 0) {
                drop(key);
                breaker.verify(name + ' grid ' + grid);
                S.kernel.log('mining', okLine);
            } else if (r.status === R.Verified) {
                // Satisfied before any send: the effect is already there.
                if (has(holds, key)) drop(key);
                S.kernel.debug('mining', label + ' already done');
            } else if (r.status === R.Failed && r.unseen) {
                breaker.miss();
                S.kernel.warn('mining', unseenLine + ' — holding the grid for 30 min');
            } else if (r.status === R.Failed) {
                // The send itself failed; it may still have gone out, so the
                // hold stays, but only an unseen send counts on the breaker.
                S.kernel.warn('mining', label + ' failed: ' + r.reason + ' — holding the grid for 30 min');
            } else if (r.status === R.Refused) {
                S.kernel.debug('mining', label + ' refused: ' + r.reason);
            }
        }

        return S.core.actions.attempt(def, onDone);
    }

    function build(mineId, grid, depoName, mineName) {
        return run(S.core.construction.place(mineId, grid, mineName),
            buildKey(grid), grid, mineName,
            // "placed" is the wording the log scans look for.
            'placed ' + mineName + ' on grid ' + grid + ' (' + depoName + ')',
            mineName + ' on grid ' + grid + ' seen, build hold cleared',
            mineName + ' on grid ' + grid + ' was not seen after the build');
    }

    function upgrade(grid, mineName, nextLvl) {
        return run(S.core.construction.upgrade(grid, mineName, nextLvl),
            upgradeKey(grid, nextLvl), grid, mineName,
            'upgrading ' + mineName + ' on grid ' + grid + ' to level ' + nextLvl,
            mineName + ' on grid ' + grid + ' upgrade to level ' + nextLvl + ' seen, hold cleared',
            mineName + ' on grid ' + grid + ' upgrade to level ' + nextLvl + ' was not seen');
    }

    api.HOLD_MS      = HOLD_MS;
    api.SUBDIR       = SUBDIR;
    api.FILE_NAME    = FILE_NAME;
    api.FILE_VERSION = FILE_VERSION;
    api.breaker      = breaker;
    api.load         = load;
    api.held         = held;
    api.seen         = seen;
    api.entries      = entries;
    api.admit        = admit;
    api.build        = build;
    api.upgrade      = upgrade;
    api.buildKey     = buildKey;
    api.upgradeKey   = upgradeKey;

    S.modules.mining.builds = api;

}(Steward));
