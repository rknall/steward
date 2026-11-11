/*
 * Release list of the updater module.
 *
 * fetch(done) reads the newest REPO.api page (30 releases) once; the same
 * list serves the latest-version check and the step-down choice, so a check
 * costs one API request. The list is kept in memory only and is gone after a
 * script reload.
 *
 * parse(json) keeps only releases that can be installed safely:
 *  - not a draft;
 *  - the tag is 'v' + a version S.kernel.semver understands, with nothing
 *    around it, and not 0.0.0, so the one version grammar decides;
 *  - exactly one asset named REPO.asset, served from the steward release
 *    download URL of that very tag, with a positive integer size.
 * A release is { tag, text, version, name, body, published, prerelease,
 * asset: { url, size, digest } }. digest is GitHub's lowercased SHA-256 hex
 * or null when GitHub did not compute one.
 */

(function (S) {

    if (!S.modules.updater) S.modules.updater = {};

    var DIGEST = /^sha256:([0-9a-fA-F]{64})$/;

    // { list, time } of the last successful fetch, or null.
    var cache = null;

    function acceptTag(tag) {
        if (typeof tag !== 'string' || tag.charAt(0) !== 'v') return null;
        var p = S.kernel.semver.parse(tag);
        if (!p || p.kind === S.VersionKind.Unknown) return null;
        if ('v' + p.text !== tag) return null;
        return p;
    }

    function isPositiveInt(n) {
        return typeof n === 'number' && isFinite(n) && n > 0 && Math.floor(n) === n;
    }

    function pickAsset(assets) {
        var REPO = S.modules.updater.REPO;
        if (!Array.isArray(assets)) return null;
        var found = null;
        for (var i = 0; i < assets.length; i++) {
            var a = assets[i];
            if (!a || typeof a !== 'object' || a.name !== REPO.asset) continue;
            if (found) return null;
            found = a;
        }
        return found;
    }

    function publishedMs(text) {
        if (typeof text !== 'string') return 0;
        var ms = Date.parse(text);
        return isFinite(ms) ? ms : 0;
    }

    // One GitHub release object to a release record, or null when skipped.
    function toRelease(r) {
        var REPO = S.modules.updater.REPO;
        if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
        if (r.draft) return null;
        var p = acceptTag(r.tag_name);
        if (!p) {
            S.kernel.log('updater', 'release skipped: tag not a version', r.tag_name);
            return null;
        }
        var tag = r.tag_name;
        var asset = pickAsset(r.assets);
        if (!asset) {
            S.kernel.log('updater', 'release skipped: no single', REPO.asset, 'asset in', tag);
            return null;
        }
        var url = REPO.downloadPrefix + tag + '/' + REPO.asset;
        if (asset.browser_download_url !== url) {
            S.kernel.warn('updater', 'release skipped: asset url', asset.browser_download_url,
                'is not', url);
            return null;
        }
        if (!isPositiveInt(asset.size)) {
            S.kernel.warn('updater', 'release skipped: bad asset size', asset.size, 'in', tag);
            return null;
        }
        var m = typeof asset.digest === 'string' ? DIGEST.exec(asset.digest) : null;
        return {
            tag:        tag,
            text:       p.text,
            version:    p,
            name:       typeof r.name === 'string' && r.name ? r.name : tag,
            body:       typeof r.body === 'string' ? r.body.slice(0, REPO.bodyMaxChars) : '',
            published:  publishedMs(r.published_at),
            prerelease: r.prerelease === true || p.kind === S.VersionKind.Prerelease,
            asset: {
                url:    url,
                size:   asset.size,
                digest: m ? m[1].toLowerCase() : null
            }
        };
    }

    // `skipped` counts every entry left out, whatever the reason.
    function parse(json) {
        var list = [];
        var skipped = 0;
        if (!Array.isArray(json)) return { list: list, skipped: skipped };
        for (var i = 0; i < json.length; i++) {
            var rel = toRelease(json[i]);
            if (rel) list.push(rel);
            else skipped++;
        }
        var semver = S.kernel.semver;
        list.sort(function (a, b) { return semver.compare(b.version, a.version); });
        return { list: list, skipped: skipped };
    }

    // done(failure, list, skipped).
    function fetch(done) {
        var U = S.modules.updater;
        U.net.getJson(U.REPO.api, function (failure, data) {
            if (failure) {
                done(failure, null, 0);
                return;
            }
            if (!Array.isArray(data)) {
                S.kernel.warn('updater', 'release list is not an array');
                done(S.UpdateFailure.BadResponse, null, 0);
                return;
            }
            var res;
            try {
                res = parse(data);
            } catch (e) {
                S.kernel.error('updater', 'release list parse threw:', e);
                done(S.UpdateFailure.BadResponse, null, 0);
                return;
            }
            cache = { list: res.list, time: U.now() };
            S.kernel.log('updater', 'releases fetched:', res.list.length, 'usable,',
                res.skipped, 'skipped');
            done(null, res.list, res.skipped);
        });
    }

    function latest(list, prereleases) {
        if (!Array.isArray(list)) return null;
        for (var i = 0; i < list.length; i++) {
            if (prereleases || !list[i].prerelease) return list[i];
        }
        return null;
    }

    function cached() {
        return cache;
    }

    S.modules.updater.releases = {
        parse:  parse,
        fetch:  fetch,
        latest: latest,
        cached: cached
    };

}(Steward));
