# autoTSO ↔ Steward Feature Parity

> Status: refreshed against the current `src/` (post v0.10). Every open gap
> links to its issue under the master issue #16 (autoTSO parity).
> Source: `autoTSO/user_auto.js` (8174 lines, single file).
>
> Purpose: catalogue every autoTSO subsystem so we don't ship Steward
> v1.0 without realising we left out a daily-use feature. This is a
> living document — update with each Steward release.

## Dashboard scope (current)

Steward's dashboard mirrors autoTSO's tab structure with one omission and
one addition:

- **Status** — Steward-only. Surfaces master pause, modules running, queue
  depth and live events. autoTSO has no equivalent.
- **Specialists / Geologists / Quests / Buildings / Events** — mirror
  autoTSO where it has the tab; Steward modules slot in.
- **Settings** — a separate dialog, not a tab. It holds the Logging,
  Scheduler and `misc` sections.
- **Mail/Trades** — *deferred*. The tab is intentionally absent until the
  Mail module ships (#6; Trade is won't do, see aTrade). Modules can't register against `'mail'`
  today (registry rejects unknown tabs). Re-add the tab to
  `TAB_ORDER` in `90_ui_shell.js` and the `TABS` set in `40_registry.js`
  when the first Mail/Trades module lands.

## Reading the table

- **Status**:
  - `✓` — implemented in Steward and verified live
  - `~` — partially implemented (foundations there, surface incomplete)
  - `✗` — not yet started; the issue link names where it is tracked
  - `n/a` — autoTSO has it but we deliberately won't (security risk, replaced by host integration, won't do, etc.)
- **Tier**: rough priority for the v0.5–v1.0 roadmap.
  - **must** — daily-use feature most autoTSO users actually run
  - **should** — common, but not blocking
  - **nice** — power-user / rare workflows
  - **drop** — explicitly de-scoped

## Top-level toggles (autoTSO `aSession.isOn.*`)

These are the master on/off switches autoTSO surfaces in the menu (`aUI.menu.featureLabel` / `toggleFeature`).

| autoTSO flag | Subsystem | Steward equivalent | Status | Tier |
|---|---|---|---|---|
| `Adventure` | aAdventure (auto-run an adventure) | `modules/adventures` (templates and scenarios, executor, runs) | ✓ | must |
| `Explorers` | aSpecialists.manageExplorers (treasure searches) | `modules/explorers` | ✓ | must |
| `Quests` | aQuests.manage (auto-complete daily/letter/event quests) | `core/quests` claims quests inside adventure runs; no home-island module (#17) | ~ | must |
| `Deposits` | aBuildings.deposits.manage (geologists + mine build/upgrade) | `modules/geologists` + `modules/mining`; removing depleted deposits is open (#15) | ~ | must |
| `Buildings` | aBuildings.manage (auto-toggle production) | — (#18) | ✗ | must |
| `Mail` | aMail.manage (loot mail + pending trades + invites) | — (#6, invites #7) | ✗ | must |
| `OpenMysteryBoxs` | aBuffs.openLootables (open inventory mystery boxes) | — (#19) | ✗ | should |
| `FromStarToStore` | aResources.transferFromStarToStore (move buffed resources to warehouse) | — (#20) | ✗ | should |
| `CollectPickups` | aBuildings.collectibles.manage | `modules/collect` | ✓ | must |

## Subsystems

### aQueue — Action Queue
| Surface | autoTSO | Steward | Status |
|---|---|---|---|
| FIFO queue | `aQueue.queue` | `Steward.kernel.queue` | ✓ |
| Per-action delay | yes | yes | ✓ |
| Pause / restart | manual | `Steward.kernel.ui.pause/resume` | ✓ |
| Retry on stuck operation | watchdog | send guard and breaker (`core/specialists/sendguard`, `core/breaker`); adventure retries on map start failure | ✓ |
| Modal-aware gating | no | yes (`runOne` defers when `div[role="dialog"]:visible`) | ✓ Steward improvement |
| Per-module cancel | no | `cancelByModule(id)` | ✓ Steward improvement |
| Module busy contract | no (modules manage themselves) | yes (`isModuleBusy` skips plan) | ✓ Steward improvement |

### aSettings — Settings Store
| autoTSO | Steward | Status |
|---|---|---|
| Single JSON file under `auto/settings.json` | Delegates to host's `settings` global at `'steward.<id>'` | ✓ |
| Deep `extend` merge with defaults | shallow merge per-module | ~ |
| Per-config nickname (`--clientconfig`) | per-profile via host's `settingsFile` | ✓ via host |
| Migration helpers | none (bumped settings shape between releases — manual edit so far) | ~ |

### aDebug + aConsoleLogger — Logging
| autoTSO | Steward | Status |
|---|---|---|
| Category filter (adventure/combat/geologists/explorers) | `Steward.kernel.log.isEnabled(category)` plus per-category map | ✓ |
| File rotation | `applicationDirectory/auto/logs/console.log.{N}` | `<client>/steward/logs/console.log.{N}` | ✓ |
| DEBUG-level gating | implicit (single level) | explicit `Steward.kernel.debug` with `debugEnabled` master | ✓ Steward improvement |
| Console + file dual sink | yes | yes | ✓ |

### aUI — In-game UI
| autoTSO | Steward | Status | Notes |
|---|---|---|---|
| Top-level "Automation" menu | "Steward" menu | ✓ | grouped/flat layout aware |
| Modal-based settings dialogs | uses host `Modal` class | ✓ — per-module dialogs and a Settings dialog | |
| Feature label "Start/Stop X Auto" | per-feature toggle | ~ — toggle exists, label scheme not enforced | |
| Status bar (top of menu) | yes | yes | ✓ |
| Adventure monitor modal | extensive | ~ — run dialog and `~Steward~ > Adventures` menu (`modules/adventures/dialog.js`, `runmenu.js`) | |
| Settings modal (giant tabbed) | ~500 lines | ✓ — Settings dialog and per-module settings (`93_ui_settings.js`) | |
| Excelsior modal (resource finder) | yes | ✗ — not filed; tracked by #16 | nice |
| Trade dialogs (with friends, saved trades) | yes | n/a — trade is won't do (#21) | |
| Lootables / mystery box dialog | yes | ✗ — #19 | |

### aEvents — Event Awareness
| autoTSO | Steward | Status |
|---|---|---|
| Hard-coded treasure values for 6 events | mirrored in `core/events/data.js` | ✓ |
| `getActiveEvent(type)` (substring match against host event names) | `core/events.active()` + `liveEventNames()` | ✓ |
| `isEventWithDepos()` | `core/events/refill.js` `depositEvent()`: the live event whose `depositInfo` (in `core/events/data.js`) names workyard buildings | ✓ |
| `calculateDailyItems` (per-explorer skill-aware items/hour estimate) | `core/specialists.estimateEventItems()`: best task per explorer, summed, shown in the Events tab. Loot-count traits are not modelled, as in autoTSO | ✓ |
| `calculateDeposits` (Valentine flowers / HW pumpkins for the rest of event) | `core/events/refill.js` `rows()` / `compute()`: one row per placed field, shown in the Events tab by the `eventcalc` module with its deposit, production per 12 h and production until the shop closes (buffed value in parentheses while a production buff is active), and the refill with the current deposit subtracted | ✓ |

### aBuffs — Buffs System
| autoTSO | Steward | Status |
|---|---|---|
| List buffs / lootables / building buffs | `core/buffs.inventory`, `entry`, `buildingBuffs`, `speedBuffs` | ✓ |
| `getBuffAmount(name)` | `core/buffs.amount`, `stock` | ✓ |
| `getBuffTargets(name, amount)` | `core/buffs.targetsOf` | ✓ |
| `applyBuff(type, grid, amount, responder)` (server packet 61) | `core/buffs.building` (single-building production buffs, verified on `productionBuff`) | ✓ |
| `openLootables` (mystery boxes) | — (#19) | ✗ |
| `getProduceableBuffs`, `getDefinition`, `fullName` | `core/buffs.definedNames`, `effectText`, `buildingBuffCandidates` | ✓ |
| `lootables()` (filter `Loottable_*` buffs) | — (#19) | ✗ |
| `applyOnFriend(buff, amount, friendId)` | — (#22) | ✗ |

**Steward gap**: opening lootables (#19) and friend-island buffs (#22). `core/buffs.js` exists and is used by adventures and mining.

### aResources — Resource Management
| autoTSO | Steward | Status |
|---|---|---|
| `getResourcesInfo` (list player resources, filter event-only) | `core.resources.list`, `eventName`, `uncategorized` | ✓ |
| `runProduction(resource, total)` (start production runs) | `core.production.order` covers troop orders only; production manager is #18, one-off orders #36, queue cancel #37 | ~ |
| `productionBuildings(resource)` | partial via `core/buildings` predicates and `core.production.queueIdFor` | ~ |
| `getResourceFormStar` (transfer from star menu) | — (#20) | ✗ |
| `transferFromStarToStore` | — (#20) | ✗ |
| `gather.byTrade(friendId)` (inter-player trade gathering) | n/a — trade is won't do (#21) | n/a |
| `Has(name, amount)` | `core.resources.amount` | ✓ |
| `remainingCapacity(name)` | — (#20) | ✗ |

### aSpecialists — Specialists
| autoTSO | Steward | Status |
|---|---|---|
| `getSpecialists(type)` | `core.specialists.byType` | ✓ |
| `manageExplorers` (auto-dispatch) | `modules/explorers` | ✓ |
| `sendGeologists(geos, count, depoIndex, depoName)` | `modules/geologists` over `core.specialists.send` and the send guard (`core/specialists/sendguard`) | ✓ |
| Templates (per-explorer task) | `explorers.overrides` | ✓ |
| Templates UI (dropdown per spec) | explorers and geologists tabs with per-specialist overrides | ✓ |
| Event optimisation (skill-aware items/hour) | `core/specialists.estimateEventItems` | ✓ |
| `pickTask` precedence (per-spec → event → host default → baseline) | yes | ✓ |
| Carrier/Admiral classification | `SpecialistType.{Carrier,Admiral,AdmiralCarrier}` | ✓ Steward improvement |

### aBuildings — Production / Mines / Collectibles
| autoTSO | Steward | Status |
|---|---|---|
| Buildings list / search / by-grid / by-name | `core.buildings.*` | ✓ |
| Production toggle (`SetProductionActiveCommand` / `SendServerAction(107)`) | mining pauses deposit-depleted mines; general toggle — (#18) | ~ |
| `aBuildings.production.{order, info, inProgress, affordable}` | `core.production.{order, queued, affordable, costs}` (troops) | ~ — rest in #18 |
| `manage()` periodic auto-production | — (#18) | ✗ |
| `collectibles.{check, collect, lootables, buildings, manage}` | `modules/collect` (refined: pure-collectible focus, event-aware patterns) | ✓ |
| `deposits.{removeDepleted, manage}` (geo dispatch + mine build/upgrade) | `modules/geologists` + `modules/mining` (build, upgrade, pause, buff); `removeDepleted` — (#15) | ~ |
| `production.getBook` (Bookbinder / skill book special handling) | — (#18) | ✗ |
| Buff application during production | `modules/mining` `tryBuff` + `core/buffs.building` (mines and masons, per deposit type) | ✓ |

### aMail — Mail Automation
| autoTSO | Steward | Status |
|---|---|---|
| `getHeaders` | — (#6) | ✗ |
| `handleHeaders` | — (#6) | ✗ |
| `acceptLootMails` | — (#6) | ✗ |
| Pending trade tracking (`aSession.mail.pendingTrades`) | — (#21, won't do) | ✗ |
| Pending invite tracking | — (#7) | ✗ |
| `getMailBody`, `setMonitor`, `manage` periodic check | — (#6) | ✗ |
| Trade-log saved trades modal | — (#21, won't do) | ✗ |

### aTrade — Trade Automation
| autoTSO | Steward | Status |
|---|---|---|
| `send(tradeSpec)` | won't do (#21) | n/a |
| `complete(tradeId)` | won't do (#21) | n/a |
| Trade office (incoming) | won't do (#21) | n/a |
| Outbox check / response (`SendMessagetoServer 1176`) | won't do (#21) | n/a |
| Friends list integration (`aUtils.friends.getRandom`) | won't do (#21) | n/a |
| Saved trades / templates UI | won't do (#21) | n/a |
| Trade-with-friends dialog | won't do (#21) | n/a |

**Won't do**: the trade subsystem (#21) was closed on purpose. No trade module is planned.

### aQuests — Quest Automation
| autoTSO | Steward | Status |
|---|---|---|
| Quest list (`getQuests(regex)`) | `core.quests.list`, `read`, `definition` | ✓ |
| Letter quests (SharpClaw, StrangeIdols, Annoholics, SilkCat, Miranda, BartTheBarter, Vigilante, SettlersBandits, LostCompass, AThreat) | — (#17) | ✗ |
| Mini quests (LittlePanda, MysteriousCoin, WeddingInvitation, ANewStone, SaveTheDeers, WolfPuppy) | — (#17) | ✗ |
| Other (Daily, DailyGuild, Weekly, Ghost, PathFinder, Starfall) | — (#17) | ✗ |
| Order-execution engine (buffapplied, resourceproduced, soldgoods, …) | — (#17); adventure quests use `core.quests.itemWant`, click/destroy names | ✗ |
| `payQuest` (skip with rubies) | — (#17) | ✗ |
| `completeQuest` action | `core.quests.claim` (verified action; used by adventures and mining) | ✓ |
| `finishAdventureQuests` (auto-claim mid-adventure) | `modules/adventures` (`away.js`, `executor.js`) claims quests during runs | ✓ |

**Note**: aQuests is the largest subsystem (~2000 lines) and depends on aBuffs, aResources, aTrade, and aMail. Home-island automation is tracked in #17.

### aAdventure — Adventures
| autoTSO | Steward | Status |
|---|---|---|
| Adventure templates (per-step plan) | `modules/adventures` run templates (one JSON file per template, dialog) | ✓ |
| Speed buff selection | per template, starts at the first in stock by name (`core/buffs`) | ✓ |
| Import autoTSO run templates (`auto/templates/*.json` + `auto/settings.json` labels) | — (#23) | ✗ |
| Black Vortex toggle | — (#24) | ✗ |
| Step-by-step execution | `modules/adventures/executor.js`, `steps.js`, `trips.js` | ✓ |
| Camp elimination tracking | waves and kill-all steps, buff kill (see docs/WAVES.md) | ✓ |
| Unit training / retraining | `core.production.order`, `core.army.raise` and `unload`; used by the executor and home loadout | ✓ |
| Lost-army recovery | stuck-step home trip; zone refresh resync — (#12) | ~ |
| Adventure monitor UI | run dialog and run menu (`dialog.js`, `runmenu.js`) | ✓ |
| `completeQuest` mid-adventure | `core.quests.claim` from the executor | ✓ |
| `auto.start` / repeat counter | menu start with run count and End repetition, executed by the run engine (`run.js`, `state.js`) | ✓ |
| Scenario adventures (produce/apply items, visit, collect pickups, return home) | `modules/adventures` scenario runs, one JSON file per scenario (see docs/SCENARIOS.md) | ✓ |
| Template menu with map counts | `~Steward~ > Adventures` lists templates and scenarios in category folders with star-menu map counts | ✓ |
| Extra template actions | home loadout, send generals, visit with quest claim, wait for departure, speed buff, produce/apply items, waves with kill-all, collect pickups, return home (#10, closed) | ✓ |
| Ventures | — (#4) | ✗ |
| Coop adventures (hosted and invited) | — (#3); sending generals between them (#11) | ✗ |
| Queue different adventures in sequence | — (#8) | ✗ |
| Auto-accept adventure invites | — (#7) | ✗ |

**Note**: `aAdventure` is autoTSO's flagship feature (~1700 lines). Steward covers templates and scenarios; the open gaps are listed above.

### aUtils — Utilities
| autoTSO | Steward | Status |
|---|---|---|
| `aUtils.file.{Read, Write, Path, validatePath}` | `S.kernel.files` (read, safe write, list, delete, browse) | ✓ |
| `aUtils.format.num` | not yet | ~ |
| `aUtils.friends.getRandom` | n/a — only trade and friend buffs used it (#21, #22) | n/a |
| `aUtils.game.{restart, sendSpecialistPacket, uID, …}` | partially in `core/packets`, `core/specialists.dispatch` | ~ |
| `aUtils.create.{Select, SettingsImg, …}` (UI builders) | `91_ui_helpers.js` | ✓ |
| `aUtils.responders.{buffOnFriend, openBox, checkOutbox, checkInbox, sendOfficeTrades}` | — (#22, #19, #6; trade responders won't do, #21) | ✗ |

### Auto-update / Distribution
| autoTSO | Steward | Status |
|---|---|---|
| In-game "check for update" via GitHub Releases API | `modules/updater` (`check.js`, `releases.js`) | ✓ |
| Background auto-check on boot | `modules/updater` | ✓ |
| Backup before applying update | `modules/updater/backups.js` | ✓ |
| Restore from backup | `modules/updater/backups.js` | ✓ |
| Changelog modal | `modules/updater/ui.js` | ✓ |
| **Plus security caveats**: autoTSO's update is base64-encoded URL with no signature verification | n/a — Steward verifies downloads (`19_sha256.js`) | n/a |

**Steward decision**: auto-update ships as the opt-in `modules/updater`.

### Native process execution / restart
| autoTSO | Steward | Status |
|---|---|---|
| `aUtils.game.restart()` (spawn `tso-portable.exe`, exit) | — | n/a — security risk, see non-goals |
| RAM-based auto-restart (`Auto.RestartRAM`) | — | n/a — see non-goals |

## Notable improvements Steward already has over autoTSO

| Improvement | Where |
|---|---|
| Modal-aware queue (collect doesn't yank user windows) | `60_queue.js:isHostModalVisible` |
| Module busy contract (no plan-ing while previous cycle drains) | `50_scheduler.js` |
| Per-module queue cancellation | `60_queue.js:cancelByModule` |
| Master pause toggle persisted across restart | `90_ui_shell.js` |
| DEBUG-level logging gating (off by default) | `20_logger.js` |
| Carrier/Admiral classification (autoTSO collapses to "general") | `core/specialists.classify` |
| Auto-derived event collectible patterns (no per-event maintenance) | `modules/collect/module.js:effectivePatterns` |
| Diagnostics module (read-only inspector for debugging) | `modules/diagnostics/*` |
| Single-bundle delivery with deterministic load order | `scripts/build.js` |
| AIR-32 ESLint enforcement at lint-staged + CI | `.eslintrc.json` |
| GPLv3 + open source (autoTSO is "private project — All rights reserved") | `LICENSE` |

## Tier-grouped roadmap implication (historical, written at v0.5.1; the open gaps are in the tables above)

If we want Steward at "daily-use parity" with autoTSO, this is the rough sequence:

**v0.5 — daily-use foundations**
- `core/buffs.js` (consumed by everything below)
- `core/resources.js` (production helpers, transfer-from-star)
- `modules/auto_buildings` (production toggle — small, no SelectBuilding)
- `modules/auto_mystery_boxes` (uses buffs.openLootables)
- `modules/auto_transfer_to_store`

**v0.6 — geologists + mail**
- `modules/templates_geologists` (depends on `core/buffs` for mine buffs)
- `modules/auto_mail` (loot mail + invite acceptance)
- `core/army.js` (preparation for adventures)

**v0.7 — quests**
- `modules/auto_quests` (letter, mini, daily/weekly)

**v0.8 — adventures**
- `modules/auto_adventures` (the big one)
- Adventure templates UI

**v0.9 — trade / friends / Excelsior / Pathfinder integration**

**v1.0 — UI overhaul, polish, auto-update mechanism**

## Explicit non-goals

- **Trade** — closed on purpose (#21).
- **Native process restart** — security risk; users can restart their client themselves.
- **Pathfinder integration** — autoTSO requires a separate userscript; defer.
- **Per-feature start/stop labels** — Steward's pause toggle covers the common case.
