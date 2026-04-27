# P5 — Host integration and UX fixes

> **Context:** see `HOST_INTEGRATION.md` for the findings driving this plan.
> User-confirmed: autoTSO has the same window-takeover issue when collectibles
> run; making Steward modal-aware is a genuine improvement, not just parity.

This plan covers six fixes. Each section gives the change, the files it
touches with current state, the new behaviour, risk/rollback, and effort.
Suggested ordering at the bottom.

---

## Fix 1 — Switch settings backend to the host's `settings` object

### What changes

`Steward.kernel.settings.{read,write,load,save,flush,all}` becomes a thin
adapter over the host's `settings.{read,store}` instead of owning its own
JSON file. Per-module namespacing maps:

```
Steward.kernel.settings.read('collect')
  → settings.read(null, 'steward.collect')

Steward.kernel.settings.write('collect', obj)
  → settings.store(obj, 'steward.collect')
```

The kernel namespace itself uses `'steward.kernel'` (for tick interval,
master pause, logger config, etc.).

### Files affected

| File | Current state | After fix |
|---|---|---|
| `src/kernel/30_settings.js` (101 lines) | Reads/writes `applicationStorageDirectory/steward/settings.json` directly via `air.FileStream`. Owns in-memory cache, debounced save timer. | Delegates to host `settings`. Drops the file/stream/debounce code. ~40 lines. |
| `docs/TSO_API.md` | Says "Steward writes everything to a `steward/` subfolder of `applicationStorageDirectory`". | Update to explain host settings delegation. |
| `docs/CORE_USAGE.md` | Settings section. | Same — redirect path description. |
| `docs/LOGGING.md` | Says logger settings live under "`Steward.kernel.settings.read('logger')`". | Path unchanged at the API level — only the on-disk location differs. |

### Behaviour difference

- **Before:** `applicationStorageDirectory/steward/settings.json` (writable per-machine, no per-profile separation, not synced).
- **After:** `applicationDirectory/<settingsFile>` shared with host + autoTSO (per-profile via `settingsFile` global, dropbox-synced via host's existing mechanism).
- Settings JSON gains `"steward.kernel"`, `"steward.collect"`, etc. keys alongside the host's `"global"`, `"scripts"`, `"keybinds"` keys.

### Risk / rollback

- **Coexistence with autoTSO:** autoTSO uses `'auto'` namespace; Steward uses `'steward.*'`. No collision.
- **Migration:** v0.1 users who already have `steward/settings.json` won't auto-migrate. Trivial migrator can be added (load old, write new, delete old) — flag whether to include in this fix.
- **Rollback:** revert the file. No on-disk lock-in; old steward/ directory just gets ignored.

### Effort

Small. ~30 minutes plus doc edits.

---

## Fix 2 — Master pause / resume

### What changes

A top-level "Steward" status entry in the menu becomes a click-to-toggle
master switch. Toggling pauses:

- The scheduler (`Steward.kernel.scheduler.stop()`)
- The queue (`Steward.kernel.queue.reset()` clears pending actions)

Resume restarts both. The state persists in `'steward.kernel'.paused`.

### Files affected

| File | Current state | After fix |
|---|---|---|
| `src/kernel/90_ui_shell.js` (lines 175-178) | Status item is a disabled label that ticks every 5 s with module count. | Replaces it with a clickable "Active"/"Paused" toggle. Status text becomes secondary (sub-line). |
| `src/kernel/50_scheduler.js` | Has `start()`/`stop()`. `tick()` returns early when `state.running` is false. | No structural change — wires `paused` setting through `lifecycle` so boot honours it. |
| `src/kernel/60_queue.js` (lines 65-69) | `reset()` clears the queue. | Already exists — caller wires it up. |
| `src/kernel/70_lifecycle.js` (boot) | Always calls `scheduler.start()`. | Reads `'steward.kernel'.paused`; if true, leaves scheduler stopped. |

### Behaviour difference

- **Before:** Toggling the collect module's "Enabled" was the only kill switch; pending queue items still drained for ~30 s.
- **After:** "Steward → Paused" stops everything immediately, clears the queue, and survives client restarts. Resuming kicks `boot()`'s scheduler-start path (without re-running module boots).

### Risk / rollback

- Module developers have to assume the scheduler can be started/stopped at runtime. Today the assumption is "scheduler runs continuously". Documented in `MODULE_GUIDE.md` if changed.
- Cancelled queue actions disappear without notice. Acceptable for collect; a future module that needs guaranteed delivery (e.g. mid-trade response) would have to use `Priority.Critical` *and* avoid being mid-action when paused.
- Rollback: revert. No persisted state migration needed since the new key didn't exist.

### Effort

Medium. ~45 minutes including UI label updates and persistence.

---

## Fix 3 — Modal-aware queue gating

### What changes

`Steward.kernel.queue.runOne()` checks for a visible host modal before firing
each action. If one exists, the action is **deferred** (not dropped) — pushed
back onto the head of the queue and re-attempted after a short delay.

```js
function isHostModalVisible() {
    try { return $('div[role="dialog"]:visible').length > 0; }
    catch (e) { return false; }
}
```

Optional: per-action opt-out via a `bypassModalGuard: true` flag on the
queued entry, for the rare case a `Critical` action must run regardless.

### Files affected

| File | Current state | After fix |
|---|---|---|
| `src/kernel/60_queue.js` (lines 50-58 — `runOne`) | Pops front, runs action, schedules next via `setTimeout(runOne, entry.delay)`. | Before popping: if modal visible, `setTimeout(runOne, MODAL_RECHECK_MS)` and return without consuming. |
| `src/kernel/10_constants.js` | `TIMEOUTS` map. | Adds `MODAL_RECHECK_MS: 2000` (re-poll while user has a window open). |

### Behaviour difference

- **Before:** Every 1.5 s the queue fires an action. If user opens a building info / settings / mail window, the next collect action's `SelectBuilding` + `UpdateGuiOnZoneLoad` closes it.
- **After:** While any host modal is visible, queued actions wait. As soon as the user closes their window, draining resumes. **Closes the user-confirmed gap autoTSO has.**

### Risk / rollback

- A user who *never* closes a window stalls the queue indefinitely. Acceptable for v0.5; mitigation is a max-wait timeout (`bypassModalGuard` after N seconds — defer).
- Rollback: revert.

### Effort

Small. ~20 minutes.

---

## Fix 4 — Per-module queue cancellation

### What changes

Each enqueued action carries the `moduleId` of the registering module. New
methods:

```js
Steward.kernel.queue.cancelByModule(id);   // drops pending entries
Steward.kernel.queue.depthByModule(id);    // diagnostic
```

The module spec gains an implicit `moduleId` injected by `register()`, so
modules don't have to repeat their id. `queue.add()` becomes:

```js
Steward.kernel.queue.add(name, params, delay, options);
// options.moduleId injected by the registry; modules don't pass it directly
```

The collect module's UI calls `queue.cancelByModule('collect')` on disable so
pending collects vanish immediately rather than draining.

### Files affected

| File | Current state | After fix |
|---|---|---|
| `src/kernel/60_queue.js` | `add(name, params, delay)` pushes `{name, params, delay}`. | Adds `moduleId` field to each entry. New `cancelByModule(id)` filters the queue. Existing `add` signature unchanged for compat. |
| `src/kernel/40_registry.js` | Validates spec, attaches it to registry. | Wraps each module's `plan(ctx)` so the call sets a "current module" thread-local before invocation; `queue.add` reads it. (No public API change — keeps modules clean.) |
| `src/modules/collect/ui.js` | Toggles setting and re-renders menu. | On `enabled → false`, calls `cancelByModule('collect')`. |
| `docs/MODULE_GUIDE.md` | Describes `Steward.kernel.queue.add(...)`. | No change to call sites; mentions new cancel facility. |
| `docs/SCHEDULER.md` | Queue contract. | Adds `cancelByModule` and "cancellation semantics" subsection. |

### Behaviour difference

- **Before:** Toggling collect off leaves up to ~30 collect actions still pacing through the queue. User keeps seeing windows close for ~45 s.
- **After:** Toggle off → queue is empty for that module within milliseconds.

### Risk / rollback

- The "current module" thread-local pattern only works because Steward is single-threaded; multi-tier walks are sequential. No JS concurrency to worry about.
- If a module enqueues an action then *another* module's `plan()` runs and adds its own action, the registry must reset the thread-local correctly. Easy to test.
- Rollback: revert. `add()` still works without `moduleId`.

### Effort

Medium. ~45 minutes including doc updates.

---

## Fix 5 — Honour `mainSettings` (`experimental`, `menuStyle`)

### What changes

Kernel reads `mainSettings` once at boot and exposes a read-only snapshot:

```js
Steward.kernel.host.mainSettings()      // returns { experimental, menuStyle, ... }
Steward.kernel.host.experimental()      // shorthand — boolean
Steward.kernel.host.menuStyle()         // 'grouped' | 'flat'
```

Steward modules can declare `experimental: true` in their `register()` spec;
the registry refuses to register them when `mainSettings.experimental === false`.

The UI shell consults `menuStyle` — in `'flat'` mode, Steward exposes its
entries directly under Tools instead of building a nested Steward menu.

### Files affected

| File | Current state | After fix |
|---|---|---|
| `src/kernel/70_lifecycle.js` | Reads logger + scheduler settings on boot. | Adds a `host` snapshot that reads `mainSettings` once with try/catch. |
| `src/kernel/40_registry.js` | Validates id, priority, isReady, plan, boot. | Adds optional `experimental` validation that gates registration. |
| `src/kernel/90_ui_shell.js` | Always builds a top-level "Steward" entry. | Branches on `host.menuStyle()` — flat → register entries via `menu.addToolsItem`. Grouped → keep current top-level Steward entry. |
| `docs/MODULE_GUIDE.md` | Spec table. | Adds `experimental: true` to the optional fields. |

### Behaviour difference

- **Before:** Steward always renders a top-level "Steward" menu. Doesn't know about `experimental`.
- **After:** When the host is in `flat` menu mode, Steward attaches under Tools (consistent with the host convention). When `experimental=false`, experimental-flagged modules don't load.

### Risk / rollback

- Behaviour change for menu placement. Visible to users immediately. Document in release notes.
- Rollback: revert. No persisted state.

### Effort

Small-to-medium. ~30 minutes.

---

## Fix 6 — `pickTask`/`pickDeposits` consult `mainSettings.{expl,geo}Def*`

### What changes

The recommendation methods become a small policy chain instead of an
event-or-default fallback:

```
1. mainSettings.{expl,geo}DefTaskByType[<spec name>]   — explicit per-spec override
2. event-aware logic                                   — current implementation
3. mainSettings.{expl,geo}DefTask                      — fallback default
4. ExplorerTask.Short / GeologistTask.Search           — hard-coded baseline
```

### Files affected

| File | Current state | After fix |
|---|---|---|
| `src/core/specialists.js` (lines 268-307 — `pickTask`) | Defaults → event lookup → fallback. | Inserts step 1 (per-spec) before event lookup, step 3 (host default) before hard-coded baseline. |
| `src/core/specialists.js` (lines 314-330 — `pickDeposits`) | Same shape; returns `[]` when no event data. | Same insertions; falls through to `[mainSettings.geoDefTask]` if no events. |
| `docs/CORE_USAGE.md` | "Rule 5: pickTask/pickDeposits are the source of truth". | Add a "host-default precedence" note. |

### Behaviour difference

- **Before:** Pre-event period → `pickTask` returns `Short` for every explorer regardless of user host config.
- **After:** Pre-event period → returns the user's configured per-spec task, or their global default, before hard-coding `Short`.

### Risk / rollback

- The old return value (`Short`) was effectively a guess; new behaviour respects user config. Lower surprise.
- Rollback: revert.

### Effort

Small. ~20 minutes plus doc.

---

## Suggested ordering

| Order | Fix | Why |
|---|---|---|
| 1 | **#3 Modal-aware gate** | Highest user-visible win; smallest surface; closes the autoTSO-shared bug. |
| 2 | **#2 Master pause** | Gives users an emergency stop. Independent of other fixes. |
| 3 | **#4 Per-module cancel** | Fixes the "disable doesn't take effect" complaint cleanly. Builds on #2. |
| 4 | **#1 Settings backend swap** | Foundational. Should land before user config has time to grow under the old path. |
| 5 | **#5 mainSettings honour** | Lower urgency. Useful for future experimental modules. |
| 6 | **#6 pickTask host-defaults** | No active explorer/geologist module yet — pure groundwork for the future explorers / templates_geologists modules. |

Recommended bundling for commits:

- **P5a** = fixes #3 + #2 (UX wins, independent).
- **P5b** = fix #4 (depends on #2 for the master clear path).
- **P5c** = fix #1 + brief settings migrator.
- **P5d** = fixes #5 + #6 (host integration polish, can ship together).

Each bundle is its own commit; `v0.2.0` after P5a/b/c, `v0.3.0` after P5d if you want a release boundary.

## Decisions locked

| # | Question | Decision |
|---|---|---|
| Q1 | Settings migrator from old steward/settings.json path | **Skip.** v0.1.0 has no users yet. Fix #1 just swaps the backend cleanly. |
| Q2 | Master pause persistence across client restart | **Persist.** Stored as `'steward.kernel'.paused`. User actions stick. |
| Q3 | Force-through for `Priority.Critical` actions when a host modal is visible | **Never force-through.** Strict modal guard for v0.5. Revisit when the first Critical-tier module ships and demonstrates a real need. |
| Q4 | Steward menu placement under flat vs grouped layout | **Adaptive.** Top-level "Steward" in `'grouped'` mode (peer to Buildings/Specialists/Tools). Nested under Tools when `mainSettings.menuStyle !== 'grouped'`. |
