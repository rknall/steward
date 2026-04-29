# Mining — Next Steps

Pickup notes for resuming work on the mining module after a context reset. Self-contained: read this and you should know what's done, what's open, and what to do next.

## Current State (as of 2026-04-29)

**Branch:** `main` (working directly).
**Tests:** 91 passing, 0 failing, lint 0 errors / 3 unrelated warnings.
**Bundle:** `build/user_steward.js` (~138 KB).

Mining module phases:

| Phase | Status |
|---|---|
| `tryBuild` | shipped (v1) — places mines on fresh deposits, gated on slots/licenses/affordability |
| `tryUpgrade` | shipped — auto-upgrade to per-type `targetLevel`, defensive re-check |
| `tryBuff` | shipped — auto-applies user-selected buff (per-type dropdown), `canApply` gate respects `productionBuff`/upgrade/destruction/paused |
| `tryPause` | shipped — pauses producing mines below `pauseThreshold`, skips when refill available, records `stewardPausedGrids` for later auto-unpause |
| `tryRefill` | **shipped but not firing on live host** — see below |

Other recent work:
- `core/resources.js` (player inventory wrapper)
- Collections section under "Collections & Buildings" tab — Tracked items list + amounts (defaults: `CollectibleFurs`, `CollectibleScarecrow`, …)
- Status tab now shows build queue + license counts; the line was removed from the Mining section
- Per-tick snapshot invalidation in `kernel/50_scheduler.js:tick()` — `core/{buildings,buffs,resources}.invalidate()` at the start of every tick. This was a memory-pressure fix for the 8-hour crash.
- Diagnostics dump button (Tools → Diagnostics → "Write inventory JSON dumps") writes `storehouse.json`, `buffs.json`, `buildings.json` to `<appStorage>/steward/dumps/`.
- Trait doc: `docs/traits/EXPLORER.md` GetType=4 confirmed as Savage Scout.

## Open Issue: tryRefill does not fire on the live host

User's reproduction: TitaniumOre at 49 (below threshold 50), Refill toggle ON for TitaniumOre, refill items in inventory ("in star"). Expected: refill fires. Actual: mine gets paused instead, no refill action.

### What we know

1. `S.core.buffs.forDeposit('TitaniumOre')` returns `[]`. Filter is `def.GetTargetType() === 1` AND target description contains the deposit name AND amount > 0.
2. The user clarified: **star items are buffs**, not a separate inventory. autoTSO `user_auto.js:4819-4842` (`transferFromStarToStore`) shows star items are `getAvailableBuffs_vector` entries with `GetType() === 'AddResource'` and `GetResourceName_string()` distinguishing them.
3. User clarified: **refills stay in star, never get transferred to the storehouse**. So the path is: buff in star → applied directly on a deposit. NOT: claim → use.
4. We currently don't know the actual `GetType` / `GetTargetType` / `GetResourceName_string` shape of TSO's deposit refill items. The default-naming guess (`FillDeposit_*`) was wrong (`FillDeposit_Fishfood` is a quest helper).

### What's left

1. **User runs the diagnostics dump** on the live host: Tools → Diagnostics → "Write inventory JSON dumps". Three files appear in `<appStorage>/steward/dumps/`.
2. **Inspect `buffs.json`** for entries that represent the user's titanium refill. Things to look for:
   - `GetType === 'AddResource'` with `GetResourceName_string` containing "Titanium" or "Refill"
   - Any entry with `definition.GetTargetType === 1`
   - Any entry whose `GetResourceName_string` matches `TitaniumOre` exactly
3. **Patch `S.core.buffs.forDeposit`** in `src/core/buffs.js` to match the actual shape.
4. **Possibly patch the queue action** (`mining.refillDeposit` in `src/modules/mining/module.js`) if the host call differs from `SendServerAction(61, 0, grid, 0, uniqueId, null)`.

### Patch fork — three likely outcomes

| What buffs.json reveals | Fix |
|---|---|
| Entry with `GetType: 'AddResource'`, `GetResourceName_string: 'TitaniumOreRefill'` (or similar), `GetTargetType: 1` and target description includes `TitaniumOre` | Bug is just our filter — adjust `forDeposit` to match `GetResourceName_string` or relax the target-description match. |
| Entry with `GetType: 'AddResource'`, target description **doesn't** include `TitaniumOre` (only the resource name) | `forDeposit` filter changes to match against `GetResourceName_string` containing the deposit name (or against a hard-coded mapping deposit→refill resource name). |
| Entry's `GetTargetType` is **not 1** (e.g. 0 or unset) | Drop the `TargetType=1` requirement; rely on naming convention or `GetResourceName_string` match instead. |
| No matching entry at all in buffs.json | Refill items live in a different inventory (mailbox?). Need a server roundtrip via `SendMessagetoServer(1175, ...)` — defer until that's in scope. |

## Test Recipe Once Patched

1. Drop new bundle, restart client.
2. Open Mining section. Refill toggle ON for TitaniumOre.
3. Mine at 49 remaining. Watch tick. Expect:
   - `mining: refilled TitaniumOre on grid <N> with <RefillName>`
   - Mine remains producing (no pause flicker — `tryPause` skips when refill is available)
4. If mine was paused-by-Steward earlier and refill brings it above threshold, expect:
   - `mining: resumed TitaniumMine on grid <N>` immediately after the refill log line

## Design Decisions to Preserve

These were debated and locked in — don't reopen without checking:

- **Refill is a yes/no toggle**, not a dropdown. The planner auto-picks the matching deposit-specific refill. We **do not** use the generic deposit refiller.
- **`tryPause` skips when refill is available** for the same type. No pause→refill→unpause flicker in one tick.
- **Auto-unpause is `tryRefill`'s responsibility, not `tryPause`'s.** `tryPause` is pause-only; `cfg.pause=false` is inert (preserves manual user pauses).
- **`stewardPausedGrids` map** lives module-private (closure var in `mining/module.js`), survives across ticks, exposed for tests as `S.modules.mining._stewardPausedGrids`. Used by `mining.refillDeposit` queue action to decide whether to auto-unpause after a refill.
- **Predicted post-refill amount** is `preRefillAmount + 100` (assumed). Reading fresh `depo.GetAmount()` immediately after `SendServerAction(61, ...)` returns stale data because the host updates async.
- **Per-tick snapshot invalidation** (`kernel/50_scheduler.js`) — do NOT remove. It's the fix for the long-session memory pressure crash.
- **Refill column position**: right after Pause, before Buff.

## Side Tickets / Backlog

- **Collections section "Tracked items"**: defaults seeded with the user's items (`CollectibleFurs`, `CollectibleScarecrow`, `CollectibleWineBarrel`, `CollectibleHerbs`, `CollectibleAdamantium`, `CollectibleFoodCart`, `CollectibleBanner`, `CollectibleGrainSacks`, `CollectibleBronzeCauldron`, `CollectibleKettle`). Existing users with the old names in their persisted `collect.inventory.items` need to either delete that field (defaults reseed) or update to the `Collectible*` keys manually.
- **Star menu (mailbox) dump**: skipped because it requires `SendMessagetoServer(1175, ...)` async response. Add when needed.
- **UI editor for Collections tracked-items list**: currently requires editing `settings.json`. Low priority.
- **Diagnostics tasks panel**: `Tools → Diagnostics` has a growing list of probes — at some point it'll deserve grouping (Specialists / Inventory / Kernel / etc.).

## Recent Commit Trail

```
81e1f38 diagnostics: building dump captures production queue, recipe, factors
c3c5a69 diagnostics: JSON dumps for storehouse / buffs / buildings to investigate refill path
5f7b3af mining: refill is yes/no with auto-detect via TargetType=1; status line moves to Status tab; traits: confirm Savage Scout (GetType=4)
486b28f mining: tryRefill phase + refillDeposit action + auto-unpause + UI column
86b8907 core/buffs: forDeposit(name) — refill items via FillDeposit_* + target match
179757c kernel/scheduler: invalidate core snapshot caches at tick start
f781957 core: tolerate whitespace in placeholder check; collect: correct default item names; diag: dump player inventory
2ca3d17 core: detect bracketed loca placeholder; collect/ui: drop on-zone list, add resource discover
bdca152 collect/ui: tracked inventory items with localized name + amount
eb7d482 core/resources: player inventory wrapper (list/byName/amount/displayName)
```

## Files of Note

- `src/core/buffs.js` — `forDeposit(name)`, `forBuilding(name, opts)`, `canApply(building, buffName)`, `displayName`, `description`, `matches`. Localization placeholder fallback is `^\[.*\]$` with leading/trailing whitespace tolerance.
- `src/modules/mining/module.js` — all five phases, three queue actions (`mining.buildMine`, `upgradeMine`, `setProduction`, `applyBuff`, `refillDeposit`), `stewardPausedGrids` closure-var state, `ASSUMED_REFILL_AMOUNT = 100`.
- `src/modules/mining/ui.js` — single deposit table; column order: Deposit / Build / Upgrade / Lvl / Pause / Refill / Buff / Active.
- `src/modules/diagnostics/ui.js` — JSON-dump helpers (`buildStorehousePayload`, `buildBuffsPayload`, `buildBuildingsPayload`). Probe utilities: `probeCall`, `probeGetters`, `probeProps`, `scalarize`, `localizedText`.
- `src/kernel/50_scheduler.js:tick()` — calls `invalidateCaches()` at the start of every tick.
