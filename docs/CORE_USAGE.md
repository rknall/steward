# Using the Core Library

`Steward.core.*` is the general TSO library. Every module uses it; nothing else should. This document is the rulebook for module authors.

## What core gives you

| Namespace            | Purpose                                                      |
|----------------------|--------------------------------------------------------------|
| `Steward.core.zone`        | Current zone identity, navigation, predicates.         |
| `Steward.core.buildings`   | Find, list, classify buildings.                        |
| `Steward.core.specialists` | Find, list, classify, dispatch specialists.            |
| `Steward.core.deposits`    | Find, list deposits.                                  |
| `Steward.core.packets`     | `SendServerAction` and `SendMessagetoServer` wrappers. |
| `Steward.core.locale`      | `loca.GetText` shorthand + safe formatter.            |
| `Steward.core.events`      | Active events and their per-task modifiers.           |
| `Steward.core.adventures`  | Adventure definitions, grouped for the template maker, and the player's own open adventures. |
| `Steward.core.army`        | Free troop pool, squads, composition checks, supply plan. |
| `Steward.core.battles`     | Battle-file loader and validator against the army.    |
| `Steward.core.buffs`       | Star-menu buff stock (including adventure maps), buff definitions and building production buffs. |
| `Steward.core.breaker`     | Run counter and probe cooldown; named instances for the send guard and mining buffs. |
| `Steward.core.actions`     | Runs write actions: send, verify by observation, retry once. |
| `Steward.core.quests`      | Quest pool reads, click-trigger and pick-up names and the claim action. |
| `Steward.core.pickups`     | Clickable quest objects and collectibles of the viewed zone, and the click action. |
| `Steward.core.production`  | Queue profiles and entries per production type, item info, generic order and complete actions, the on/off action, the planner and the demand ledger. |
| `Steward.core.buffing`     | Shared building-buff engine: verified apply, per-grid hold after an unseen apply, one breaker per owner. |
| `Steward.core.construction` | Place and upgrade action defs for one grid, verified by observation, never retried, and `capacity()`, the Result of build-queue slots and building licences. |
| `Steward.core.resources`   | Resource amount and free population reads.            |
| `Steward.core.mail`        | Inbox headers and bodies as Results, shared single-flight refresh, subscribe/news, and verified mail actions: dismiss, trade, own-trade collect, invite; every write held while the game's mail window is open. |

Write actions are defs (plain objects with `precheck`, `send`, `check` and so on) built by the core that owns the action, for example `S.core.army.raise`, `S.core.quests.claim`, `S.core.pickups.click`, `S.core.production.order`, `S.core.mail.dismiss` and `S.core.mail.trade`. They run through `S.core.actions.attempt(def, onDone)`, which verifies by positive observation: a failed read or a missing object never counts as success. Which action to run and when stays with the module; the cores stay policy-free. Readers that defs rely on report a failed read as `null`, never as zero or an empty list. A def may add `observable()`: while it returns false no check runs and the wait does not use up the verify window, up to a fixed cap (`S.core.actions.HOLD_MAX_MS`).

Detailed API per file lives in `docs/analysis/PLAN.md` (P2 file scopes). Once P2 lands, each `core/*.js` source file's IIFE will be the canonical reference.

## Rule 1: don't reach past the helpers

Core returns **raw game objects**. That is intentional — it keeps the layer cheap. But it means it's tempting to chain into game internals from your module:

```js
// BAD — module reaches into the game API directly
if (b.GetGOContainer().mIsAttackable && !b.GetGOContainer().mIsLeaderCamp && b.GetGOContainer().ui !== 'enemy') {
    // ...
}

// GOOD — module asks core
if (Steward.core.buildings.isAttackable(b) && !Steward.core.buildings.isEnemy(b)) {
    // ...
}
```

If a helper you need doesn't exist yet, **add it to core**. Three signs you should:

1. You're about to write the same multi-step expression a second time.
2. The expression depends on game-internal field names (anything starting with `m`, `Get*`, `_`).
3. The expression encodes a meaningful concept (`isCollectible`, `isHome`, `hasArmy`).

Helpers are cheap to add. The cost of *not* adding them — duplicated logic, decay when the game API changes — is high.

## Rule 2: never compare against bare strings

Steward exposes shared enums for everything that has a fixed set of values:

```js
Steward.Building              // BuildingButchers, BuildingBakery, …
Steward.SpecialistType        // SpecialistGeneral, SpecialistCarrier, SpecialistExplorer, SpecialistGeologist
Steward.SpecialistStatus      // StatusIdle, StatusWorking, StatusTraveling, StatusReturning, StatusUnavailable
Steward.SkillModifier         // ModifierSearchTime, ModifierLootRolls, …
Steward.ExplorerTask          // TaskExplorerShort, …
Steward.GeologistTask         // TaskGeologistSearch, …
Steward.Priority              // PriorityCritical, PriorityNormal, PriorityIdle
```

Always use the enum reference at the call site:

```js
// BAD
if (Steward.core.specialists.classify(s) === 'SpecialistCarrier') { /* ... */ }
if (skill.modifier === 'searchtime') { /* ... */ }

// GOOD
if (Steward.core.specialists.classify(s) === Steward.SpecialistType.Carrier) { /* ... */ }
if (skill.modifier === Steward.SkillModifier.SearchTime) { /* ... */ }
```

The values are prefixed strings (`'SpecialistCarrier'`, not `'CARRIER'`) precisely so they're self-explanatory if they ever leak into a log or settings file. Don't undo that by hard-coding them.

## Rule 2.5: settings live in the host's namespace

Steward delegates settings persistence to the host's `settings` object. Every read/write goes through `Steward.kernel.settings.{read,write}` — modules never call `settings.store(...)` directly. Internally the kernel namespaces under `'steward.<module>'` so:

```js
Steward.kernel.settings.write('collect', { enabled: true });
// → host: settings.store({enabled: true}, 'steward.collect')
```

Why: per-profile separation (one settings file per game account, set in host index.html), free dropbox sync, single place to inspect.

## Rule 3: respect the cache contract

`Steward.core.buildings.list()` keeps its snapshot until `Steward.core.buildings.invalidate()` is called. Nothing clears it at the start of a tick, so call `invalidate()` before a read whose freshness matters. `byName` and `byGrid` read the host and are not served from that snapshot.

If your module **mutates the building set** (places a mine, destroys a depleted deposit, upgrades a building), call:

```js
Steward.core.buildings.invalidate();
```

Otherwise subsequent reads will return the stale snapshot.

You don't need to invalidate after server packets that *trigger* an asynchronous mutation — invalidation is for when you've taken an action whose effect you need to see immediately. Most modules never need this.

## Rule 3.5: a specialist read can drop entries

The specialist list leaves out an entry whose members are unreadable for a moment (see the AIR bridge note in `TSO_API.md`). A dropped entry is unknown, not absent:

- `Steward.core.specialists.lookup(key)` returns `ok: false` when the key is missing from a read that dropped entries. `refind` reports the same case with the reason `Steward.core.specialists.UNREADABLE`. Treat both as "try again later".
- A clean read that misses the key is read again, up to `Steward.core.specialists.LOOKUP_CLEAN_MISSES` times in the same call, before `lookup` reports "not listed" (`ok: true, spec: null`). A hit costs one read.
- An empty (falsy) slot in the vector counts as a dropped entry, so a read that holds one is not complete.
- A member of a listed specialist can also vanish between a `typeof` check and the call. The army readers then answer unreadable without a warning (`readGeneralArmy` and `garrisonGrid` return null, `isTravelling` returns false), and the raise, attack and star prechecks refuse with `Steward.core.specialists.UNREADABLE`. A module that calls a member itself should, in its catch, ask `Steward.core.specialists.memberGone(spec, name)` and warn only when it returns false.
- Around a count that drives a decision, read `Steward.core.specialists.dropped()` before and after the read, or check `listComplete()`. A count from a read with drops can be too low.
- Do not pause, or record an entry as gone, on one read. The next tick is the retry.

```js
var before = Steward.core.specialists.dropped();
var list   = Steward.core.specialists.geologists();
if (Steward.core.specialists.dropped() !== before) return; // count is not reliable this tick
```

## Rule 3.6: specialist names are plain text

`Steward.core.specialists.name(spec)` returns plain text, so never strip it again. Escape it before it reaches `html()` (`h.escape`, as in `{ html }` table cells). Identify specialists by `uniqueIdKey` and not by name. Read name-keyed settings with `namedOverride(map, name)`, which also accepts keys saved with entities or markup. A specialist's kind is `kind(spec)` (the host GetType number, locale independent, null when unreadable) and the localized label of a kind nobody owns is `kindLabel(type)`; settings key kinds by number, never by label. Table views take the portrait from `portraitTag(spec)`, sort with `compareByName`, and read a geologist's searched deposit index with `searchingIndex(spec)` instead of reading `GetTask()` themselves. `portraitTag(spec)` takes an optional pass object as its third argument (`portraitTag(spec, size, pass)`), caches real images per icon and size, and sets `pass.portraitMissed` for a placeholder. A table view answers that with one `h.redrawOnce($holder, redraw, S.kernel.TIMEOUTS.PORTRAIT_RETRY_MS)`.

## Rule 3.7: read the host once, inside a pass

A host member can read as a function and then as undefined, and a view that walks many rows reads the same host lists again and again. `Steward.kernel.hostRead` covers both:

- `hostRead.call(o, m)` reads the member into a local and invokes it on its owner. Use it instead of `o.M ? o.M() : x`. It never catches, so keep your own try.
- `hostRead.list(vec)` copies a host vector into a plain array. It uses `vec.toArray()` when offered, otherwise walks the indexes, and returns null when the value is not array-like. Only a throwing `toArray` is caught, because the index walk still reads the vector; an index read that throws reaches the caller. Never write a local walk.
- `hostRead.pass(fn)` opens a read pass around a view model, a window render, a dashboard tab draw or a module's planning pass. Inside it the memoizing readers answer from one memo; outside a pass they read fresh, exactly as before. A nested pass joins the open one. A module status that must agree across the parts of one draw memoizes it with `hostRead.cached`.
- Never wrap an action def, a send or `actions.attempt` in a pass. They run later from the kernel queue and their verification reads must stay live.
- A cached value is shared by every reader in the pass, so treat it as read-only.
- The memoizing readers are `production.queueTypes`, `queueOf`, `entries`, `itemsOf`, `queuedIn`, `buffTable`, `production.avail|<type>|<item>` (one item's availability) and `production.skills`, `buildings.byName` (the name index), the `buffs` entries, star menu, target table and group-contains reads, and the production model's status (`hostRead.cached('production.status')`).
- `buffs.buildingBuffCandidates` and `buffs.speedBuffs` read the star menu once per call even outside a pass, so the amounts of one call agree.
- `buffs.amount`, a candidate's or speed buff's `amount`, `mapCounts` and `populationStock` are null when unreadable. A view shows `?`, never 0.
- `production.stockOf` passes a buff or resource stock's null on; the planner marks the row `stockUnknown` and orders nothing on it, and the buff that would go with an order is left out.

```js
var model = Steward.kernel.hostRead.pass(function () {
    return buildViewModel();   // many rows, one host read per list
});
```

## Rule 3.8: a read is a Result, not a bare value

`Steward.kernel.read` tells "nothing there" from "could not look". A source returns `{ state, value, lost, why, zoneId }`, never null, with `state` one of `ok`, `partial` (the value holds what was read; `lost` counts what was not), `unreadable` (value null) or `notReady` (the zone is still loading; value null). Core readers expose them next to the old ones: `zone.view()`, `buildings.listRead()`, `specialists.listRead()`, `adventures.ownRead()`, `quests.pool()` and `resources.listRead()`. All take `opts` (`{ live: true }` or `{ zone }` bypass the memo).

- `has(r)` is true for `ok` and `partial`: present facts are usable.
- `isOk(r)` is true only for `ok`. `absent(r, test)` is true only for an `ok` list with no match, because a `partial` list may have lost the entry you look for. Never conclude "not there" from `has`.
- `num(r)` gives null and `show(r)` gives `?` for anything but `ok`.
- Scopes: `zone` and `pass` answers are memoized per read pass (a `zone` one also per viewed zone id), `static` definitions stay for the session once read ok, `live` never. Definitions that a later decision depends on are read live, even inside a pass.
- Never wrap an action def, a send or `actions.attempt` in a pass; their reads stay live.
- A refusal that only means "a read failed" is registered with `readRefusal(reason)` (`Steward.core.zone.UNREADABLE`, the specialist, quest and construction ones). Test `isReadRefusal(reason)`: it is not a real refusal, so wait and try again instead of counting a failure.
- `buildings.upgrading(b)`, `buildings.isUpgradable(b)` and `buildings.levelOf(b)` answer null for a failed read; test `=== true` / `=== false` or `!== null`, never truthiness.
- `wait(owner, key, r, opts)` returns `'go'`, `'wait'` (the module is woken after `TIMEOUTS.READ_RETRY_MS`) or `'expired'` once per window, after `LIMITS.READ_WAIT_TRIES` tries and `TIMEOUTS.READ_MAX_MS`. Skip your work on `'wait'`, warn on `'expired'`, and `clearWait` when you stop caring.
- A specialist status that could not be read is `S.SpecialistStatus.Unknown`. Views show it as `reading...` (`h.unknown`), never as busy or idle, and redraw once the pass settles.
- The legacy readers (`buildings.list`, `zone.isHome`, ...) are kept for callers that can live with an empty answer; a caller that acts on the answer uses the Result reader.

```js
var r = Steward.core.zone.view();
if (!Steward.kernel.read.isOk(r)) return;   // loading or unreadable: retry later
```

## Rule 3.9: type guards and enum walks come from the kernel

Use `Steward.kernel.is.*` (`has`, `array`, `plainObject`, `str`, `trim`, `num`, `finite`) and `Steward.kernel.enumKey(E, v)` / `enumHas(E, v)` instead of a private copy. A file may keep a one-line local wrapper under its own name, as long as the body only delegates. Pick the member by its contract: `num` lets `Infinity` through and `finite` does not; `str` gives `''` for a non-string. A contract that differs from these gets its own name in the kernel, never a widened shared one.

## Rule 4: use the locale wrapper

```js
// BAD
loca.GetText('BUI', 'FlyingHouse');
loca.GetText('RES', 'Coin');

// GOOD
Steward.core.locale.bui('FlyingHouse');
Steward.core.locale.res('Coin');
```

The wrapper handles missing-key fallback uniformly, and centralises the categorical strings (`'BUI'`, `'RES'`) so a typo doesn't ship.

The wrapper never throws. When the host has no text for a key it returns the key itself, so call `res` and `bui` directly and skip local try/catch blocks and `|| name` fallbacks. When the caller must tell "untranslated" apart from a translated name, use `known`, which returns the host text or `null`:

```js
var shown = Steward.core.locale.known('RES', name);
var label = shown || builtInLabel;   // null means the host has no text for this key
```

Alerts go through `Steward.kernel.ui.notify(text)`, which adds the `Steward:` prefix and shows nothing for empty text. Modules never call `showGameAlert` themselves.

## Rule 5: `pickTask` and `pickDeposits` are the source of truth

When choosing what an explorer or geologist should do next, ask core:

```js
var task     = Steward.core.specialists.pickTask(explorer);
var deposits = Steward.core.specialists.pickDeposits(geologist);
```

These methods consult, in order:

1. **Host per-spec overrides** — `mainSettings.explDefTaskByType[name]` / `geoDefTaskByType[name]`. If the user has configured a specific explorer/geologist's preferred task in the host UI, Steward respects it.
2. **Event-aware optimization** — for treasure events, picks the task with the best items-per-hour rate. For deposit-affecting events, returns the prioritized deposit list.
3. **Host global default** — `mainSettings.explDefTask` / `geoDefTask`.
4. **Hard-coded baseline** — `ExplorerTask.Short` / empty list.

If you're tempted to compute your own preferred task, check whether the desired behaviour is "the canonical answer plus a constraint" — if so, filter the result of `pickTask` rather than recomputing it. Modules add their own override at most as the *last* word, never bypassing host preferences entirely.

## Rule 6: dispatch composition is module concern

Core stays thin. The low-level send is in core:

```js
Steward.core.specialists.send(spec, taskType, params, responder);
```

The composed operation — "send geologists to find iron until we have 3 deposits queued" — is **module concern**. Each module composes its own dispatch logic over `available` + `pickX` + `send`. We don't centralize these compositions because different modules want different policies.

### Exception: the specialist send guard

`Steward.core.specialists.sendGuard` is shared by every module that sends explorers or geologists. It is safety, not dispatch policy: if the client stops applying search tasks, an idle specialist stays idle and would otherwise be re-sent on every pass without limit. What to send and when stays in the module. A new specialist module must use the guard:

- `note(owner, uid, label, tag)` after a send that really left (`send` returned true). Failed lookups, not-idle specialists and a false or thrown send record nothing.
- `settle(owner, list, complete)` once per `plan()`, with the list that `plan()` already read and whether that read was complete (see Rule 3.5). A specialist seen busy counts as verified, one still Idle after the verify window counts as a miss.
- Skip uids for which `blocked(uid)` is true (send still pending, or held after a miss).
- `admit(n)` before queueing: it returns how many sends may go out. When several sends in a row changed nothing, the breaker opens and `admit` lets only one probe through per cooldown.

State is shared across modules, lives in memory only and is reset by a script reload.

The breaker part of the guard is `Steward.core.breaker`: a factory that makes named instances
with their own run counter, open state and probe cooldown. The send guard holds one instance
for explorers and geologists. Mining buffs hold a separate instance, so a failing buff never
pauses specialist dispatch, and a specialist failure never pauses buffing. Each instance logs
its open and close transitions once. Production orders and production buffs hold two more instances, and the buff side runs through `Steward.core.buffing.create()`, which mining shares, so each owner pauses only itself. `buffing.create().eligible(b, assigned)` answers one `Steward.BuffVerdict`: `Ok` to buff now, `Skip` to try the next building, `Stop` when the breaker is open and no probe is due. Mining build and upgrade sends hold their own breaker instance and a 30 min per-grid hold persisted in `steward/mining/holds.json`, so a reload does not resend a build that the grid has not shown yet.

## Rule 6.5: the production demand ledger

Several owners order into the same host queues, so none of them spends the warehouse on its own. Each declares what it wants in `Steward.core.production.demand` and one planner prices all of it.

- Declare through `put(owner, key, need)` (items wanted), `hold(owner, key, {kind|item})` (other owners must not order that kind or item) or `provide(owner, fn)` (a function pulled on every read, for state kept elsewhere, such as a paused run).
- A need is `{ label, type, item, items, basis, priority }`: `items` is a positive integer, `basis` is `Steward.DemandBasis.Queue` (keep N queued) or `Steward.DemandBasis.Stock` (have N in stock), and a module never writes the string. `priority` is one value of `Steward.ProductionPriority`. Never write a number.
- A `put` or `hold` lives 2 minutes. Re-put every pass; an owner that stops running stops reserving.
- `Steward.core.production.plan(needs, { actFor })` returns `{ rows, orders }`. Every need reserves its missing runs in priority order, but only the rows of the `actFor` owner produce orders. Another owner's needs reduce what is left to spend and nothing more. Feed it `demand.list()`.
- `plan` also takes `opts.orderRuns(need)`. For an own need it returns the runs to order: the planner then orders exactly that many runs (capped by the type's per-order limit), only into an empty queue, and reads the need Covered while the queue holds any entry. One order per type is placed per call, so two names that share a queue never both order. Anything but a positive whole number takes the normal path. The per-order ceiling is `Steward.core.production.orderMax(type)` (the Bookbinder 1, every other type `maxProductionAmount()`).
- `Steward.core.production.itemsOf(type)` entries are `{ name, label, producible, why, page, pageLabel }`. `isProducible(type, item)` answers true, false or null for one item without building the whole list. null means a check could not be read and never hides an item.
- Send each order with `Steward.core.production.orderIn`. The planner sends nothing.
- `Steward.core.production.producer(name)` is the building a name's queue runs at (highest level, then lowest grid). Order into and buff only that one.
- `Steward.core.production.isActive(b)` reads the on/off state and returns null when unknown.
- `Steward.core.production.producing(b)` says whether a queue building is producing: true (unfinished head, queue runs at this building), false (empty queue, finished head, or the queue runs at another building of the type), null when unreadable. Queue buildings only. `Steward.core.buildings.buffBlock(b)` uses it for a building with a `productionQueue` and no ResourceCreation; never compare a queue building against `productionState`.
- `Steward.core.buildings.productionState(b)` and `Steward.core.buildings.MISSING_INPUT_STATE` read the production state. Compare against the constant, never a bare number.

## Rule 6.6: mail cadence and holds

`Steward.core.mail` reads the inbox and sends mail actions; it never decides when to look.

- The module owns the refresh cadence. It calls `mail.refresh()` (single-flight, floored by `MIN_REFRESH_GAP_MS`) and reads `mail.headers()`, a Result with `notReady`, `unreadable` and `partial` as for any other read (Rule 3.8).
- `mail.news()` and `subscribe` are a hint that something new arrived, never proof. Re-read the headers before acting. `unsubscribe` when the owner stops.
- Bodies come from `requestBody(id)` and `body(id)`. `acceptInvite` refuses until the body was read; the item list of a loot mail comes from `parseItems`, which returns null for a malformed one.
- Every write (`dismiss`, `trade`, `completeTrade`, `acceptInvite`) is refused with `HELD` while the game's mail window is open, and with `WINDOW_UNREADABLE` when that cannot be told. `mail.isHold(reason)` is true for those reasons: try again later, do not count it as a failure.
- A one-shot mail def (a trade or an invite) is sent at most once per mail. After an unseen failure the same mail is never rebuilt: refusal `ALREADY_SENT`. Dismiss is repeatable because the headers show whether the mail is gone.
- The inbox is read only at home; elsewhere the refusal is `NOT_HOME`.

## Rule 7: wrap risky calls

Every game-API call can throw — the API surface is large and not all of it is documented. Wrap calls in try/catch and log the failure:

```js
function name(b) {
    try {
        return b.GetBuildingName_string();
    } catch (e) {
        Steward.kernel.warn('buildings', 'name failed:', e);
        return null;
    }
}
```

Core helpers do this internally so module code doesn't have to. When you're forced to reach past a helper (rare), do it yourself.

Don't wrap calls just to swallow them — autoTSO had 237 silent try/catch blocks and the cost of that decision is exactly why Steward exists. Always log the error with category context.

## Anti-patterns

| Anti-pattern                                   | Use instead                                              |
|-----------------------------------------------|----------------------------------------------------------|
| `building.GetGOContainer().mIsAttackable`     | `Steward.core.buildings.isAttackable(building)`          |
| `loca.GetText('BUI', name)`                   | `Steward.core.locale.bui(name)`                          |
| `if (status === 'IDLE')`                      | `if (status === Steward.SpecialistStatus.Idle)`          |
| Reaching into another module's settings       | Don't, except a read-only settings read; see below.      |
| Holding onto a `list()` result across ticks   | The cache is per-tick. Re-fetch every tick.              |
| Hard-coding deposit type names                | Add an entry to `Steward.Building` and use the enum.     |
| Using `console.log`                           | Use `Steward.kernel.log('module-id', …)`.                |

The one exception to the settings row is a read-only
`Steward.kernel.settings.read('<other>')` whose absence errs toward doing
nothing. Cross-module communication is otherwise via the kernel. Today only
adventures reads collect's `enabled`, `adventureZones` and `namePatterns`, to
decide whether its Pickups step waits for collect. Renaming or reshaping any of
them must update that reader.

The second exception runs the other way: collect asks
`S.modules.adventures.trips.scenarioViewed()` at call time, read-only, to skip
collectibles on a scenario island. Absence means no scenario island, so collect
behaves as before. Renaming it must update collect.

## When to extend core

Core grows as patterns become apparent. The flow:

1. You write a module and find yourself doing the same multi-step game-API expression more than once.
2. Add a helper to the relevant `core/*.js` file.
3. Update this document if the helper deserves explicit mention.

Core changes ship with their consumers. We don't pre-emptively design helpers for hypothetical modules.
