# Scenario runs

A scenario run plays a TSO scenario adventure (the BuffAdventures_* maps and
the five Birthday 2013 adventures) from one JSON file per scenario. It is an adventures-module run without generals: same run record,
step table, persistence, run menu, pause and resume, zone trip, watcher and
end-of-map steps. Three series steps are new: produce items at home, apply
items on the island, and the end of a trip. The run repeats trips on one map,
then repeats maps like a template series.

## Files

- Repo `scenarios/<id>.json` (id = file base name). The build embeds every file
  into the bundle as a built-in scenario.
- Naming: the id is the lowercase English adventure name with `_` and no mode
  suffix (`twins`, `storm_recovery`). The menu text is the file's `label`.
- Since 0.10.7 the built-in ids are renamed: Birthday2013Adventure1 ->
  a_new_experience, Birthday2013Adventure2 -> hero_wanted, Birthday2013Adventure3 ->
  the_jesters_map, Birthday2013Adventure4 -> retro_style, Birthday2013Adventure5 ->
  nothing_special, Easter_Event_2015 -> where_do_easter_eggs_come_from,
  heartOfTheWood_medium -> heart_of_the_wood, safeTheTowns_easy -> save_the_towns,
  twins_easy -> twins, Riches_of_the_Mountain -> riches_of_the_mountain,
  Storm_Recovery -> storm_recovery. A user override saved under an old id (for
  example `twins_easy.json`) no longer replaces the built-in and shows as a
  separate menu entry: rename it to the new id. A saved run that started under
  an old id resumes as before.
- Override folder `<steward>/adventures/scenarios/<id>.json`. A user file with
  the id of a built-in replaces it. The folder is read when the menu is
  rebuilt, so a corrected file needs no new build.
- A text that cannot be parsed is listed as a broken entry with its error, and a
  broken user file replaces the built-in of its id.
- The autoTSO converter that produced the first files was a one-off and is not
  shipped.

## Format (version 1)

```json
{ "version": 1, "label": "Storm Recovery", "adventure": "BuffAdventures_Storm_Recovery",
  "trips": [ { "items": [ { "buff": "BuffAdventure...", "grids": [1, 2, 3],
                            "amount": 10 } ] },
             {} ] }
```

- A trip is the set of items applied during one visit to the map. A trip
  without `items` (or `{}`) is a visit only: the run goes there, handles quests
  and returns.
- `buff` is the full game name. `grids` are positive integers. Unknown keys are
  ignored.
- `amount` is the item's total need over its grids for the trip (default: one
  per grid), for example Storm small dynamite 10 for four boulder groups. Each
  grid is a group that takes only what it needs. Production makes that total at
  home in one go; each send offers `min((amount or 1) - taken, stock)` and what the grid
  does not take stays in stock. A return trip when stock runs out is only a fallback.
- The start check refuses a scenario whose buff is not a produceable buff
  definition and stores nothing.

## Rules

- Production overlap: while at home for trip i the run orders the needs of
  trip i (the item total, or one per open grid) plus trip i+1 (all grids), minus stock and queued items,
  and waits only until trip i's needs are in the star menu.
- Send to a grid: `min((amount or 1) - taken, stock)`, where `taken` is what the
  grid has taken of the item so far (0 at first). Stock is logged before and after.
- Quest gating (strict): on the run's island an item is applied and a map
  object is picked up only while a running quest asks for it explicitly. A map
  pick-up is either a click-trigger object or a host collectible that a quest's
  `buildingdestroyed` end condition names (buckets, ore, fire wood). The second
  kind needs the host collectible flag, so building sites and rubble are never
  clicked. Both follow this same gate. Running
  means the quest is in the pool (visible in the quest log), not finished,
  IsQuestActive() holds and its mode is 3 (READ_MODE, set once the player or
  the run has read it). Mode 2 (unread) and every other mode never count. The
  main quest is skipped. A pick-up or item spent on a quest that does not take
  it is lost, so the scenario could run short. An item also counts as asked for
  when a running quest's open type-1 trigger (not a click trigger) names the
  building standing at the item's grid (e.g. Riches `buffad_sabotage`).
- While a scenario run (running or paused) has its island viewed, collect
  clicks only the quest objects and the collectibles that running quests count
  there, and no pattern collectibles. Apply and Trip log once "waiting for quest <name> to be
  running, mode N" for what waits only on its quest; the run's unread-quest
  reader keeps reading unread quests so they start. Trip and Clear count such
  objects as left, so the run picks them up before it goes home, until
  TRIP_MAX_MS on Trip. Trip settles READ_LAG_MS from its entry and
  QUEST_SETTLE_MS (20 s) from the last quest the run read or claimed on the
  island, waits while a running quest's open buildingdestroyed pick-up is not on
  the map yet (its objects show some seconds after the read), and leaves only
  once all of that has read clear for READ_LAG_MS, within the same TRIP_MAX_MS.
  Outside scenario runs collect and template runs
  keep the looser gate (any started, active quest that is not unread).
- Stock-out (fallback, since trips are produced in full): when an item runs out with grids still open, the run takes a
  return trip home (production is home-only), orders the rest and comes back to
  the same trip. No pause.
- Start trip: the count prompt accepts a trip number, so a run can begin on a
  map that is already open at a later trip.

## Steps

Scenario chain: Wait between maps, Produce items, Start map, Jump to the map,
Apply items, Quests and pick-ups, then more trips (jump home, produce, back) or
Clear, last quest, Close, Return home, Next map.

Skipped for a scenario run: check and load generals, send generals, wait for
generals, pick up items, send all to the star, horseshoe, waves, pack, retrain.
The step list is the one run table; the run menu greys rows that do not apply.

## In-game checks

Diagnostics > Quests dump shows per-grid needs (end conditions with action and
item strings, trigger index and status) and the last-quest marker. If the
marker is missing, Clear pauses with "last quest not listed" and the dump shows
why.

## Known limits

- Grid-done rule: each grid records what it has taken. A send that takes less
  than offered keeps the grid open and the rest (`amount - taken`) goes to the
  same grid next, until the grid has taken the amount, the quest no longer wants
  the item, or a send takes nothing.
- Need is not reduced by what grids already took, so after a fallback stock-out
  home trip the run may reorder up to the already-taken count.
- A top-up send to a grid that shows no stock drop is counted done, also when
  the drop was only missed by a read lag. The item's quest then stays open
  until Clear pauses.
- Quest gating is per item, not per grid, so the grid order in the file decides
  which grid goes first (same as autoTSO).
- Quest objects of unread quests are no longer clicked by collect on any
  adventure until the quest is read.
- Clear (after the last trip) still counts quest objects with the looser gate.
  An object of a quest in a mode other than 2 or 3 is not clicked on a scenario
  island, so Clear waits for it and pauses after its pick-up limit.
- The 'production' log line "queue entry <buff>: GetAmount n, yield y" shows
  whether the queue counts runs or items. Compare it with the ordered runs on
  the first scenario run.
- A stuckMinutes setting below 10 lets the stuck zone trip fire during the
  Apply and Trip waits. This costs travel time only.
