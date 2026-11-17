/*
 * Scenario steps of an adventure run: produce items at home, apply them on
 * the island, and end a trip.
 *
 * A scenario run sends no generals. Its chain is Muster -> Produce ->
 * StartMap -> Jump -> Apply -> Trip, then JumpHome -> ArriveHome -> Produce
 * for the next trip, or Clear -> LastQuest -> Close after the last one. The
 * steps shared with a template run live in home.js and away.js; the three
 * here are the ones only a scenario run uses.
 *
 * Produce orders what the current trip still needs (its open grids) plus
 * what the next trip needs (all its grids), minus the stock and what is
 * already queued, so the next trip's items are made while the current one
 * runs. It leaves home only once no item of this or the next trip is in a
 * production queue (whoever queued it), no order of the run is still on its
 * way, the current trip's items are in the star menu, and all of it reads so
 * again READ_LAG_MS later: stock already in the star menu never counts while
 * an item of the trips is still queued. A queue entry can leave minutes
 * before its items show in the star menu, so each order is kept on its make:
 * mark (the items it owes, and the stock and queue read before its send) and
 * counts as on the way until the queue or a stock rise shows it. An order
 * that shows nowhere for MAKE_LOST_MS is planned again, and an order that
 * fails is tried again after a while; neither pauses the run: only missing
 * resources do.
 *
 * Apply sends each item of the trip as one burst: one action sends the
 * item to all its open grids back to back, from one star-menu entry, with
 * nothing in between, as the game takes an item best when its grids get it
 * together. It sends only while a running quest wants the item
 * (core/quests.js itemWant with opts.running): a quest that is unread, not
 * yet started or in any mode other than running is never sent to, and the
 * wait for it is logged once. A quest also wants the item when its open
 * type-1 trigger, not a click trigger, names the building standing at the
 * grid: such a quest takes the item without naming it. So does its open
 * item-action end condition (onmap, buildingdestroyed) naming that
 * building, as a quest that asks for the boulders dynamite clears. The want
 * is asked per grid: a grid whose quest condition is met is skipped on its
 * own, a grid whose quest is not running yet is left for a later burst, and
 * the item's other grids still go. Each grid has a persisted send marker,
 * written before the first packet, so a reload never sends to it twice.
 * The burst's check reads the stock only BURST_GAP_MS after the send, and
 * the next burst of the trip goes out no sooner than BURST_GAP_MS after the
 * latest send marker, so the server has finished with one item before the
 * next arrives, after a reload too. An item's amount is its total for the
 * trip over all its grids: every grid of the burst is offered what the
 * trip still needs of it, the game takes only what each grid needs, and the
 * burst needs one stack holding that offer (each packet draws on the same
 * entry). A total stock below it goes home for more; stock split over
 * stacks pauses before any packet. An item without an amount offers 1 per
 * grid, and its burst is cut to the largest stack. Only the total stock
 * drop of a verified burst is known, so it goes on the 'part:' marker of
 * the burst's first grid (the item's part markers sum to what the trip has
 * taken of it). A verified burst closes all its grids whatever it took: a
 * short take is logged as a warning and nothing more is offered. The
 * buildings read when the burst is decided go with it: the action may run
 * later, and when another building stands at any of its grids by then
 * nothing is sent and the next round decides again. Every burst logs one
 * 'item ... entries' line per grid (star-menu entries, the building and the
 * item's targets) and one 'apply' line; core logs the packet times in its
 * 'burst' line. Out of stock, Apply
 * first sends the other items a running quest wants that are in stock; a
 * grid the out-of-stock item still owes is held back from every later item,
 * so the file order on a shared grid holds. A trip may list a buff more
 * than once: each entry has its own amount and progress, and the entries go
 * in file order on a shared grid, a later one waiting there while an earlier
 * one is still open. Once nothing else can go the run
 * goes home for more and comes back to the same trip, rather than wait on
 * items no running quest wants yet. A burst that made no host call (nothing
 * went out) keeps its grids open and is tried again after NOT_SENT_RETRY_MS,
 * up to NOT_SENT_MAX times per grid, then pauses. An item with a quest
 * (item.quest) is wanted only by that quest, which must also pass the
 * client's own IsRunning(): the grid's building alone cannot tell which
 * quest the item is for. Apply decides nothing within QUEST_SETTLE_MS of a
 * quest read or claim on the island, so the next quest has appeared before
 * any item is sent or any grid is closed.
 *
 * Trip lets the quests update (READ_LAG_MS from the step entry and
 * QUEST_SETTLE_MS from the last verified quest read or claim on the island),
 * waits for unread and claimable quests, quest objects and the pick-ups a
 * running quest still counts that are not on the map yet, leaves only once
 * all of that has read clear for READ_LAG_MS, and leaves after TRIP_MAX_MS
 * whatever is left, unless pick-ups are left and Produce found the next
 * trip short of resources: those pick-ups may be what covers it, so the run
 * re-visits the island (home and back, which reloads the zone and its
 * objects) after TRIP_REVISIT_MS (TRIP_MAX_MS when every pick-up is on the
 * map), up to TRIP_REVISITS times per trip, and pauses after that.
 *
 * Apply and Trip act only while the run's island is viewed; the quest pool
 * read elsewhere is not the run's.
 *
 * scenarioViewed() tells collect (which reads it at call time; renaming it must
 * update collect scenarioIsland) that a scenario run's island is viewed, so
 * it clicks only the quest objects of running quests there and no
 * collectibles: on a scenario island every pick-up is counted by a quest.
 *
 * Bundle slot: module file, after templates.js and before watcher.js; top
 * level only assigns S.modules.adventures.trips; state, loader, watcher,
 * home, away, scenarios and every core are read at call time.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    // Starting values, to be tuned in game.
    var PRODUCE_RETRY_MS = 60000;    // a failed item order is tried again after this
    var MAKE_LOST_MS     = 600000;   // an order neither queued nor in the star menu this long is lost
    var APPLY_QUIET_MS   = 600000;   // quiet time a quest gets to want an item
    var TRIP_MAX_MS      = 300000;   // quiet time a trip waits for quests and objects
    var QUEST_SETTLE_MS  = 20000;    // settle after a quest read or claim on the island
    var TRIP_REVISIT_MS  = 120000;   // quiet time an awaited pick-up gets before a re-visit, next trip short
    var TRIP_REVISITS    = 2;        // re-visits per trip before a pause
    var NOT_SENT_MAX     = 3;        // no-packet sends per grid before a pause
    var NOT_SENT_RETRY_MS = 10000;   // gap after a no-packet send before the next try to that grid
    var BURST_GAP_MS     = 15000;    // an item burst's check waits this long, and the next burst goes out no sooner

    var CATEGORY = 'adventures';

    // Mark name prefixes: one mark per item ordered (its count, stock and
    // queued fields: the items its orders owe beyond what was queued, and the
    // star-menu stock and queued items read for the plan before its send; at,
    // memory only, the last time the order could still be in production), one
    // per trip, entry and grid sent to,
    // and one per trip, entry and grid that took something (written seen,
    // never sent; its taken field is what the grid has taken so far, and a
    // burst's whole take goes on its first grid, so the entry's part marks
    // together hold what the trip has taken of it). An entry is named by the
    // buff for its first listing in the trip and by <buff>#<n> for the n-th
    // (entryKey). One
    // per trip holds Produce's verdict that the next trip waits for
    // resources (seen, its text the shortfall), since the island cannot read
    // the home queues; one per trip counts the re-visits taken (seen, count).
    // One per trip holds when the home exit first read clear (seen, field
    // at), so the run leaves only after a second clear read READ_LAG_MS later.
    var MAKE    = 'make:';
    var APPLY   = 'apply:';
    var PART    = 'part:';
    var SHORT   = 'short:';
    var REVISIT = 'revisit:';
    var READY   = 'ready:';

    function has(obj, key) { return S.kernel.is.has(obj, key); }

    function st() {
        return S.modules.adventures.state;
    }

    function ld() {
        return S.modules.adventures.loader;
    }

    function sc() {
        return S.modules.adventures.scenarios;
    }

    function wt() {
        return S.modules.adventures.watcher;
    }

    function now() {
        return S.modules.adventures.state.now();
    }

    function log(text) {
        S.kernel.log(CATEGORY, st().label() + ': ' + text);
    }

    // A verified effect may read late; the quests after the last send get
    // the same time.
    function tripSettleMs() {
        return ld().READ_LAG_MS;
    }

    // Logs a fact once per run, step, trip and key instead of on every pass.
    // Memory only: after a reload it is logged once more. There is one slot,
    // so a pass with several facts passes them as one list under one key;
    // separate calls would overwrite each other and log on every pass.
    function noteOnce(r, key, text) {
        var rs = st().current();
        var tag = r.id + ':' + r.step + ':' + r.trip + ':' + key;
        if (rs.tripNote === tag) return;
        rs.tripNote = tag;
        var lines = typeof text === 'string' ? [text] : text;
        for (var i = 0; i < lines.length; i++) log(lines[i]);
    }

    // Logs once per run, trip and buff that the bound quest names no condition
    // for the item, so the send rests on the scenario binding alone. A slot of
    // its own: noteOnce holds one fact and the Apply pass logs others.
    // Memory only, like noteOnce.
    function bindNote(r, buff, quest) {
        var rs = st().current();
        if (!rs.bindNotes) rs.bindNotes = {};
        var key = r.id + ':' + r.trip + ':' + buff;
        if (rs.bindNotes[key]) return;
        rs.bindNotes[key] = true;
        log('quest ' + quest + ' names no condition for ' + buff + '; applying by the scenario binding');
    }

    // ---- Marks --------------------------------------------------------------

    function gridName(prefix, tripIndex, key, grid) {
        return prefix + tripIndex + ':' + key + ':' + grid;
    }

    // With a buff as key it names that buff's first entry in the trip.
    function applyMark(r, key, grid) {
        return gridName(APPLY, r.trip, key, grid);
    }

    function partMark(r, key, grid) {
        return gridName(PART, r.trip, key, grid);
    }

    // The entry key of items[i] in its trip's marks. The first entry of a
    // buff keeps the plain buff, so the marks of a trip that lists each buff
    // once (and of runs saved before a buff could repeat) keep their names;
    // a later entry of the same buff is <buff>#<n>, n its count in file
    // order, which is stable across reloads. A buff name holds no '#' or ':'.
    function entryKey(items, i) {
        var count = 0;
        for (var j = 0; j < i; j++) {
            if (items[j].buff === items[i].buff) count++;
        }
        return count ? items[i].buff + '#' + (count + 1) : items[i].buff;
    }

    // The entry key of item, one of items; an item not among them counts as
    // its buff's first entry.
    function keyOf(items, item) {
        var i = items.indexOf(item);
        return i < 0 ? item.buff : entryKey(items, i);
    }

    // { key, grid } of an apply mark name. The grid follows the last ':',
    // the entry key the trip index.
    function parseApply(name) {
        var rest = name.slice(APPLY.length);
        var a = rest.indexOf(':');
        var b = rest.lastIndexOf(':');
        return { key: rest.slice(a + 1, b), grid: rest.slice(b + 1) };
    }

    // isOpen(item, grid) for scenarios.tripNeeds: a grid waits while the
    // apply mark of that trip, entry and grid is not seen.
    function isOpen(r, tripIndex) {
        var items = ((r.trips || [])[tripIndex] || {}).items || [];
        return function (item, grid) {
            var m = ld().marked(r, gridName(APPLY, tripIndex, keyOf(items, item), grid));
            return !(m && m.seen);
        };
    }

    function allOpen() {
        return true;
    }

    // A new leg visits at once: the jump marks of the earlier leg would hold
    // the visit back up to the jump retry time.
    function newLeg(r) {
        ld().dropMark(r, 'visit');
        ld().dropMark(r, 'visitHome');
    }

    // ---- Produce ------------------------------------------------------------

    // Same rows as the retrain shortfall, so both pauses read alike.
    function shortText(list) {
        return S.modules.adventures.home.shortText(list);
    }

    // [{ unit, count }] of every buff with runs > 0, in name order, so the
    // orders and their log lines keep one order.
    function orderList(runs) {
        var names = [];
        for (var b in runs) if (has(runs, b) && runs[b] > 0) names.push(b);
        names.sort();
        var out = [];
        for (var i = 0; i < names.length; i++) out.push({ unit: names[i], count: runs[names[i]] });
        return out;
    }

    // Items a MAKE mark's orders owe that neither the queue nor the star menu
    // shows now: everything queued at its read plus what it ordered, less what is
    // queued now and the stock rise since the read. An entry that leaves the queue
    // before its items reach the star menu stays counted, also an earlier order
    // that was still queued when more of the item was ordered. null for a mark
    // without a send record (none sent, sent by an older version, or cleared by
    // Resume), which keeps the plain wait-then-order-again path.
    function onTheWay(m, it) {
        if (!m || typeof m.sentAt !== 'number') return null;
        if (typeof m.count !== 'number' || typeof m.stock !== 'number' || typeof m.queued !== 'number') return null;
        return Math.max(0, m.count + m.queued - it.q - Math.max(0, it.stock - m.stock));
    }

    // def with its send wrapped so the MAKE mark name gets rec (count, stock,
    // queued) and a fresh at, saved before the packet, while the run is still
    // r. A send that did not go out (NOT_SENT or a failed send) puts the
    // mark's earlier fields back, so an order that never left is not counted
    // as on its way.
    function trackOrder(r, name, def, rec) {
        if (!def || typeof def.send !== 'function') return def;
        var send = def.send;
        var runId = r.id;
        var FIELDS = ['count', 'stock', 'queued'];
        def.send = function (b) {
            var cur = st().run();
            var was = null;
            var i;
            if (cur && cur.id === runId) {
                var m = ld().mark(cur, name);
                was = {};
                for (i = 0; i < FIELDS.length; i++) {
                    was[FIELDS[i]] = m[FIELDS[i]];
                    m[FIELDS[i]] = rec[FIELDS[i]];
                }
                m.at = now();
                st().save();
            }
            var res = send(b);
            if (was && res !== true) {
                var c = st().run();
                if (c && c.id === runId) {
                    var mm = ld().mark(c, name);
                    for (i = 0; i < FIELDS.length; i++) {
                        if (was[FIELDS[i]] === undefined) delete mm[FIELDS[i]];
                        else mm[FIELDS[i]] = was[FIELDS[i]];
                    }
                    st().save();
                }
            }
            return res;
        };
        return def;
    }

    function orderRuns(r, list, info) {
        var round = ld().startRound(r, S.RunStep.Produce, []);
        for (var i = 0; i < list.length; i++) {
            var b = list[i].unit;
            var runs = list[i].count;
            var name = MAKE + b;
            log('producing: ' + b + ' x' + (runs * info[b].y) + ' (' + runs + ' run(s))');
            // Ordering more while an order is on its way merges both into one
            // record against the new read: what is still on its way plus this
            // order, with the earlier order's entries still queued kept
            // through queued.
            var def = S.core.production.order(b, runs);
            trackOrder(r, name, def, { count: info[b].way + runs * info[b].y,
                stock: info[b].stock, queued: info[b].q });
            ld().attempt(round, name, ld().wrapSend(r, name, def), ld().seenOnVerified(name));
        }
    }

    // Records on the trip whether the next trip's items wait for resources
    // (text) or not (null). Saved only on a change, so a waiting Produce does
    // not write the run file every pass.
    function noteShort(r, tripIndex, text) {
        var name = SHORT + tripIndex;
        if (text === null) {
            ld().dropMark(r, name);
            return;
        }
        var m = ld().marked(r, name);
        if (m && m.seen && m.text === text) return;
        ld().markSeen(r, name);
        ld().marked(r, name).text = text;
        st().save();
    }

    // One entry per item of this and the next trip: stock/need for this
    // trip's items, "next" for an item only the next trip needs, and what is
    // still queued of it.
    function haveText(thisNeed, info, buffs) {
        var out = [];
        for (var k = 0; k < buffs.length; k++) {
            var b = buffs[k];
            var t = has(thisNeed, b) ? b + ' ' + info[b].stock + '/' + thisNeed[b] : b + ' next';
            if (info[b].q > 0) t += ' queued ' + info[b].q;
            if (info[b].way > 0) t += ' on the way ' + info[b].way;
            out.push(t);
        }
        out.sort();
        return out.join(', ');
    }

    // Produce (home). Production runs yield y items each, so a need in items
    // becomes ceil(items / y) runs. A queued run counts as items on the way,
    // and so does an order of the run that neither the queue nor the star
    // menu shows yet: its queue entry can leave minutes before its items show
    // in the star menu. An order that shows nowhere for MAKE_LOST_MS is
    // planned again, never paused on. The run leaves only on two clear reads
    // READ_LAG_MS apart, clear meaning nothing of either trip queued or on
    // its way and this trip's items in stock.
    function produce(r) {
        var RS = S.RunStep;
        var trips = r.trips || [];
        var n = trips.length;
        var i = r.trip;
        if (i >= n) {
            st().go(RS.Account, 'all trips done');
            return;
        }
        var thisNeed = sc().tripNeeds(trips[i], isOpen(r, i));
        var nextNeed = i + 1 < n ? sc().tripNeeds(trips[i + 1], allOpen) : {};
        var info = {};
        var buffs = [];
        var b;
        for (b in thisNeed) if (has(thisNeed, b)) buffs.push(b);
        for (b in nextNeed) if (has(nextNeed, b) && !has(thisNeed, b)) buffs.push(b);
        for (var k = 0; k < buffs.length; k++) {
            b = buffs[k];
            var stock = S.core.buffs.stock(b, '');
            var q = S.core.production.queuedItems(b);
            var y = S.core.production.yieldOf(b);
            if (typeof stock !== 'number' || typeof q !== 'number' || typeof y !== 'number' || !(y > 0)) {
                ld().waitRead(r, 'item stock or production queue');
                return;
            }
            info[b] = { stock: stock, q: q, y: y };
        }

        // A round in flight: a failure is tried again only after
        // PRODUCE_RETRY_MS, so a queue that keeps refusing gets one order a
        // minute; r.rounds is never counted, a refusal never pauses.
        ld().dropOrphan(r);
        var round = ld().currentRound(r, RS.Produce);
        if (round) {
            if (ld().roundSettling(round)) return;
            var f = ld().firstFailure(round);
            if (f && typeof round.doneAt === 'number' && now() - round.doneAt < PRODUCE_RETRY_MS) {
                ld().waitBusy(r, null, 'item order failed (' + f.reason + '), trying again');
                return;
            }
            st().dropRound(f ? 'item order failed, trying again' : 'item orders sent');
        }
        for (k = 0; k < buffs.length; k++) {
            b = buffs[k];
            var way = onTheWay(ld().marked(r, MAKE + b), info[b]);
            info[b].way = way === null ? 0 : way;
        }

        var runsThis = {};
        var runsAll = {};
        for (k = 0; k < buffs.length; k++) {
            b = buffs[k];
            var it = info[b];
            var mine = has(thisNeed, b) ? thisNeed[b] : 0;
            var next = has(nextNeed, b) ? nextNeed[b] : 0;
            runsThis[b] = Math.ceil(Math.max(0, mine - it.stock - it.q - it.way) / it.y);
            runsAll[b] = Math.ceil(Math.max(0, mine + next - it.stock - it.q - it.way) / it.y);
        }
        // A mark with a send record stays while its order is on its way and
        // drops once nothing is queued and the stock shows it all. While any
        // of the item is queued the order may still be in production, so its
        // lost clock (at, memory only) restarts; a reload starts it afresh.
        // A mark without a send record drops once its item drops out of the
        // plan. Marks are dropped after the walk, never during it.
        var drop = [];
        for (var name in (r.marks || {})) {
            if (!has(r.marks, name) || name.indexOf(MAKE) !== 0) continue;
            var mb = name.substring(MAKE.length);
            if (!has(info, mb)) {
                drop.push(name);
                continue;
            }
            var mm = r.marks[name];
            var w = onTheWay(mm, info[mb]);
            if (w === null) {
                if (!(runsAll[mb] > 0)) drop.push(name);
                continue;
            }
            if (w === 0 && info[mb].q === 0) {
                drop.push(name);
                continue;
            }
            if (info[mb].q > 0 || typeof mm.at !== 'number') mm.at = now();
            if (w > 0 && now() - mm.at >= MAKE_LOST_MS) {
                log('order of ' + mb + ' not seen in the queue or the star menu for ' +
                    S.kernel.text.minText(MAKE_LOST_MS) + ', planning it again');
                ld().dropMark(r, name);
                return;
            }
        }
        for (k = 0; k < drop.length; k++) ld().dropMark(r, drop[k]);
        var all = orderList(runsAll);
        for (k = 0; k < all.length; k++) {
            b = all[k].unit;
            var lm = ld().marked(r, MAKE + b);
            if (!lm || onTheWay(lm, info[b]) !== null) continue;
            var s = ld().staleMark(r, MAKE + b, 'order of ' + b, { seen: true });
            if (s === 'wait') return;
            if (s === 'stale') {
                // The queue limits of a production building are not known, so
                // an order that never showed is planned again, never paused on.
                log('order of ' + b + ' not seen in the queue after ' +
                    S.kernel.text.minText(ld().ORDER_WAIT_MS) + ', ordering again');
                ld().dropMark(r, MAKE + b);
                return;
            }
        }

        // Any queued entry of an item holds the exit, the run's own or a
        // manual one: the queue cannot tell them apart, and leftover stock
        // must not release the run while its own order is still being made.
        // So does an order of either trip still on its way.
        var clear = true;
        for (b in thisNeed) {
            if (has(thisNeed, b) && info[b].stock < thisNeed[b]) clear = false;
        }
        for (k = 0; k < buffs.length; k++) {
            if (info[buffs[k]].q !== 0 || info[buffs[k]].way > 0) clear = false;
        }

        var list = all;
        var shortNext = null;
        if (all.length) {
            var j = S.core.production.jointShortfalls(all);
            if (j === null) {
                ld().waitRead(r, 'item costs');
                return;
            }
            if (j.length) {
                list = orderList(runsThis);
                if (list.length) {
                    var jt = S.core.production.jointShortfalls(list);
                    if (jt === null) {
                        ld().waitRead(r, 'item costs');
                        return;
                    }
                    if (jt.length) {
                        st().pause(S.RunPause.ItemShort, 'cannot produce: ' + shortText(jt));
                        return;
                    }
                }
                shortNext = shortText(j);
                noteOnce(r, 'next', 'next trip items wait for resources: ' + shortNext);
            }
        }
        noteShort(r, i, shortNext);
        var readyName = READY + i;
        if (list.length) {
            // A new order restarts the settle: the exit needs two clear reads
            // with nothing ordered between them.
            ld().dropMark(r, readyName);
            orderRuns(r, list, info);
            return;
        }
        if (!clear) {
            ld().dropMark(r, readyName);
            ld().waitBusy(r, null, 'waiting for production: ' + haveText(thisNeed, info, buffs));
            return;
        }
        // The time lives in memory only (a reload reads the mark back without
        // it), so a mark without one starts the settle afresh.
        var rm = ld().marked(r, readyName);
        if (!rm || typeof rm.at !== 'number') {
            ld().markSeen(r, readyName);
            ld().marked(r, readyName).at = now();
            st().save();
            ld().waitBusy(r, null, 'production done, checking stock again');
            return;
        }
        if (now() - rm.at < ld().READ_LAG_MS) {
            ld().waitBusy(r, null, 'production done, checking stock again');
            return;
        }
        var left = [];
        for (name in (r.marks || {})) {
            if (has(r.marks, name) && name.indexOf(MAKE) === 0) left.push(name);
        }
        for (k = 0; k < left.length; k++) ld().dropMark(r, left[k]);
        ld().dropMark(r, readyName);
        log('items ready: ' + haveText(thisNeed, info, buffs));
        st().go(RS.StartMap, 'items ready');
    }

    // ---- Apply --------------------------------------------------------------

    function islandViewed(r) {
        return typeof r.zoneId === 'number' && S.core.zone.id() === r.zoneId;
    }

    // True while a running or paused scenario run has its island viewed. A
    // paused run still owns the island: its quests must not lose pick-ups.
    function scenarioViewed() {
        var r = st().run();
        if (!r || !st().isScenario(r)) return false;
        if (r.status !== S.RunStatus.Running && r.status !== S.RunStatus.Paused) return false;
        return islandViewed(r);
    }

    // The names of the building at grid: the one standing there now, plus the
    // first one seen there on this run and trip when it differs. A quest that
    // asks for items by the building may see it vanish or change after one of
    // them (an explosive, say), and the remaining items must still find that
    // quest's trigger instead of waiting for a quest that never names them.
    // Memory only: after a reload the gone building is not known any more and
    // the item waits as for any quest that does not want it.
    function gridBuildings(r, grid) {
        var s = gridSeen(r, grid);
        var out = [];
        if (s.cur) out.push(s.cur);
        if (s.first && s.first !== s.cur) out.push(s.first);
        return out;
    }

    // { b, cur, first } at grid: the building standing there now (null when
    // none), its name ('' when none) and the first name seen there on this
    // run and trip ('' when none yet). The one read of the grid's building and
    // of that memory; a name seen for the first time is recorded here.
    function gridSeen(r, grid) {
        var b = null;
        var cur = '';
        try {
            b = S.core.buildings.byGrid(grid);
            cur = S.core.buildings.name(b);
        } catch (e) {
            cur = '';
        }
        if (typeof cur !== 'string') cur = '';
        var rs = st().current();
        if (!rs.applyBuildings) rs.applyBuildings = {};
        var key = r.id + ':' + r.trip + ':' + grid;
        if (cur && !has(rs.applyBuildings, key)) rs.applyBuildings[key] = cur;
        var first = has(rs.applyBuildings, key) ? rs.applyBuildings[key] : '';
        return { b: b, cur: cur, first: first };
    }

    // The diagnostic line of an item send, from s (gridSeen of the grid): the
    // star-menu entries of the item, the building and what the item's
    // definition targets. A refused or refunded send can then be read from
    // the log later. Text only, and every read is guarded so it never throws.
    function sendNote(b, grid, s) {
        var ents = [];
        var invRead = true;
        try {
            // A null inventory is an unreadable star menu, not an empty one,
            // so the line says so instead of 'none'.
            var inv = S.core.buffs.inventory();
            if (inv === null) invRead = false;
            for (var i = 0; inv && i < inv.length; i++) {
                if (inv[i].type !== b || (inv[i].resource || '') !== '') continue;
                ents.push(inv[i].bad ? '?' : inv[i].amount + '[' + (inv[i].uid || '') + ']');
            }
        } catch (e) {
            ents = ['?'];
        }
        var own = null;
        var nb = null;
        var des = null;
        try { own = S.core.buildings.grid(s.b); } catch (e2) { own = null; }
        try {
            var bs = S.core.buildings.buffState(s.b);
            nb = bs ? bs.buffsVector : null;
        } catch (e3) { nb = null; }
        try { des = S.core.buildings.inDestruction(s.b); } catch (e4) { des = null; }
        var tgt = null;
        try { tgt = S.core.buffs.adventureTarget(b, s.cur); } catch (e5) { tgt = null; }
        var targets = tgt && tgt.targets && tgt.targets.length ? tgt.targets.join(',') : 'none';
        var group = tgt && tgt.group ? tgt.group : 'none';
        var via = !tgt ? '?' : (!s.cur ? '-' : (tgt.via || 'no'));
        return 'item ' + b + ' -> ' + grid + ': entries ' +
            (ents.length ? ents.join(',') : (invRead ? 'none' : 'unreadable')) +
            '; building ' + (s.cur || 'none') +
            (s.first && s.first !== s.cur ? ' (first seen ' + s.first + ')' : '') +
            ' grid ' + (own === null ? '?' : own) +
            ', buffs ' + (typeof nb === 'number' ? nb : '?') +
            ', in destruction ' + (des === true ? 'true' : (des === false ? 'false' : '?')) +
            '; targets ' + targets + ' group ' + group + ' via ' + via;
    }

    // Whether the building first seen at grid is gone: no named building
    // stands there now, or the one there is being destroyed. A grid never
    // named on this run and trip is never gone, since there is nothing to
    // tell its building's end by (and after a reload that memory is empty).
    function buildingGone(r, grid) {
        var s = gridSeen(r, grid);
        if (!s.first) return false;
        if (s.cur === '') return true;
        try {
            return S.core.buildings.inDestruction(s.b) === true;
        } catch (e) {
            return false;
        }
    }

    // What grid has taken for the entry key on this trip so far (its part
    // mark).
    function gridTaken(r, key, grid) {
        var pm = ld().marked(r, partMark(r, key, grid));
        return pm && typeof pm.taken === 'number' ? pm.taken : 0;
    }

    // What the grids of the entry (item, its key) together have taken on
    // this trip so far.
    function tripTaken(r, item, key) {
        var sum = 0;
        for (var i = 0; i < item.grids.length; i++) sum += gridTaken(r, key, item.grids[i]);
        return sum;
    }

    // What a send of the entry (item, its key) to grid may still offer: the
    // rest of the entry's trip total when it has an amount, else the rest of
    // the grid's 1.
    function stillNeeded(r, item, key, grid) {
        var bound = sc().sendAmount(item);
        if (item.amount !== null) return bound - tripTaken(r, item, key);
        return bound - gridTaken(r, key, grid);
    }

    // itemWant under the strict gate, for a send of the item to grid; the one
    // place that composes the gate call. held gets the quests that want the
    // item but are not running yet. Apply runs only while the run's island is
    // viewed, so the building at grid is read in the viewed zone. An item with
    // a quest is asked of that quest only; when it names no condition for the
    // item the binding stands in for one, and that is logged once.
    function want(r, item, grid, held) {
        var un = [];
        var res = S.core.quests.itemWant(item.buff, S.core.buffs.targetsOf(item.buff),
            { running: true, held: held, buildings: gridBuildings(r, grid),
                quest: item.quest || null, unnamed: un });
        if (un.length) bindNote(r, item.buff, un[0]);
        return res;
    }

    // The trip item of an entry key, for a pending mark that holds only the
    // key, else an unbound stand-in for the key's buff (the key without a
    // trailing '#<n>').
    function itemOf(items, key) {
        for (var i = 0; i < items.length; i++) {
            if (entryKey(items, i) === key) return items[i];
        }
        var h = key.lastIndexOf('#');
        var buff = h > 0 && /^[0-9]+$/.test(key.slice(h + 1)) ? key.slice(0, h) : key;
        return { buff: buff, quest: null };
    }

    // The quest objects collect clicks on a scenario island (running quests
    // only); held gets the ones whose quest is not running yet, and awaited,
    // when given, the names a running quest still counts that have no object
    // on the map yet. null when the map or the quest pool cannot be read.
    function islandObjects(held, awaited) {
        try {
            return S.core.pickups.targets({ quests: true, running: true, held: held, awaited: awaited });
        } catch (e) {
            S.kernel.warn(CATEGORY, 'quest objects read threw:', e);
            return null;
        }
    }

    // 'waiting for quest <name> to be running, mode N' per distinct quest, in
    // first-seen order, joined with '; '.
    function heldText(held) {
        var seen = {};
        var out = [];
        for (var i = 0; i < held.length; i++) {
            var key = held[i].quest + '|' + held[i].mode;
            if (has(seen, key)) continue;
            seen[key] = true;
            out.push('waiting for quest ' + (held[i].quest || '?') + ' to be running, mode ' + held[i].mode);
        }
        return out.join('; ');
    }

    // When the latest burst of this trip went out: the largest sentAt over
    // the trip's apply marks, else null. The marks are written before the
    // first packet and persist, so the gap to the next burst holds after a
    // reload; a burst that sent nothing gave its sentAt back and counts not.
    function lastBurstAt(r) {
        var pre = APPLY + r.trip + ':';
        var last = null;
        for (var name in (r.marks || {})) {
            if (!has(r.marks, name) || name.indexOf(pre) !== 0) continue;
            var t = r.marks[name].sentAt;
            if (typeof t === 'number' && (last === null || t > last)) last = t;
        }
        return last;
    }

    // The onDone follow-up of a burst, on the current run like
    // seenOnVerified. Only a verified burst decides here; the step reads any
    // other result. took is the stock drop the check saw, plus the queued
    // items that landed in the star menu during the burst, which raised the
    // stock. Only the burst's total is known, not what each grid took, so it
    // is added to the part mark of the first grid (given0 is what that grid
    // had taken before), and the item's part marks still sum to its trip
    // take. Every grid of the burst is done whatever it took: each grid takes
    // only what it needs, and a grid offered again after a burst took nothing
    // in nearly every case seen, so nothing is offered twice.
    function burstApplied(names, b, grids, offer, goal, firstPart, given0, q0, def) {
        return function (result, cur) {
            if (!result || result.status !== S.ActionResult.Verified) return;
            var took = def.dropped();
            var q1 = S.core.production.queuedItems(b);
            if (typeof took === 'number' && typeof q0 === 'number' && typeof q1 === 'number' && q1 < q0) {
                took += q0 - q1;
            }
            var where = b + ' burst x' + offer + ' -> ' + grids.join(',');
            var i;
            if (took === null || !(took > 0)) {
                for (i = 0; i < names.length; i++) ld().markSeen(cur, names[i]);
                log(where + ': took ' + took + '; ' + grids.length + ' grid(s) done');
                return;
            }
            ld().markSeen(cur, firstPart);
            ld().marked(cur, firstPart).taken = given0 + took;
            for (i = 0; i < names.length; i++) ld().markSeen(cur, names[i]);
            var text = where + ': took ' + took + ' of ' + goal +
                (took > goal ? ' (more than the ' + goal + ' needed)' : '') +
                '; ' + grids.length + ' grid(s) done';
            if (took < goal) {
                S.kernel.warn(CATEGORY, st().label() + ': ' + text +
                    '; the grids took what they needed, nothing more is sent');
                return;
            }
            log(text);
        };
    }

    // Whether the island is quiet for the item wait: nothing unread, nothing
    // to claim, and no quest object left when collect picks them up here.
    function questsQuiet() {
        var un = wt().unread();
        var pend = wt().pending();
        if (!un || un.length || !pend || pend.length) return false;
        if (wt().patterns() === null) return true;
        var objs = islandObjects(null);
        return !!objs && !objs.length;
    }

    // The grids of the burst that the entry key's failed Apply round
    // expected, from its apply mark names, so a pause names every grid the
    // burst was for. fallback is the failed mark's grid.
    function burstGrids(r, key, fallback) {
        var round = ld().currentRound(r, S.RunStep.Apply);
        var out = [];
        if (round) {
            for (var k in round.expected) {
                if (!has(round.expected, k) || k.indexOf(APPLY) !== 0) continue;
                var p = parseApply(k);
                if (p.key === key) out.push(p.grid);
            }
        }
        return out.length ? out.join(',') : fallback;
    }

    // Apply (island). One burst per round, so its check reads the stock drop
    // of that burst alone.
    function apply(r) {
        var RS = S.RunStep;
        if (!islandViewed(r)) return;
        var trip = (r.trips || [])[r.trip];
        var items = trip && trip.items ? trip.items : [];
        if (!items.length) {
            st().go(RS.Trip, 'visit only');
            return;
        }

        var open = isOpen(r, r.trip);
        var keys = [];
        var openOf = [];
        var pending = [];
        var any = false;
        var i, g;
        for (i = 0; i < items.length; i++) {
            keys.push(entryKey(items, i));
            var grids = [];
            for (g = 0; g < items[i].grids.length; g++) {
                var grid = items[i].grids[g];
                if (!open(items[i], grid)) continue;
                grids.push(grid);
                var name = applyMark(r, keys[i], grid);
                var m = ld().marked(r, name);
                if (m && typeof m.sentAt === 'number') pending.push(name);
            }
            openOf.push(grids);
            if (grids.length) any = true;
        }
        if (!any) {
            st().go(RS.Trip, 'items applied');
            return;
        }

        ld().dropShown(r, RS.Apply, pending);
        for (i = 0; i < pending.length; i++) {
            var pp = parseApply(pending[i]);
            var it = itemOf(items, pp.key);
            var s = ld().staleMark(r, pending[i], 'item ' + it.buff + ' -> ' + pp.grid);
            if (s === 'wait') return;
            if (s === 'stale') {
                var w = want(r, it, Number(pp.grid), null);
                if (w === null) {
                    ld().waitRead(r, 'quests');
                    return;
                }
                if (w === 'done') {
                    ld().markSeen(r, pending[i]);
                    log('quest no longer wants ' + it.buff + '; send to ' + pp.grid + ' counted');
                    return;
                }
                st().pause(S.RunPause.NotObserved, 'item ' + it.buff + ' sent to ' + pp.grid +
                    ' but not seen; check the star menu, then Resume');
                return;
            }
        }

        var next = ld().settleRound(r, RS.Apply, function (f) {
            var fp = f.key.indexOf(APPLY) === 0 ? parseApply(f.key) : null;
            var ft = fp ? itemOf(items, fp.key).buff + ' to ' + burstGrids(r, fp.key, fp.grid) : f.key + ' to ?';
            st().pause(S.RunPause.BuffFailed, 'apply ' + ft + ' failed: ' + f.reason);
        }, 'item apply');
        if (next !== 'new') return;

        closeFinished(r, items, openOf, pending);

        // A quest read or claimed here shows the next quest some seconds
        // later; until then a want read could send to the wrong quest or
        // close a grid for good, so nothing is decided.
        if (questSettling(r)) {
            ld().waitBusy(r, null, 'waiting for the quests to settle after a quest read or claim');
            return;
        }
        // The server is given BURST_GAP_MS after a burst before the next one;
        // the burst's own check usually covers it, a reload or a burst that
        // sent nothing does not.
        var lb = lastBurstAt(r);
        if (lb !== null && now() - lb < BURST_GAP_MS) {
            ld().waitBusy(r, null, 'waiting ' + Math.ceil((BURST_GAP_MS - (now() - lb)) / 1000) +
                ' s after the last item burst');
            return;
        }

        var target = null;
        var waitItem = null;
        var held = [];
        var shorts = [];
        // Grids an earlier out-of-stock item still owes: a later item on the
        // same grid waits until that item is done there, so the file order on
        // a shared grid holds while other grids go on.
        var blocked = {};
        // Grids, as buff:grid, an earlier entry of a buff still has open: a
        // later entry of that buff waits there, so the file order holds even
        // when the two entries are bound to different quests.
        var owed = {};
        for (i = 0; i < items.length; i++) {
            if (!openOf[i].length) continue;
            var buff = items[i].buff;
            var key = keys[i];
            // Asked per grid: a quest matched by the building at the grid
            // can be done for one boulder kind while the item's grids of
            // another kind are still wanted, so a done grid skips only itself,
            // and a grid whose quest is not running yet waits for a later
            // burst while the open ones go now.
            var burst = [];
            var later = [];
            var skipped = 0;
            var doneHere = {};
            for (g = 0; g < openOf[i].length; g++) {
                var w2 = want(r, items[i], openOf[i][g], held);
                if (w2 === 'done') {
                    ld().markSeen(r, applyMark(r, key, openOf[i][g]));
                    doneHere[openOf[i][g]] = true;
                    skipped++;
                    continue;
                }
                if (w2 === null) {
                    ld().waitRead(r, 'quests');
                    return;
                }
                if (has(blocked, openOf[i][g])) continue;
                if (has(owed, buff + ':' + openOf[i][g])) continue;
                if (w2 === 'open') burst.push(openOf[i][g]);
                else later.push(openOf[i][g]);
            }
            for (g = 0; g < openOf[i].length; g++) {
                if (!has(doneHere, openOf[i][g])) owed[buff + ':' + openOf[i][g]] = true;
            }
            if (skipped) log('quest no longer wants ' + buff + '; ' + skipped + ' grid(s) skipped');
            if (!burst.length) {
                if (later.length && waitItem === null) waitItem = items[i];
                continue;
            }
            var sk = S.core.buffs.stack(buff, '');
            if (!sk || typeof sk.total !== 'number') {
                ld().waitRead(r, 'item stock');
                return;
            }
            var largest = typeof sk.largest === 'number' ? sk.largest : sk.total;
            var isShort = false;
            var t = null;
            if (items[i].amount !== null) {
                // Every packet of the burst offers what the trip still needs
                // and draws on the same entry, so one stack must hold it.
                var remaining = stillNeeded(r, items[i], key, burst[0]);
                if (remaining <= 0) {
                    for (g = 0; g < burst.length; g++) ld().markSeen(r, applyMark(r, key, burst[g]));
                    log(buff + ': amount already taken; ' + burst.length + ' grid(s) done');
                    return;
                }
                if (sk.total < remaining) {
                    isShort = true;
                } else if (largest < remaining) {
                    st().pause(S.RunPause.BuffFailed, 'apply ' + buff + ' to ' + burst.join(',') +
                        ' failed: no single stack of ' + remaining + ' (largest ' + largest + ', stock ' +
                        sk.total + '); a burst sends from one stack');
                    return;
                } else {
                    t = { item: items[i], grids: burst, offer: remaining, need: remaining, cut: null };
                }
            } else {
                // 1 per grid, at most as many grids as the largest stack holds,
                // so the entry never runs dry in the middle of the burst.
                var still = [];
                var full = 0;
                for (g = 0; g < burst.length; g++) {
                    if (stillNeeded(r, items[i], key, burst[g]) > 0) {
                        still.push(burst[g]);
                        continue;
                    }
                    ld().markSeen(r, applyMark(r, key, burst[g]));
                    full++;
                }
                if (full) {
                    log(buff + ': ' + full + ' grid(s) already took theirs; grid(s) done');
                    return;
                }
                if (!(largest > 0)) {
                    isShort = true;
                } else {
                    var cut = still.slice(0, Math.min(still.length, largest));
                    t = { item: items[i], grids: cut, offer: 1, need: cut.length,
                        cut: cut.length < still.length ? still.length : null };
                }
            }
            if (isShort) {
                shorts.push({ buff: buff, left: burst.length });
                for (g = 0; g < openOf[i].length; g++) {
                    if (!has(doneHere, openOf[i][g])) blocked[openOf[i][g]] = true;
                }
                continue;
            }
            t.key = key;
            t.stock = sk.total;
            t.largest = largest;
            t.later = later;
            target = t;
            break;
        }

        // Out of a wanted item and nothing else can go: home for more now,
        // since a held item's quest may never run before that item is applied.
        if (!target && shorts.length) {
            for (i = 0; i < shorts.length; i++) {
                log('out of ' + shorts[i].buff + ' with ' + shorts[i].left + ' grid(s) left; going home for more');
            }
            newLeg(r);
            st().go(RS.JumpHome, 'out of ' + shorts[0].buff);
            return;
        }
        if (target && shorts.length) {
            var sb = [];
            for (i = 0; i < shorts.length; i++) sb.push(shorts[i].buff);
            noteOnce(r, 'short:' + sb.join(','), 'out of ' + sb.join(', ') +
                '; continuing with the other items first');
        }

        if (!target) {
            if (waitItem === null) {
                st().go(RS.Trip, 'items applied');
                return;
            }
            // The watcher reads unread quests meanwhile, so they come to run.
            if (held.length) {
                var ht = heldText(held);
                noteOnce(r, 'held:' + ht, waitItem.buff + ': ' + ht);
            }
            var q = ld().quietClock(r, questsQuiet(), 'applyClock');
            var wq = waitItem.quest || null;
            var qt = S.modules.adventures.away.quietText(q, APPLY_QUIET_MS);
            ld().waitBusy(r, null, wq ?
                'waiting for quest ' + wq + ' for ' + waitItem.buff + ', ' + qt :
                'waiting for a quest that wants ' + waitItem.buff + ', ' + qt);
            if (q.ms < APPLY_QUIET_MS) return;
            var mins = S.kernel.text.minutes(APPLY_QUIET_MS);
            st().pause(S.RunPause.NotObserved, wq ?
                'quest ' + wq + ' does not want ' + waitItem.buff + ' after ' + mins +
                    ' min; check the quest book, then Resume' :
                'no open quest wants ' + waitItem.buff + ' after ' + mins +
                    ' min; check the quest book, then Resume');
            return;
        }

        var b = target.item.buff;
        var k = target.key;
        var tg = target.grids;
        var names = [];
        for (g = 0; g < tg.length; g++) names.push(applyMark(r, k, tg[g]));
        // A burst that made no host call left its grids open. The count
        // resets before the pause, so a Resume gets fresh tries; the gap gives
        // a passing bridge glitch time to clear before the next try.
        var tries = false;
        var recent = false;
        for (g = 0; g < names.length; g++) {
            var nm = ld().marked(r, names[g]);
            if (nm && nm.notSent >= NOT_SENT_MAX) tries = true;
            if (nm && typeof nm.notSentAt === 'number' && now() - nm.notSentAt < NOT_SENT_RETRY_MS) recent = true;
        }
        if (tries) {
            for (g = 0; g < names.length; g++) {
                var rm = ld().marked(r, names[g]);
                if (rm) rm.notSent = 0;
            }
            st().save();
            st().pause(S.RunPause.BuffFailed, 'apply ' + b + ' to ' + tg.join(',') + ' failed: nothing sent after ' +
                NOT_SENT_MAX + ' tries; see the log for the reason');
            return;
        }
        if (recent) {
            ld().waitBusy(r, null, 'item ' + b + ' -> ' + tg.join(',') + ' not sent, trying again');
            return;
        }
        var q0 = S.core.production.queuedItems(b);
        // The grids as the burst was decided on: the burst refuses (NOT_SENT)
        // if another building stands at any of them by the time it runs.
        // The entries lines go out here, before the action is queued, so
        // nothing is logged between the packets.
        var cur = [];
        for (g = 0; g < tg.length; g++) {
            var seen = gridSeen(r, tg[g]);
            cur.push(seen.cur);
            log(sendNote(b, tg[g], seen));
        }
        log('apply ' + b + ' x' + target.offer + ' -> ' + tg.join(',') + ' (stock ' + target.stock +
            ', need ' + target.need +
            (target.largest < target.stock ? ', largest ' + target.largest : '') +
            (target.cut !== null ? ', cut to ' + tg.length + ' of ' + target.cut + ' grids' : '') +
            (target.later.length ? '; ' + target.later.join(',') + ' left for a later burst' : '') + ')');
        // A send is progress: the next item wait starts its quiet time afresh.
        st().current().applyClock = null;
        var def = S.core.buffs.adventureBurst(b, tg, target.offer,
            { need: target.need, buildings: cur, quietMs: BURST_GAP_MS });
        var round = ld().startRound(r, RS.Apply, []);
        ld().attempt(round, names, ld().wrapSend(r, names, def),
            burstApplied(names, b, tg, target.offer, target.need, partMark(r, k, tg[0]),
                gridTaken(r, k, tg[0]), q0, def));
    }

    // Closes the open grids nothing is left to send to, before a target is
    // picked: every grid of an item whose grids together took its trip total,
    // and a grid that took something whose building is gone since (a send
    // that took less than offered, or a building removed a moment after the
    // check). A pending grid is left alone: its send's check may still drop
    // or set its mark. openOf loses the closed grids.
    function closeFinished(r, items, openOf, pending) {
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var key = entryKey(items, i);
            var grids = openOf[i];
            if (!grids.length) continue;
            var busy = false;
            var g;
            for (g = 0; g < grids.length; g++) {
                if (pending.indexOf(applyMark(r, key, grids[g])) !== -1) busy = true;
            }
            if (item.amount !== null && !busy && tripTaken(r, item, key) >= item.amount) {
                for (g = 0; g < grids.length; g++) ld().markSeen(r, applyMark(r, key, grids[g]));
                log(item.buff + ': trip total ' + item.amount + ' taken; ' + grids.length + ' grid(s) done');
                openOf[i] = [];
                continue;
            }
            var keep = [];
            for (g = 0; g < grids.length; g++) {
                var an = applyMark(r, key, grids[g]);
                var taken = gridTaken(r, key, grids[g]);
                if (pending.indexOf(an) === -1 && taken > 0 && buildingGone(r, grids[g])) {
                    ld().markSeen(r, an);
                    log(item.buff + ' -> ' + grids[g] + ': building gone after ' + taken + '; grid done');
                    continue;
                }
                keep.push(grids[g]);
            }
            openOf[i] = keep;
        }
    }

    // ---- Trip ---------------------------------------------------------------

    // A finished trip leaves no per-trip state behind.
    function leave(r, n) {
        ld().dropMark(r, SHORT + r.trip);
        ld().dropMark(r, REVISIT + r.trip);
        var done = r.trip + 1;
        r.trip = done;
        newLeg(r);
        st().go(S.RunStep.JumpHome, 'trip ' + done + '/' + n + ' done');
    }

    // A quest read or claimed on the island shows its map objects and the
    // next quest some seconds later, so an empty read right after it proves
    // nothing yet.
    function questSettling(r) {
        var c = wt().changedAt(r.zoneId);
        return typeof c === 'number' && now() - c < QUEST_SETTLE_MS;
    }

    // Pick-ups are left after lim and the next trip is short (short is
    // Produce's text): go home and back, which reloads the island and may
    // show an object the client did not place, without advancing the trip;
    // the stock-out chain brings the run back here. After TRIP_REVISITS
    // re-visits the run pauses on the island, where the user can collect
    // them; the count resets first so a Resume gets fresh re-visits.
    function revisit(r, text, short, lim) {
        var name = REVISIT + r.trip;
        var m = ld().marked(r, name);
        var k = m && typeof m.count === 'number' ? m.count : 0;
        if (k >= TRIP_REVISITS) {
            m.count = 0;
            st().save();
            st().pause(S.RunPause.NotObserved, text + ' still left after ' + TRIP_REVISITS +
                ' re-visits; the next trip is short of ' + short + '; collect them, then Resume');
            return;
        }
        k++;
        ld().markSeen(r, name);
        ld().marked(r, name).count = k;
        st().save();
        log(text + ' after ' + S.kernel.text.minText(lim) + '; next trip short of ' + short +
            '; going home and back to reload the island (' + k + '/' + TRIP_REVISITS + ')');
        newLeg(r);
        st().go(S.RunStep.JumpHome, 're-visit ' + k + '/' + TRIP_REVISITS);
    }

    // Trip (island). The last trip hands over to Clear, which waits for the
    // last quest and the quest objects itself.
    function trip(r) {
        var n = (r.trips || []).length;
        if (r.trip + 1 >= n) {
            r.trip = n;
            st().go(S.RunStep.Clear, 'last trip done');
            return;
        }
        if (!islandViewed(r)) return;
        if (now() - r.since < tripSettleMs() || questSettling(r)) {
            ld().waitBusy(r, null, 'letting the quests update');
            return;
        }
        var un = wt().unread();
        var pend = wt().pending();
        // Objects whose quest is not running are not clicked; they still
        // count as left, since reading the quest makes them clickable. A
        // running quest's pick-up with no object on the map yet counts as
        // left too: its objects show some time after the quest is read.
        var held = [];
        var awaited = [];
        var objs = [];
        if (wt().patterns() !== null) {
            // A spawned object must show in this read, not in a cached list.
            S.core.buildings.invalidate();
            objs = islandObjects(held, awaited);
        }
        if (un === null || pend === null || objs === null) {
            ld().waitRead(r, 'quests or quest objects');
            return;
        }
        if (!un.length && !pend.length && !objs.length && !held.length && !awaited.length) {
            // The map must read clear for a settle time: the finished quest
            // may not be claimable yet, or a claim's next quest may not show
            // yet, right after the last pick-up.
            var seen = st().current().tripSeenAt;
            if (typeof seen === 'number' && seen >= r.since && now() - seen < tripSettleMs()) {
                ld().waitBusy(r, null, 'making sure no quest or object is left');
                return;
            }
            leave(r, n);
            return;
        }
        st().current().tripSeenAt = now();
        var noteKey = [];
        var notes = [];
        if (held.length) {
            noteKey.push('held:' + heldText(held));
            notes.push(wt().pickupText(held) + ': ' + heldText(held));
        }
        if (awaited.length) {
            noteKey.push('awaited:' + wt().pickupText(awaited));
            notes.push(wt().pickupText(awaited) + ': waiting for it to appear on the map');
        }
        if (notes.length) noteOnce(r, noteKey.join('|'), notes);
        var parts = [];
        if (un.length) parts.push(un.length + ' unread');
        if (pend.length) parts.push(pend.length + ' to claim');
        if (objs.length) parts.push(wt().pickupText(objs));
        if (held.length) parts.push(held.length + ' waiting for a running quest');
        if (awaited.length) parts.push(wt().pickupText(awaited) + ' not on the map yet');
        var text = parts.join(', ');
        var p = S.modules.adventures.away.pickupClock(r, objs.concat(held).concat(awaited));
        // A pick-up left behind may be what the next trip is short of, so it
        // is not given up on the plain limit. One not on the map yet (dead
        // crops, say) sometimes shows only after a zone reload, so it gets
        // the shorter wait.
        var sm = ld().marked(r, SHORT + r.trip);
        var owed = objs.length + held.length + awaited.length;
        if (sm && owed) {
            var lim = awaited.length ? TRIP_REVISIT_MS : TRIP_MAX_MS;
            if (p.ms >= lim) {
                revisit(r, text, sm.text, lim);
                return;
            }
            ld().waitBusy(r, null, 'quests and objects left: ' + text + ', ' +
                S.modules.adventures.away.quietText(p, lim));
            return;
        }
        if (p.ms >= TRIP_MAX_MS) {
            log('leaving with: ' + text);
            leave(r, n);
            return;
        }
        ld().waitBusy(r, null, 'quests and objects left: ' + text + ', ' +
            S.modules.adventures.away.quietText(p, TRIP_MAX_MS));
    }

    S.modules.adventures.trips = {
        PRODUCE_RETRY_MS: PRODUCE_RETRY_MS,
        MAKE_LOST_MS:     MAKE_LOST_MS,
        APPLY_QUIET_MS:   APPLY_QUIET_MS,
        TRIP_MAX_MS:      TRIP_MAX_MS,
        QUEST_SETTLE_MS:  QUEST_SETTLE_MS,
        TRIP_REVISIT_MS:  TRIP_REVISIT_MS,
        TRIP_REVISITS:    TRIP_REVISITS,
        NOT_SENT_MAX:     NOT_SENT_MAX,
        NOT_SENT_RETRY_MS: NOT_SENT_RETRY_MS,
        BURST_GAP_MS:     BURST_GAP_MS,
        produce:         produce,
        apply:            apply,
        trip:             trip,
        applyMark:        applyMark,
        scenarioViewed:   scenarioViewed
    };

}(Steward));
