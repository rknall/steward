/*
 * Adventure queue store for the adventures module.
 *
 * A queue is an ordered list of entries, each a template or a scenario with
 * its own run count, run one after another by the run state machine. Storage
 * layout: one JSON file per queue in
 * <steward folder>/adventures/queues/<id>.json, next to the template and
 * scenario folders, with the same id and file rules as templates.js (the file
 * name is the id, a stored `id` field is ignored, any valid file dropped in is
 * a queue). File format: JSON.stringify of
 *   { version, label, entries: [ { kind, id, count } ], loop, passes, early,
 *     retrain, noMap, saved }
 * indented, so it stays readable and shareable.
 *
 * An entry holds only its kind and id. Its label and adventure are read from
 * the template or scenario record when needed, so renaming a template or a
 * scenario needs no queue edit. KIND, RETRAIN and NO_MAP below are the only
 * lists of entry kinds and option values; every other file reads them from
 * here. An entry of a kind this build does not know (a later `venture`, say)
 * is kept on load so saving an older build's view never rewrites a newer file
 * silently; validate reports it, and the queue cannot start until it is
 * removed.
 *
 * Options: `loop` repeats the whole queue, `passes` limits the repeats
 * (0 = until End repetition or Stop), `early` starts the next entry while the
 * finished entry's generals travel home, `retrain` follows Settings >
 * Adventures or forces retraining on or off for every entry, `noMap` pauses
 * or steps over an entry with no map left in the star menu.
 *
 * toRun builds the copy a run request carries: a started queue never reads
 * its file again, so edits saved while it runs apply at the next start.
 *
 * A file that cannot be read or parsed is listed as a broken entry
 * { id, path, error }, as templates are, so the user sees it and can delete
 * it. Writes go through S.kernel.files.writeText (temp file, then move).
 *
 * Bundle slot: module file; top level only assigns
 * S.modules.adventures.queues; templates and scenarios are read at call time.
 */

(function (S) {
    'use strict';

    if (!S.modules.adventures) S.modules.adventures = {};

    var SUBDIR = 'adventures/queues';
    var FORMAT_VERSION = 1;

    var KIND    = { Template: 'template', Scenario: 'scenario' };
    var RETRAIN = { Settings: 'settings', On: 'on', Off: 'off' };
    var NO_MAP  = { Pause: 'pause', Skip: 'skip' };

    function isArray(v) {
        return Object.prototype.toString.call(v) === '[object Array]';
    }

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';
    }

    function str(v) {
        return typeof v === 'string' ? v : '';
    }

    function trim(v) {
        return str(v).replace(/^\s+|\s+$/g, '');
    }

    function templates() {
        return S.modules.adventures.templates;
    }

    function scenarios() {
        return S.modules.adventures.scenarios;
    }

    // Pure. Whether v is one of the values of the enum object.
    function isValue(en, v) {
        for (var k in en) {
            if (Object.prototype.hasOwnProperty.call(en, k) && en[k] === v) return true;
        }
        return false;
    }

    function isKnownKind(kind) {
        return isValue(KIND, kind);
    }

    // Pure. A whole number of at least `min`, or `fallback` for anything that
    // is not a finite number.
    function whole(v, min, fallback) {
        if (typeof v !== 'number' || !isFinite(v)) return fallback;
        var n = Math.floor(v);
        return n < min ? min : n;
    }

    // ---- Location ---------------------------------------------------------

    function dir() {
        return S.kernel.files.stewardDir(SUBDIR);
    }

    function dirPath() {
        var d = dir();
        return d && d.dir ? d.dir.nativePath : null;
    }

    function pathOf(id) {
        if (!templates().validId(id)) return null;
        var d = dir();
        if (!d || !d.dir) return null;
        try {
            return d.dir.resolvePath(id + templates().EXT).nativePath;
        } catch (e) {
            S.kernel.warn('adventures', 'cannot resolve queue path for', id, ':', e);
            return null;
        }
    }

    // ---- Records ----------------------------------------------------------

    // Pure. The entry's canonical form, or null to drop it: not an object or
    // an id no file could have. The kind is kept as written, known or not.
    function normEntry(raw) {
        if (!isPlainObject(raw)) return null;
        if (!templates().validId(raw.id)) return null;
        return { kind: str(raw.kind), id: raw.id, count: whole(raw.count, 1, 1) };
    }

    function normalize(raw) {
        raw = raw || {};
        var entries = [];
        if (isArray(raw.entries)) {
            for (var i = 0; i < raw.entries.length; i++) {
                var e = normEntry(raw.entries[i]);
                if (e) entries.push(e);
            }
        }
        return {
            id:      raw.id === undefined ? null : raw.id,
            label:   trim(raw.label),
            entries: entries,
            loop:    raw.loop === true,
            passes:  whole(raw.passes, 0, 0),
            early:   raw.early === true,
            retrain: isValue(RETRAIN, raw.retrain) ? raw.retrain : RETRAIN.Settings,
            noMap:   isValue(NO_MAP, raw.noMap) ? raw.noMap : NO_MAP.Pause,
            saved:   typeof raw.saved === 'number' ? raw.saved : null
        };
    }

    function broken(id, path, error) {
        return { id: id, path: path, error: error };
    }

    // Pure. The id always comes from the file name.
    function fromFile(id, path, text) {
        var data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            return broken(id, path, 'not valid JSON: ' + e);
        }
        if (!isPlainObject(data)) return broken(id, path, 'not a queue: top level is not an object');
        var rec = normalize({
            label:   data.label,
            entries: data.entries,
            loop:    data.loop,
            passes:  data.passes,
            early:   data.early,
            retrain: data.retrain,
            noMap:   data.noMap,
            saved:   data.saved
        });
        rec.id = id;
        return rec;
    }

    // Pure.
    function toFile(rec) {
        var entries = [];
        for (var i = 0; i < rec.entries.length; i++) {
            var e = rec.entries[i];
            entries.push({ kind: e.kind, id: e.id, count: e.count });
        }
        return JSON.stringify({
            version: FORMAT_VERSION,
            label:   rec.label,
            entries: entries,
            loop:    rec.loop,
            passes:  rec.passes,
            early:   rec.early,
            retrain: rec.retrain,
            noMap:   rec.noMap,
            saved:   rec.saved
        }, null, 2);
    }

    // Queue files in the folder; null without a writable steward folder.
    function entries() {
        return templates().entriesIn(SUBDIR);
    }

    function readEntry(e) {
        var r = S.kernel.files.readText(e.path);
        if (!r.ok) return broken(e.id, e.path, r.message);
        return fromFile(e.id, e.path, r.text);
    }

    function compareIds(a, b) {
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    }

    // Records sorted by label (case-insensitive), then broken entries by id.
    function list() {
        var es = entries();
        if (es === null) {
            S.kernel.warn('adventures', 'no writable steward folder: queue list is empty');
            return [];
        }
        var recs = [];
        var bad = [];
        for (var i = 0; i < es.length; i++) {
            var r = readEntry(es[i]);
            if (r.error !== undefined) bad.push(r);
            else recs.push(r);
        }
        recs.sort(function (a, b) {
            var x = a.label.toLowerCase(), y = b.label.toLowerCase();
            if (x !== y) return x < y ? -1 : 1;
            return compareIds(a, b);
        });
        bad.sort(compareIds);
        return recs.concat(bad);
    }

    function ids() {
        var es = entries() || [];
        var out = [];
        for (var i = 0; i < es.length; i++) out.push(es[i].id);
        return out;
    }

    // The record, or null when the id is invalid, missing or broken.
    function get(id) {
        var path = pathOf(id);
        if (!path) return null;
        var info = S.kernel.files.info(path);
        if (!info || !info.exists) return null;
        var r = readEntry({ id: id, path: path });
        return r.error !== undefined ? null : r;
    }

    // The template or scenario record an entry names, or null when its kind
    // is unknown or the record is missing or broken.
    function entryRecord(entry) {
        if (!entry) return null;
        if (entry.kind === KIND.Template) return templates().get(entry.id);
        if (entry.kind === KIND.Scenario) return scenarios().get(entry.id);
        return null;
    }

    // Problems { field, message } and, for an entry, its 0-based `index`, in
    // the editor's order. queueRecs (as from list()) enables the label check;
    // without it a label shared by two files on disk does not block a start,
    // as two templates sharing one still run.
    function validate(rec, queueRecs) {
        var out = [];
        if (!rec.label) {
            out.push({ field: 'label', message: 'Label is empty' });
        } else if (queueRecs && templates().labelTaken(rec.label, rec.id, queueRecs)) {
            out.push({ field: 'label', message: 'The label ' + rec.label + ' is already used by another queue' });
        }
        var list = isArray(rec.entries) ? rec.entries : [];
        if (list.length === 0) out.push({ field: 'entries', message: 'This queue has no entries' });
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            var where = 'Entry ' + (i + 1) + ': ';
            if (!isKnownKind(e.kind)) {
                out.push({ field: 'entries', index: i, message: where + 'unknown kind ' + (e.kind || '(none)') +
                    '. The entry is kept in the file; remove it or update Steward.' });
            } else if (!entryRecord(e)) {
                out.push({ field: 'entries', index: i, message: where + e.kind + ' ' + e.id +
                    ' is missing or unreadable. Remove it or restore the file.' });
            }
        }
        return out;
    }

    // Pure. The template store's id rule, so both folders name files alike.
    function newId(now, existing) {
        return templates().newId(now, existing);
    }

    // A new save is refused for any problem, a taken label included: queues
    // already sharing one on disk still list and start.
    function save(rec, now) {
        if (typeof now !== 'number') now = new Date().getTime();
        var r = normalize(rec);
        if (dirPath() === null) {
            return { ok: false, problems: [{ field: 'file', message: 'No writable steward folder' }] };
        }
        var problems = validate(r, list());
        if (problems.length) return { ok: false, problems: problems };
        var id = templates().validId(r.id) ? r.id : newId(now, ids());
        r.id = id;
        r.saved = now;
        var path = pathOf(id);
        if (!path) {
            return { ok: false, problems: [{ field: 'file', message: 'No writable steward folder' }] };
        }
        var w = S.kernel.files.writeText(path, toFile(r));
        if (!w.ok) return { ok: false, problems: [{ field: 'file', message: w.message }] };
        return { ok: true, id: id, path: w.path };
    }

    function remove(id) {
        var path = pathOf(id);
        if (!path) return false;
        return S.kernel.files.remove(path);
    }

    // ---- Running copy -------------------------------------------------------

    // The copy a run request carries. templateId is the id of a template
    // entry and '' otherwise, the same as a single scenario request, so the
    // run code copies fields without testing the kind. A missing record keeps
    // its id as label; validate blocks starting such a queue anyway. width is
    // the run menu's wave-row count, the longest waves list of the template
    // entries, so one menu layout fits every entry.
    function toRun(rec) {
        var out = [];
        var width = 1;
        for (var i = 0; i < rec.entries.length; i++) {
            var e = rec.entries[i];
            var r = entryRecord(e);
            var isTemplate = e.kind === KIND.Template;
            if (isTemplate && r && isArray(r.waves) && r.waves.length > width) width = r.waves.length;
            out.push({
                kind:       e.kind,
                id:         e.id,
                templateId: isTemplate ? e.id : '',
                label:      r ? r.label : e.id,
                adventure:  r ? r.adventure : '',
                count:      e.count
            });
        }
        return {
            id:      rec.id,
            label:   rec.label,
            entries: out,
            index:   0,
            loop:    rec.loop,
            passes:  rec.passes,
            pass:    0,
            early:   rec.early,
            retrain: rec.retrain,
            noMap:   rec.noMap,
            width:   width,
            skip:    0
        };
    }

    S.modules.adventures.queues = {
        SUBDIR:         SUBDIR,
        FORMAT_VERSION: FORMAT_VERSION,
        KIND:           KIND,
        RETRAIN:        RETRAIN,
        NO_MAP:         NO_MAP,
        isKnownKind:    isKnownKind,
        dir:            dir,
        dirPath:        dirPath,
        pathOf:         pathOf,
        normalize:      normalize,
        fromFile:       fromFile,
        toFile:         toFile,
        list:           list,
        ids:            ids,
        get:            get,
        entryRecord:    entryRecord,
        validate:       validate,
        newId:          newId,
        save:           save,
        remove:         remove,
        toRun:          toRun
    };

}(Steward));
