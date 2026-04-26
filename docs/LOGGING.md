# Logging

Steward provides a single, category-based logger that emits to both the in-client JavaScript console and a rotating log file in writable storage.

> **Status:** This document describes the v0.1 logger contract. Implementation lands in P1 (`src/kernel/20_logger.js`). Module authors should code against this surface from day one.

## API

```js
Steward.kernel.log(category, ...values)         // INFO-level
Steward.kernel.warn(category, ...values)        // WARN-level
Steward.kernel.error(category, ...values)       // ERROR-level

Steward.kernel.log.isEnabled(category)          // gate expensive log construction
```

`category` is an arbitrary string, conventionally the module ID (`'collect'`, `'scheduler'`, `'buildings'`). Multiple values are joined with single spaces.

### Why pass values varargly?

So callers can avoid building expensive strings when the category is disabled:

```js
if (Steward.kernel.log.isEnabled('buildings')) {
    Steward.kernel.log('buildings', 'list snapshot:', JSON.stringify(snapshot));
}
```

## Configuration

Settings live under `Steward.kernel.settings.read('logger')` (mapped to `'steward.logger'` in the host's settings file):

| Key            | Default | Meaning                                                         |
|----------------|---------|-----------------------------------------------------------------|
| `enabled`      | `true`  | Master switch. `false` disables both console and file output.   |
| `categories`   | `{}`    | Per-category enable map. A missing key defaults to `true`.      |
| `fileEnabled`  | `true`  | Whether to also write to disk.                                  |
| `maxFileSizeKB`| `5000`  | Rotate the file when it grows past this size. `0` = no rotate.  |
| `keepRotated`  | `3`     | Number of rotated files to retain.                              |

To disable a noisy category at runtime:

```js
var s = Steward.kernel.settings.read('logger') || { categories: {} };
s.categories.buildings = false;
Steward.kernel.settings.write('logger', s);
```

## Log file location

```
<applicationStorageDirectory>/steward/logs/console.log
```

Logs are independent of settings — they live in the writable storage dir Steward owns. Settings are delegated to the host (`applicationDirectory/<settingsFile>`); see `analysis/HOST_INTEGRATION.md`.

When the file exceeds `maxFileSizeKB`, it is renamed in-place:

```
console.log              # current
console.log.1            # most recent rotation
console.log.2
...
console.log.<keepRotated>
```

The oldest is deleted before the rotation chain shifts.

## Log line format

```
[LEVEL] [YYYY-MM-DD HH:MM:SS] [category] message
```

Examples:

```
[LOG]   [2026-04-26 14:32:01] [collect] queued 3 collectibles, 1 lootable
[WARN]  [2026-04-26 14:32:11] [scheduler] tick took 6312ms (>5000ms threshold)
[ERROR] [2026-04-26 14:32:11] [packets] sendAction failed: TypeError: ...
```

## Output sinks

The logger writes to (in order):

1. **In-client JS console** via `air.Introspector.Console` when present (host-provided debug console). Falls back to `debug()` if available.
2. **Log file** at the path above, when `fileEnabled` is `true`.

Sinks fail safely — if the file write throws, the console write still happens. The kernel never raises a logger failure to module code.

## Conventions

- Use the module ID as the category. Don't reuse another module's category.
- Reserve `kernel:*` prefixes for internal kernel logging (`scheduler`, `queue`, `lifecycle`).
- Don't `try/catch` around `Steward.kernel.log` — the logger swallows its own failures.
- Don't log at INFO level inside hot loops. The scheduler tick should produce one INFO line per cycle and that's it.
- Errors caught from game APIs should be logged at ERROR with category context, then handled — never re-thrown into the kernel tick.

## What this replaces

autoTSO had two parallel systems: `aDebug` (category-based) and `aConsoleLogger` (rotating file). Steward unifies both behind `Steward.kernel.log` and lets configuration distinguish them. Reference for the autoTSO patterns we're collapsing:

- `autoTSO/user_auto.js:358` — `aDebug`
- `autoTSO/docs/LOGGING.md` — original logging design
