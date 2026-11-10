# Scenario runs

A scenario run plays a TSO scenario adventure (BuffAdventures_*,
Birthday2013Adventure1..5, Storm_Recovery and others) from one JSON file per
scenario. It is an adventures-module run without generals: same run record,
step table, persistence, run menu, pause and resume, zone trip, watcher and
end-of-map steps. Three series steps are new: produce items at home, apply
items on the island, and the end of a trip. The run repeats trips on one map,
then repeats maps like a template series.

## Files

- Repo `scenarios/<id>.json` (id = file base name). The build embeds every file
  into the bundle as a built-in scenario.
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
  home in one go; each send offers `min(amount, stock)` and what the grid
  does not take stays in stock. A return trip when stock runs out is only a fallback.
- The start check refuses a scenario whose buff is not a produceable buff
  definition and stores nothing.

## Rules

- Production overlap: while at home for trip i the run orders the needs of
  trip i (the item total, or one per open grid) plus trip i+1 (all grids), minus stock and queued items,
  and waits only until trip i's needs are in the star menu.
- Send to a grid: `min(amount or 1, stock)`. Stock is logged before and after.
- Quest gating (strict): on the run's island an item is applied and a map
  object is picked up only while a running quest asks for it explicitly. Running
  means the quest is in the pool (visible in the quest log), not finished,
  IsQuestActive() holds and its mode is 3 (READ_MODE, set once the player or
  the run has read it). Mode 2 (unread) and every other mode never count. The
  main quest is skipped. A pick-up or item spent on a quest that does not take
  it is lost, so the scenario could run short.
- While a scenario run (running or paused) has its island viewed, collect
  clicks only the quest objects of running quests there and no pattern
  collectibles. Apply and Trip log once "waiting for quest <name> to be
  running, mode N" for what waits only on its quest; the run's unread-quest
  reader keeps reading unread quests so they start. Trip counts such objects
  as left until TRIP_MAX_MS. Outside scenario runs collect and template runs
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

- Grid-done rule: a send is done when the grid took less than offered or took
  the trip-total bound (sendAmount = amount or 1). A send capped by stock
  keeps the grid open for a top-up after the stock-out trip.
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
