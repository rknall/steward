# Scheduler

The scheduler decides which module runs when. It uses three priority tiers and round-robins within each tier so no module can starve another.

> **Status:** This document specifies the scheduler contract. Implementation lands in P1 (`src/kernel/50_scheduler.js`). Module authors should code against this surface from day one.

## Priority tiers

```js
Steward.Priority.Critical    // === 'PriorityCritical'
Steward.Priority.Normal      // === 'PriorityNormal'
Steward.Priority.Idle        // === 'PriorityIdle'
```

| Tier       | Use for                                                                     |
|------------|-----------------------------------------------------------------------------|
| `Critical` | Time-sensitive responses — accepting a mid-flight trade, mail-driven actions. |
| `Normal`   | Standard automation — production, collection, dispatch.                      |
| `Idle`     | Cleanup, observability, drift correction.                                   |

A higher tier always runs before a lower one in a given tick. Within a tier, modules round-robin so they get fair access.

## Tick model

```
tick(now):
    ctx = buildContext()                    # zone, now, session flags
    for tier in [Critical, Normal, Idle]:
        modules = registry.byTier(tier)     # array of module specs
        cursor  = scheduler.cursors[tier]   # 0..modules.length-1
        for offset in 0..modules.length:
            m = modules[(cursor + offset) % modules.length]
            if not safeIsReady(m, ctx): continue
            safePlan(m, ctx)                # may enqueue tasks
        scheduler.cursors[tier] = (cursor + 1) % modules.length
    queue.drain()
    schedule(tick, tickInterval)
```

The cursor advance happens **once per tier per tick**, regardless of how many modules in that tier had work. That's the round-robin guarantee: if module A and module B are both `Normal`, they alternate first-look across ticks.

## Module registration

```js
Steward.kernel.register({
    id:       'collect',
    priority: Steward.Priority.Normal,
    isReady:  function (ctx) {
        return ctx.zone.isHome && ctx.now > state.cooldownUntil;
    },
    plan:     function (ctx) {
        // Inspect game state via Steward.core.*
        // Enqueue work via Steward.kernel.queue.add(name, params, delay)
    }
});
```

### `isReady(ctx)` contract

- **Cheap.** Called every tick for every module. If your readiness check needs an expensive game query, cache the result.
- **Pure boolean return.** Returning `null`/`undefined` is treated as `false`.
- **Throws are swallowed.** A throw is treated as `false` and logged at WARN.
- Receives `ctx`:
  - `ctx.now` — `Date.now()` at tick start.
  - `ctx.tick` — monotonically incrementing integer.
  - `ctx.zone` — `{ id, isHome, isAdventure, isFriend }` snapshot.
  - `ctx.session` — module-shared session flags (read-only).

### `plan(ctx)` contract

- **Side-effects allowed.** Called only when `isReady` returned true.
- **No return value expected.** Modules enqueue work via `Steward.kernel.queue.add(...)`; the kernel doesn't read what `plan` returns.
- **Throws are swallowed.** Logged at ERROR. The module's next tick is unaffected.
- **Don't block.** `plan` should return quickly; the queue handles paced execution.

## Action queue

Modules enqueue actions:

```js
Steward.kernel.queue.add(name, params, delay);
```

| Argument | Type     | Meaning                                                           |
|----------|----------|-------------------------------------------------------------------|
| `name`   | string   | A registered action (e.g. `'collect'`, `'sendSpecialist'`).      |
| `params` | array    | Positional arguments passed to the action handler.               |
| `delay`  | number   | Optional. Milliseconds to wait before running this action.        |

Actions are registered once at boot:

```js
Steward.kernel.queue.action('collect', function (params) {
    var grid = params[0];
    Steward.core.packets.sendAction(/* ... */);
});
```

The queue drains FIFO with a default 1500 ms inter-action gap (overridable per action via `delay`). Actions never run faster than the kernel tick.

### Module tagging and cancellation

Every action enqueued from inside a module's `plan()` or `boot()` is automatically tagged with that module's `id` (the kernel sets a "current module" pointer around the call so `queue.add` can read it).

This makes per-module cancellation safe and cheap:

```js
Steward.kernel.queue.cancelByModule('collect');   // drops every pending entry tagged 'collect'
Steward.kernel.queue.depthByModule('collect');    // diagnostic
```

The `collect` module uses this when the user toggles its master switch off — pending actions disappear in milliseconds instead of draining for ~45 s. Modules should mirror the pattern when they have an "off" switch with pending side effects.

### Modal-aware execution

Each action is gated by a host-modal check before it fires (`60_queue.js:isHostModalVisible`). If any `div[role="dialog"]:visible` is on the page when the queue tries to run the next entry, the entry is **deferred** (not dropped) — the queue re-polls every `QUEUE_MODAL_RECHECK_MS` (2 s) and resumes the moment the user closes their window. This prevents Steward from yanking a window the user just opened.

## Starvation, fairness, and back-pressure

- **Starvation:** prevented by the per-tier round-robin cursor. A misbehaving `Normal` module enqueueing 50 actions per tick still does not starve other `Normal` modules — they get first-look on the next tick.
- **Tier inversion:** a `Critical` module always runs before any `Normal` module in the same tick. There is no preemption within a tick (cooperative model).
- **Back-pressure:** if the queue is non-empty when a tick fires, draining continues; new `plan` calls just append. There is no enforced ceiling on queue depth in v0.1 — modules are expected to gate themselves with `isReady`.

## Tick interval

```js
Steward.kernel.settings.read('scheduler').tickInterval     // default: 10000 (ms)
```

Faster ticks mean tighter responsiveness at the cost of more game-API churn. 10 seconds matches autoTSO's `aQueue.interval` and is a known-safe default.

## Example: a Normal-tier module

```js
(function (S) {
    var state = { cooldownUntil: 0 };

    S.kernel.register({
        id:       'example',
        priority: S.Priority.Normal,
        isReady:  function (ctx) {
            return S.core.zone.isHome() && ctx.now > state.cooldownUntil;
        },
        plan:     function (ctx) {
            var ready = S.core.buildings.list({ type: S.Building.FlyingHouse });
            for (var i = 0; i < ready.length; i++) {
                S.kernel.queue.add('collect', [S.core.buildings.grid(ready[i])]);
            }
            state.cooldownUntil = ctx.now + 30000;
        }
    });
})(Steward);
```

## What this replaces

autoTSO's `aQueue` + ad-hoc `aSession.isOn.*` flags. Reference: `autoTSO/user_auto.js:585`.
