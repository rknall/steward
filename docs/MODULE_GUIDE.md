# Authoring a Steward Module

A module is a small piece of automation that the kernel runs on its tick. This guide walks through writing one from scratch.

## File layout

Every module lives under `src/modules/<id>/`. By convention:

```
src/modules/<id>/
├── module.js     # The IIFE that calls Steward.kernel.register({...})
├── settings.js   # Default settings schema
└── ui.js         # Settings panel (optional)
```

You can split into more files if the module grows; the build picks them up alphabetically per directory. Just make sure `module.js` is concatenated last so its `register` call sees the rest of the module's helpers.

## The minimum viable module

```js
// src/modules/hello/module.js
(function (S) {
    S.kernel.register({
        id:       'hello',
        priority: S.Priority.Idle,
        isReady:  function () { return true; },
        plan:     function (ctx) {
            S.kernel.log('hello', 'tick', ctx.tick, 'now', ctx.now);
        }
    });
})(Steward);
```

That's a complete module. After `npm run build` it'll be bundled into `user_steward.js` and the kernel will call its `plan` once per tick.

## Anatomy of a real module: `collect`

```js
// src/modules/collect/settings.js
(function (S) {
    S.modules.collect = S.modules.collect || {};
    S.modules.collect.defaultSettings = {
        enabled:   true,
        pickups:   true,
        lootBoxes: true
    };
})(Steward);
```

```js
// src/modules/collect/module.js
(function (S) {
    var state = {
        lastRun:       0,
        cooldownUntil: 0
    };

    function settings() {
        var stored = S.kernel.settings.read('collect');
        return stored || S.modules.collect.defaultSettings;
    }

    S.kernel.register({
        id:       'collect',
        priority: S.Priority.Normal,
        boot:     function () {
            // Seed defaults if this is the first run
            if (!S.kernel.settings.read('collect')) {
                S.kernel.settings.write('collect', S.modules.collect.defaultSettings);
            }
        },
        isReady:  function (ctx) {
            var s = settings();
            if (!s.enabled) return false;
            if (!ctx.zone.isHome) return false;
            if (ctx.now < state.cooldownUntil) return false;
            return true;
        },
        plan:     function (ctx) {
            var s = settings();
            var enqueued = 0;

            if (s.pickups) {
                var pickups = S.core.buildings.list({ /* predicate from core */ });
                for (var i = 0; i < pickups.length; i++) {
                    S.kernel.queue.add('collect', [S.core.buildings.grid(pickups[i])]);
                    enqueued++;
                }
            }

            if (s.lootBoxes) {
                // similar
            }

            S.kernel.log('collect', 'queued', enqueued, 'actions');
            state.lastRun = ctx.now;
            state.cooldownUntil = ctx.now + 30000;
        }
    });
})(Steward);
```

## The `register` spec

| Field      | Required | Type      | Notes                                                            |
|------------|----------|-----------|------------------------------------------------------------------|
| `id`       | yes      | string    | Unique. Used as logger category, settings namespace, UI label.   |
| `priority` | yes      | enum      | `Steward.Priority.{Critical,Normal,Idle}`.                       |
| `isReady`  | yes      | `(ctx)→bool` | Cheap. Errors are treated as `false`.                         |
| `plan`     | yes      | `(ctx)→void` | Called when `isReady` returns true. Errors are swallowed and logged. |
| `boot`     | no       | `()→void` | One-shot, called after registration completes.                   |

See [`SCHEDULER.md`](SCHEDULER.md) for the contract details.

## Settings

Modules own their settings schema. Read and write through the kernel, namespaced by module id:

```js
var s = Steward.kernel.settings.read('collect');     // returns object or null
Steward.kernel.settings.write('collect', { enabled: true, pickups: false });
```

The kernel persists settings to a single JSON file on disk. Don't write outside your module's namespace.

### Defaulting

Two patterns are common:

**Lazy:** `read()` returns `null` until first write; the module substitutes a default each call.

```js
function settings() {
    return Steward.kernel.settings.read('collect') || Steward.modules.collect.defaultSettings;
}
```

**Eager:** seed defaults in the `boot` hook so subsequent reads always return populated data.

```js
boot: function () {
    if (!Steward.kernel.settings.read('collect')) {
        Steward.kernel.settings.write('collect', Steward.modules.collect.defaultSettings);
    }
}
```

Eager is friendlier for debugging — you can inspect `settings.json` and see what every module expects. Prefer it.

## Enqueueing actions

`plan` should not perform side effects directly. It should enqueue actions:

```js
Steward.kernel.queue.add('collect', [grid]);
```

Actions are registered separately:

```js
Steward.kernel.queue.action('collect', function (params) {
    var grid = params[0];
    // perform the actual game-API call
});
```

The kernel paces action execution; one `plan` call can enqueue dozens, the queue drains FIFO.

### Cancelling on disable

When your module exposes an "off" switch, drop pending queued actions immediately so users don't see your work continue for tens of seconds after they disable you:

```js
S.kernel.queue.cancelByModule('your-module-id');
```

Actions enqueued from inside your `plan()` or `boot()` are automatically tagged with your module's id — you don't pass it explicitly. See `SCHEDULER.md` for the full contract.

## Logging

```js
Steward.kernel.log('collect', 'queued', n, 'pickups');
Steward.kernel.warn('collect', 'unexpected building shape:', JSON.stringify(b));
Steward.kernel.error('collect', 'failed to read game state:', e);
```

Use your module's `id` as the category. Don't log inside hot loops.

## UI

If your module needs a settings panel, register one in `ui.js`:

```js
// src/modules/collect/ui.js
(function (S) {
    S.modules.collect = S.modules.collect || {};
    S.modules.collect.renderSettings = function (modal) {
        var s = S.kernel.settings.read('collect');
        modal.Body().append(/* html */);
        // wire up createSwitch(...) and write back to settings on change
    };
    S.kernel.ui.menu.add({
        label: 'Collect',
        render: S.modules.collect.renderSettings
    });
})(Steward);
```

The kernel renders the menu shell; modules supply per-entry render functions. UI primitives (`createModalWindow`, `createSwitch`, `createTableRow`) are host-provided — see [`TSO_API.md`](TSO_API.md).

## Error handling

The kernel guards both `isReady` and `plan` with try/catch. If your code throws:

- `isReady` throw → treated as `false`. Logged at WARN.
- `plan` throw → swallowed. Logged at ERROR. Module is unaffected on next tick.

Don't rely on this as your only error handling — wrap risky game-API calls in try/catch yourself so you can decide what to do (skip, defer, disable). Failing silently to the kernel makes diagnosis harder.

## Module lifecycle

```
build:   src/modules/<id>/*.js → bundled into user_steward.js
load:    client loads bundle → IIFE runs → register() called
boot:    kernel runs your boot() hook (if provided)
tick N:  isReady(ctx) → plan(ctx) → kernel drains queue
…
```

There is no explicit unload — modules live for the lifetime of the client. If you need to disable a module at runtime, gate everything behind `settings.enabled` in `isReady`.

## Naming and discoverability

- Module `id` is lowercase, no spaces, dash-separated if multi-word: `'collect'`, `'auto-mail'`, `'templates-explorers'`.
- Reserve `Steward.modules.<id>` for any state your module wants to publish (helpers, render functions, public read-only data).
- Internal state goes in IIFE-scoped `var`s, not on the namespace.

## Where to look for examples

- `src/modules/collect/` (v0.1) — the canonical reference module once it lands in P3.
- autoTSO's `aBuildings.collectibles` (`autoTSO/user_auto.js:5021`) — proven game-side logic to mirror.
