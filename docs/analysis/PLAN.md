# Steward — Replacement for autoTSO

## Context

`autoTSO` is an 8,174-line monolithic Adobe AIR userscript (`/Users/rknall/Development/Settlers/autoTSO/user_auto.js`) that automates The Settlers Online. Its own analysis (`autoTSO/docs/user_auto_analysis.md`) flags it as unmaintainable: 237 try/catch blocks (mostly silent), magic numbers everywhere, mixed naming, 300–400-line functions, no module boundaries. Adding a feature today means editing one giant file with no safe boundaries.

**Steward** is a clean-sheet replacement that keeps the same runtime constraints but breaks the monolith into a kernel + a general TSO library + opt-in automation submodules. The kernel owns prioritised round-robin scheduling; submodules just declare what they want to do and when they're ready. v0.1 ships the foundation plus one real automation (`collect`) end-to-end so the architecture is proven before scaling.

User-confirmed decisions:
- **Delivery:** single bundled `user_steward.js` for release, multi-file source tree during development.
- **Scheduler:** priority + cooperative round-robin (3 tiers, per-tier cursors).
- **Migration:** clean break from autoTSO settings (own storage namespace; coexist on disk).
- **Scope:** kernel + core lib + ONE submodule (`collect`) for v0.1.
- **License:** GPLv3.
- **Repo:** https://github.com/rknall/steward (local dir stays `Steward/`).

## Constraints

Adobe AIR 32.0.0.116 JavaScript engine — same constraints as autoTSO:
- Allowed: `var`, top-level `const`, traditional `function`, ES5 string/array methods, `JSON`, regex, try/catch, `air.*`, `game`, `swmmo`, `loca`, `assets`, `$` (jQuery), `debug()`, `console` via `air.Introspector.Console`, host helpers (`createModalWindow`, `createTableRow`, `createSwitch`, `getImageTag`, `Modal`, `MenuItem`).
- Banned: `let`, arrow functions, template literals, destructuring, spread/rest, `Promise`/`async`/`await`, classes, `Set`/`Map`, `import`/`export`, modern array methods (`.includes`/`.find`/`.findIndex` on arrays, `.includes`/`.startsWith`/`.endsWith` on strings).
- Loader: TSO client loads each file in `<client>/userscripts/user_*.js` once at startup. Single-file delivery sidesteps load-order risk.

## Naming convention (applies repo-wide)

Shared enums live at `Steward.<Name>.<Value>`. The access path is namespaced and short; the literal value is **prefixed** so it's unambiguous when it appears alone (logs, settings JSON, comparisons).

```js
Steward.Building.Butchers              === 'BuildingButchers'
Steward.SpecialistType.General         === 'SpecialistGeneral'
Steward.SpecialistType.Carrier         === 'SpecialistCarrier'
Steward.SpecialistType.Explorer        === 'SpecialistExplorer'
Steward.SpecialistType.Geologist       === 'SpecialistGeologist'
Steward.SpecialistStatus.Idle          === 'StatusIdle'
Steward.SpecialistStatus.Working       === 'StatusWorking'
Steward.SpecialistStatus.Traveling     === 'StatusTraveling'
Steward.SpecialistStatus.Returning     === 'StatusReturning'
Steward.SpecialistStatus.Unavailable   === 'StatusUnavailable'
Steward.SkillModifier.SearchTime       === 'ModifierSearchTime'
Steward.SkillModifier.LootRolls        === 'ModifierLootRolls'
Steward.ExplorerTask.Short             === 'TaskExplorerShort'
Steward.GeologistTask.Search           === 'TaskGeologistSearch'
Steward.Priority.Critical              === 'PriorityCritical'
Steward.Priority.Normal                === 'PriorityNormal'
Steward.Priority.Idle                  === 'PriorityIdle'
```

Modules **never** compare against bare strings — always use the enum reference.

## Repository setup (P0)

- `git init` in `/Users/rknall/Development/Settlers/Steward`; remote `https://github.com/rknall/steward`.
- `LICENSE` — GPLv3 verbatim.
- `.gitignore` — `node_modules/`, `build/`, `.DS_Store`, `_temp/`.
- `package.json` — devDeps: `eslint`, `husky`, `lint-staged`. Scripts: `lint`, `lint:fix`, `build`, `test`.
- `.eslintrc.json` — adapted from `autoTSO/.eslintrc.json` (already bans `SpreadElement`, `RestElement`, `TemplateLiteral`, `ArrowFunctionExpression`). Add bans for `MemberExpression[property.name='includes'|'startsWith'|'endsWith'|'find'|'findIndex']` and `NewExpression[callee.name='Set'|'Map'|'WeakSet'|'WeakMap'|'Promise']`.
- `.husky/pre-commit` — runs `lint-staged`.
- `.github/workflows/ci.yml` — on PR/push: `npm ci`, `npm run lint`, `npm run build`, upload `build/user_steward.js` as artifact.
- `.github/workflows/release.yml` — on `v*` tag: lint, build, inject version into bundle banner, create GitHub Release, attach `build/user_steward.js`. Mirrors `autoTSO/.github/workflows/release.yml`.
- `README.md` — preliminary: what Steward is, install (drop bundle into `<TSO>/userscripts/`), dev quickstart, AIR-32 constraints note, link to `docs/`, GPLv3.
- Initial commit on `main`, then push to GitHub.
- **Copy this plan** to `Steward/docs/analysis/PLAN.md` as part of the initial commit so the architecture doc lives in the repo.

## Source tree (target after P3)

```
Steward/
├── src/
│   ├── kernel/                       # Bundle order driven by leading numeric prefix
│   │   ├── 00_namespace.js           # var Steward = window.Steward || { kernel:{}, core:{}, modules:{} };
│   │   ├── 10_constants.js           # TIMEOUTS, LIMITS
│   │   ├── 15_enums.js               # Steward.Priority, plus declarations of shared enum slots
│   │   ├── 20_logger.js              # Steward.kernel.log — categories + file rotation
│   │   ├── 30_settings.js            # JSON store, per-module namespaces
│   │   ├── 40_registry.js            # Steward.kernel.register(moduleSpec)
│   │   ├── 50_scheduler.js           # priority + round-robin
│   │   ├── 60_queue.js               # FIFO action queue (replaces aQueue)
│   │   ├── 70_lifecycle.js           # boot(), tick(), shutdown()
│   │   └── 90_ui_shell.js            # in-game "Steward" menu + status panel
│   ├── core/
│   │   ├── zone.js
│   │   ├── buildings.js
│   │   ├── buildings/types.js        # curated Steward.Building enum
│   │   ├── specialists.js
│   │   ├── specialists/dispatch.js   # internal helpers (still core, thin)
│   │   ├── deposits.js
│   │   ├── packets.js
│   │   ├── locale.js
│   │   ├── events.js
│   │   └── events/data.js            # event-data maps (treasures, modifiers)
│   ├── modules/
│   │   └── collect/
│   │       ├── module.js             # Steward.kernel.register({...})
│   │       ├── settings.js           # default schema for this module
│   │       └── ui.js                 # settings panel
│   └── vendor/
│       └── README.md                 # placeholder for any embedded helpers
├── docs/
│   ├── README.md
│   ├── COMPATIBILITY.md              # AIR JS limits — adapted from autoTSO
│   ├── TSO_API.md                    # game/swmmo/loca/air.* surface — adapted from autoTSO
│   ├── ARCHITECTURE.md               # NEW — kernel/core/module model
│   ├── SCHEDULER.md                  # NEW — priority + round-robin contract
│   ├── MODULE_GUIDE.md               # NEW — how to author a module
│   ├── CORE_USAGE.md                 # NEW — module-author rules: accessor discipline, cache invalidation, when to add a helper
│   ├── LOGGING.md                    # adapted from autoTSO
│   └── analysis/
│       └── PLAN.md                   # this document, copied at initial commit
├── scripts/
│   ├── build.js                      # concat src/**/*.js → build/user_steward.js
│   └── lint-air.js                   # wrapper around eslint with AIR ruleset
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
├── build/                            # gitignored
├── .eslintrc.json
├── .gitignore
├── .husky/pre-commit
├── LICENSE                           # GPLv3
├── package.json
└── README.md
```

## Module/namespace pattern

Single global `Steward`. Every source file is an IIFE that attaches to it:

```js
(function (S) {
    S.kernel.scheduler = {
        // ...
    };
})(Steward);
```

Filename prefixes (`00_`, `10_`, …) drive concat order. Modules under `src/modules/<id>/` are emitted last so the kernel exists before they `register`.

## Scheduler contract (priority + cooperative round-robin)

Three tiers in `Steward.Priority`. Each registered module declares:

```js
Steward.kernel.register({
    id: 'collect',
    priority: Steward.Priority.Normal,
    isReady: function (ctx) { return ctx.zone.isHome && ctx.now > state.cooldownUntil; },
    plan: function (ctx) { /* enqueue 0..N tasks via Steward.kernel.queue.add */ }
});
```

Each tick:
1. Build `ctx` (zone, time, session flags).
2. Walk modules sorted by priority.
3. Within a tier, advance a per-tier cursor each tick so module N+1 runs first next time (round-robin, prevents starvation).
4. Call `isReady`; if true call `plan` to enqueue tasks.
5. Drain queue (FIFO + per-task delay).
6. Sleep `tickInterval` (default 10s, configurable in settings — matches autoTSO's `aQueue.interval`).

State (cursors, last-run timestamps) lives on `Steward.kernel.scheduler.state` and persists across `tick()` calls but does not survive client restart (in-memory only — fine for v0.1).

## Settings

`Steward.kernel.settings` writes a single JSON file at `air.File.applicationStorageDirectory.resolvePath('steward/settings.json').nativePath` (writable; AIR docs in `autoTSO/docs/TSO_CLIENT_API.md` confirm). Per-module namespaces:

```js
var s = Steward.kernel.settings.read('collect');     // returns object or null
Steward.kernel.settings.write('collect', { enabled: true, lootBoxes: true });
```

Schema is owned by the registering module — kernel doesn't know fields. No autoTSO migration code (clean break).

## P2 file scopes

### `core/zone.js`
Zone identity, navigation, current-state queries.
```js
Steward.core.zone.current()           // raw zone object
Steward.core.zone.id()                // current zone ID
Steward.core.zone.isHome()
Steward.core.zone.isAdventure()
Steward.core.zone.visit(zoneId)
Steward.core.zone.scrollTo(grid)
Steward.core.zone.homePlayer()
Steward.core.zone.viewedPlayer()
```

### `core/buildings.js`
- **Returns raw game objects.** `docs/CORE_USAGE.md` enforces accessor discipline. Helpers added as patterns repeat.
- **Cache:** strict per-tick (cleared at every tick start). Modules that mutate (place mine, destroy depleted) call `Steward.core.buildings.invalidate()`.
- **Type enum source:** curated master list in `src/core/buildings/types.js`, populated from autoTSO's settings + tso_client's known names. Easy to extend.
```js
Steward.core.buildings.list({ zone })
Steward.core.buildings.list({ type: Steward.Building.Butchers, zone })
Steward.core.buildings.byName(name, { zone })
Steward.core.buildings.byGrid(grid, { zone })
Steward.core.buildings.byPredicate(fn, { zone })
Steward.core.buildings.listMines({ zone })
Steward.core.buildings.invalidate()

// State helpers (more added as patterns repeat)
Steward.core.buildings.name(b)
Steward.core.buildings.grid(b)
Steward.core.buildings.level(b)
Steward.core.buildings.isMine(b)
Steward.core.buildings.isEnemy(b)
Steward.core.buildings.isCollectible(b)
Steward.core.buildings.isAttackable(b)
Steward.core.buildings.hasArmy(b)
Steward.core.buildings.isUpgradable(b)
```

### `core/specialists.js`
- **Generals vs Carriers:** TSO collapses both to raw type 0; Steward classifies them itself. **Carriers cannot attack** (primary distinction); **generals are capacity-capped at 330** (carriers exceed this). The actual classification mechanism (capability flag vs capacity threshold vs both) is **deferred to a P2 spike** against the live client.
- **`hasExpertTroops` is a query, not a classifier** — both types can carry the full troop selection.
- **Status enum** is generic; type-specific helpers wrap it for readability.
- **Skills** normalized to `Steward.SkillModifier` enum; modules never compare modifier strings.
- **`pickTask` / `pickDeposits`** encapsulate the event-aware recommendation so modules don't reach into event data themselves.
- Composed dispatch ("send geologist to find X") is **module-level**, not core. Core stays thin.

```js
// Listing
Steward.core.specialists.all({ zone })
Steward.core.specialists.byType(Steward.SpecialistType.General, { zone })
Steward.core.specialists.byName(name, { zone })

// Classification
Steward.core.specialists.classify(spec)            // → SpecialistType.*
Steward.core.specialists.canAttack(spec)
Steward.core.specialists.troopCapacity(spec)
Steward.core.specialists.isGeneral(spec)
Steward.core.specialists.isCarrier(spec)
Steward.core.specialists.hasArmy(spec)
Steward.core.specialists.hasExpertTroops(spec)     // query, NOT classifier

// Status
Steward.core.specialists.status(spec)              // → SpecialistStatus.*
Steward.core.specialists.isAttacking(general)
Steward.core.specialists.isExploring(explorer)
Steward.core.specialists.isProspecting(geologist)
Steward.core.specialists.isHauling(carrier)
Steward.core.specialists.available(type, { zone }) // status === Idle
Steward.core.specialists.busy(type, { zone })      // status !== Idle

// Skills + recommendations
Steward.core.specialists.skills(spec)
    // → [{ modifier: Steward.SkillModifier.SearchTime, multiplier, adder, value }, ...]
Steward.core.specialists.pickTask(explorer)        // event-aware
Steward.core.specialists.pickDeposits(geologist)   // event-aware

// Low-level dispatch
Steward.core.specialists.send(spec, taskType, params, responder)
Steward.core.specialists.recall(spec, responder)
```

**P2 spike (mark as TODO in code):** during P2 implementation, validate `classify()` against the live client. Try capability flag first, fall back to capacity threshold (>330 = Carrier). Document the chosen mechanism in `docs/CORE_USAGE.md`.

### `core/deposits.js`
```js
Steward.core.deposits.list({ zone })
Steward.core.deposits.byType(name, { zone })
Steward.core.deposits.byGrid(grid, { zone })
Steward.core.deposits.depleted({ zone })           // matches "Depleted*" buildings
```

### `core/packets.js`
```js
Steward.core.packets.sendAction(actionId, p1, p2, p3, data, responder)
    // wraps game.gi.SendServerAction
Steward.core.packets.sendMessage(msgId, data, responder)
    // wraps game.gi.mClientMessages.SendMessagetoServer
Steward.core.packets.responder(spec)               // typed responder builder
```

### `core/locale.js`
Translation wrapper + safe formatter.
```js
Steward.core.locale.text(category, key)            // raw loca.GetText
Steward.core.locale.bui(key)                       // sugar for category 'BUI'
Steward.core.locale.res(key)                       // 'RES'
Steward.core.locale.lab(key)                       // 'LAB'
Steward.core.locale.adn(key)                       // 'ADN'
Steward.core.locale.qul(key)                       // 'QUL'
Steward.core.locale.format(template, args)         // string concatenation, no template literals
```

### `core/events.js` (NEW for v0.1 — required by `pickTask`/`pickDeposits`)
```js
Steward.core.events.active()                       // [{ code, name, startTime, endTime }, ...]
Steward.core.events.isActive(eventCode)
Steward.core.events.treasureValues(eventCode)      // [v0..v4] per task
Steward.core.events.depositModifier(eventCode, depositType)
Steward.core.events.byCategory(category)           // adventure | treasure | ...
```
Event-data maps live in `src/core/events/data.js` so we can add events without changing the API.

### ~~`core/army.js`~~ — **dropped from v0.1**
Classification doesn't need army inspection, and `collect` (the v0.1 module) doesn't touch specialists. Add `core/army.js` the moment we start the first specialist-using module (loadout composition, casualties, costs).

## Build pipeline

- `npm run build` → `node scripts/build.js`:
  1. Glob `src/kernel/*.js`, `src/core/**/*.js`, `src/modules/**/*.js` (each tree sorted by filename).
  2. Concat with header banner (`/* Steward vX.Y.Z — built YYYY-MM-DD — commit <sha> */`).
  3. Write to `build/user_steward.js`.
- `npm run lint` → `node scripts/lint-air.js` runs ESLint with AIR rules over `src/`.
- `npm test` → placeholder (`exit 0`) for v0.1.
- Pre-commit hook runs `lint-staged` on changed `src/**/*.js`. Match autoTSO's husky setup (`autoTSO/.husky/pre-commit`).

## First submodule: `collect`

**Why this one:** exercises the core lib (`buildings.list`, `buildings.invalidate`, packet helpers, zone gating); visually verifiable in-game; self-contained (no cross-module deps); maps to autoTSO's proven `aBuildings.collectibles.manage` (`autoTSO/user_auto.js:5100-5108`) and `aBuildings.deposits.manage` (`autoTSO/user_auto.js:5124-5175`) so the logic is known-good.

**v0.1 behaviour:**
- On home zone: enqueue `collect` actions for ready collectibles (mystery boxes, ready deposits).
- Settings: `enabled` (master toggle), `pickups` (collectibles), `lootBoxes` (FlyingHouse / GiftChristmasTree / GhostShip / BalloonMarket).
- No deposit *building/upgrading* in v0.1 — that's a later module.

**Reference logic to mirror (read-only, port to Steward idioms — no copy-paste of autoTSO bugs):**
- `autoTSO/user_auto.js:5022-5054` — collectibles detection
- `autoTSO/user_auto.js:5055-5073` — lootables list
- `autoTSO/user_auto.js:5100-5108` — manage gate

## Templates as future modules (post-v0.1, design awareness)

```
src/modules/
├── collect/                    # v0.1
├── explorers/        # later — uses core/specialists.pickTask, core/events
├── templates_geologists/       # later — also handles mine building/leveling
└── templates_armies/           # later — warfare loadouts (will pull in core/army.js)
```

UI grouped per module = configuration grouped thematically, as discussed.

## Documentation (authored in P0, before any code)

| File | Source |
|---|---|
| `docs/COMPATIBILITY.md` | Adapt `autoTSO/docs/COMPATIBILITY.md`. Add Steward IIFE/namespace idiom. |
| `docs/TSO_API.md` | Adapt `autoTSO/docs/TSO_CLIENT_API.md`. |
| `docs/ARCHITECTURE.md` | NEW. Kernel/core/module model. Lifecycle. Tick model. |
| `docs/SCHEDULER.md` | NEW. Priority tiers, round-robin cursor, `isReady`/`plan` contract, examples. |
| `docs/MODULE_GUIDE.md` | NEW. How to add a module: file layout, `register()`, settings schema, UI hooks. Hello-world example. |
| `docs/CORE_USAGE.md` | NEW. Accessor discipline (raw objects, no chained `.GetGOContainer().mIsX` in modules). Cache invalidation contract. When to add a helper. Naming convention reference. |
| `docs/LOGGING.md` | Adapt `autoTSO/docs/LOGGING.md`. |
| `docs/analysis/PLAN.md` | This plan, copied verbatim at initial commit. |

## Phasing for v0.1

1. **P0 — Repo + docs.** `git init`, GPLv3 LICENSE, `.gitignore`, `.eslintrc.json`, `package.json`, husky hook, build script skeleton (writes empty bundle), all 7 docs + `docs/analysis/PLAN.md`, GitHub Actions CI + release workflows. Initial commit, push to `https://github.com/rknall/steward`.
2. **P1 — Kernel skeleton.** `00_namespace.js`–`90_ui_shell.js`. Boot in TSO client with no modules: shows "Steward" menu entry and "Steward online — 0 modules" status. Verifies single-file bundle loads cleanly inside AIR.
3. **P2 — Core lib.** `zone.js`, `buildings.js` + `buildings/types.js`, `specialists.js` + `specialists/dispatch.js`, `deposits.js`, `packets.js`, `locale.js`, `events.js` + `events/data.js`. **Spike `classify()` against live client** (capability flag vs >330 capacity heuristic). Each function ports the autoTSO pattern but returns explicit results — no silent catch swallowing.
4. **P3 — `collect` module + UI shell.** Real automation. Settings panel. End-to-end smoke in client.
5. **P4 — First release.** Tag `v0.1.0`, GitHub Action publishes `build/user_steward.js`. README install instructions.

Each phase = its own commit (or small commit series). Plan covers P0–P3; P4 is a separate task.

## Critical files to create (P0 — this round)

- `/Users/rknall/Development/Settlers/Steward/.gitignore`
- `/Users/rknall/Development/Settlers/Steward/.eslintrc.json`
- `/Users/rknall/Development/Settlers/Steward/package.json`
- `/Users/rknall/Development/Settlers/Steward/README.md`
- `/Users/rknall/Development/Settlers/Steward/LICENSE` (GPLv3)
- `/Users/rknall/Development/Settlers/Steward/scripts/build.js`
- `/Users/rknall/Development/Settlers/Steward/scripts/lint-air.js`
- `/Users/rknall/Development/Settlers/Steward/.husky/pre-commit`
- `/Users/rknall/Development/Settlers/Steward/.github/workflows/ci.yml`
- `/Users/rknall/Development/Settlers/Steward/.github/workflows/release.yml`
- `/Users/rknall/Development/Settlers/Steward/docs/README.md`
- `/Users/rknall/Development/Settlers/Steward/docs/COMPATIBILITY.md`
- `/Users/rknall/Development/Settlers/Steward/docs/TSO_API.md`
- `/Users/rknall/Development/Settlers/Steward/docs/ARCHITECTURE.md`
- `/Users/rknall/Development/Settlers/Steward/docs/SCHEDULER.md`
- `/Users/rknall/Development/Settlers/Steward/docs/MODULE_GUIDE.md`
- `/Users/rknall/Development/Settlers/Steward/docs/CORE_USAGE.md`
- `/Users/rknall/Development/Settlers/Steward/docs/LOGGING.md`
- `/Users/rknall/Development/Settlers/Steward/docs/analysis/PLAN.md` (copy of this plan)

## Reference files (read-only, source material)

- `autoTSO/docs/COMPATIBILITY.md` — full AIR JS compat reference
- `autoTSO/docs/TSO_CLIENT_API.md` — TSO client API surface
- `autoTSO/docs/LOGGING.md` — logging/rotation model
- `autoTSO/.eslintrc.json` — AIR-incompat ESLint rules to extend
- `autoTSO/.husky/pre-commit` — husky setup template
- `autoTSO/.github/workflows/release.yml` — release workflow template
- `autoTSO/user_auto.js:358` — `aDebug` (logger pattern)
- `autoTSO/user_auto.js:585` — `aQueue` (queue pattern)
- `autoTSO/user_auto.js:1046` — `aSettings` (settings store pattern)
- `autoTSO/user_auto.js:5021` — `aBuildings` (entry to collect logic)
- `tso_client/userscripts/user_buffenhancer.js` — example small userscript pattern (IIFE, jQuery)

## Verification (per phase)

- **P0:** `git log` shows one initial commit. `git remote -v` points at `rknall/steward`. `npm install` succeeds. `npm run lint` passes on the empty src tree. `npm run build` produces `build/user_steward.js` (just the banner). CI workflow visible in GitHub Actions.
- **P1:** Drop bundled file into TSO client `userscripts/`. Launch client. "Steward" appears in the menu; status panel reads `Steward online — 0 modules`. No errors in the AIR JS console.
- **P2:** Add a tiny diagnostic submodule that calls each core function and logs results; bundle, install, run; verify each core call returns sensible data on home zone. **`classify()` correctly distinguishes generals from carriers** in the live client.
- **P3:** Enable `collect` module. On home zone, mystery boxes/ready deposits trigger collect actions with status updates. Disable → loop stops cleanly. Run alongside autoTSO in `userscripts/` — no global collisions.
- **Coexistence check:** `grep -nE '^\s*(var|const)\s+a[A-Z]' build/user_steward.js` must return nothing.

## Out of scope for v0.1 (explicit non-decisions)

- Out-of-band auto-update mechanism (defer to P5+).
- Adventure/mail/trade/quests/templates modules (later phases).
- `core/army.js` (deferred — added with first specialist-using module).
- Settings UI framework — keep jQuery + host-provided `Modal`/`createModalWindow`/`createTableRow`/`createSwitch` helpers; no React/Vue/etc.
- TypeScript / unit testing harness — pure JS for now; tests TBD when modules grow.
