# Mining Module — v1 Design

**Status:** approved for implementation planning
**Date:** 2026-04-27
**Predecessor:** `modules/geologists` (commit fa01cd3) — handles deposit-search dispatch; this module covers what happens to mines on found deposits.

## Goal

Add a `mining` module that places mine buildings on freshly-found deposits on the home zone. Frame the planner as a phased shell so future work (upgrade, pause, buff, refill) lands as additions, not restructures.

## v1 Scope

**In scope**
- Place a mine on every deposit grid that has no building, for the 6 mine-bearing deposit types (BronzeOre, IronOre, GoldOre, Coal, TitaniumOre, Salpeter).
- Honour build-queue slots, building licenses, and per-mine affordability.
- Per-deposit-type settings tree, master enable/disable toggle.
- Dashboard section co-located on the existing `geologists` tab.

**Out of scope (deferred to v2+)**
- Upgrade mines to a target level.
- Pause / unpause production.
- Apply buffs to mines or masons.
- Refill depleted deposits.
- Removing depleted deposit-buildings (depleted shells do not consume building licenses, and geos can re-find on top of them — autoTSO's `removeDepleted` phase is an unnecessary action).
- A `core/buffs` subsystem (`AUTOTSO_PARITY.md:153` confirms it does not yet exist; both `tryBuff` and `tryRefill` likely depend on it).

## Architecture

### Module layout

```
src/modules/mining/
├── module.js     # kernel.register, plan(), boot(), queue action(s)
├── settings.js   # default settings tree
└── ui.js         # dashboard section renderer
```

Mirrors `src/modules/geologists/`. Build script concatenates everything under `src/modules/` into the single AIR bundle — no build wiring change.

### Registration

```js
S.kernel.register({
    id:       'mining',
    priority: S.Priority.Normal,
    boot:     boot,
    isReady:  isReady,
    plan:     plan,
    ui: {
        tab: 'geologists',          // shared with the geologists module
        section: {
            id:    'mining',
            title: 'Mining',
            render:  function ($body, h) { ... },
            summary: function () { ... }
        }
    }
});
```

`isReady()`: `enabled && ctx.zone && ctx.zone.isHome`.

The kernel allows multiple modules to register sections on the same tab — this is how UI co-location and code separation co-exist.

### Phased planner shell

```js
function plan() {
    if (!preflight()) return;
    var ctx = readPlanContext();          // { slotsRemaining, licensesRemaining, queued, assigned }
    var types = S.core.deposits.types();
    for (var t = 0; t < types.length; t++) {
        var info = types[t];
        var cfg  = readDepositCfg(info.name);
        if (!cfg || !cfg.enabled) continue;

        if (info.mineName) {              // mine-bearing only (6 of 9)
            tryBuild(info, cfg, ctx);
            tryUpgrade(info, cfg, ctx);   // stub — v2
            tryPause(info, cfg, ctx);     // stub — v2
        }
        tryBuff(info, cfg, ctx);          // stub — v2 (mine OR mason)
        tryRefill(info, cfg, ctx);        // stub — v2 (all types)
    }
    if (ctx.queued > 0) S.kernel.log('mining', 'queued', ctx.queued, 'action(s)');
}
```

`ctx` is mutable, threaded through every phase. Each phase decrements `slotsRemaining` / `licensesRemaining` as it queues, so subsequent phases see accurate residual capacity without re-reading host counters mid-tick.

The `info.mineName` predicate is the natural capability flag: Stone, Marble, Granite carry `mineName: null` and skip the build/upgrade/pause block entirely. `tryBuff` internally branches on `info.mineName` vs `info.masonName` to choose its target.

### `tryBuild()` (the only filled phase)

```js
function tryBuild(info, cfg, ctx) {
    if (!cfg.build) return;
    if (ctx.slotsRemaining <= 0 || ctx.licensesRemaining <= 0) return;

    var onMapDepos = S.core.deposits.byType(info.name);
    for (var i = 0; i < onMapDepos.length; i++) {
        var depo = onMapDepos[i];
        var grid = S.core.deposits.grid(depo);
        if (!grid || ctx.assigned[grid]) continue;

        // A building (any building, including a depleted shell) on this
        // grid means the deposit is already covered. Depleted shells
        // resolve naturally: a geo finds a new deposit, the shell goes
        // away, byGrid returns null, the next tick queues the build.
        if (S.core.buildings.byGrid(grid)) continue;

        if (!canAffordMine(info.mineName)) continue;

        ctx.assigned[grid] = true;
        ctx.slotsRemaining--;
        ctx.licensesRemaining--;
        ctx.queued++;

        var delay = (ctx.queued === 1) ? 0 : ctx.actionDelay;
        S.kernel.queue.add('mining.buildMine',
            [info.mineId, grid, info.name, info.mineName],
            delay);

        if (ctx.slotsRemaining <= 0 || ctx.licensesRemaining <= 0) return;
    }
}
```

### `mining.buildMine` queue action

Registered in `boot()`:

```js
S.kernel.queue.action('mining.buildMine', function (params) {
    var mineId   = params[0];
    var grid     = params[1];
    var depoName = params[2];
    var mineName = params[3];

    if (S.core.buildings.byGrid(grid)) {
        S.kernel.log('mining', 'grid', grid, 'now occupied — skipping', mineName);
        return;
    }
    if (!canAffordMine(mineName)) {
        S.kernel.log('mining', 'no longer affordable — skipping', mineName);
        return;
    }
    try {
        game.gi.SendServerAction(50, mineId, grid, 0, null);
        S.kernel.log('mining', 'placed', mineName, 'on grid', grid, '(' + depoName + ')');
        S.core.buildings.invalidate();
    } catch (e) {
        S.kernel.error('mining', 'SendServerAction(50) threw for', mineName, ':', e);
    }
});
```

State can drift between `plan()` and the action firing (delays, manual user clicks, other modules). The defensive re-checks no-op gracefully rather than committing to a stale plan. `buildings.invalidate()` after success forces a fresh snapshot next tick so the new mine doesn't double-trigger.

### Pre-flight and context helpers

```js
function preflight() {
    var s = readSettings();
    if (!s || !s.enabled) return false;
    return true;       // home-zone check is in isReady()
}

function readPlanContext() {
    var s  = readSettings();
    var p  = game.gi.mCurrentPlayer;
    var bq = p.mBuildQueue;
    return {
        slotsRemaining:    bq.GetTotalAvailableSlots() - bq.GetQueue_vector().length,
        licensesRemaining: p.GetMaxBuildingCount() - p.mCurrentBuildingsCountAll,
        queued:            0,
        assigned:          {},
        actionDelay:       (typeof s.actionDelay === 'number') ? s.actionDelay : 1500
    };
}

function canAffordMine(mineName) {
    return game.zone.GetResources(game.player).CanPlayerAffordBuilding(mineName);
}
```

## Data Model — `core/deposits/types.js` extension

Each entry in the existing `TABLE` gains three fields:

| name        | mineId | mineName     | masonName    |
|-------------|-------:|--------------|--------------|
| Stone       |     — | —            | Mason        |
| BronzeOre   |     36 | BronzeMine   | —            |
| Marble      |     — | —            | MarbleMason  |
| IronOre     |     50 | IronMine     | —            |
| GoldOre     |     46 | GoldMine     | —            |
| Coal        |     37 | CoalMine     | —            |
| Granite     |     — | —            | GraniteMason |
| TitaniumOre |     69 | TitaniumMine | —            |
| Salpeter    |     63 | SalpeterMine | —            |

Source: `autoTSO/user_auto.js:1086-1095`; mason naming convention from `user_auto.js:5168` (`Stone → Mason`, others → `<name>Mason`).

`null` for fields that don't apply. The data is intrinsic to the deposit type, not the mining module's policy — diagnostics and any other module needing the mapping reads the same table.

The existing `S.core.deposits.types()` API stays intact; new fields are added keys on each returned object.

## Settings — `steward.mining`

```js
S.modules.mining.defaultSettings = {
    enabled:     false,
    actionDelay: 1500,
    deposits: {
        Stone:       { enabled: true, buff: '', refill: '' },
        BronzeOre:   { enabled: true, build: true, upgrade: false, targetLevel: 3,
                       pause: false, buff: '', refill: '' },
        Marble:      { enabled: true, buff: '', refill: '' },
        IronOre:     { enabled: true, build: true, upgrade: false, targetLevel: 3,
                       pause: false, buff: '', refill: '' },
        GoldOre:     { enabled: true, build: true, upgrade: false, targetLevel: 3,
                       pause: false, buff: '', refill: '' },
        Coal:        { enabled: true, build: true, upgrade: false, targetLevel: 3,
                       pause: false, buff: '', refill: '' },
        Granite:     { enabled: true, buff: '', refill: '' },
        TitaniumOre: { enabled: true, build: true, upgrade: false, targetLevel: 3,
                       pause: false, buff: '', refill: '' },
        Salpeter:    { enabled: true, build: true, upgrade: false, targetLevel: 3,
                       pause: false, buff: '', refill: '' }
    }
};
```

Choices:
- **`enabled` at root** — module-level master toggle; gates the planner.
- **Per-type `enabled`** — type-level master switch; if false, no phase runs for that type.
- **`build: true` default** for the 6 mine-bearing types — matches autoTSO `options[1]: true`. Module is opt-in at the root, so this default only activates once the user enables Mining.
- **`targetLevel: 3`** stored now even though `tryUpgrade` is a stub — settings shape stable across v1→v2, no migration.
- **Stone/Marble/Granite** carry only `enabled`/`buff`/`refill` — no build/upgrade/pause/targetLevel because those phases are unreachable for mason types.
- **`buff` and `refill` are strings** (`''` = off) — selecting *which* buff or refill item is required eventually; baking the string shape now avoids a v2 migration.
- **No coupling to `steward.geologists.deposits[name]`** — overlapping deposit names, but each module owns its own toggles. Sharing would link roll-forward / roll-back of the two.

## UI — Mining section under the geologists tab

A second section beside the existing Geologists section. Header, master toggle, then a table over all 9 types in the canonical `S.core.deposits.types()` order. No icon on the section header (per user UI preference — avoid icons unless explicitly requested):

```
Mining                                     summary: "3 mines pending"
─────────────────────────────────────────────────
☐ Enable Mining

  Deposit         Build Mine    Build Queue    Active
  ────────────────────────────────────────────────────
  Stone           —             —              4
  Bronze Ore      ☑             —              3
  Marble          —             —              2
  Iron Ore        ☑             1 queued       5
  Gold Ore        ☑             —              2
  Coal            ☐             —              1
  Granite         —             —              1
  Titanium Ore    ☑             —              1
  Salpeter        ☑             —              1

  Build queue: 2/4 slots used · Licenses: 47/50
```

- **All 9 types listed** in the canonical order. Stone/Marble/Granite show `—` in every action column — stable mental map of the deposit roster across modules.
- **Build Mine column** — only checkable for the 6 mine-bearing types. Writes `deposits.<name>.build`. Stone/Marble/Granite show `—`.
- **Build Queue column** — populated only when the current tick has queued a `mining.buildMine` for that type. Empty cell otherwise.
- **Active column** — count of live buildings of the relevant kind. For mine-bearing types: `core.buildings.byName(info.mineName).length` — depleted shells do not match (different name prefix). For Stone/Marble/Granite: `core.buildings.byName(info.masonName).length`. Computed via:
  ```js
  function activeCount(info) {
      var n = info.mineName || info.masonName;
      if (!n) return 0;
      return S.core.buildings.byName(n).length;
  }
  ```
- **Status footer** — current build-queue usage and license count. Read-only, refreshes on tab open.
- **Section summary** (rendered in the section header collapsed view) — pending build count, mirroring the geologists section's summary helper in `modules/geologists/ui.js`.
- **No `action:` button in v1** — geologists has one for "Show ranking + state"; mining has nothing equivalent to dump until upgrade/buff phases land. Easy to add later.

The per-type `enabled` flag is **not surfaced** in v1 — the master toggle plus per-type `build` checkbox is sufficient for the scope. When upgrade/pause/buff/refill columns appear, per-type `enabled` becomes meaningful as "skip this type entirely" and gets its own column.

## Cross-module Interaction

- **Geologists** runs on the same tick. Geo dispatch finds deposits → next tick, mining sees them on map → queues build. No coupling beyond shared `S.core.deposits.types()`.
- **Collect** is unrelated — collectibles are not mines or deposits.
- **Diagnostics** is read-only.
- The kernel busy contract (per `docs/MODULE_GUIDE.md`) prevents `plan()` from re-queueing while the module's queue actions are still draining — same pattern as geologists.

## Files

**Create**
- `src/modules/mining/module.js`
- `src/modules/mining/settings.js`
- `src/modules/mining/ui.js`

**Modify**
- `src/core/deposits/types.js` — extend `TABLE` entries with `mineId`, `mineName`, `masonName`.

## Validation

- `npm run lint` — Biome + AIR-32 ESLint config; fails on any forbidden ES6+ syntax.
- `npm run build` — emits `build/user_steward.js`; fails on syntax errors.
- **Live host smoke test** — drop the bundle into TSO's `userscripts/`, enable Mining, observe:
  - With at least one unbuilt deposit on the home zone and full resources: a `mining.buildMine` queues and the mine appears.
  - With Build Mine unchecked for a type: no action queued for that type.
  - With zero build slots: planner skips silently, no queued log line.
  - Active column updates after a successful build.
  - Disabling Mining stops the planner cleanly.

## v1 Acceptance

1. Module loads, registers a section under the geologists tab.
2. Master toggle gates the planner; per-type Build Mine checkbox drives queue behavior.
3. With at least one unbuilt deposit + budget + capacity, a mine appears in the host.
4. Active column reflects live state.
5. Bundle passes lint and build.

## Open Questions for v2 (not blocking v1)

- Refill mechanism — item use, buff application, or distinct server action? Needs a spike against the live host before `tryRefill` is implemented.
- `core/buffs` shape — required by both `tryBuff` and likely `tryRefill`; deserves its own design pass.
- Per-type `enabled` exposure in UI — surface when the second column lands.
