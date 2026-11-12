/*
 * User commands of an adventure run: start, pause, resume, stop and end
 * repetition, chosen from the ~Steward~ > Adventures menu.
 *
 * Start asks for the run count, prefilled with the maps available (star-menu
 * maps plus one when an own adventure of that map is already open). What
 * happens next depends on where the user is:
 * - the template's map is open and viewed: a second prompt asks for the
 *   start wave (default 1), the executor checks the loadout and wave files
 *   against the island, and the run starts at Gate of that wave. There is
 *   no troop snapshot, so the first return home retrains nothing.
 * - at home: the files and the loadout keys are checked without the
 *   fighters, because the generals may still be away, and the run starts by
 *   mustering them. The map is started by the run when it is not open yet.
 * - anywhere else: nothing is stored; the user goes home or views the
 *   island and chooses the template again.
 * A fatal check problem stores nothing. End repetition lets the series stop
 * after the current run.
 *
 * Start of a scenario (startScenario) needs no generals and no battle
 * files: it starts from home only, because the first step produces the
 * scenario's items there. Every item must be a produceable buff the game
 * knows; an unreadable definition list asks the user to try again, since
 * that is a moment after load, not a broken file. When the map is already
 * open a prompt asks for the start trip (default 1), so a series stopped
 * mid-map can carry on; otherwise the run starts at the first trip. Quest
 * objects are clicked by the collect module, so a scenario started while
 * collect does not pick up on adventures warns but still starts.
 *
 * Menu handlers only change state. They never enqueue: an entry added from
 * a menu callback carries no module tag, so cancelByModule could not remove
 * it. The scheduler's plan() enqueues every step. Pause, Stop and replacing
 * a run cancel the module's queued entries so nothing acts after the user
 * said stop. A wake enqueues nothing, so Start and Resume may ask for one:
 * the next plan() then comes right away instead of on the tick.
 *
 * The request and the run live on S.modules.adventures.runState and are
 * written to the run state file through S.modules.adventures.state, so both
 * survive a script reload and a client restart. They stay out of the
 * settings and the template file: they describe what to do now, not how a
 * template is configured. There is one request and one run at a time;
 * starting another asks before replacing them.
 *
 * Start of a queue (startQueue) checks every entry first, so a queue with a
 * missing or unknown entry stores nothing. It begins with the first entry,
 * or, when the queue skips entries without a map, the first one that has a
 * map, and asks that entry's own prompts (start wave or start trip when its
 * map is open) but no count: each entry carries its count. Later entries
 * begin at home through entryRun, which the hand-over calls too.
 *
 * Skip entry, only in a queue, paused and at home: before the entry's map
 * is out it drops the entry's remaining runs uncounted and begins the next
 * entry at once, keeping the troops on their way home. At Next, where an
 * entry that cannot begin paused the hand-over, it steps over that entry
 * and the hand-over tries the one after it.
 *
 * Request shape: { templateId, label, adventure, count, ended, requested,
 * finished, closedAt, queue }: finished counts the runs done in this series
 * and closedAt is when the last map was closed. queue is null for a single
 * series, else the running copy of the queue; the other fields then describe
 * its current entry.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};
    if (!S.modules.adventures.runState) S.modules.adventures.runState = { request: null, run: null };

    var MODULE_ID = 'adventures';

    // The run state store, read at call time: it loads after this file and a
    // script reload may replace it.
    function store() {
        return S.modules.adventures.state;
    }

    // The template step registry, read at call time: it loads after this file.
    function steps() {
        return S.modules.adventures.steps;
    }

    // The queue store and the loader, read at call time for the same reasons.
    function queues() {
        return S.modules.adventures.queues;
    }

    function loader() {
        return S.modules.adventures.loader;
    }

    function current() {
        return store().current().request;
    }

    // A queue request names the queue and the entry: 'Requested: Event loop
    // 2/3: Chain ×1'.
    function statusText(req) {
        if (!req) return 'No run requested';
        var q = req.queue;
        var head = q ? q.label + ' ' + (q.index + 1) + '/' + q.entries.length + ': ' : '';
        return 'Requested: ' + head + req.label + ' ×' + req.count + (req.ended ? ', repetition ended' : '');
    }

    function trim(v) {
        return String(v).replace(/^\s+|\s+$/g, '');
    }

    // Turns a prompt answer into a run count. Cancel stores nothing, unlike
    // autoTSO, which treats a cancelled prompt as one run.
    function countFrom(answer, maps) {
        if (answer === null || answer === undefined) return { ok: false, reason: 'cancel' };
        var n = parseInt(trim(answer), 10);
        if (isNaN(n) || n < 1) return { ok: false, reason: 'invalid' };
        return { ok: true, count: Math.min(n, maps) };
    }

    // Turns a prompt answer into a 1-based start wave. Unlike the count it is
    // never clamped: starting at a wave the user did not name could skip a
    // wave or send one twice.
    function waveFrom(answer, waves) {
        if (answer === null || answer === undefined) return { ok: false, reason: 'cancel' };
        var s = trim(answer);
        if (!/^[0-9]+$/.test(s)) return { ok: false, reason: 'invalid' };
        var n = parseInt(s, 10);
        if (n < 1 || n > waves) return { ok: false, reason: 'invalid' };
        return { ok: true, wave: n };
    }

    // Maps of `adventure` the player can run: star-menu stock plus one for an
    // own adventure already open. `pass` caches both reads, so a menu pass that
    // asks for every template reads the star menu and the open adventures once.
    // Null while the star menu cannot be read: a null read is cached too, so one
    // pass does not ask the host again for each template.
    function available(adventure, pass) {
        pass = pass || {};
        if (pass.maps === undefined) pass.maps = S.core.buffs.mapCounts();
        if (!pass.open) pass.open = S.core.adventures.ownOpen();
        if (pass.maps === null) return null;
        return (pass.maps[adventure] || 0) + (pass.open.indexOf(adventure) !== -1 ? 1 : 0);
    }

    // prompt/confirm are host globals; resolved at call time because they are
    // not guaranteed to exist when this file loads.
    function ask(text, def) {
        if (typeof prompt === 'function') return prompt(text, def);
        S.kernel.warn('adventures', 'prompt() is not available; nothing asked');
        return null;
    }

    function agree(text) {
        return typeof confirm === 'function' && confirm(text) === true;
    }

    function notify(text) {
        if (S.kernel.ui && S.kernel.ui.notify) S.kernel.ui.notify(text);
    }

    // Rewrites the menu status line in place; no menu rebuild.
    function refresh() {
        if (S.kernel.ui && S.kernel.ui.status && S.kernel.ui.status.refresh) S.kernel.ui.status.refresh();
    }

    // The first pass of a started or resumed run, sooner than the tick.
    function wakeRun() {
        S.kernel.scheduler.wake(MODULE_ID, 0);
    }

    // Drops this module's queued entries: action attempts and the attack pacer.
    function cancelQueued() {
        if (S.kernel.queue && S.kernel.queue.cancelByModule) S.kernel.queue.cancelByModule(MODULE_ID);
    }

    // Problems may be battle file problem records or plain strings.
    function messageOf(p) {
        if (p && typeof p === 'object') return String(p.message);
        return String(p);
    }

    function listOf(v) {
        return v && typeof v.length === 'number' ? v : [];
    }

    // Text of the replace question: the request, plus where the run stands.
    function replaceQuestion(rs) {
        var r = rs.run;
        var q = rs.request;
        var what = q ? '"' + q.label + '" ×' + q.count : '"' + r.label + '"';
        if (r) what += ' (' + store().label() + ', ' + store().nameOf(S.RunStatus, r.status) + ')';
        return 'Replace the requested run ' + what + '?';
    }

    // queue: the running copy of a queue, or none for a single series.
    function makeRequest(rec, count, queue) {
        return {
            templateId: rec.id,
            label:      rec.label,
            adventure:  rec.adventure,
            count:      count,
            ended:      false,
            requested:  store().now(),
            finished:   0,
            closedAt:   null,
            queue:      queue || null
        };
    }

    function checkFailed(rec, problems) {
        var first = [];
        for (var i = 0; i < problems.length; i++) {
            S.kernel.warn('adventures', 'start check "' + rec.label + '" failed:', messageOf(problems[i]));
            if (i < 3) first.push(messageOf(problems[i]));
        }
        notify('"' + rec.label + '" cannot start: ' + problems.length + ' problem(s). ' + first.join('; '));
        return false;
    }

    // Runs the executor's start check and logs its warnings, without telling
    // the user: the hand-over calls it on every pass while it waits, so the
    // notice belongs to the caller. { ok: true, chk }, or { ok: false,
    // message } when the executor is not loaded, with retry when the
    // specialist list lost entries, whose generals would read as problems of
    // the template; a moment later it reads again.
    function templateCheck(rec, opts) {
        var executor = S.modules.adventures.executor;
        if (!executor || !executor.check) return { ok: false, message: 'the wave executor is not loaded' };
        var chk = executor.check(rec, opts) || {};
        if (chk.listOk === false) return { ok: false, retry: true, message: 'specialist list' };
        var warnings = listOf(chk.warnings);
        for (var i = 0; i < warnings.length; i++) {
            S.kernel.warn('adventures', 'start check "' + rec.label + '":', messageOf(warnings[i]));
        }
        chk.warnings = warnings;
        return { ok: true, chk: chk };
    }

    // templateCheck for a start the user chose: null after telling him why.
    function startCheck(rec, opts) {
        var c = templateCheck(rec, opts);
        if (c.ok) return c.chk;
        if (c.retry) notify('The specialist list cannot be read right now; try again in a moment.');
        else notify('The wave executor is not loaded; nothing started.');
        return null;
    }

    // A new run of the template, checked as chk. Without a step the store
    // starts the run at Gate of the given wave.
    function runFromTemplate(rec, chk, zoneId, waveIndex, step) {
        return store().newRun({
            id:          store().now(),
            templateId:  rec.id,
            label:       rec.label,
            adventure:   rec.adventure,
            zoneId:      zoneId,
            paths:       rec.waves,
            loadoutPath: rec.loadout,
            loadoutKeys: chk.loadoutKeys,
            loadoutNames: chk.loadoutNames,
            waveIndex:   waveIndex,
            step:        step,
            speedBuff:   S.modules.adventures.templates.speedBuffChoice(rec),
            startBuffs:  S.modules.adventures.templates.normStartBuffs(rec.startBuffs),
            // A template without the field sends everyone to the star.
            starAll:     rec.starAll !== false
        });
    }

    // The template's map is open and viewed: ask the start wave, check the
    // files against the island, then store a run at Gate of that wave.
    // The user counts waves, the battle files only; the run counts list
    // entries, template steps included. Wave 1 starts at the first entry, so
    // steps before it run as in a start from home. Wave k > 1 starts at its
    // own file: the steps before it belong to the part of the map already
    // played, and a Send home there would wait for a general an earlier
    // session already sent home.
    function startWaves(rec, req, zoneId) {
        var count = req.count;
        var waves = steps().waveCount(rec.waves || []);
        var answer = ask('Start at which wave of "' + rec.label + '"? 1..' + waves, '1');
        var w = waveFrom(answer, waves);
        if (!w.ok) {
            if (w.reason === 'invalid') notify('Not a wave number: ' + answer);
            return false;
        }

        var chk = startCheck(rec);
        if (!chk) return false;
        var warnings = chk.warnings;
        if (!chk.ok) return checkFailed(rec, listOf(chk.problems));

        var run = runFromTemplate(rec, chk, zoneId, steps().startIndex(rec.waves || [], w.wave));
        store().begin(req, run);
        wakeRun();
        S.kernel.log('adventures', 'run started:', rec.label, 'x' + count, 'at wave', w.wave, 'of', waves,
            'zone', zoneId, '(' + warnings.length + ' warning(s))');
        notify('Run started at wave ' + w.wave + ' of ' + waves + ': ' + rec.label +
            '. It acts while you view the map.' +
            (warnings.length ? ' ' + warnings.length + ' warning(s) in the log.' : ''));
        return true;
    }

    // At home: check the files and loadout keys only (the generals may be
    // away), then store a run at Muster. zoneId is the open map's zone, or
    // null until the run starts the map.
    function startHome(rec, req, zoneId) {
        var count = req.count;
        var chk = startCheck(rec, homeCheck());
        if (!chk) return false;
        var warnings = chk.warnings;
        if (!chk.ok) return checkFailed(rec, listOf(chk.problems));

        var run = runFromTemplate(rec, chk, typeof zoneId === 'number' ? zoneId : null, 0, S.RunStep.Muster);
        store().begin(req, run);
        wakeRun();
        S.kernel.log('adventures', 'run started from home:', rec.label, 'x' + count, zoneText(zoneId),
            '(' + warnings.length + ' warning(s))');
        notify('Run started from home: ' + rec.label + ' ×' + count + '.' +
            (warnings.length ? ' ' + warnings.length + ' warning(s) in the log.' : ''));
        return true;
    }

    // The prompts every start shares: the record is readable, a map is in the
    // star menu, the user agrees to replace a current run and names a count.
    // kind names the record in the notice ('Template', 'Scenario'). A given
    // count (a queue entry carries its own) asks no count. Returns
    // { rec, count, advLabel }, or null when the start ends here.
    function startPrompts(rec, id, kind, count) {
        if (!rec) {
            notify(kind + ' ' + id + ' cannot be read.');
            return null;
        }
        var maps = available(rec.adventure);
        if (maps === null) {
            notify('The star menu cannot be read right now. Try again in a moment.');
            return null;
        }
        var advLabel = S.core.adventures.label(rec.adventure) || rec.adventure;
        if (maps < 1) {
            notify('No ' + advLabel + ' map in the star menu.');
            return null;
        }
        var rs = store().current();
        if (store().settled(rs)) {
            // The last run is over (home, or done): nothing to ask about.
            S.kernel.log('adventures', 'finished run replaced without asking:', rs.run.label);
            cancelQueued();
            store().dropRound();
        } else if (rs.request || rs.run) {
            if (!agree(replaceQuestion(rs))) return null;
            // The old run must not act while the prompts below are answered. A
            // queued attack leaves its round half sent; later exits keep the
            // run, so the round goes with the queue.
            cancelQueued();
            store().dropRound();
        }
        if (typeof count === 'number') return { rec: rec, count: count, advLabel: advLabel };
        var answer = ask('How many consecutive runs of "' + rec.label + '"? ' + maps + ' available.', String(maps));
        var r = countFrom(answer, maps);
        if (!r.ok) {
            if (r.reason === 'invalid') notify('Not a run count: ' + answer);
            return null;
        }
        return { rec: rec, count: r.count, advLabel: advLabel };
    }

    // The check of a start from home, without the camps and the fighters:
    // the generals may still be away.
    function homeCheck() {
        return { camps: false, fighters: false };
    }

    // Where the user stands decides how a template run starts. what names
    // the thing to choose again ('the template', 'the queue').
    function startTemplate(rec, req, advLabel, what) {
        var zoneId = S.core.adventures.zoneIdOf(rec.adventure);
        if (typeof zoneId === 'number' && S.core.zone.id() === zoneId) return startWaves(rec, req, zoneId);
        if (S.core.zone.isHome() === true) return startHome(rec, req, zoneId);
        notify('Go home or view the ' + advLabel + ' island, then choose ' + what + ' again.');
        return false;
    }

    function start(id) {
        var p = startPrompts(S.modules.adventures.templates.get(id), id, 'Template');
        if (!p) return false;
        return startTemplate(p.rec, makeRequest(p.rec, p.count), p.advLabel, 'the template');
    }

    // A scenario's items the game cannot produce, or null when the definitions
    // cannot be read now.
    function unknownItems(rec) {
        var names = S.modules.adventures.scenarios.buffsOf(rec);
        var out = [];
        for (var i = 0; i < names.length; i++) {
            var known = S.core.production.isProduceable(names[i]);
            if (known === null || known === undefined) return null;
            if (known === false) out.push('unknown item ' + names[i]);
        }
        return out;
    }

    // The start check of a scenario, without telling the user: { ok,
    // problems, warnings }, with retry when the item definitions cannot be
    // read now. The warnings are logged here, once per check that passed.
    function scenarioCheck(rec) {
        var unknown = unknownItems(rec);
        if (unknown === null) return { ok: false, retry: true, problems: [], warnings: [] };
        if (unknown.length) return { ok: false, retry: false, problems: unknown, warnings: [] };
        var warnings = [];
        var watcher = S.modules.adventures.watcher;
        if (!watcher || !watcher.patterns || watcher.patterns() === null) {
            warnings.push('collect does not pick up on adventures: quest objects will not be clicked');
        }
        for (var i = 0; i < warnings.length; i++) {
            S.kernel.warn('adventures', 'start check "' + rec.label + '":', warnings[i]);
        }
        return { ok: true, retry: false, problems: [], warnings: warnings };
    }

    // A new run of the scenario at trip `trip`, starting at Muster.
    function scenarioRun(rec, zoneId, trip) {
        return store().newRun({
            id:          store().now(),
            templateId:  '',
            scenarioId:  rec.id,
            label:       rec.label,
            adventure:   rec.adventure,
            zoneId:      zoneId,
            paths:       [],
            loadoutPath: '',
            loadoutKeys: {},
            waveIndex:   0,
            step:        S.RunStep.Muster,
            speedBuff:   S.SpeedBuffChoice.None,
            trips:       rec.trips,
            trip:        trip
        });
    }

    // The start trip index: 0 unless the map is open, then the user's answer.
    // null when the prompt was cancelled or not a trip number.
    function startTrip(rec, zoneId) {
        if (typeof zoneId !== 'number') return 0;
        var trips = rec.trips.length;
        var answer = ask('Start at which trip of "' + rec.label + '"? 1..' + trips, '1');
        var w = waveFrom(answer, trips);
        if (!w.ok) {
            if (w.reason === 'invalid') notify('Not a trip number: ' + answer);
            return null;
        }
        return w.wave - 1;
    }

    // Where a new scenario series starts, runs and trips named apart, since
    // the trip count of the scenario is no run count: 'run 1 of 2, trip 1 of 3'.
    function seriesText(runs, trip, trips) {
        return 'run 1 of ' + runs + ', trip ' + (trip + 1) + ' of ' + trips;
    }

    // From home with no map of the adventure open yet, the zone id is unknown
    // until StartMap opens one, so the log says so instead of 'zone null'.
    function zoneText(zoneId) {
        return typeof zoneId === 'number' ? 'zone ' + zoneId : 'no map open yet';
    }

    // Stores a scenario series for req, from home only. what names the thing
    // to choose again ('the scenario', 'the queue').
    function startScenarioRun(rec, req, what) {
        if (S.core.zone.isHome() !== true) {
            notify('Go home, then choose ' + what + ' again.');
            return false;
        }
        var chk = scenarioCheck(rec);
        if (chk.retry) {
            notify('Item definitions cannot be read right now; try again in a moment.');
            return false;
        }
        if (!chk.ok) return checkFailed(rec, chk.problems);
        var warnings = chk.warnings;

        var zoneId = S.core.adventures.zoneIdOf(rec.adventure);
        if (typeof zoneId !== 'number') zoneId = null;
        var trip = startTrip(rec, zoneId);
        if (trip === null) return false;

        var count = req.count;
        store().begin(req, scenarioRun(rec, zoneId, trip));
        wakeRun();
        S.kernel.log('adventures', 'scenario run started from home:', rec.label, 'x' + count + ',',
            seriesText(count, trip, rec.trips.length) + ',', zoneText(zoneId),
            '(' + warnings.length + ' warning(s))');
        notify('Scenario run started from home: ' + rec.label + ' ×' + count + ', ' +
            seriesText(count, trip, rec.trips.length) + '.' +
            (warnings.length ? ' Warning: ' + warnings.join('; ') + '.' : ''));
        return true;
    }

    function startScenario(id) {
        var p = startPrompts(S.modules.adventures.scenarios.get(id), id, 'Scenario');
        if (!p) return false;
        var rec = p.rec;
        return startScenarioRun(rec, makeRequest({ id: '', label: rec.label, adventure: rec.adventure }, p.count),
            'the scenario');
    }

    // ---- Queue -------------------------------------------------------------

    function isTemplateEntry(entry) {
        return !!entry && entry.kind === queues().KIND.Template;
    }

    function isScenarioEntry(entry) {
        return !!entry && entry.kind === queues().KIND.Scenario;
    }

    // The first run of a queue entry, at home, for the hand-over and Skip
    // entry: nothing is asked and nothing told, since the hand-over may call
    // it on every pass while a read waits. { ok: true, run }; { ok: false,
    // retry: true, message } when a list the check needs cannot be read now
    // (message names it); { ok: false, message } when the entry cannot run.
    function entryRun(entry) {
        var rec;
        if (isTemplateEntry(entry)) {
            rec = S.modules.adventures.templates.get(entry.id);
            if (!rec) return { ok: false, message: 'template ' + entry.id + ' is missing or unreadable' };
            var c = templateCheck(rec, homeCheck());
            if (!c.ok) return { ok: false, retry: c.retry === true, message: c.message };
            if (!c.chk.ok) {
                return { ok: false, message: listOf(c.chk.problems).slice(0, 3).map(messageOf).join('; ') };
            }
            var zoneId = S.core.adventures.zoneIdOf(rec.adventure);
            return { ok: true, run: runFromTemplate(rec, c.chk, typeof zoneId === 'number' ? zoneId : null, 0,
                S.RunStep.Muster) };
        }
        if (isScenarioEntry(entry)) {
            rec = S.modules.adventures.scenarios.get(entry.id);
            if (!rec) return { ok: false, message: 'scenario ' + entry.id + ' is missing or unreadable' };
            var s = scenarioCheck(rec);
            if (s.retry) return { ok: false, retry: true, message: 'item definitions' };
            if (!s.ok) return { ok: false, message: s.problems.slice(0, 3).join('; ') };
            return { ok: true, run: scenarioRun(rec, null, 0) };
        }
        return { ok: false, message: 'unknown kind ' + (entry && entry.kind ? entry.kind : '(none)') };
    }

    // The entry a queue starts with (queues.startIndex). { index, skipped }
    // with the labels stepped over; null after telling the user why none can
    // start.
    function firstEntry(copy) {
        var pass = {};
        var r = queues().startIndex(copy.noMap, copy.entries.length, function (i) {
            return available(copy.entries[i].adventure, pass);
        });
        if (!r) {
            notify('The star menu cannot be read right now. Try again in a moment.');
            return null;
        }
        if (r.index < 0) {
            notify('No map for any entry of "' + copy.label + '".');
            return null;
        }
        var skipped = [];
        for (var i = 0; i < r.skipped.length; i++) skipped.push(copy.entries[r.skipped[i]].label);
        return { index: r.index, skipped: skipped };
    }

    // Starts a saved queue at its first entry: every entry must be readable,
    // the entry's own prompts apply and its count is the queue's. Stores
    // nothing when it refuses.
    function startQueue(id) {
        var rec = queues().get(id);
        if (!rec) {
            notify('Queue ' + id + ' cannot be read.');
            return false;
        }
        var problems = queues().validate(rec);
        if (problems.length) return checkFailed(rec, problems);
        var copy = queues().toRun(rec);
        var first = firstEntry(copy);
        if (!first) return false;
        var entry = copy.entries[first.index];
        var entryRec = queues().entryRecord(entry);
        var kind = isTemplateEntry(entry) ? 'Template' : 'Scenario';
        var p = startPrompts(entryRec, entry.id, kind, entry.count);
        if (!p) return false;

        var req = makeRequest(p.rec, entry.count, copy);
        store().enterEntry(req, { index: first.index, pass: 0 });
        var ok = isTemplateEntry(entry) ? startTemplate(p.rec, req, p.advLabel, 'the queue') :
            startScenarioRun(p.rec, req, 'the queue');
        if (!ok) return false;
        S.kernel.log('adventures', 'queue ' + copy.label + ': entry ' + (first.index + 1) + '/' +
            copy.entries.length + ' begins: ' + entry.label);
        if (first.skipped.length) {
            S.kernel.log('adventures', 'queue ' + copy.label + ': no map for ' + first.skipped.join(', ') +
                ', ' + first.skipped.length + ' entry(ies) skipped');
            notify('Queue "' + copy.label + '": no map for ' + first.skipped.join(', ') + '; it starts at entry ' +
                (first.index + 1) + ', ' + entry.label + '.');
        }
        return true;
    }

    // True while runs are requested beyond the one in progress, or a queue
    // entry or pass follows, so there is a repetition left to end.
    function repetitionLeft() {
        return store().requestedRuns() > store().finishedRuns() + 1 || !!store().queueNext(current());
    }

    // Which Skip entry applies now: 'drop' (the entry's map is not out yet,
    // so its remaining runs go uncounted and the next entry begins), 'over'
    // (the hand-over paused on an entry that cannot begin) or null. Only in
    // a paused queue at home: the next entry begins at home. A map start that
    // was seen, or that cannot be told apart from one (NotObserved), keeps
    // the entry, since its map may be out.
    function skipCase(rs) {
        var req = rs.request;
        var r = rs.run;
        if (!req || !req.queue || !r || r.status !== S.RunStatus.Paused) return null;
        if (S.core.zone.isHome() !== true) return null;
        if (r.step === S.RunStep.Next && r.pause && r.pause.reason === S.RunPause.QueueEntry) return 'over';
        if (store().position(r.step) > store().position(S.RunStep.StartMap)) return null;
        if (!store().queueNext(req)) return null;
        if (typeof S.core.adventures.zoneIdOf(r.adventure) === 'number') return null;
        if (r.step === S.RunStep.StartMap && r.pause && r.pause.reason === S.RunPause.NotObserved) return null;
        var m = loader() && loader().marked ? loader().marked(r, 'map') : null;
        if (m && m.seen) return null;
        return 'drop';
    }

    function skipEntry() {
        var rs = store().current();
        var c = skipCase(rs);
        if (!c) {
            notify('No queue entry to skip now.');
            return false;
        }
        var req = rs.request;
        var q = req.queue;
        var r = rs.run;
        if (c === 'over') {
            // Past the entry the hand-over tried, so entries with no map it
            // stepped over before it are not where the next try lands.
            var tried = store().queueTried(req);
            var past = store().queueSkipPast(req, tried);
            var name = tried ? q.entries[tried.index].label : '';
            q.skip = past !== null ? past : q.skip + 1;
            q.tried = null;
            store().save();
            store().resume();
            wakeRun();
            S.kernel.log('adventures', 'queue ' + q.label + ': entry skipped at the hand-over: ' + name);
            notify('Entry skipped: ' + name + '.');
            return true;
        }
        cancelQueued();
        store().dropRound('entry skipped');
        var at = store().queueNext(req);
        var next = q.entries[at.index];
        var e = entryRun(next);
        if (!e.ok) {
            notify('Entry ' + next.label + ' cannot begin' + (e.retry ? ': ' + e.message + ' not readable' :
                ': ' + e.message) + '. The run stays paused.');
            return false;
        }
        var old = req.label;
        store().enterEntry(req, at);
        var run = e.run;
        run.id = Math.max(store().now(), r.id + 1);
        run.transit = r.transit;
        run.transitBase = r.transitBase;
        store().begin(req, run);
        wakeRun();
        S.kernel.log('adventures', 'queue ' + q.label + ': entry skipped: ' + old + '; entry ' + (at.index + 1) + '/' +
            q.entries.length + ' begins: ' + next.label);
        notify('Entry skipped: ' + old + '; ' + next.label + ' begins.');
        return true;
    }

    // Which commands apply now; each key is the name of its command. The
    // conditions mirror the ones the commands guard themselves with, so a
    // control this table enables is accepted by its command. The one exception
    // is endRepetition: for a request without a run, this table is stricter
    // and greys it out, while the command itself still accepts the call.
    function can() {
        var rs = store().current();
        var status = rs.run ? rs.run.status : null;
        return {
            pause:         status === S.RunStatus.Running,
            resume:        status === S.RunStatus.Paused,
            endRepetition: !!rs.run && status !== S.RunStatus.Done && !!rs.request && repetitionLeft(),
            stop:          !!rs.request || !!rs.run,
            skipEntry:     skipCase(rs) !== null
        };
    }

    function pause() {
        if (!can().pause) {
            notify('No running adventure run to pause.');
            return false;
        }
        cancelQueued();
        return store().pause(S.RunPause.User, 'paused by you');
    }

    function resume() {
        var run = store().run();
        if (!run) {
            notify('No adventure run to resume.');
            return false;
        }
        if (run.status === S.RunStatus.Done) {
            notify('The series is done; use Stop run.');
            return false;
        }
        if (run.status !== S.RunStatus.Paused) {
            notify('The run is not paused.');
            return false;
        }
        if (!store().resume()) return false;
        wakeRun();
        notify('Run resumed at ' + store().label() + ': ' + run.label + '.');
        return true;
    }

    // Same meaning as autoTSO's end repetition: the series ends with the run
    // in progress, so the count becomes the runs finished plus that one. In a
    // queue, ended also keeps the next entry from beginning, so the queue
    // ends with this run.
    function endRepetition() {
        var req = current();
        if (!req) {
            notify('No run requested.');
            return false;
        }
        if (!repetitionLeft()) {
            notify('This is the last run requested; there is no repetition to end.');
            return false;
        }
        req.count = store().finishedRuns() + 1;
        req.ended = true;
        store().save();
        var what = req.queue ? req.queue.label : req.label;
        S.kernel.log('adventures', 'run repetition ended:', what);
        notify('Repetition ended: ' + what + ' stops after the current run.');
        refresh();
        return true;
    }

    // Drops the request and the run. Queued entries go first, so no attempt
    // or attack is sent after the state is gone.
    function stop() {
        if (!can().stop) {
            notify('No run requested.');
            return false;
        }
        var rs = store().current();
        var label = rs.run ? rs.run.label : rs.request.label;
        cancelQueued();
        store().clear();
        S.kernel.log('adventures', 'run stopped:', label);
        notify('Run stopped.');
        return true;
    }

    S.modules.adventures.run = {
        current:       current,
        statusText:    statusText,
        countFrom:     countFrom,
        waveFrom:      waveFrom,
        available:     available,
        can:           can,
        start:         start,
        startScenario: startScenario,
        startQueue:    startQueue,
        entryRun:      entryRun,
        skipEntry:     skipEntry,
        pause:         pause,
        resume:        resume,
        stop:          stop,
        endRepetition: endRepetition
    };

}(Steward));
