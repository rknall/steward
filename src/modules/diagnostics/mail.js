/*
 * Mail probe.
 *
 * Dump of what the mail API decides on: the game's mail window (which member
 * tells whether it is shown is not confirmed live), the mail service's
 * operations and last header answer, the channel names, the steward header
 * snapshot, how many mails of each raw type the inbox holds (so a type the
 * API does not know shows up), the member names of one raw header and the
 * status of the request this dump made. Written as JSON under steward/dumps/
 * as mail-<zone>-<epoch ms>.json.
 *
 * Read-only except that it asks for the inbox headers once through the core
 * mail refresh. That request is asynchronous, so the answer is in a second
 * dump taken about 10 s later. Never reads or logs mail bodies: only member
 * names, counts and types are recorded.
 *
 * Loads after inspect.js and before minebuffs.js; every helper is read at call
 * time.
 */

(function (S) {

    if (!S.modules.diagnostics) S.modules.diagnostics = {};

    // Longest log line when the dump cannot be written to a file.
    var CHUNK_LEN = 1500;

    // One failed read becomes a value in the document, never an abort.
    function guard(fn) {
        return S.modules.diagnostics.inspect.guard(fn);
    }

    // Enumerable member names of a host object, sorted so two dumps diff.
    function names(obj) {
        var out = [];
        if (obj === null || obj === undefined) return out;
        for (var k in obj) out.push(k);
        out.sort();
        return out;
    }

    function windowRecord() {
        var w = globalFlash.gui.mMailWindow;
        return {
            open:    S.core.mail.windowOpen(),
            present: w !== null && w !== undefined,
            members: names(w),
            types:   (w === null || w === undefined) ? null : {
                visible: typeof w.visible,
                stage:   w.stage === null ? 'null' : typeof w.stage,
                IsOpen:  typeof w.IsOpen,
                isOpen:  typeof w.isOpen
            }
        };
    }

    function connection() {
        return game.def('ServerState::cConnectionManager').GetInstance();
    }

    // The passive header answer, the same object the core read adopts from.
    function lastResult() {
        return connection().mMailService.operations['GetHeaders'].lastResult;
    }

    function collectionOf(lr) {
        var c = null;
        try { c = lr.data.data.headers_collection; } catch (e) { c = null; }
        if (c === null || c === undefined) {
            try { c = lr.data.headers_collection; } catch (e2) { c = null; }
        }
        return (c === undefined) ? null : c;
    }

    function serviceRecord() {
        var ops = connection().mMailService.operations;
        var lr = null;
        var c = null;
        try { lr = ops['GetHeaders'].lastResult; } catch (e) { lr = null; }
        if (lr) c = collectionOf(lr);
        var items = c ? S.kernel.hostRead.list(c) : null;
        return {
            operations:    names(ops),
            hasLastResult: !!lr,
            hasCollection: c !== null,
            length:        items ? items.length : null
        };
    }

    function snapshotRecord() {
        var h = S.core.mail.headers();
        return {
            state: h.state,
            count: h.value ? h.value.length : null,
            lost:  h.lost,
            why:   h.why,
            stamp: S.core.mail.stamp()
        };
    }

    // Count per raw type, with the kind the API gives it, so a type it does
    // not know reads as Unknown.
    function typesRecord() {
        var h = S.core.mail.headers();
        if (!h.value) return { state: h.state, why: h.why, types: null };
        var out = {};
        for (var i = 0; i < h.value.length; i++) {
            var type = h.value[i].type;
            var key = String(type);
            if (!out[key]) out[key] = { type: type, kind: S.core.mail.kindOf(type), count: 0 };
            out[key].count++;
        }
        return out;
    }

    // The API keeps raw headers private, so the first one comes from the
    // passive collection. Member names only, never values.
    function firstRawRecord() {
        var c = collectionOf(lastResult());
        if (c === null) return null;
        var items = S.kernel.hostRead.list(c);
        return (items && items.length > 0) ? names(items[0]) : null;
    }

    function mailUtilsRecord() {
        var mu = game.def('MailUtils');
        return {
            present:        !!mu,
            canCollectMail: !!mu && typeof mu.CanCollectMail
        };
    }

    // The whole document. The refresh runs last so every other part shows
    // the state from before this dump's own request.
    function record() {
        var doc = {
            zoneId:    guard(function () { return S.core.zone.id(); }),
            window:    guard(windowRecord),
            service:   guard(serviceRecord),
            channels:  guard(function () { return names(game.gi.channels); }),
            snapshot:  guard(snapshotRecord),
            types:     guard(typesRecord),
            firstRaw:  guard(firstRawRecord),
            mailUtils: guard(mailUtilsRecord)
        };
        doc.refresh = guard(function () { return S.core.mail.refresh({ force: true }); });
        return doc;
    }

    // Logs the document one part at a time, for a dump that has no file to
    // go to.
    function logChunks(cat, doc) {
        for (var key in doc) {
            var text;
            try { text = JSON.stringify(doc[key]); }
            catch (e) { text = '[unprintable]'; }
            if (text === undefined) text = 'undefined';
            var n = Math.max(1, Math.ceil(text.length / CHUNK_LEN));
            for (var c = 0; c < n; c++) {
                S.kernel.log(cat, key + ' ' + (c + 1) + '/' + n + ': ' +
                                  text.substr(c * CHUNK_LEN, CHUNK_LEN));
            }
        }
    }

    function dump() {
        var cat = 'diag:mail';
        S.kernel.log(cat, '--- mail ---');
        var doc = record();
        var text = null;
        try { text = JSON.stringify(doc, null, 2); }
        catch (e) { text = null; }

        var army = S.modules.diagnostics.army;
        var w = (text !== null)
            ? army.writeDump(army.dumpFileName('mail', doc.zoneId), text) : null;
        var tail = ' Headers were requested; dump again after about 10 s to see the answer.';
        if (w && w.ok) {
            S.kernel.log(cat, 'mail written to ' + w.path);
            S.kernel.ui.notify('Mail dumped to ' + w.path + '.' + tail);
        } else {
            S.kernel.warn(cat, w && w.path ? 'write failed: ' + w.message
                                           : 'no writable dumps folder, logging the document');
            logChunks(cat, doc);
            S.kernel.ui.notify('Mail dumped to log (category ' + cat + ').' + tail);
        }
        S.kernel.log(cat, '--- end mail ---');
    }

    S.modules.diagnostics.mail = { dump: dump, record: record };

}(Steward));
