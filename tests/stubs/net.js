/*
 * Network stubs: jQuery-style $.ajax and the AIR URLLoader.
 *
 * make(fs) installs URLLoader, URLRequest, URLLoaderDataFormat, IOErrorEvent
 * and SecurityErrorEvent onto fs.air (the airfs stub's `air`) and makes sure
 * air.Event has COMPLETE. It returns
 * { ajax, requests, respondJson, failJson, respondBytes, failBytes }.
 *
 *   ajax:   assign to the host's `$.ajax`. Returns a jqXHR-like object with
 *           done / fail / always, and honours the success / error / complete
 *           options.
 *   requests: one record per request, in call order, and every request stays
 *           pending until a test resolves it:
 *             { url, kind: 'json' | 'bytes', opts, ... }
 *           opts is the $.ajax option object for 'json', and
 *           { dataFormat, idleTimeout } for 'bytes' (read when load runs).
 *   respondJson(i, data)            resolves request i with parsed JSON.
 *   failJson(i, status, textStatus) fails request i (status 0 and
 *                                   textStatus 'timeout' model a timeout).
 *   respondBytes(i, buffer)         the loader's `data` becomes a ByteArray
 *                                   over the Buffer and COMPLETE fires.
 *   failBytes(i, kind)              fires IO_ERROR ('io', the default) or
 *                                   SECURITY_ERROR ('security').
 *
 * Resolving a request twice throws, so a test notices a transport that
 * answers more than once.
 */

'use strict';

function make(fs) {
    var air = fs.air;
    var requests = [];

    air.Event = air.Event || {};
    air.Event.COMPLETE = 'complete';
    air.IOErrorEvent = { IO_ERROR: 'ioError' };
    air.SecurityErrorEvent = { SECURITY_ERROR: 'securityError' };
    air.URLLoaderDataFormat = { TEXT: 'text', BINARY: 'binary', VARIABLES: 'variables' };

    function URLRequest(url) {
        this.url = url;
        this.idleTimeout = 0;
    }

    function URLLoader() {
        this.dataFormat = 'text';
        this.data = null;
        this._listeners = {};
        this._rec = null;
    }

    URLLoader.prototype.addEventListener = function (type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
    };

    URLLoader.prototype.removeEventListener = function (type, fn) {
        var list = this._listeners[type] || [];
        var i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
    };

    URLLoader.prototype.listenerCount = function (type) {
        return (this._listeners[type] || []).length;
    };

    URLLoader.prototype.load = function (req) {
        this._rec = {
            url: req.url,
            kind: 'bytes',
            opts: { dataFormat: this.dataFormat, idleTimeout: req.idleTimeout },
            loader: this,
            request: req,
            settled: false
        };
        requests.push(this._rec);
    };

    URLLoader.prototype.close = function () {};

    URLLoader.prototype._fire = function (type) {
        var list = (this._listeners[type] || []).slice();
        for (var i = 0; i < list.length; i++) list[i]({ type: type, target: this });
    };

    air.URLRequest = URLRequest;
    air.URLLoader = URLLoader;

    function pending(i, kind) {
        var rec = requests[i];
        if (!rec) throw new Error('net stub: no request ' + i);
        if (rec.kind !== kind) throw new Error('net stub: request ' + i + ' is ' + rec.kind);
        if (rec.settled) throw new Error('net stub: request ' + i + ' already resolved');
        rec.settled = true;
        return rec;
    }

    function ajax(opts) {
        var rec = { url: opts.url, kind: 'json', opts: opts, settled: false,
                    state: null, args: null, cbs: { done: [], fail: [], always: [] } };
        requests.push(rec);
        var xhr = {
            status: 0,
            done:   function (fn) { return chain(rec, 'done', fn, xhr); },
            fail:   function (fn) { return chain(rec, 'fail', fn, xhr); },
            always: function (fn) { return chain(rec, 'always', fn, xhr); }
        };
        rec.xhr = xhr;
        return xhr;
    }

    // Callbacks registered after the request settled run at once, as in jQuery.
    function chain(rec, which, fn, xhr) {
        if (rec.state === null) {
            rec.cbs[which].push(fn);
        } else if (which === 'always' || which === rec.state) {
            fn.apply(null, rec.args);
        }
        return xhr;
    }

    function settle(rec, state, args, optName) {
        rec.state = state;
        rec.args = args;
        if (typeof rec.opts[optName] === 'function') rec.opts[optName].apply(null, args);
        var i;
        for (i = 0; i < rec.cbs[state].length; i++) rec.cbs[state][i].apply(null, args);
        for (i = 0; i < rec.cbs.always.length; i++) rec.cbs.always[i].apply(null, args);
        if (typeof rec.opts.complete === 'function') rec.opts.complete(rec.xhr, state === 'done' ? 'success' : 'error');
    }

    function respondJson(i, data) {
        var rec = pending(i, 'json');
        rec.xhr.status = 200;
        settle(rec, 'done', [data, 'success', rec.xhr], 'success');
    }

    function failJson(i, status, textStatus) {
        var rec = pending(i, 'json');
        rec.xhr.status = status;
        settle(rec, 'fail', [rec.xhr, textStatus || 'error', ''], 'error');
    }

    function respondBytes(i, buffer) {
        var rec = pending(i, 'bytes');
        rec.loader.data = air.ByteArray.fromBuffer(buffer);
        rec.loader._fire(air.Event.COMPLETE);
    }

    function failBytes(i, kind) {
        var rec = pending(i, 'bytes');
        rec.loader._fire(kind === 'security' ? air.SecurityErrorEvent.SECURITY_ERROR
                                              : air.IOErrorEvent.IO_ERROR);
    }

    return {
        ajax:         ajax,
        requests:     requests,
        respondJson:  respondJson,
        failJson:     failJson,
        respondBytes: respondBytes,
        failBytes:    failBytes
    };
}

module.exports = { make: make };
