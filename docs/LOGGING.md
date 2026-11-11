# Logging

Steward provides a single, category-based logger that emits to both the in-client JavaScript console and a rotating log file in writable storage.

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
| `maxFileSizeKB`| `5120`  | Rotate the file when it grows past this size. `0` = no size rotation. |
| `keepRotated`  | `7`     | Number of rotated files to retain. `0` keeps none.              |
| `rotateDaily`  | `true`  | Also rotate the file when its last write was on an earlier day. |

The Settings screen (Settings → Logging) edits these values.

To disable a noisy category at runtime:

```js
var s = Steward.kernel.settings.read('logger') || { categories: {} };
s.categories.buildings = false;
Steward.kernel.settings.write('logger', s);
```

## Log file location

Primary path:

```
<client install>/steward/logs/console.log
```

The client install folder holds the client binaries. On TSO-Portable (Windows) the file is `C:\Users\<user>\AppData\Local\tso_portable\steward\logs\console.log`. The logger asks `Steward.kernel.files.writableDir('steward/logs')` for the folder, so the log follows the same location policy as every other steward file (see [TSO_API.md](TSO_API.md#adobe-air--file-system)).

If that folder cannot be used, the logger falls back in this order:

```
<applicationStorageDirectory>/steward/logs/console.log
<documentsDirectory>/steward/logs/console.log
```

Either way, the rotation chain is `console.log.1`, `console.log.2`, … kept in the same directory.

When the logger boots, it writes one of these to the console sink so users can confirm the path:

```
[LOG]   [...] [logger] writing to /path/to/steward/logs/console.log
[WARN]  [...] [logger] applicationDirectory unavailable, using applicationStorageDirectory /path/to/steward/logs/console.log
[WARN]  [...] [logger] storage dir unavailable, using documents fallback ...
[ERROR] [...] [logger] no writable log location — file output disabled
```

The tags are the values of `Steward.LogLevel` (kernel/15_enums.js). The file API's low-level notes use the same strings, so a tag means the same thing wherever it is printed.

To find the absolute path programmatically, call this after boot (it returns `null` when no writable location exists):

```js
Steward.kernel.log.filePath()
```

Directory creation walks the parents, because `air.File.createDirectory()` is not recursive: `steward/` is created before `steward/logs/`.

### Why not alongside autoTSO?

autoTSO writes to `applicationDirectory/auto/logs/console.log`, and that works because it **bypasses AIR's application-content security check** by round-tripping through `.nativePath`:

```js
// autoTSO pattern:
var path = air.File.applicationDirectory.resolvePath('auto/logs/console.log').nativePath;
var file = new air.File(path);   // ← new File from a path string, not a resolvePath result
```

`applicationDirectory.resolvePath(...)` returns a File object that AIR has marked as "application content" — writing to it throws `SecurityError: fileWriteResource`. Constructing a new `air.File(stringPath)` bypasses the marker because the resulting File object isn't classified as application content. Same path on disk, different AIR-internal flag.

Steward uses the same round trip, in `Steward.kernel.files.appFile`, so its logs sit under the install folder next to autoTSO's `auto/` folder. `applicationStorageDirectory` is the fallback when the install folder refuses the write.

Settings remain delegated to the host's `settings` global (which uses its own per-profile path under `applicationDirectory` — and the host similarly bypasses the security check via the same `.nativePath` trick). Logs and settings are unrelated path-wise.

### Rotation

Either trigger rotates the file: it grew past `maxFileSizeKB`, or (with `rotateDaily`) its last write was on an earlier day. The two are independent; either can be off. Rotation is driven by writes, so a quiet log rotates at its first line after midnight, not at midnight itself.

```
console.log              # current
console.log.1            # most recent rotation
console.log.2
...
console.log.<keepRotated>
```

The oldest is deleted before the chain shifts. With `keepRotated` at `0` no rotated file is kept. Lowering `keepRotated` deletes the excess files when the setting is saved.

If a rotation fails, history stays intact, the line that triggered it is still written, and the next attempt happens after a minute. While a rotation is in flight the current file is moved aside to `console.log.rotating`. That file may exist briefly, or remain after a failure, and goes through the chain at the next rotation.

Disk use is bounded by `(keepRotated + 1) * maxFileSizeKB`, 40 MB with the defaults.

Stored settings apply when the bundle loads, before the first file write. Save on the Settings screen applies them again at once, with no reload. A direct `settings.write('logger', ...)` from elsewhere still needs a script reload or a call to `S.kernel.lifecycle.applySettings.logger()`.

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

## Kernel health lines

| Id | Where | Level, category | Text (values in `<>`) | When |
|---|---|---|---|---|
| L1a | queue | log `queue` | `deferring <depth> action(s): dialog visible: <list>` | the first poll of a deferral |
| L1b | queue | log `queue` | `still deferring <depth> action(s) after <s> s: dialog visible: <list>` | at most once per `LOG_REPEAT_MS` while deferred |
| L1c | queue | warn `queue` | `held <m> min by dialog <list>; if no steward window is on screen the game may be covering it: restart the client` | once per deferral, at `QUEUE_MODAL_STALE_MS` |
| L1d | queue | log `queue` | `resumed after <s> s` | the first poll with no visible dialog after a deferral |
| L1e | queue | log `queue` | `deferral ended after <s> s: queue empty` | the queue emptied while deferred (cancel) |
| L1f | queue | log `queue` | `reset while deferring after <s> s, <depth> action(s) dropped` | `reset()` while deferred |
| L2 | scheduler | log `scheduler` | `heartbeat: tick <n>, queue <depth> (<draining|idle>), deferring <no|<s> s by <list>>, busy <ids|none>` | at most once per `HEARTBEAT_MS`, from `tick()` |
| L3 | scheduler | warn `scheduler` | `tick gap <s> s (interval <i> s): the timer was held, e.g. by a locked or disconnected session` | a tick more than `TICK_GAP_FACTOR` intervals after the last one |
| L4a | scheduler | error `scheduler` | `tick threw[ (<n> more since the last line)]: <e>` | a throw in the tick body, rate-limited |
| L4b | queue | error `queue` | `runOne threw[ (<n> more since the last line)]: <e>` | a throw outside the action call, rate-limited |
| L5a | ui | log `ui` | `window shown: <rawId>` / `window show had no effect: <rawId> (still closing)` | after `modal.show()` in `showModal` |
| L5b | ui | log `ui` | `window hidden: <rawId>` | a `hide.bs.modal` event on a shown steward modal (steward, host X or the host's `Modal.show`) |
| L5c | ui | warn `ui` | `second hide of <rawId> while it closes: the game may now cover steward windows; restart the client if the game stops reacting` | a `hide.bs.modal` event on a steward modal that is not shown |
| L6a | lifecycle | log `lifecycle` | `boot complete — <buildLabel> — modules: <n> — state: <active|paused> — dialogs visible: <list>` | end of `boot()` |
| L6b | lifecycle | warn `lifecycle` | `<n> dialog(s) visible at boot: <list>; queued actions wait until they close` | at boot when the list is not empty |

`<s>` is whole seconds, `<m>` whole minutes. No line is written per 2 s poll.

`tick threw` and `runOne threw` each use one `S.kernel.log.limited(ms)` limiter (kernel/20_logger.js), which writes at most one line per `LOG_REPEAT_MS` and adds `(<n> more since the last line)` when lines were held back. The deferral repeat keeps its own stamp, since it repeats a state line.

Examples:

```
[LOG]   [2026-04-26 14:30:00] [lifecycle] boot complete — v0.11.0 — modules: 9 — state: active — dialogs visible: none
[LOG]   [2026-04-26 14:32:01] [queue] deferring 3 action(s): dialog visible: #steward-production
```

Reading a stall: no heartbeat for more than 15 min means the timer stopped. A `deferring` line with no `resumed` means a dialog holds the queue. A `second hide` WARN marks the moment the stage may have been wedged.

## Output sinks

The logger writes to (in order):

1. **In-client JS console** via `air.Introspector.Console` when present (host-provided debug console). Falls back to `debug()` if available.
2. **Log file** at the path above, when `fileEnabled` is `true`.

Sinks fail safely — if the file write throws, the console write still happens. The kernel never raises a logger failure to module code.

## Conventions

- Use the module ID as the category. Don't reuse another module's category. The production module and the production core (queue readers, planner, demand ledger, complete and on/off actions) log under `production`; the diagnostics dump of the production queues logs under `diag:production`.
- Reserve `kernel:*` prefixes for internal kernel logging (`scheduler`, `queue`, `lifecycle`).
- Don't `try/catch` around `Steward.kernel.log` — the logger swallows its own failures.
- Don't log at INFO level inside hot loops. The scheduler tick writes no INFO line per cycle; its only INFO line is the rate-limited heartbeat.
- A condition that can repeat every tick logs through `S.kernel.log.limited`, never a hand-kept stamp and counter.
- Errors caught from game APIs should be logged at ERROR with category context, then handled — never re-thrown into the kernel tick.

## What this replaces

autoTSO had two parallel systems: `aDebug` (category-based) and `aConsoleLogger` (rotating file). Steward unifies both behind `Steward.kernel.log` and lets configuration distinguish them. Reference for the autoTSO patterns we're collapsing:

- `autoTSO/user_auto.js:358` — `aDebug`
- `autoTSO/docs/LOGGING.md` — original logging design
