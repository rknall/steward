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
 * runs. It waits only until the current trip's items are in the star menu.
 * An order that fails or does not show in the queue is tried again after a
 * while and never pauses the run: only missing resources do.
 *
 * Apply sends the items of the trip one grid per round, and only while a
 * running quest wants the item (core/quests.js itemWant with opts.running):
 * a quest that is unread, not yet started or in any mode other than running
 * is never sent to, and the wait for it is logged once. A quest also wants
 * the item when its open type-1 trigger, not a click trigger, names the
 * building standing at the grid: such a quest takes the item without naming
 * it. So does its open item-action end condition (onmap, buildingdestroyed)
 * naming that building, as a quest that asks for the boulders dynamite
 * clears. The want is asked per grid: a grid whose quest condition is met is
 * skipped on its own while the item's other grids still go. Each grid has a
 * persisted send marker, so a reload never sends to it twice. An item's
 * amount is its total for the trip over all its grids (an item without one
 * takes 1 per grid). The game may take less than it is offered, so only the
 * stock drop of a verified send counts: a seen 'part:' marker records what
 * each grid has taken so far, and while the item's grids together are short
 * of the amount the grid stays open and the rest is offered to the same grid
 * next, until the item has taken the amount, the quest no longer wants the
 * item, a send shows no drop at all (the grid was already full), or the
 * building first seen at the grid is gone or being destroyed after the grid
 * took something (nothing is left there to take more). Out of stock, Apply
 * first sends the other items a running quest wants that are in stock; a
 * grid the out-of-stock item still owes is held back from every later item,
 * so the file order on a shared grid holds. Once nothing else can go the run
 * goes home for more and comes back to the same trip, rather than wait on
 * items no running quest wants yet. A send that made no host call (nothing
 * went out) keeps its grid open and is tried again after NOT_SENT_RETRY_MS,
 * up to NOT_SENT_MAX times per grid, then pauses.
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
    var APPLY_QUIET_MS   = 600000;   // quiet time a quest gets to want an item
    var TRIP_MAX_MS      = 300000;   // quiet time a trip waits for quests and objects
    var QUEST_SETTLE_MS  = 20000;    // settle after a quest read or claim on the island
    var TRIP_REVISIT_MS  = 120000;   // quiet time an awaited pick-up gets before a re-visit, next trip short
    var TRIP_REVISITS    = 2;        // re-visits per trip before a pause
    var NOT_SENT_MAX     = 3;        // no-packet sends per grid before a pause
    var NOT_SENT_RETRY_MS = 10000;   // gap after a no-packet send before the next try to that grid

    var CATEGORY = 'adventures';

    // Mark name prefixes: one mark per item ordered, one per grid sent to,
    // and one per grid that took something (written seen, never sent; its
    // taken field is what the grid has taken so far, so the item's part
    // marks together hold what the trip has taken of it). One
    // per trip holds Produce's verdict that the next trip waits for
    // resources (seen, its text the shortfall), since the island cannot read
    // the home queues; one per trip counts the re-visits taken (seen, count).
    var MAKE    = 'make:';
    var APPLY   = 'apply:';
    var PART    = 'part:';
    var SHORT   = 'short:';
    var REVISIT = 'revisit:';

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

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

    // ---- Marks --------------------------------------------------------------

    function gridName(prefix, tripIndex, buff, grid) {
        return prefix + tripIndex + ':' + buff + ':' + grid;
    }

    function applyMark(r, buff, grid) {
        return gridName(APPLY, r.trip, buff, grid);
    }

    function partMark(r, buff, grid) {
        return gridName(PART, r.trip, buff, grid);
    }

    // The part mark that belongs to an apply mark: the same trip, buff and
    // grid under the other prefix.
    function partOf(applyName) {
        return PART + applyName.slice(APPLY.length);
    }

    // { buff, grid } of an apply mark name. The grid follows the last ':',
    // the buff the trip index.
    function parseApply(name) {
        var rest = name.slice(APPLY.length);
        var a = rest.indexOf(':');
        var b = rest.lastIndexOf(':');
        return { buff: rest.slice(a + 1, b), grid: rest.slice(b + 1) };
    }

    // isOpen(item, grid) for scenarios.tripNeeds: a grid waits while the
    // apply mark of that trip, buff and grid is not seen.
    function isOpen(r, tripIndex) {
        return function (item, grid) {
            var m = ld().marked(r, gridName(APPLY, tripIndex, item.buff, grid));
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

    function orderRuns(r, list, info) {
        var round = ld().startRound(r, S.RunStep.Produce, []);
        for (var i = 0; i < list.length; i++) {
            var b = list[i].unit;
            var runs = list[i].count;
            var name = MAKE + b;
            log('producing: ' + b + ' x' + (runs * info[b].y) + ' (' + runs + ' run(s))');
            ld().attempt(round, name, ld().wrapSend(r, name, S.core.production.order(b, runs)),
                ld().seenOnVerified(name));
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

    function haveText(thisNeed, info) {
        var out = [];
        for (var b in thisNeed) {
            if (has(thisNeed, b)) out.push(b + ' ' + info[b].stock + '/' + thisNeed[b]);
        }
        out.sort();
        return out.join(', ');
    }

    // Produce (home). Production runs yield y items each, so a need in items
    // becomes ceil(items / y) runs. A queued run counts as items on the way.
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

        var runsThis = {};
        var runsAll = {};
        for (k = 0; k < buffs.length; k++) {
            b = buffs[k];
            var it = info[b];
            var mine = has(thisNeed, b) ? thisNeed[b] : 0;
            var next = has(nextNeed, b) ? nextNeed[b] : 0;
            runsThis[b] = Math.ceil(Math.max(0, mine - it.stock - it.q) / it.y);
            runsAll[b] = Math.ceil(Math.max(0, mine + next - it.stock - it.q) / it.y);
        }
        // An order that reached the queue drops out of the plan, and its mark
        // with it.
        var drop = [];
        for (var name in (r.marks || {})) {
            if (!has(r.marks, name) || name.indexOf(MAKE) !== 0) continue;
            var mb = name.substring(MAKE.length);
            if (!(has(runsAll, mb) && runsAll[mb] > 0)) drop.push(name);
        }
        for (k = 0; k < drop.length; k++) ld().dropMark(r, drop[k]);
        var all = orderList(runsAll);
        for (k = 0; k < all.length; k++) {
            b = all[k].unit;
            var s = ld().staleMark(r, MAKE + b, 'order of ' + b, { seen: true });
            if (s === 'wait') return;
            if (s === 'stale') {
                // The queue limits of a production building are not known, so
                // an order that never showed is planned again, never paused on.
                log('order of ' + b + ' not seen in the queue after ' +
                    Math.round(ld().ORDER_WAIT_MS / 60000) + ' min, ordering again');
                ld().dropMark(r, MAKE + b);
                return;
            }
        }

        var ready = true;
        for (b in thisNeed) {
            if (has(thisNeed, b) && info[b].stock < thisNeed[b]) ready = false;
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
        if (list.length) {
            orderRuns(r, list, info);
            return;
        }
        if (ready) {
            var left = [];
            for (name in (r.marks || {})) {
                if (has(r.marks, name) && name.indexOf(MAKE) === 0) left.push(name);
            }
            for (k = 0; k < left.length; k++) ld().dropMark(r, left[k]);
            st().go(RS.StartMap, 'items ready');
            return;
        }
        ld().waitBusy(r, null, 'waiting for production: ' + haveText(thisNeed, info));
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

    // Whether the building first seen at grid is gone: no named building
    // stands there now, or the one there is being destroyed. A grid never
    // named on this run and trip is never gone, since there is nothing to
    // tell its building's end by (and after a reload that memory is empty).
    function buildingGone(r, grid) {
        var s = gridSeen(r, grid);
        if (!s.first) return false;
        if (s.cur === '') return true;
        var bs = null;
        try {
            bs = S.core.buildings.buffState(s.b);
        } catch (e) {
            bs = null;
        }
        var list = bs && bs.blockers ? bs.blockers : [];
        for (var i = 0; i < list.length; i++) {
            if (list[i].method === 'IsInDestruction' && list[i].value === true) return true;
        }
        return false;
    }

    // What grid has taken of buff on this trip so far (its part mark).
    function gridTaken(r, buff, grid) {
        var pm = ld().marked(r, partMark(r, buff, grid));
        return pm && typeof pm.taken === 'number' ? pm.taken : 0;
    }

    // What the item's grids together have taken on this trip so far.
    function tripTaken(r, item) {
        var sum = 0;
        for (var i = 0; i < item.grids.length; i++) sum += gridTaken(r, item.buff, item.grids[i]);
        return sum;
    }

    // What a send of the item to grid may still offer: the rest of the
    // item's trip total when it has an amount, else the rest of the grid's 1.
    function stillNeeded(r, item, grid) {
        var bound = sc().sendAmount(item);
        if (item.amount !== null) return bound - tripTaken(r, item);
        return bound - gridTaken(r, item.buff, grid);
    }

    // itemWant under the strict gate, for a send of buff to grid; the one place
    // that composes the gate call. held gets the quests that want the item but
    // are not running yet. Apply runs only while the run's island is viewed,
    // so the building at grid is read in the viewed zone.
    function want(r, buff, grid, held) {
        return S.core.quests.itemWant(buff, S.core.buffs.targetsOf(buff),
            { running: true, held: held, buildings: gridBuildings(r, grid) });
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

    // A top-up send to a grid that took less than the amount before (a
    // stock-capped send, or a remainder after a short take) and then shows no
    // stock drop at all: the grid was already full. Counted done without a
    // pause, and the round dropped so the stale wait and settleRound never
    // see it.
    function topUpNotTaken(r) {
        var round = ld().currentRound(r, S.RunStep.Apply);
        if (!round || !ld().complete(round)) return;
        var keys = [];
        for (var k in round.expected) {
            if (!has(round.expected, k)) continue;
            var res = ld().resultOf(round, k);
            if (!res || res.status === S.ActionResult.Verified) continue;
            if (res.unseen !== true || k.indexOf(APPLY) !== 0) return;
            var pm = ld().marked(r, partOf(k));
            if (!pm || !pm.seen) return;
            keys.push(k);
        }
        if (!keys.length) return;
        for (var i = 0; i < keys.length; i++) {
            var p = parseApply(keys[i]);
            ld().markSeen(r, keys[i]);
            log(p.buff + ' -> ' + p.grid + ': took nothing more; grid done');
        }
        st().dropRound('top-up not taken');
    }

    // The onDone follow-up of a send, on the current run like seenOnVerified.
    // Only a verified send decides here; the step reads any other result.
    // took is the stock drop the send's check saw, plus the queued items that
    // landed in the star menu during the send, which raised the stock. given
    // is what the grid had taken before this send, and before what the goal
    // (the item's trip total, or the grid's 1) had got by then. Every take is
    // added to the grid's part mark, so the item's marks sum to its trip
    // total. A send that met the goal is done; one still short stays open, so
    // the next round offers the rest, unless the grid took all it was offered
    // and its building is gone (nothing left there to take more). A take of
    // nothing ends the grid as before, so a grid is never offered forever.
    function applied(name, part, b, grid, offered, goal, before, given, q0, def) {
        return function (result, cur) {
            if (!result || result.status !== S.ActionResult.Verified) return;
            var took = def.dropped();
            var q1 = S.core.production.queuedItems(b);
            if (typeof took === 'number' && typeof q0 === 'number' && typeof q1 === 'number' && q1 < q0) {
                took += q0 - q1;
            }
            if (took === null || !(took > 0)) {
                ld().markSeen(cur, name);
                log(b + ' -> ' + grid + ': took ' + took + ' of ' + offered + '; grid done');
                return;
            }
            ld().markSeen(cur, part);
            ld().marked(cur, part).taken = given + took;
            st().save();
            var sofar = before + took;
            if (sofar >= goal) {
                ld().markSeen(cur, name);
                log(b + ' -> ' + grid + ': took ' + took + ' of ' + offered + '; grid done');
                return;
            }
            if (took >= offered && buildingGone(cur, grid)) {
                ld().markSeen(cur, name);
                log(b + ' -> ' + grid + ': took all ' + offered + ' offered; building gone, grid done');
                return;
            }
            ld().dropMark(cur, name);
            if (took >= offered) {
                log(b + ' -> ' + grid + ': took all ' + offered + ' offered (' + sofar + ' of ' + goal +
                    ' so far); grid stays open');
            } else {
                log(b + ' -> ' + grid + ': took ' + took + ' of ' + offered + ', ' + sofar + ' of ' + goal +
                    ' so far; sending the other ' + (goal - sofar));
            }
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

    // Apply (island). One grid per round, so each check reads the stock drop
    // of its own send.
    function apply(r) {
        var RS = S.RunStep;
        if (!islandViewed(r)) return;
        var trip = (r.trips || [])[r.trip];
        var items = trip && trip.items ? trip.items : [];
        if (!items.length) {
            st().go(RS.Trip, 'visit only');
            return;
        }
        // Before any stale wait, so a top-up that took nothing never waits
        // the order time or pauses.
        topUpNotTaken(r);

        var open = isOpen(r, r.trip);
        var openOf = [];
        var pending = [];
        var any = false;
        var i, g;
        for (i = 0; i < items.length; i++) {
            var grids = [];
            for (g = 0; g < items[i].grids.length; g++) {
                var grid = items[i].grids[g];
                if (!open(items[i], grid)) continue;
                grids.push(grid);
                var name = applyMark(r, items[i].buff, grid);
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

        // A grid re-opened after a short or capped send has no apply mark, so it is
        // not pending and its round is dropped as shown, not counted.
        ld().dropShown(r, RS.Apply, pending);
        for (i = 0; i < pending.length; i++) {
            var pp = parseApply(pending[i]);
            var s = ld().staleMark(r, pending[i], 'item ' + pp.buff + ' -> ' + pp.grid);
            if (s === 'wait') return;
            if (s === 'stale') {
                var w = want(r, pp.buff, Number(pp.grid), null);
                if (w === null) {
                    ld().waitRead(r, 'quests');
                    return;
                }
                if (w === 'done') {
                    ld().markSeen(r, pending[i]);
                    log('quest no longer wants ' + pp.buff + '; send to ' + pp.grid + ' counted');
                    return;
                }
                st().pause(S.RunPause.NotObserved, 'item ' + pp.buff + ' sent to ' + pp.grid +
                    ' but not seen; check the star menu, then Resume');
                return;
            }
        }

        var next = ld().settleRound(r, RS.Apply, function (f) {
            var fp = f.key.indexOf(APPLY) === 0 ? parseApply(f.key) : { buff: f.key, grid: '?' };
            st().pause(S.RunPause.BuffFailed, 'apply ' + fp.buff + ' to ' + fp.grid + ' failed: ' + f.reason);
        }, 'item apply');
        if (next !== 'new') return;

        closeFinished(r, items, openOf, pending);

        var target = null;
        var waitFor = null;
        var held = [];
        var shorts = [];
        // Grids an earlier out-of-stock item still owes: a later item on the
        // same grid waits until that item is done there, so the file order on
        // a shared grid holds while other grids go on.
        var blocked = {};
        for (i = 0; i < items.length; i++) {
            if (!openOf[i].length) continue;
            var buff = items[i].buff;
            // Asked per grid: a quest matched by the building at the grid
            // can be done for one boulder kind while the item's grids of
            // another kind are still wanted, so a done grid skips only itself.
            var wants = 'done';
            var at = null;
            var skipped = 0;
            var doneHere = {};
            for (g = 0; g < openOf[i].length; g++) {
                var w2 = want(r, buff, openOf[i][g], held);
                if (w2 === 'done') {
                    ld().markSeen(r, applyMark(r, buff, openOf[i][g]));
                    doneHere[openOf[i][g]] = true;
                    skipped++;
                    continue;
                }
                if (w2 === null) {
                    wants = null;
                    break;
                }
                if (has(blocked, openOf[i][g])) continue;
                wants = w2;
                at = openOf[i][g];
                break;
            }
            if (skipped) log('quest no longer wants ' + buff + '; ' + skipped + ' grid(s) skipped');
            if (wants === null) {
                ld().waitRead(r, 'quests');
                return;
            }
            if (at === null) continue;
            if (wants === 'open') {
                var have = S.core.buffs.stock(buff, '');
                if (typeof have !== 'number') {
                    ld().waitRead(r, 'item stock');
                    return;
                }
                if (have > 0) {
                    target = { item: items[i], grid: at, stock: have };
                    break;
                }
                shorts.push({ buff: buff, left: openOf[i].length - skipped });
                for (g = 0; g < openOf[i].length; g++) {
                    if (!has(doneHere, openOf[i][g])) blocked[openOf[i][g]] = true;
                }
                continue;
            }
            if (waitFor === null) waitFor = buff;
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
            if (waitFor === null) {
                st().go(RS.Trip, 'items applied');
                return;
            }
            // The watcher reads unread quests meanwhile, so they come to run.
            if (held.length) {
                var ht = heldText(held);
                noteOnce(r, 'held:' + ht, waitFor + ': ' + ht);
            }
            var q = ld().quietClock(r, questsQuiet(), 'applyClock');
            ld().waitBusy(r, null, 'waiting for a quest that wants ' + waitFor + ', ' +
                S.modules.adventures.away.quietText(q, APPLY_QUIET_MS));
            if (q.ms < APPLY_QUIET_MS) return;
            st().pause(S.RunPause.NotObserved, 'no open quest wants ' + waitFor + ' after ' +
                Math.round(APPLY_QUIET_MS / 60000) + ' min; check the quest book, then Resume');
            return;
        }

        var b = target.item.buff;
        var tg = target.grid;
        var an = applyMark(r, b, tg);
        // A send that made no host call left the grid open. The count resets
        // before the pause, so a Resume gets fresh tries; the gap gives a
        // passing bridge glitch time to clear before the next try.
        var nm = ld().marked(r, an);
        if (nm && nm.notSent >= NOT_SENT_MAX) {
            nm.notSent = 0;
            st().save();
            st().pause(S.RunPause.BuffFailed, 'apply ' + b + ' to ' + tg + ' failed: nothing sent after ' +
                NOT_SENT_MAX + ' tries; see the log for the reason');
            return;
        }
        if (nm && typeof nm.notSentAt === 'number' && now() - nm.notSentAt < NOT_SENT_RETRY_MS) {
            ld().waitBusy(r, null, 'item ' + b + ' -> ' + tg + ' not sent, trying again');
            return;
        }
        var pn = partMark(r, b, tg);
        // What the item still needs (its trip total over all its grids, or
        // this grid's 1); the send offers only that, so the item never gets
        // more than its amount.
        var goal = sc().sendAmount(target.item);
        var given = gridTaken(r, b, tg);
        var remaining = stillNeeded(r, target.item, tg);
        if (remaining <= 0) {
            ld().markSeen(r, an);
            log(b + ' -> ' + tg + ': amount already taken; grid done');
            return;
        }
        var stock = target.stock;
        var amount = Math.min(remaining, stock);
        var q0 = S.core.production.queuedItems(b);
        log('apply ' + b + ' x' + amount + ' -> ' + tg + ' (stock ' + stock + ')');
        // A send is progress: the next item wait starts its quiet time afresh.
        st().current().applyClock = null;
        var def = S.core.buffs.adventureItem(b, tg, amount);
        var round = ld().startRound(r, RS.Apply, []);
        ld().attempt(round, an, ld().wrapSend(r, an, def),
            applied(an, pn, b, tg, amount, goal, goal - remaining, given, q0, def));
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
            var grids = openOf[i];
            if (!grids.length) continue;
            var busy = false;
            var g;
            for (g = 0; g < grids.length; g++) {
                if (pending.indexOf(applyMark(r, item.buff, grids[g])) !== -1) busy = true;
            }
            if (item.amount !== null && !busy && tripTaken(r, item) >= item.amount) {
                for (g = 0; g < grids.length; g++) ld().markSeen(r, applyMark(r, item.buff, grids[g]));
                log(item.buff + ': trip total ' + item.amount + ' taken; ' + grids.length + ' grid(s) done');
                openOf[i] = [];
                continue;
            }
            var keep = [];
            for (g = 0; g < grids.length; g++) {
                var an = applyMark(r, item.buff, grids[g]);
                var taken = gridTaken(r, item.buff, grids[g]);
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
        log(text + ' after ' + Math.round(lim / 60000) + ' min; next trip short of ' + short +
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
        APPLY_QUIET_MS:   APPLY_QUIET_MS,
        TRIP_MAX_MS:      TRIP_MAX_MS,
        QUEST_SETTLE_MS:  QUEST_SETTLE_MS,
        TRIP_REVISIT_MS:  TRIP_REVISIT_MS,
        TRIP_REVISITS:    TRIP_REVISITS,
        NOT_SENT_MAX:     NOT_SENT_MAX,
        NOT_SENT_RETRY_MS: NOT_SENT_RETRY_MS,
        produce:          produce,
        apply:            apply,
        trip:             trip,
        applyMark:        applyMark,
        scenarioViewed:   scenarioViewed
    };

}(Steward));
