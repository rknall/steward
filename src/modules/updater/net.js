/*
 * Network transports for the updater module.
 *
 * getJson(url, done) asks the GitHub API through the host's jQuery $.ajax;
 * getBytes(url, done) downloads a release asset through air.URLLoader in
 * BINARY mode, because $.ajax in the AIR WebKit only hands back text and
 * would mangle the bytes the checksum is computed over.
 *
 * done(failure, data, status): failure is null or an S.UpdateFailure value.
 *  - A URL outside REPO.apiPrefix / REPO.downloadPrefix is refused with
 *    ForeignUrl before any request, so nothing but the steward repo is ever
 *    fetched, whatever a release body or a stored state says.
 *  - A missing transport gives Unsupported.
 *  - done runs at most once. When a script reload replaced the lifecycle
 *    while the request was in flight, the answer belongs to the old bundle
 *    and is dropped. A throw inside done is caught and logged so it cannot
 *    escape into the host's event dispatch.
 */

(function (S) {

    if (!S.modules.updater) S.modules.updater = {};

    function under(url, prefix) {
        return typeof url === 'string' && url.indexOf(prefix) === 0;
    }

    function once(label, url, done) {
        var owner = S.kernel.lifecycle;
        var called = false;
        return function (failure, data, status) {
            if (called) return;
            called = true;
            if (S.kernel.lifecycle !== owner) {
                S.kernel.log('updater', label, 'answer dropped: script reloaded', url);
                return;
            }
            try {
                done(failure, data, status);
            } catch (e) {
                S.kernel.error('updater', label, 'callback threw:', e);
            }
        };
    }

    function statusOf(xhr) {
        return (xhr && typeof xhr.status === 'number') ? xhr.status : 0;
    }

    function getJson(url, done) {
        var F = S.UpdateFailure;
        var REPO = S.modules.updater.REPO;
        var finish = once('getJson', url, done);
        if (!under(url, REPO.apiPrefix)) {
            S.kernel.warn('updater', 'getJson refused foreign url', url);
            finish(F.ForeignUrl, null, 0);
            return;
        }
        if (typeof $ === 'undefined' || !$ || typeof $.ajax !== 'function') {
            finish(F.Unsupported, null, 0);
            return;
        }
        try {
            $.ajax({
                url:      url,
                dataType: 'json',
                timeout:  REPO.apiTimeoutMs,
                headers:  { Accept: 'application/vnd.github+json' },
                success:  function (data, textStatus, xhr) {
                    finish(null, data, statusOf(xhr) || 200);
                },
                error:    function (xhr, textStatus) {
                    var st = statusOf(xhr);
                    var failure;
                    if (st === 403 || st === 429) failure = F.RateLimited;
                    else if (textStatus === 'timeout' || st === 0) failure = F.Network;
                    else failure = F.BadResponse;
                    S.kernel.warn('updater', 'getJson failed', url, 'status', st, textStatus);
                    finish(failure, null, st);
                }
            });
        } catch (e) {
            S.kernel.error('updater', 'getJson: $.ajax threw:', e);
            finish(F.Network, null, 0);
        }
    }

    function hasLoader() {
        return typeof air !== 'undefined' && !!air &&
            typeof air.URLLoader === 'function' &&
            typeof air.URLRequest === 'function' &&
            !!air.URLLoaderDataFormat && !!air.Event &&
            !!air.IOErrorEvent && !!air.SecurityErrorEvent;
    }

    function getBytes(url, done) {
        var F = S.UpdateFailure;
        var REPO = S.modules.updater.REPO;
        var finish = once('getBytes', url, done);
        if (!under(url, REPO.downloadPrefix)) {
            S.kernel.warn('updater', 'getBytes refused foreign url', url);
            finish(F.ForeignUrl, null, 0);
            return;
        }
        if (!hasLoader()) {
            finish(F.Unsupported, null, 0);
            return;
        }

        var loader, req;
        var COMPLETE = air.Event.COMPLETE;
        var IO_ERROR = air.IOErrorEvent.IO_ERROR;
        var SECURITY_ERROR = air.SecurityErrorEvent.SECURITY_ERROR;

        function detach() {
            try {
                loader.removeEventListener(COMPLETE, onComplete);
                loader.removeEventListener(IO_ERROR, onError);
                loader.removeEventListener(SECURITY_ERROR, onError);
            } catch (e) {
                S.kernel.error('updater', 'getBytes: removing listeners threw:', e);
            }
        }

        function onComplete() {
            detach();
            var data = loader.data;
            if (!data) {
                S.kernel.warn('updater', 'getBytes: empty answer', url);
                finish(F.BadResponse, null, 0);
                return;
            }
            finish(null, data, 200);
        }

        function onError(ev) {
            detach();
            S.kernel.warn('updater', 'getBytes failed', url, ev && ev.type);
            finish(F.Network, null, 0);
        }

        try {
            loader = new air.URLLoader();
            loader.dataFormat = air.URLLoaderDataFormat.BINARY;
            req = new air.URLRequest(url);
        } catch (e) {
            S.kernel.error('updater', 'getBytes: loader setup threw:', e);
            finish(F.Unsupported, null, 0);
            return;
        }
        // idleTimeout is an AIR-only URLRequest property; a runtime without
        // it still downloads, only without the stall limit.
        try {
            req.idleTimeout = REPO.downloadTimeoutMs;
        } catch (e) {
            S.kernel.warn('updater', 'getBytes: idleTimeout not settable:', e);
        }
        loader.addEventListener(COMPLETE, onComplete);
        loader.addEventListener(IO_ERROR, onError);
        loader.addEventListener(SECURITY_ERROR, onError);
        try {
            loader.load(req);
        } catch (e) {
            detach();
            S.kernel.error('updater', 'getBytes: load threw:', e);
            finish(F.Network, null, 0);
        }
    }

    S.modules.updater.net = {
        getJson:  getJson,
        getBytes: getBytes
    };

}(Steward));
