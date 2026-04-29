# Mining — Next Steps

Pickup notes for resuming work on the mining module after a context reset. Self-contained: read this and you should know what's done, what's open, and what to do next.

## Current State (as of 2026-04-29)

**Branch:** `main` (working directly).
**Tests:** 99 passing, 0 failing, lint 0 errors / 3 unrelated warnings.
**Bundle:** `build/user_steward.js` (~147 KB).

Mining module phases:

| Phase | Status |
|---|---|
| `tryBuild` | shipped (v1) — places mines on fresh deposits, gated on slots/licenses/affordability |
| `tryUpgrade` | shipped — auto-upgrade to per-type `targetLevel`, defensive re-check |
| `tryBuff` | shipped — auto-applies user-selected buff (per-type dropdown), `canApply` gate respects `productionBuff`/upgrade/destruction/paused |
| `tryPause` | shipped — pauses producing mines below `pauseThreshold`, records `stewardPausedGrids` for later auto-unpause |
| `tryRefill` | **disabled** — code preserved behind `S.modules.mining._REFILL_ENABLED` flag (default false). Host silently rejects programmatic deposit refills regardless of call shape we tried. See `docs/superpowers/mining/refill-investigation.md`. |

Other recent work:
- `core/resources.js` (player inventory wrapper)
- Collections section under "Collections & Buildings" tab — Tracked items list + amounts (defaults: `CollectibleFurs`, `CollectibleScarecrow`, …)
- Status tab now shows build queue + license counts; the line was removed from the Mining section
- Per-tick snapshot invalidation in `kernel/50_scheduler.js:tick()` — `core/{buildings,buffs,resources}.invalidate()` at the start of every tick. This was a memory-pressure fix for the 8-hour crash.
- Diagnostics dump button (Tools → Diagnostics → "Write inventory JSON dumps") writes `storehouse.json`, `buffs.json`, `buildings.json` to `<appStorage>/steward/dumps/`.
- Trait doc: `docs/traits/EXPLORER.md` GetType=4 confirmed as Savage Scout.

## Resolved: tryRefill on the live host (2026-04-29)

The dump (`docs/analysis/dump/buffs.json:5250-5266`) revealed two bugs.

### Bug 1 — `forDeposit` filter never matched FillDeposit buffs

The live host's refill items all share `GetType: "FillDeposit"` (one entry per resource: TitaniumOre, Salpeter, Meat, Fish, …) with `GetTargetDescription_string: ""` (empty). The deposit name lives in `GetResourceName_string` on the *outer* buff object, not in the definition's target list.

Old filter (`src/core/buffs.js`): `TargetType === 1 && target list includes depositName` — second clause never satisfied → empty result → `tryPause` ran instead.

Fix: strict-equality match on `GetResourceName_string`. Target-description path was retired (Option B) so a tolerant fallback can't accidentally pick the wrong stack. New `resourceName(b)` accessor on `S.core.buffs`.

### Bug 2 — `mining.refillDeposit` action could grab the wrong stack

Every FillDeposit shares `GetType: "FillDeposit"`. The action's `S.core.buffs.byName(buffName)` lookup would have returned the *first* FillDeposit entry in inventory (in our dump, that was Meat — at line 4207). Even with bug 1 fixed, queueing a TitaniumOre refill could have sent a Meat buff to the deposit.

Fix: drop `buffName` from the queue params. The action re-resolves via `S.core.buffs.forDeposit(depoName)[0]` at send-time, which is collision-resistant by construction (resourceName equality).

### Test coverage added

- `forDeposit() filters to TargetType=1 buffs by GetResourceName_string` — live-host shape, resourceName-only match.
- `forDeposit() does not fall back to GetTargetDescription_string` — locks Option B's strict semantics.
- `forDeposit() does not collide across FillDeposit entries with same GetType` — Meat/Fish/Iron multi-entry inventory, only Iron matches a `forDeposit('IronOre')` query.
- `tryRefill ignores FillDeposit entries for other resources (no GetType collision)` — planner-side end-to-end.

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

- **Generic host-VO introspection helper + Diagnostics dumper** (NEW 2026-04-29): The mining module currently inlines a `describeType` + named-property probe (`probeCursorShape` in `src/modules/mining/module.js`) — useful for any host VO whose properties are invisible to `for-in` (every Flash-bridged object). Promote to `src/core/host-introspect.js` exposing `describeVO(obj)` returning `{classMetadata, candidateProbes, knownAccessors}`, and add a Diagnostics button "Dump host VO" that writes JSON dumps for a curated list (`game.gi.mCurrentCursor`, `mCurrentPlayer`, `mClientMessages`, `mCurrentPlayerZone`, `channels.BUFF`). Cuts ~70 lines from the mining-module diagnostic and gives us a reusable tool when the next "what shape is this host VO?" question shows up. Defer until refill fix lands.
- **Bootup readiness gate** (NEW 2026-04-29): autoTSO defers initialization until host VOs are reachable. Pattern in `autoTSO/user_auto.js:8073` (`auto.load(count)`):
  1. Try the boot work inside try/catch.
  2. On exception: `if (count < 6) auto.load(++count); else setTimeout(auto.load, 10000);` — six fast retries, then 10s gap, repeating.
  3. Only after `auto.update.fetchReleaseData()` completes does `auto.init()` register `game.gi.channels.ZONE` observers etc.
  Steward currently registers modules and starts the scheduler at script load, on the assumption that `game.gi.mCurrentPlayer` etc. are already populated. If the user enables Steward early in a session — or the host has a slow first paint — `boot()` hooks may fire against half-initialized state and silently misbehave (e.g. an empty `getAvailableBuffs_vector`, missing `mStreetDataMap`). Implement at `src/kernel/lifecycle.js` (or wherever boot is sequenced): poll readiness probes (`game?.gi?.mCurrentPlayer?.getAvailableBuffs_vector`, `mCurrentPlayerZone?.mStreetDataMap`) on a setTimeout backoff before invoking module `boot` hooks. Defer until after the refill investigation is closed.
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
