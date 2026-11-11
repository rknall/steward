/*
 * Kernel version parser and comparer.
 *
 * Bundle place: 18_, after 17_files.js and before 20_logger.js; it only
 * assigns Steward.kernel.semver at load (no IO, no state); enum values
 * (S.VersionKind) are read at call time.
 *
 * It understands the version shapes scripts/version.js produces from
 * `git describe`, so a running build and a release tag compare on one grammar:
 *   1.2.3                  Release
 *   1.2.3-alpha2           Prerelease (any other suffix)
 *   1.2.3-4-gabc1234       Dev, 4 commits ahead of the tag
 *   1.2.3-4-gabc1234-dirty Dev with uncommitted changes
 *   1.2.3-dirty            Dev, on the tag but dirty
 *   0.0.0, 0.0.0-git       Unknown (no tag; the package.json placeholder or
 *                          the last fallback)
 * A dev build on a prerelease base (1.2.3-alpha2-4-gabc) has the prerelease
 * suffix first, so it parses as Prerelease; it never counts as Release, which
 * keeps it out of automatic installs.
 *
 * Order: major, minor, patch numerically, then Prerelease < Release (= Unknown)
 * < Dev. Two prereleases compare their suffix naturally (alpha2 < alpha10),
 * two dev builds compare commits ahead and then dirty.
 */

(function (S) {

    var MATCH     = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;
    var DEV_AHEAD = /^(\d+)-g[0-9a-f]+(-dirty)?$/;

    function parse(text) {
        if (typeof text !== 'string') return null;
        if (text.charAt(0) === 'v') text = text.slice(1);
        var m = MATCH.exec(text);
        if (!m) return null;

        var K = S.VersionKind;
        var v = {
            major: parseInt(m[1], 10),
            minor: parseInt(m[2], 10),
            patch: parseInt(m[3], 10),
            kind:  K.Release,
            pre:   null,
            ahead: 0,
            dirty: false,
            text:  text
        };
        // No tag was ever v0.0.0, so 0.0.0 with any suffix is the unversioned
        // fallback (the package.json placeholder or the last resort) and must
        // never be offered an update.
        if (v.major === 0 && v.minor === 0 && v.patch === 0) {
            v.kind = K.Unknown;
            return v;
        }
        var suffix = m[4];
        if (suffix === undefined) return v;
        var d = DEV_AHEAD.exec(suffix);
        if (d) {
            v.kind  = K.Dev;
            v.ahead = parseInt(d[1], 10);
            v.dirty = !!d[2];
        } else if (suffix === 'dirty') {
            v.kind  = K.Dev;
            v.dirty = true;
        } else {
            v.kind = K.Prerelease;
            v.pre  = suffix;
        }
        return v;
    }

    function asParsed(x) {
        if (typeof x === 'string') return parse(x);
        return (x && typeof x === 'object') ? x : null;
    }

    function rank(kind) {
        var K = S.VersionKind;
        if (kind === K.Prerelease) return 0;
        if (kind === K.Dev) return 2;
        return 1;
    }

    function sign(n) {
        return n < 0 ? -1 : (n > 0 ? 1 : 0);
    }

    // Digit runs compare numerically, other runs as strings.
    function naturalCompare(a, b) {
        var ra = String(a).match(/\d+|\D+/g) || [];
        var rb = String(b).match(/\d+|\D+/g) || [];
        var n = Math.min(ra.length, rb.length);
        for (var i = 0; i < n; i++) {
            var x = ra[i], y = rb[i];
            var xd = /^\d/.test(x), yd = /^\d/.test(y);
            if (xd && yd) {
                var dx = parseInt(x, 10), dy = parseInt(y, 10);
                if (dx !== dy) return dx < dy ? -1 : 1;
            } else if (x !== y) {
                return x < y ? -1 : 1;
            }
        }
        return sign(ra.length - rb.length);
    }

    function compare(a, b) {
        var pa = asParsed(a), pb = asParsed(b);
        if (!pa || !pb) {
            if (!pa && !pb) return 0;
            return pa ? 1 : -1;
        }
        if (pa.major !== pb.major) return sign(pa.major - pb.major);
        if (pa.minor !== pb.minor) return sign(pa.minor - pb.minor);
        if (pa.patch !== pb.patch) return sign(pa.patch - pb.patch);

        var ka = rank(pa.kind), kb = rank(pb.kind);
        if (ka !== kb) return ka < kb ? -1 : 1;

        var K = S.VersionKind;
        if (pa.kind === K.Prerelease && pb.kind === K.Prerelease) {
            return naturalCompare(pa.pre, pb.pre);
        }
        if (pa.kind === K.Dev && pb.kind === K.Dev) {
            if (pa.ahead !== pb.ahead) return pa.ahead < pb.ahead ? -1 : 1;
            if (pa.dirty !== pb.dirty) return pa.dirty ? 1 : -1;
        }
        return 0;
    }

    function running() {
        return parse(S.kernel.VERSION);
    }

    function isNewer(candidate, base) {
        var pb = asParsed(base);
        if (!pb || pb.kind === S.VersionKind.Unknown) return false;
        return compare(candidate, pb) > 0;
    }

    // Only a plain release replacing a plain, older release may install by
    // itself; dev, test and unknown builds always need the user.
    function autoInstallable(runningVersion, candidate) {
        var pr = asParsed(runningVersion), pc = asParsed(candidate);
        if (!pr || !pc) return false;
        var K = S.VersionKind;
        return pr.kind === K.Release && pc.kind === K.Release && isNewer(pc, pr);
    }

    S.kernel.semver = {
        parse:           parse,
        compare:         compare,
        running:         running,
        isNewer:         isNewer,
        autoInstallable: autoInstallable
    };

}(Steward));
