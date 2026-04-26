# Logging

Steward provides a single, category-based logger that emits to both the in-client JavaScript console and a rotating log file in writable storage.

> **Status:** This document describes the v0.1 logger contract. Implementation lands in P1 (`src/kernel/20_logger.js`). Module authors should code against this surface from day one.

## API

```js
Steward.kernel.debug(category, ...values)       // DEBUG-level (off by default)
Steward.kernel.log(category, ...values)         // INFO-level
Steward.kernel.warn(category, ...values)        // WARN-level
Steward.kernel.error(category, ...values)       // ERROR-level

Steward.kernel.log.isEnabled(category)          // gate expensive log construction
Steward.kernel.debug.isEnabled(category)        // also checks the debug master switch
```

`category` is an arbitrary string, conventionally the module ID (`'collect'`, `'scheduler'`, `'buildings'`). Multiple values are joined with single spaces.

### When to use which level

| Level   | Use for                                                             | Example                                          |
|---------|---------------------------------------------------------------------|--------------------------------------------------|
| `debug` | Per-tick / per-action chatter that's only useful while diagnosing.  | scheduler tick, ui menu rebuilds, per-action collect lines |
| `log`   | One-shot or rate-limited events meaningful at runtime.              | "module registered", "boot complete", "queued N actions"  |
| `warn`  | Recoverable surprises — game API quirks, malformed input.           | "buildings.list threw, returning empty"          |
| `error` | Things that broke; user action may be needed.                       | "settings.json read failed", "module plan threw" |

DEBUG is dropped silently when the master switch is off, even if the category is enabled.

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
| `debugEnabled` | `false` | When `true`, DEBUG-level lines are emitted; otherwise dropped.  |
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

Primary path:

```
<applicationStorageDirectory>/steward/logs/console.log
```

This is AIR's standard writable location and works across every platform and distribution. On TSO-Portable (Windows) it resolves to:

```
C:\Users\<user>\AppData\Local\tso_portable\Local Store\steward\logs\console.log
```

We don't write to `applicationDirectory` (the install/portable folder where `client.swf` lives) — autoTSO's `auto/logs/` works only because autoTSO's distribution pre-creates that directory in the portable bundle. AIR otherwise rejects writes to `applicationDirectory` with `SecurityError: fileWriteResource`. Steward owns its own subtree under storage.

Last-ditch fallback (if `applicationStorageDirectory` itself is unavailable):

```
<documentsDirectory>/steward/logs/console.log
```

Either way, the rotation chain is `console.log.1`, `console.log.2`, … kept in the same directory.

When the logger boots, it writes one of these to the console sink so users can confirm the path:

```
[LOG]   [...] [logger] writing to /path/to/steward/logs/console.log
[WARN]  [...] [logger] storage dir unavailable, using documents fallback ...
[ERROR] [...] [logger] no writable log location — file output disabled
```

To find the absolute path programmatically, run this in the AIR introspector console after boot:

```js
air.File.applicationStorageDirectory.resolvePath('steward/logs/console.log').nativePath
```

Directory creation is recursive — `steward/` is created if missing, then `steward/logs/`. Adobe AIR's `createDirectory()` is *not* recursive on its own, so we walk the path manually.

### Why not alongside autoTSO?

autoTSO writes to `applicationDirectory/auto/logs/console.log`. The reason that works isn't because the portable distribution pre-creates the directory (it doesn't — autoTSO creates it on first run). It works because autoTSO **bypasses AIR's application-content security check** by round-tripping through `.nativePath`:

```js
// autoTSO pattern:
var path = air.File.applicationDirectory.resolvePath('auto/logs/console.log').nativePath;
var file = new air.File(path);   // ← new File from a path string, not a resolvePath result
```

`applicationDirectory.resolvePath(...)` returns a File object that AIR has marked as "application content" — writing to it throws `SecurityError: fileWriteResource`. Constructing a new `air.File(stringPath)` bypasses the marker because the resulting File object isn't classified as application content. Same path on disk, different AIR-internal flag.

Steward avoids the bypass entirely by writing to `applicationStorageDirectory`, which is AIR's documented writable location and works on every distribution without security gymnastics. The downside is the path is buried in `AppData\Roaming\`, but the upside is it's robust.

Settings remain delegated to the host's `settings` global (which uses its own per-profile path under `applicationDirectory` — and the host similarly bypasses the security check via the same `.nativePath` trick). Logs and settings are unrelated path-wise.

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
