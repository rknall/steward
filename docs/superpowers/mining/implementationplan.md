# Mining Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `mining` module that places mine buildings on freshly-found deposits on the home zone, framed as a phased planner so future work (upgrade, pause, buff, refill) lands as additions rather than restructures.

**Architecture:** New `src/modules/mining/` module, sibling to `src/modules/geologists/`. Extends `src/core/deposits/types.js` with mine/mason metadata. Registers a section under the existing `geologists` UI tab. Phased `plan()` runs `tryBuild` (filled), `tryUpgrade` / `tryPause` / `tryBuff` / `tryRefill` (stubs). Settings stored at `steward.mining`. See `docs/superpowers/mining/module-design.md` for the full spec.

**Tech Stack:** Adobe AIR 32 / ES5+ (strict — no `let`/`const`/arrow/template literals/destructuring/spread/`.includes()`/`.find()`/`.startsWith()`/`Promise`/`Set`/`Map`). Single-file bundle built by `scripts/build.js` (concatenation by directory + filename sort). Lint by `scripts/lint-air.js`. No test runner — verification is `npm run lint` + `npm run build` + live-host smoke against the AIR client.

---

## Task 1: Extend `core/deposits/types.js` with mine/mason metadata

**Files:**
- Modify: `src/core/deposits/types.js`

The `TABLE` entries returned by `S.core.deposits.types()` need three new fields: `mineId` (numeric building type for `SendServerAction(50, ...)`), `mineName` (string for `CanPlayerAffordBuilding`), and `masonName` (host's mason building name, only for Stone/Marble/Granite). All values come from `autoTSO/user_auto.js:1086-1095` and `:5168`.

- [ ] **Step 1: Edit `src/core/deposits/types.js` to add a `MINE_DATA` map and merge it into `TABLE`**

Replace the existing `TABLE` construction block (lines 42-51) with:

```js
    // Per-deposit mine + mason metadata. Source: autoTSO/user_auto.js:1086-1095
    // (numeric mine IDs, mine name convention) and :5168 (mason name
    // convention — Stone uses bare 'Mason', the others get prefix).
    var MINE_DATA = {
        Stone:       { mineId: null, mineName: null,           masonName: 'Mason' },
        BronzeOre:   { mineId: 36,   mineName: 'BronzeMine',   masonName: null },
        Marble:      { mineId: null, mineName: null,           masonName: 'MarbleMason' },
        IronOre:     { mineId: 50,   mineName: 'IronMine',     masonName: null },
        GoldOre:     { mineId: 46,   mineName: 'GoldMine',     masonName: null },
        Coal:        { mineId: 37,   mineName: 'CoalMine',     masonName: null },
        Granite:     { mineId: null, mineName: null,           masonName: 'GraniteMason' },
        TitaniumOre: { mineId: 69,   mineName: 'TitaniumMine', masonName: null },
        Salpeter:    { mineId: 63,   mineName: 'SalpeterMine', masonName: null }
    };

    // Cache the type-table so callers can iterate without rebuilding.
    var TABLE = [];
    for (var j = 0; j < TYPE_ORDER.length; j++) {
        var nm = TYPE_ORDER[j];
        var md = MINE_DATA[nm] || { mineId: null, mineName: null, masonName: null };
        TABLE.push({
            name:       nm,
            enumVal:    nm,
            index:      j,
            typeString: 'FindDeposit' + nm,
            mineId:     md.mineId,
            mineName:   md.mineName,
            masonName:  md.masonName
        });
    }
```

- [ ] **Step 2: Run lint to verify syntax**

Run: `npm run lint`
Expected: passes with no errors.

- [ ] **Step 3: Run build to verify the bundle compiles**

Run: `npm run build`
Expected: writes `build/user_steward.js`, no errors.

- [ ] **Step 4: Verify the new fields appear in the bundle**

Run: `grep -c "BronzeMine" build/user_steward.js`
Expected: at least 1 (string is now present in the bundled types table).

- [ ] **Step 5: Commit**

```bash
git add src/core/deposits/types.js
git commit -m "core/deposits: add mine/mason metadata to type table"
```

---

## Task 2: Create `src/modules/mining/settings.js`

**Files:**
- Create: `src/modules/mining/settings.js`

Default settings tree at `steward.mining`. Per-deposit shape differs between mine-bearing types (have `build`/`upgrade`/`targetLevel`/`pause`) and mason types (have only `enabled`/`buff`/`refill`). The `buff` and `refill` fields are strings from day one — selecting *which* buff or refill item is required eventually, and stable shape avoids a v2 migration.

- [ ] **Step 1: Create the file**

Path: `src/modules/mining/settings.js`

Contents:

```js
/*
 * Default settings for the mining module.
 *
 * Stored under steward.mining. Shape:
 *
 *   {
 *     enabled:     false,
 *     actionDelay: 1500,
 *     deposits: {
 *       <Name>: { enabled, build?, upgrade?, targetLevel?, pause?, buff, refill }
 *     }
 *   }
 *
 * Mine-bearing types (Bronze/Iron/Gold/Coal/Titanium/Salpeter) have the
 * full shape. Mason-only types (Stone/Marble/Granite) carry only
 * enabled / buff / refill — the build/upgrade/pause phases are
 * unreachable for them.
 *
 * `buff` and `refill` are strings; '' means off. The shape leaves room
 * for selecting which buff item or refill item to apply once those
 * phases land in v2 (depends on a future core/buffs subsystem).
 *
 * Defaults mirror autoTSO's Deposits.data (user_auto.js:1086-1095):
 * options[1] true (build) and options[3] 3 (target level) for the six
 * mine-bearing types.
 */

(function (S) {

    if (!S.modules.mining) S.modules.mining = {};

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

}(Steward));
```

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: passes.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: writes `build/user_steward.js`, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/modules/mining/settings.js
git commit -m "mining: default settings tree"
```

---

## Task 3: Create module skeleton with registration and stub phases

**Files:**
- Create: `src/modules/mining/module.js`

Module skeleton: IIFE, `readSettings` with deep-merge of the deposits map, `isReady` (enabled + home zone), `boot` (no queue actions yet — those land in Task 4), `plan` shell calling all five phase functions (every phase is a stub that returns immediately), `kernel.register` call. The phase stubs intentionally exist now so Task 4 only fills `tryBuild` rather than restructuring.

- [ ] **Step 1: Create the file**

Path: `src/modules/mining/module.js`

Contents:

```js
/*
 * Mining module.
 *
 * Manages the mine-building lifecycle on the home zone. v1 fills the
 * `tryBuild` phase only — places a mine on every deposit grid that
 * has no building, subject to build-queue slots, building licenses,
 * and per-mine affordability. The other phases (tryUpgrade, tryPause,
 * tryBuff, tryRefill) are stubs that return immediately; they land in
 * v2 once the core/buffs subsystem exists.
 *
 * The geologists module covers deposit-search dispatch. This module
 * runs independently on the same tick: geos find deposits → next tick,
 * mining sees them on map → queues build. No coupling beyond shared
 * S.core.deposits.types().
 *
 * Honours the kernel's busy contract: once plan() has enqueued one
 * action per available slot the module is "busy" until the queue
 * drains. No second plan() call piles work on top.
 */

(function (S) {

    if (!S.modules.mining) S.modules.mining = {};

    function readSettings() {
        var stored = S.kernel.settings.read('mining') || {};
        var defaults = S.modules.mining.defaultSettings || {};
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        // Deep-merge nested deposits map so partial user edits don't
        // wipe defaults for deposit types the user hasn't touched.
        var depMerged = {};
        var defaultDeps = defaults.deposits || {};
        var storedDeps  = stored.deposits  || {};
        for (key in defaultDeps) depMerged[key] = defaultDeps[key];
        for (key in storedDeps)  depMerged[key] = storedDeps[key];
        merged.deposits = depMerged;
        return merged;
    }

    function isReady(ctx) {
        var s = readSettings();
        if (!s || !s.enabled) return false;
        if (!ctx.zone || !ctx.zone.isHome) return false;
        return true;
    }

    function readPlanContext() {
        var s = readSettings();
        var slotsRemaining = 0;
        var licensesRemaining = 0;
        try {
            var p  = game.gi.mCurrentPlayer;
            var bq = p.mBuildQueue;
            slotsRemaining    = bq.GetTotalAvailableSlots() - bq.GetQueue_vector().length;
            licensesRemaining = p.GetMaxBuildingCount() - p.mCurrentBuildingsCountAll;
        } catch (e) {
            S.kernel.warn('mining', 'readPlanContext threw:', e);
        }
        return {
            slotsRemaining:    slotsRemaining,
            licensesRemaining: licensesRemaining,
            queued:             0,
            assigned:           {},
            actionDelay:       (typeof s.actionDelay === 'number') ? s.actionDelay : 1500
        };
    }

    // Phase stubs — filled in v2.
    function tryBuild(info, cfg, ctx)   { /* filled in Task 4 */ }
    function tryUpgrade(info, cfg, ctx) { /* v2 */ }
    function tryPause(info, cfg, ctx)   { /* v2 */ }
    function tryBuff(info, cfg, ctx)    { /* v2 — mine OR mason */ }
    function tryRefill(info, cfg, ctx)  { /* v2 — all types */ }

    function plan() {
        var s = readSettings();
        if (!s || !s.enabled) return;
        if (!S.core.deposits || !S.core.deposits.types) {
            S.kernel.error('mining', 'core.deposits.types unavailable — bundle order issue?');
            return;
        }
        var ctx = readPlanContext();
        var types = S.core.deposits.types();
        var depCfg = (s && s.deposits) || {};
        for (var t = 0; t < types.length; t++) {
            var info = types[t];
            var cfg = depCfg[info.name];
            if (!cfg || !cfg.enabled) continue;

            if (info.mineName) {
                tryBuild(info, cfg, ctx);
                tryUpgrade(info, cfg, ctx);
                tryPause(info, cfg, ctx);
            }
            tryBuff(info, cfg, ctx);
            tryRefill(info, cfg, ctx);
        }
        if (ctx.queued > 0) {
            S.kernel.log('mining', 'queued', ctx.queued, 'action(s)');
        }
    }

    function boot() {
        if (!S.kernel.settings.read('mining')) {
            S.kernel.settings.write('mining', S.modules.mining.defaultSettings);
        }
        // Queue action 'mining.buildMine' is registered in Task 4.
    }

    // Exposed for ui.js (set in Task 5).
    S.modules.mining.readSettings = readSettings;

    S.kernel.register({
        id:       'mining',
        priority: S.Priority.Normal,
        boot:     boot,
        isReady:  isReady,
        plan:     plan,
        ui: {
            tab: 'geologists',
            section: {
                id:    'mining',
                title: 'Mining',
                render: function ($body, h) {
                    if (S.modules.mining.renderSection) {
                        return S.modules.mining.renderSection($body, h);
                    }
                },
                summary: function () {
                    return S.modules.mining.summary
                        ? S.modules.mining.summary()
                        : '';
                }
            }
        }
    });

}(Steward));
```

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: passes.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: writes `build/user_steward.js`, no errors.

- [ ] **Step 4: Verify the module ID is registered in the bundle**

Run: `grep -c "id: *'mining'\|id:'mining'" build/user_steward.js`
Expected: at least 1.

- [ ] **Step 5: Commit**

```bash
git add src/modules/mining/module.js
git commit -m "mining: module skeleton with phased plan() shell"
```

---

## Task 4: Implement `tryBuild` and the `mining.buildMine` queue action

**Files:**
- Modify: `src/modules/mining/module.js`

Fill the `tryBuild` phase body and register the `mining.buildMine` queue action in `boot()`. Both contain defensive re-checks because state can drift between `plan()` and the queued action firing.

- [ ] **Step 1: Replace the empty `tryBuild` stub with the filled body**

In `src/modules/mining/module.js`, find:

```js
    function tryBuild(info, cfg, ctx)   { /* filled in Task 4 */ }
```

Replace with:

```js
    function canAffordMine(mineName) {
        if (!mineName) return false;
        try {
            var res = game.zone.GetResources(game.player);
            return !!(res && typeof res.CanPlayerAffordBuilding === 'function' &&
                      res.CanPlayerAffordBuilding(mineName));
        } catch (e) {
            S.kernel.warn('mining', 'canAffordMine threw for', mineName, ':', e);
            return false;
        }
    }

    function tryBuild(info, cfg, ctx) {
        if (!cfg.build) return;
        if (ctx.slotsRemaining <= 0 || ctx.licensesRemaining <= 0) return;
        if (!info.mineId || !info.mineName) return;

        var onMapDepos;
        try { onMapDepos = S.core.deposits.byType(info.name); }
        catch (e) {
            S.kernel.warn('mining', 'byType threw for', info.name, ':', e);
            return;
        }

        for (var i = 0; i < onMapDepos.length; i++) {
            var depo = onMapDepos[i];
            if (!depo) continue;

            var grid = S.core.deposits.grid(depo);
            if (!grid) continue;
            if (ctx.assigned[grid]) continue;

            // A building (any building, including a depleted shell) on
            // this grid means the deposit is already covered. Depleted
            // shells resolve naturally on the next tick: a geo finds a
            // new deposit, the shell goes away, byGrid returns null,
            // and we queue the build then.
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

- [ ] **Step 2: Register the `mining.buildMine` queue action in `boot()`**

In `src/modules/mining/module.js`, find:

```js
    function boot() {
        if (!S.kernel.settings.read('mining')) {
            S.kernel.settings.write('mining', S.modules.mining.defaultSettings);
        }
        // Queue action 'mining.buildMine' is registered in Task 4.
    }
```

Replace with:

```js
    function boot() {
        if (!S.kernel.settings.read('mining')) {
            S.kernel.settings.write('mining', S.modules.mining.defaultSettings);
        }

        S.kernel.queue.action('mining.buildMine', function (params) {
            var mineId   = params[0];
            var grid     = params[1];
            var depoName = params[2];
            var mineName = params[3];

            // Re-check: state may have drifted since plan() queued.
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
                S.kernel.log('mining', 'placed', mineName, 'on grid', grid,
                             '(' + depoName + ')');
                S.core.buildings.invalidate();
            } catch (e) {
                S.kernel.error('mining', 'SendServerAction(50) threw for', mineName, ':', e);
            }
        });
    }
```

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: passes.

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: writes `build/user_steward.js`, no errors.

- [ ] **Step 5: Verify the queue action is registered in the bundle**

Run: `grep -c "mining.buildMine" build/user_steward.js`
Expected: at least 2 (one registration, one `queue.add` call).

- [ ] **Step 6: Commit**

```bash
git add src/modules/mining/module.js
git commit -m "mining: tryBuild phase + buildMine queue action"
```

---

## Task 5: Create `src/modules/mining/ui.js`

**Files:**
- Create: `src/modules/mining/ui.js`

Renders the Mining section under the geologists tab. Reads from settings, deep-merges defaults (mirrors `geologists/ui.js:16-32`), provides per-deposit `Build Mine` checkboxes (only for mine-bearing types), live `Build Queue` and `Active` columns, and a status footer with build-queue + license counts. Per-deposit writes preserve all schema fields so partial settings.json edits don't lose unconfigured ones.

- [ ] **Step 1: Create the file**

Path: `src/modules/mining/ui.js`

Contents:

```js
/*
 * Dashboard surface for the mining module.
 *
 * Renders inside the Geologists tab as a "Mining" section beside the
 * existing Geologists section. Master toggle + per-deposit table over
 * all 9 deposit types (canonical S.core.deposits.types() order).
 *
 * Stone/Marble/Granite show '—' in the action columns since they have
 * no mine; their Active count reads the mason building instead.
 *
 * Per-deposit writes go through updateDeposit, which preserves every
 * schema field (build, upgrade, targetLevel, pause, buff, refill) so
 * later phase landings don't have to migrate user settings.
 */

(function (S) {

    if (!S.modules.mining) S.modules.mining = {};

    function readSettings() {
        var stored = S.kernel.settings.read('mining') || {};
        var defaults = S.modules.mining.defaultSettings || {};
        var merged = {};
        var key;
        for (key in defaults) merged[key] = defaults[key];
        for (key in stored)   merged[key] = stored[key];
        var depMerged = {};
        var defaultDeps = defaults.deposits || {};
        var storedDeps  = stored.deposits  || {};
        for (key in defaultDeps) depMerged[key] = defaultDeps[key];
        for (key in storedDeps)  depMerged[key] = storedDeps[key];
        merged.deposits = depMerged;
        return merged;
    }

    function activeCount(info) {
        if (!info) return 0;
        var n = info.mineName || info.masonName;
        if (!n) return 0;
        if (!S.core.buildings || !S.core.buildings.byName) return 0;
        try { return S.core.buildings.byName(n).length; }
        catch (e) { return 0; }
    }

    function readQueueCounts() {
        var slotsTotal = 0, slotsUsed = 0;
        var licMax = 0, licUsed = 0;
        try {
            var p = game.gi.mCurrentPlayer;
            var bq = p.mBuildQueue;
            slotsTotal = bq.GetTotalAvailableSlots();
            slotsUsed  = bq.GetQueue_vector().length;
            licMax     = p.GetMaxBuildingCount();
            licUsed    = p.mCurrentBuildingsCountAll;
        } catch (e) { /* leave 0 */ }
        return {
            slotsTotal: slotsTotal,
            slotsUsed:  slotsUsed,
            licMax:     licMax,
            licUsed:    licUsed
        };
    }

    function summary() {
        var s = readSettings();
        if (!s.enabled) return 'disabled';
        var counts = readQueueCounts();
        return counts.slotsUsed + '/' + counts.slotsTotal + ' build slots';
    }

    function updateDeposit(h, depositName, partial) {
        var s = readSettings();
        var deposits = {};
        var k;
        for (k in (s.deposits || {})) deposits[k] = s.deposits[k];
        var current = deposits[depositName] || {};
        // Preserve every known field — copy first, then overlay partial.
        var next = {};
        var fields = ['enabled', 'build', 'upgrade', 'targetLevel',
                      'pause', 'buff', 'refill'];
        for (var f = 0; f < fields.length; f++) {
            var key = fields[f];
            if (typeof current[key] !== 'undefined') next[key] = current[key];
        }
        for (var pk in partial) next[pk] = partial[pk];
        deposits[depositName] = next;
        h.update('mining', { deposits: deposits });
    }

    function renderSection($panel, h) {
        var s = h.settings('mining');

        $panel.append(h.formRow('Run on Startup', h.toggle({
            checked:  !!s.enabled,
            onChange: function (next) {
                h.update('mining', { enabled: next });
            }
        })));

        $panel.append(h.formRow('Action delay', h.input({
            type:     'number',
            value:    s.actionDelay || 1500,
            width:    '90px',
            onChange: function (val) {
                var n = parseInt(val, 10);
                if (!isNaN(n) && n >= 0) {
                    h.update('mining', { actionDelay: n });
                }
            }
        }), 'ms — pause between sends'));

        appendDepositTable($panel, h, s);
        appendStatusFooter($panel, h);
    }

    function appendDepositTable($panel, h, s) {
        var d = S.core.deposits;
        if (!d || !d.types) return;
        var types = d.types();
        var depCfg = (s && s.deposits) || {};

        $panel.append(h.gridRow(
            [[5, 'Deposit'], [3, 'Build Mine'], [2, 'Active']],
            { headerCells: true }
        ));

        for (var i = 0; i < types.length; i++) {
            var info = types[i];
            var cfg = depCfg[info.name] || {};
            var active = activeCount(info);

            (function (depositName, currentCfg, activeNum, mineable) {
                var $buildCell;
                if (mineable) {
                    $buildCell = h.toggle({
                        checked:  !!currentCfg.build,
                        onChange: function (next) {
                            updateDeposit(h, depositName, { build: next });
                        }
                    });
                } else {
                    $buildCell = '—';
                }
                $panel.append(h.gridRow(
                    [[5, depositName],
                     [3, $buildCell],
                     [2, String(activeNum)]]
                ));
            })(info.name, cfg, active, !!info.mineName);
        }
    }

    function appendStatusFooter($panel, h) {
        var counts = readQueueCounts();
        var line = 'Build queue: ' + counts.slotsUsed + '/' + counts.slotsTotal +
                   ' slots used  ·  Licenses: ' + counts.licUsed + '/' + counts.licMax;
        $panel.append(h.formRow('Status', line));
    }

    S.modules.mining.readSettings  = readSettings;
    S.modules.mining.renderSection = renderSection;
    S.modules.mining.summary       = summary;

}(Steward));
```

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: passes.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: writes `build/user_steward.js`, no errors.

- [ ] **Step 4: Verify the section title is in the bundle**

Run: `grep -c "title: *'Mining'\|title:'Mining'" build/user_steward.js`
Expected: at least 1.

- [ ] **Step 5: Commit**

```bash
git add src/modules/mining/ui.js
git commit -m "mining: dashboard section with per-deposit toggles + status"
```

---

## Task 6: Live host smoke test

**Files:**
- Modify: none (deployment + observation only)

The bundle is now feature-complete for v1. Validate against the live AIR client.

- [ ] **Step 1: Copy the bundle to the TSO userscripts folder**

Run: `cp build/user_steward.js <path-to-TSO-client>/userscripts/`
(User-specific path. Copying overrides any prior Steward bundle.)

- [ ] **Step 2: Restart the AIR client**

Close and reopen the TSO client so the new bundle loads.

- [ ] **Step 3: Open the Steward menu and confirm the Mining section appears under the Geologists tab**

Expected: a "Mining" section is visible alongside the existing Geologists section. The 9-row deposit table renders. Stone/Marble/Granite show `—` in the Build Mine column. The other six show a toggle (default checked).

- [ ] **Step 4: Toggle the master Run on Startup off**

Expected: no `mining` log lines fire on subsequent ticks. `S.kernel.log('mining', ...)` should not appear in the log output.

- [ ] **Step 5: Toggle the master Run on Startup on, ensure at least one unbuilt deposit exists on the home zone with sufficient resources, and observe the next tick**

Expected: a `mining.buildMine` action fires, a mine appears at the deposit grid, and a log line in the form `mining: placed IronMine on grid <N> (IronOre)` appears. The Active column count for that type increments by 1.

- [ ] **Step 6: Uncheck Build Mine for one type (e.g. Coal) while at least one Coal deposit is unbuilt**

Expected: the planner does not queue any `mining.buildMine` for Coal, while still queuing for other types that remain enabled. No log line for Coal.

- [ ] **Step 7: Fill the build queue manually (place buildings until `slotsRemaining <= 0`), then watch a tick**

Expected: planner skips silently — no `queued N action(s)` log line. Once a slot frees, the next tick resumes.

- [ ] **Step 8: Mark validation complete in commit**

```bash
git commit --allow-empty -m "mining: v1 host smoke test complete"
```

---

## Self-Review

**Spec coverage:**

- v1 scope (build mine on found deposits, 6 mine-bearing types) → Tasks 1, 2, 3, 4
- Phased planner shell with stubs for upgrade/pause/buff/refill → Task 3
- Build-queue slots / building licenses / affordability gates → Task 4 (`tryBuild` + `canAffordMine`)
- Defensive re-check in queued action → Task 4 Step 2
- `core/deposits/types.js` mineId / mineName / masonName extension → Task 1
- Settings tree with per-type shape difference → Task 2
- Dashboard section (master toggle, table over 9 types, Build Mine column, Active column, status footer, no icon) → Task 5
- Cross-module behavior (geologists runs independently) → no code change needed; covered by isReady / plan independence
- Validation via lint + build + host smoke → Tasks 1-5 lint+build steps, Task 6 host smoke

**Placeholder scan:** No "TBD"/"TODO" left in steps. `tryUpgrade` / `tryPause` / `tryBuff` / `tryRefill` empty bodies are intentional v2 stubs as the spec explicitly defines, not placeholders.

**Type consistency:**

- `info.mineId`, `info.mineName`, `info.masonName` are added in Task 1 and used in Tasks 4 (`tryBuild`, queue action) and 5 (`activeCount`). Names match.
- Settings field names (`enabled`, `actionDelay`, `deposits.<name>.{enabled, build, upgrade, targetLevel, pause, buff, refill}`) match across Tasks 2, 3, 5.
- `mining.buildMine` action ID matches between Task 4 Step 1 (`queue.add`) and Step 2 (`queue.action`).
- `S.modules.mining.{readSettings, renderSection, summary, defaultSettings}` exported from one file and consumed in another all align.
- `ctx` shape (`slotsRemaining`, `licensesRemaining`, `queued`, `assigned`, `actionDelay`) is identical between `readPlanContext` (Task 3) and `tryBuild` (Task 4).
