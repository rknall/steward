/*
 * Template step registry for the adventures module.
 *
 * A template's `waves` list holds, in run order, battle-file paths (strings)
 * mixed with step entries: plain objects that run between two waves, e.g.
 *   [ "C:/.../wave01.txt",
 *     { "step": "unload", "generals": ["12.345"] },
 *     "C:/.../wave02.txt",
 *     { "step": "pause", "message": "Check the boss camp" },
 *     { "step": "home",  "generals": ["12.346"] },
 *     { "step": "wait",  "minutes": 5 },
 *     "C:/.../wave03.txt" ]
 * `generals` holds loadout keys (uids), never names, because a name is not
 * unique and may change. The run copies the list into run.paths, and
 * run.waveIndex indexes the mixed list. Steps never sit inside a battle
 * file: the battle parser refuses unknown keys there.
 *
 * DEFS below is the one table of step kinds. S.TemplateStep is filled from
 * it, and the template parser, the run-state loader, the start check, the
 * executor, the template window and the run menu read each kind's labels,
 * help, parse/validate and runtime hooks from it, so no second list of kinds
 * exists to drift from it. This file holds no step order of its own: the one
 * driver of the step contract is loader.runStep, and this file only
 * describes the kinds.
 *
 * The contract of one kind (defOf() returns it whole):
 *   kind, label, addLabel, help   file value, row/menu label, Add-step label,
 *                                 one-line help
 *   inventory                     the executor reads the army inventory (and
 *                                 holds on a short list) before the driver
 *   longWait                      waits minutes, so the 10 s tick is enough
 *                                 (not `long`: a reserved word in AIR's ES3
 *                                 grammar, which a dot-property cannot use)
 *   parse(raw)                    -> { ok, item, problems }; ok false when raw
 *                                 is not an entry of this kind
 *   validate(item, ctx)           start-check messages of one row in its
 *                                 sequence: [{ code, message, key }]
 *   skip(r, item, inv)            optional; a text skips the step. No kind
 *                                 defines it yet; an Optional wave flag would
 *                                 read the same hook
 *   done(r, item, inv)            true, false or null (unreadable, wait)
 *   blocked(r, item, inv)         null or a blocked result of the driver
 *   orders(r, item, inv)          [{ key, mark?, def }]
 *   fail                          { reason, what, text? } for a failed round
 *   next(r, item)                 moves the run on
 *   input                         the item field the Add-step card fills
 *   sendsHome                     the row sends its generals home, so no
 *                                 later row may use them
 *   text(item, names)             { name, small } of the template window row
 *   subject(item, names)          what the row acts on: names or message
 *   title(item)                   optional short name; label otherwise
 *   detail(r, item, idx, now)     optional run menu detail of the current row
 * Every per-kind rule is a column of its row; the functions below dispatch
 * through the row and name no kind.
 * There is no `where` and no `option`: a step entry only runs under a wave
 * step at its index, and wave steps always run on the run's island, so its
 * zone follows from the wave step; and a step is on by being in the
 * template, so nothing switches it off.
 *
 * Marks (persisted on run.marks, one map per run): PAUSE_PREFIX + index for
 * a Pause row (seen once it paused, so Resume goes on), WAIT_PREFIX + index
 * for a timed wait (sentAt is its start), and loader.HOME_PREFIX + key per
 * general of a Send home row. Unload and Send home build their hooks with
 * loader.orderEach on first use and cache them, because the loader is read
 * at call time.
 *
 * Waves keep their numbers 1..M counting battle files only; the list helpers
 * below give numbers and labels for a mixed list, and for a list of strings
 * only every text equals the one of a build without steps.
 *
 * Bundle slot: module file, in name order after state.js and before
 * templates.js; top level fills S.TemplateStep and assigns
 * S.modules.adventures.steps; state, loader, executor and every core are
 * read at call time.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    var CATEGORY = 'adventures';

    var PAUSE_PREFIX = 'pause:';
    var WAIT_PREFIX  = 'wait:';

    var MIN_MINUTES = 1;
    var MAX_MINUTES = 120;
    var MAX_MESSAGE = 200;

    function isArray(v) {
        return Object.prototype.toString.call(v) === '[object Array]';
    }

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';
    }

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function st() {
        return S.modules.adventures.state;
    }

    function ld() {
        return S.modules.adventures.loader;
    }

    function advance(r, why) {
        S.modules.adventures.executor.advance(r, why, why);
    }

    function nameOf(names, key) {
        return (names && has(names, key) && names[key]) ? names[key] : key;
    }

    function namesText(keys, names) {
        var out = [];
        for (var i = 0; i < keys.length; i++) out.push(nameOf(names, keys[i]));
        return out.join(', ');
    }

    // ---- Parsing ----------------------------------------------------------

    // Unique non-empty strings in the given order; anything else is dropped.
    function keyList(v) {
        var out = [];
        var seen = {};
        if (!isArray(v)) return out;
        for (var i = 0; i < v.length; i++) {
            if (typeof v[i] !== 'string' || v[i] === '' || has(seen, v[i])) continue;
            seen[v[i]] = true;
            out.push(v[i]);
        }
        return out;
    }

    function isKind(raw, kind) {
        return isPlainObject(raw) && raw.step === kind;
    }

    function parseGenerals(kind) {
        return function (raw) {
            if (!isKind(raw, kind)) return { ok: false, item: null, problems: [] };
            var item = { step: kind, generals: keyList(raw.generals) };
            return { ok: true, item: item, problems: item.generals.length ? [] : ['choose at least one general'] };
        };
    }

    function parsePause(raw) {
        if (!isKind(raw, 'pause')) return { ok: false, item: null, problems: [] };
        var msg = typeof raw.message === 'string' ? raw.message.replace(/^\s+|\s+$/g, '') : '';
        if (msg.length > MAX_MESSAGE) msg = msg.substring(0, MAX_MESSAGE);
        return { ok: true, item: { step: 'pause', message: msg }, problems: [] };
    }

    function isWholeMinutes(v) {
        return typeof v === 'number' && isFinite(v) && Math.floor(v) === v &&
            v >= MIN_MINUTES && v <= MAX_MINUTES;
    }

    function parseWait(raw) {
        if (!isKind(raw, 'wait')) return { ok: false, item: null, problems: [] };
        var m = typeof raw.minutes === 'number' && isFinite(raw.minutes) ? raw.minutes : null;
        var problems = isWholeMinutes(m) ? [] :
            ['minutes must be a whole number from ' + MIN_MINUTES + ' to ' + MAX_MINUTES];
        return { ok: true, item: { step: 'wait', minutes: m }, problems: problems };
    }

    // ---- Start check ------------------------------------------------------

    // Unload and Send home: every general must come with the loadout, and none
    // may have been sent home by an earlier row, because he is gone from the
    // island by then.
    function validateGenerals(item, ctx) {
        var out = [];
        var keys = item.generals || [];
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var name = nameOf(ctx.names, key);
            if (ctx.loadoutKeys && !has(ctx.loadoutKeys, key)) {
                out.push({ code: S.BattleProblem.NotInLoadout, key: key,
                    message: name + ' (' + key + ') is not in the loadout' });
            }
            if (ctx.sentBefore && has(ctx.sentBefore, key)) {
                out.push({ code: S.BattleProblem.BadLine, key: key,
                    message: name + ' was sent home at row ' + (ctx.sentBefore[key] + 1) });
            }
        }
        return out;
    }

    // Send home also refuses a later wave that still uses one of its
    // generals: he is on his way home when that wave runs.
    function validateHome(item, ctx) {
        var out = validateGenerals(item, ctx);
        var list = ctx.list || [];
        var keys = item.generals || [];
        for (var j = ctx.index + 1; j < list.length; j++) {
            if (typeof list[j] !== 'string') continue;
            var used = ctx.waveKeys ? ctx.waveKeys(j) : null;
            if (!used) continue;
            for (var i = 0; i < keys.length; i++) {
                if (!has(used, keys[i])) continue;
                var file = ctx.fileName ? ctx.fileName(list[j]) : list[j];
                out.push({ code: S.BattleProblem.BadLine, key: keys[i],
                    message: 'wave ' + waveNumber(list, j) + ' (' + file + ') uses ' +
                        nameOf(ctx.names, keys[i]) + ' after this step' });
            }
        }
        return out;
    }

    function validateNone() {
        return [];
    }

    // ---- Runtime hooks ----------------------------------------------------

    function markName(prefix, r) {
        return prefix + r.waveIndex;
    }

    function generalsOf(r, item) {
        return item && item.generals ? item.generals : [];
    }

    // Unload and Send home act on their generals, by name where known.
    function generalsSubject(item, names) {
        return namesText(item.generals || [], names);
    }

    function unloadText(item, names) {
        return { name: 'Unload ' + generalsSubject(item, names), small: 'Troops back to the pool; he stays on his grid' };
    }

    function homeText(item, names) {
        return { name: 'Send home ' + generalsSubject(item, names), small: 'Travels home now; later rows cannot use him' };
    }

    // Unload: troops go back to the pool, the general keeps his grid. Done
    // once the read of his army is good and it holds nothing.
    function unloadOpts() {
        return {
            keys:       generalsOf,
            isDone:     function (g) { return !!g.armyOk && S.core.army.total(g.army) === 0; },
            absentDone: false,
            mark:       '',
            sendBusy:   false,
            def:        function (key) { return S.core.army.unload(key); },
            fail:       { reason: S.RunPause.UnloadFailed, what: 'unload' },
            next:       function (r) { advance(r, 'generals unloaded'); }
        };
    }

    // Send home: the order is marked per general, so it never goes out twice;
    // a sent general counts as done once he is seen leaving or is gone.
    function homeOpts() {
        return {
            keys:       generalsOf,
            isDone:     function (g, key, rec) { return !!(rec && rec.sentOnce) && ld().leaving(g, key); },
            absentDone: false,
            mark:       ld().HOME_PREFIX,
            sendBusy:   false,
            need:       function () {
                return typeof S.core.zone.homeId() === 'number' ? null : { read: 'home zone id' };
            },
            def:        function (key) { return S.core.specialists.orders.sendToZone(key, S.core.zone.homeId()); },
            fail:       { reason: S.RunPause.DepartFailed, what: 'send home' },
            next:       function (r) { advance(r, 'generals sent home'); }
        };
    }

    function pauseText(r, item) {
        var msg = item && item.message ? item.message : 'planned pause';
        return 'Pause step: ' + msg + '; Resume run goes on with ' + nextText(r.paths, r.waveIndex);
    }

    // Pause: one pause per row. The driver marks the row seen in the same
    // save as the pause, and Resume keeps seen marks, so a resumed Pause is
    // done and the run goes on.
    function pauseDone(r) {
        var rec = ld().marked(r, markName(PAUSE_PREFIX, r));
        return !!(rec && rec.seen);
    }

    function pauseBlocked(r, item) {
        return { pause: S.RunPause.Planned, text: pauseText(r, item), mark: markName(PAUSE_PREFIX, r) };
    }

    function pauseNext(r) {
        advance(r, 'pause step done');
    }

    function pauseRowText(item) {
        return { name: 'Pause · plays the pause sound',
            small: (item.message ? '"' + item.message + '" · ' : '') + 'Resume run goes on' };
    }

    function pauseSubject(item) {
        return item.message || '';
    }

    // The run menu says a planned pause of this row played its sound.
    function pauseDetail(r) {
        return r.status === S.RunStatus.Paused && r.pause && r.pause.reason === S.RunPause.Planned ?
            'sound played' : '';
    }

    function minutesText(item) {
        return 'pause ' + item.minutes + ' min';
    }

    // A timed wait names its minutes; null falls back to the row label.
    function waitTitle(item) {
        return typeof item.minutes === 'number' ? 'Pause ' + item.minutes + ' min' : null;
    }

    function waitText(item) {
        return { name: titleOf(item), small: 'Waits, then goes on by itself' };
    }

    function waitSubject() {
        return '';
    }

    // Minutes left of the current wait, counted from its mark's sentAt and
    // never below 1, so the menu does not show 0 while the tick catches up.
    function waitDetail(r, item, idx, now) {
        if (typeof item.minutes !== 'number') return '';
        var rec = ld().marked(r, WAIT_PREFIX + idx);
        var left = item.minutes * 60000;
        if (rec && typeof rec.sentAt === 'number') left -= now - rec.sentAt;
        return Math.max(1, Math.ceil(left / 60000)) + ' min left';
    }

    // Wait: the mark's sentAt is the start of the wait. Resume clears an
    // unseen sentAt, so a resumed wait starts its minutes again.
    function waitDone(r, item) {
        var rec = ld().marked(r, markName(WAIT_PREFIX, r));
        if (!rec || typeof rec.sentAt !== 'number') return false;
        return st().now() - rec.sentAt >= item.minutes * 60000;
    }

    function waitBlocked(r, item) {
        return { hold: minutesText(item) + ' started', mark: markName(WAIT_PREFIX, r) };
    }

    function waitNext(r, item) {
        ld().markSeen(r, markName(WAIT_PREFIX, r));
        S.kernel.log(CATEGORY, st().label() + ': ' + minutesText(item) + ' over');
        advance(r, minutesText(item) + ' over');
    }

    // ---- The table --------------------------------------------------------

    // The step kinds in menu order. The kind values are unprefixed on
    // purpose: they are what a template file holds, so they stay readable
    // when someone edits or shares a file. build names the loader.orderEach
    // options of a per-general kind; its hooks are filled on first use.
    // input names the item field the Add-step card fills
    // (raw[row.input] = value); title and detail are optional.
    var DEFS = [
        {
            key: 'Unload', kind: 'unload', label: 'Unload', addLabel: 'Unload generals',
            help: 'Their troops go back to the pool; each general stays where he is',
            inventory: true, longWait: false, input: 'generals', sendsHome: false,
            parse: parseGenerals('unload'), validate: validateGenerals, build: unloadOpts,
            text: unloadText, subject: generalsSubject
        },
        {
            key: 'Home', kind: 'home', label: 'Send home', addLabel: 'Send generals home',
            help: 'They travel home now; later waves and end-of-map steps leave them out',
            inventory: true, longWait: false, input: 'generals', sendsHome: true,
            parse: parseGenerals('home'), validate: validateHome, build: homeOpts,
            text: homeText, subject: generalsSubject
        },
        {
            key: 'Pause', kind: 'pause', label: 'Pause', addLabel: 'Pause with a sound',
            help: 'The run pauses here and plays the pause sound; Resume run goes on',
            inventory: false, longWait: false, input: 'message', sendsHome: false,
            parse: parsePause, validate: validateNone, fail: null,
            done: pauseDone, blocked: pauseBlocked, next: pauseNext,
            text: pauseRowText, subject: pauseSubject, detail: pauseDetail
        },
        {
            key: 'Wait', kind: 'wait', label: 'Pause x min', addLabel: 'Pause x min',
            help: 'The run waits, then goes on by itself; no sound',
            inventory: false, longWait: true, input: 'minutes', sendsHome: false,
            parse: parseWait, validate: validateNone, fail: null,
            done: waitDone, blocked: waitBlocked, next: waitNext,
            text: waitText, subject: waitSubject, title: waitTitle, detail: waitDetail
        }
    ];

    // Built contracts of the per-general kinds, by kind.
    var built = {};

    function contract(row) {
        if (!row.build) return row;
        if (has(built, row.kind)) return built[row.kind];
        var c = ld().orderEach(row.build());
        // The built contract carries every column the row describes. build
        // is only the recipe, and the hooks orderEach returned win over the
        // row's late-binding wrappers, which would only call back into c.
        for (var k in row) {
            if (has(row, k) && k !== 'build' && !has(c, k)) c[k] = row[k];
        }
        built[row.kind] = c;
        return c;
    }

    // The per-general rows answer the runtime hooks through their built
    // contract, so every row carries the whole contract.
    (function () {
        function hook(row, name) {
            return function (r, item, inv) {
                var c = contract(row);
                return c[name] ? c[name](r, item, inv) : null;
            };
        }
        for (var i = 0; i < DEFS.length; i++) {
            S.TemplateStep[DEFS[i].key] = DEFS[i].kind;
            if (!DEFS[i].build) continue;
            DEFS[i].done = hook(DEFS[i], 'done');
            DEFS[i].blocked = hook(DEFS[i], 'blocked');
            DEFS[i].orders = hook(DEFS[i], 'orders');
            DEFS[i].next = hook(DEFS[i], 'next');
        }
    }());

    function rowOf(kind) {
        for (var i = 0; i < DEFS.length; i++) {
            if (DEFS[i].kind === kind) return DEFS[i];
        }
        return null;
    }

    // ---- Public API -------------------------------------------------------

    function kinds() {
        var out = [];
        for (var i = 0; i < DEFS.length; i++) {
            out.push({ kind: DEFS[i].kind, label: DEFS[i].label, addLabel: DEFS[i].addLabel, help: DEFS[i].help });
        }
        return out;
    }

    function byKind(kind) {
        return rowOf(kind);
    }

    // rowOf matches only the string kinds of DEFS, so it also refuses a
    // step value of any other type.
    function isItem(v) {
        return isPlainObject(v) && rowOf(v.step) !== null;
    }

    // The normalised entry, or null when raw is no entry of a known kind. An
    // entry with problems is kept, so the template window can show the fix.
    function normItem(raw) {
        if (!isItem(raw)) return null;
        var p = rowOf(raw.step).parse(raw);
        return p.ok ? p.item : null;
    }

    function itemProblems(item) {
        if (!isItem(item)) return ['unknown step'];
        var p = rowOf(item.step).parse(item);
        return p.ok ? p.problems : ['unknown step'];
    }

    function defOf(item) {
        if (!isItem(item)) return null;
        return contract(rowOf(item.step));
    }

    function itemAt(r) {
        if (!r || !isArray(r.paths) || typeof r.waveIndex !== 'number') return null;
        var v = r.paths[r.waveIndex];
        return isItem(v) ? v : null;
    }

    function defAt(r) {
        return defOf(itemAt(r));
    }

    // ---- List helpers -----------------------------------------------------

    function waveCount(list) {
        var n = 0;
        for (var i = 0; list && i < list.length; i++) if (typeof list[i] === 'string') n++;
        return n;
    }

    // Battle files at or before entry i.
    function waveNumber(list, i) {
        var n = 0;
        for (var j = 0; list && j <= i && j < list.length; j++) if (typeof list[j] === 'string') n++;
        return n;
    }

    function indexOfWave(list, n) {
        var c = 0;
        for (var i = 0; list && i < list.length; i++) {
            if (typeof list[i] !== 'string') continue;
            c++;
            if (c === n) return i;
        }
        return -1;
    }

    // Where a run that starts at wave k begins. Wave 1 starts at the top, so
    // steps before the first wave run as in a start from home. A later wave
    // starts at its own file: the steps before it belong to the part of the
    // map already played.
    function startIndex(list, k) {
        if (k <= 1) return 0;
        var i = indexOfWave(list, k);
        return i < 0 ? 0 : i;
    }

    // The short name of an entry: its row's title (a timed wait names its
    // minutes), else the row label.
    function titleOf(item) {
        var row = item ? rowOf(item.step) : null;
        if (!row) return String(item && item.step);
        var t = row.title ? row.title(item) : null;
        return t || row.label;
    }

    function rowLabel(list, i) {
        var v = list[i];
        if (typeof v === 'string') return 'wave ' + waveNumber(list, i);
        var n = waveNumber(list, i);
        return titleOf(v) + (n ? ' after wave ' + n : ' before wave 1');
    }

    // What comes after entry i, for a pause text.
    function nextText(list, i) {
        var j = i + 1;
        if (!list || j >= list.length) return 'the end of the map';
        if (typeof list[j] === 'string') return 'wave ' + waveNumber(list, j);
        return isItem(list[j]) ? titleOf(list[j]) : 'the end of the map';
    }

    // { key: name } of the general lines of parsed battle lines.
    function namesOf(lines) {
        var out = {};
        for (var i = 0; lines && i < lines.length; i++) {
            var line = lines[i];
            if (S.core.battles.isGeneralLine(line) && line.name) out[line.key] = line.name;
        }
        return out;
    }

    // { name, small } of a row in the template window.
    function itemText(item, names) {
        var row = rowOf(item.step);
        return row ? row.text(item, names) : { name: String(item.step), small: '' };
    }

    // What a row acts on: its generals by name (names may be missing, then
    // the keys), a pause message, or '' for a kind with no subject.
    function subject(item, names) {
        var row = item ? rowOf(item.step) : null;
        return row && row.subject ? row.subject(item, names) : '';
    }

    // { key: row index } of the generals that a sendsHome row before entry
    // at sends home; the earliest row wins. The start check calls it per row,
    // a quadratic walk that stays cheap on a template's short list.
    function sentBefore(list, at) {
        var out = {};
        for (var i = 0; list && i < at && i < list.length; i++) {
            if (!isItem(list[i])) continue;
            var row = rowOf(list[i].step);
            if (!row.sendsHome) continue;
            var p = row.parse(list[i]);
            if (!p.ok) continue;
            var keys = p.item.generals || [];
            for (var k = 0; k < keys.length; k++) {
                if (!has(out, keys[k])) out[keys[k]] = i;
            }
        }
        return out;
    }

    // Start-check problems of the step entries in their sequence. Every entry
    // is fatal, so the start check files it as a problem and not a warning.
    // ctx: { loadoutKeys, names, waveKeys(i), fileName(path) }.
    function checkSequence(list, ctx) {
        var out = [];
        ctx = ctx || {};
        function push(index, code, message, key) {
            out.push({ index: index, code: code, message: message, fatal: true, key: key || null });
        }
        for (var i = 0; list && i < list.length; i++) {
            var v = list[i];
            if (typeof v === 'string') continue;
            if (!isItem(v)) {
                push(i, S.BattleProblem.BadLine, 'unknown step', null);
                continue;
            }
            var row = rowOf(v.step);
            var p = row.parse(v);
            var item = p.ok ? p.item : v;
            var k;
            for (k = 0; k < p.problems.length; k++) push(i, S.BattleProblem.BadLine, p.problems[k], null);
            var ms = row.validate(item, {
                index:       i,
                list:        list,
                loadoutKeys: ctx.loadoutKeys || null,
                names:       ctx.names || {},
                waveKeys:    ctx.waveKeys,
                fileName:    ctx.fileName,
                sentBefore:  sentBefore(list, i)
            });
            for (k = 0; k < ms.length; k++) push(i, ms[k].code, ms[k].message, ms[k].key);
        }
        return out;
    }

    // Detail text of row idx in the run menu, from the row's detail column;
    // only the current row has one.
    function detail(r, idx, at) {
        if (!r || !isArray(r.paths) || idx !== r.waveIndex) return '';
        var item = itemAt(r);
        if (!item) return '';
        var row = rowOf(item.step);
        return row && row.detail ? row.detail(r, item, idx, typeof at === 'number' ? at : st().now()) : '';
    }

    S.modules.adventures.steps = {
        PAUSE_PREFIX:  PAUSE_PREFIX,
        WAIT_PREFIX:   WAIT_PREFIX,
        MIN_MINUTES:   MIN_MINUTES,
        MAX_MINUTES:   MAX_MINUTES,
        kinds:         kinds,
        byKind:        byKind,
        isItem:        isItem,
        normItem:      normItem,
        itemProblems:  itemProblems,
        defOf:         defOf,
        defAt:         defAt,
        itemAt:        itemAt,
        waveCount:     waveCount,
        waveNumber:    waveNumber,
        indexOfWave:   indexOfWave,
        startIndex:    startIndex,
        titleOf:       titleOf,
        rowLabel:      rowLabel,
        nextText:      nextText,
        namesOf:       namesOf,
        itemText:      itemText,
        subject:       subject,
        sentBefore:    sentBefore,
        checkSequence: checkSequence,
        detail:        detail
    };

}(Steward));
