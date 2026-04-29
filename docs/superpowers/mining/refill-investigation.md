# Mining — Deposit Refill Investigation (2026-04-29)

## Status: feature gated off, code preserved

The deposit-refill phase (`tryRefill` in `src/modules/mining/module.js`) was **shipped, debugged extensively, and disabled**. The host silently rejects every JS-originated FillDeposit application we tried. Manual UI applies work; programmatic ones don't. We could not find the wire-format difference without a cracked / decompiled client.

The code is left intact behind two namespace flags so a future session can resume cheaply:

- `S.modules.mining._REFILL_ENABLED = false` — when true, `tryRefill` plans + queues, the UI shows the Refill column, and `readSettings` honors `cfg.refill=true`. Default false.
- `S.modules.mining._REFILL_DEBUG = false` — when true, all `[diag]` logs around the refill paths fire (cursor probes, `describeType` dumps, `buffApplied` channel observer, action-body stock deltas, responder logs).

To resume the investigation:
1. Edit `S.modules.mining._REFILL_ENABLED = true` (line ~41 in `mining/module.js`).
2. Edit `S.modules.mining._REFILL_DEBUG = true`.
3. Rebuild, reload bundle on live host.
4. Read the next section before iterating.

## Re-entry summary

Manual refill works — the `buffApplied` event fires on `game.gi.channels.BUFF` with the right target. Steward's programmatic refill reaches one of two failure modes:

- Via `game.gi.SendServerAction(61, 0, grid, 0, uid, null)`: silent rejection. No `buffApplied` event, no responder, no inventory change. Even with `mCurrentCursor.mCurrentBuff = b` set in advance.
- Via `game.gi.mClientMessages.SendMessagetoServer(61, mCurrentViewedZoneID, dServerAction, responder)`: server receives, responder fires with empty `data={}`, but no `buffApplied` event, no inventory change. Server-side validation rejects with no payload.

The current best-guess code path (in `mining.refillDeposit` action) tries the `SendMessagetoServer` route with cursor preconditions set. Stays as the baseline for re-investigation.

## What we tried

Chronological summary. Everything below is verified by live-host logs, not assumed.

### 1. `forDeposit` filter (FIXED — was a real bug)

Original filter: `def.GetTargetType() === 1 && targets list contains depositName`. Live-host FillDeposit buffs all share `GetType="FillDeposit"` with `GetTargetDescription_string=""` (empty target list). The deposit name lives in the *outer* `GetResourceName_string`. Filter rewritten to `resourceName(b) === depositName` — strict equality, no fallback. See `src/core/buffs.js:forDeposit`.

### 2. `mining.refillDeposit` action's buff lookup (FIXED)

Old: `S.core.buffs.byName(buffName)` where `buffName="FillDeposit"`. Collides across resources. Fix: re-resolve via `forDeposit(depoName)` at action time. The deposit name is the unambiguous handle.

### 3. `S.core.deposits.byGrid` excludes deposits under buildings (FIXED)

Live-host `mDepositContainer` doesn't include deposits sitting under a mine; they only surface through `mStreetDataMap.getDeposits_vectorByType(typeName)`. Action verification rewritten to walk `byType(depoName)` filtered by grid. `byGrid` itself now carries a doc comment about this trap.

### 4. `freshUniqueId(b)` — Create-reconstructed dUniqueID (TRIED, REVERTED)

Hypothesis: cached buff VOs become stale; `b.GetUniqueId()` returns a wrapper the host rejects. tso_client/6-buffs.js builds a fresh `dUniqueID` via `game.def("Communication.VO::dUniqueID").Create(uniqueID1, uniqueID2)`. Implemented as `S.core.buffs.freshUniqueId(b)`. Did not fix the rejection. Helper retained for future use.

### 5. `mCurrentCursor.mCurrentBuff` precondition (TRIED, NO EFFECT)

Specialist tasks set `game.gi.mCurrentCursor.mCurrentSpecialist = spec` before `SendServerAction(95, ...)` (`tso_client/.../5-battle.js:174`). `cCursor` describeType confirms `mCurrentBuff: BuffSystem::cBuff` and `mCurrentBuilding: GO::cBuilding` slots exist. Setting both before `SendServerAction(61, ...)` did not unlock the call. Cursor write readback verified — the assignment took effect.

### 6. `SendMessagetoServer(61, zoneID, dSA, responder)` route (TRIED, PARTIAL)

`autoTSO/user_auto.js:4706` (applyOnFriend) uses this dispatcher with a `dServerAction` VO containing `{type:0, grid, endGrid, data:uid}`. Switched our refill action to this path. **Responder fires** (server received our message), but with empty `data={}`. No `buffApplied` event. Stock unchanged. Server-side validation rejects.

We tried `dSA.endGrid = 0`. We did not exhaustively try other values for `dSA.type`, `dSA.endGrid`, alternative recipient IDs (player ID vs zone ID vs friend ID for own zone), or alternative action codes.

## Ground-truth signals captured

- **Manual refill `buffApplied` event** (logged via `channels.BUFF.addPropertyObserver`, see `installBuffAppliedObserver`):
  ```
  type=FillDeposit, def=FillDeposit, resource=IronOre,
  target_grid=7887, building=, deposit=IronOre, ownerID=1786720
  ```
  Target is the deposit (not the mine), `target.GetName_string()` returns the deposit's resource name.

- **`cBuff` describeType** reveals client-side result handlers (`applyBuffResultToZone`, `applyBuffResultToBuff`, `calculateBuffResult`) plus a `IsApplyable` precheck. These are *post-server-confirmation* application hooks — not request dispatchers. Calling them locally would desync the client without consuming server state.

- **`cCursor` describeType** lists `mCurrentBuff`, `mCurrentBuilding`, `mCurrentSpecialist`, `mCurrentSettler` as the application-target slots.

- Bundle does NOT include any working programmatic deposit refill path. autoTSO never calls `applyBuff(['FillDeposit', resource], ...)` for own-zone deposits. tso_client/6-buffs.js's "Buffs" feature replays building-buff events (TargetType=0), not FillDeposit.

## What's next, if revisited

Diminishing returns territory. Approaches ranked by likelihood:

1. **Try more `dSA` field combinations.** Vary `type` (0..n), `endGrid` (0, 1, stock count, definition.GetAmount), and try sending with no responder. Empty responder data is at least a *reaction*; the right combo may flip it to a successful event.

2. **Decompile / inspect host SWF.** Find the actual `SendServerAction(61)` handler for TargetType=1 buffs. Likely lives in `BuffSystem::cBuff.applyServer*` or a controller class. Definitive but heavy.

3. **Network MITM.** Wireshark blocked by TLS 1.3; could install a per-AIR cert + proxy. Cumbersome and brittle.

4. **Community references.** TSO bot/automation forums or GitHub forks may have solved this. Worth a search.

## File-level changes left in the codebase

All preserved behind the gate flags. Removing any of these undoes part of the investigation foundation:

- `src/core/buffs.js`: `resourceName(b)`, `freshUniqueId(b)`, rewritten `forDeposit`. Retained — used by tests, useful for future work.
- `src/core/deposits.js`: doc-comment on `byGrid` warning about the `mDepositContainer` trap. Retain.
- `src/modules/mining/module.js`: `tryRefill` phase, `mining.refillDeposit` action, `installBuffAppliedObserver`, `probeCursorShape`, `probeHostVOs`, `logDescribeType`, `stewardPausedGrids` (auto-unpause was tied to refill; harmless when refill never fires). Retain — gated.
- `src/modules/mining/ui.js`: Refill column conditional on `_REFILL_ENABLED`. Retain.
- `src/modules/mining/settings.js`: schema still includes `refill`. Retain — `readSettings` sanitizes at runtime.

Tests for the refill paths flip `_REFILL_ENABLED = true` per test. The default-off behavior is also tested (settings sanitized).
