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
- Scenarios are listed in `~Steward~ > Adventures > Scenarios`, in a sub-folder
  per host campaign when the adventure has one. A row with no map in the star
  menu (x0) is greyed; a pass that cannot read the star menu (x?) keeps the
  row's last state. Until the game's adventure list is readable the folder is
  one greyed `Scenarios (loading...)` row.
- A text that cannot be parsed is listed as a broken entry with its error, and a
  broken user file replaces the built-in of its id.
- The autoTSO converter that produced the first files was a one-off and is not
  shipped.

## Format (version 1)

```json
{ "version": 1, "label": "Storm Recovery", "adventure": "BuffAdventures_Storm_Recovery",
  "trips": [ { "items": [ { "buff": "BuffAdventure...", "grids": [1, 2, 3],
                            "amount": 10, "quest": "Buff_Adv_..." } ] },
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
  home in one go. For an item with an amount each grid of a burst is offered the
  remaining trip total, takes only what it needs, and the item is done after one burst;
  without an amount each grid is offered 1. What a grid does not take stays in stock.
  A return trip when stock runs out is only a fallback.
- `quest` is an optional full quest name. When it is set, only that quest can
  make the item wanted for Apply: the quest must be running, and where the
  client has `IsRunning()` it must also report true. Production ignores it.
  Use it when an item shares a grid with items of an earlier quest that asks
  for the building by name, as the Storm Recovery kits share the ruins with
  the dynamite quest. A value that is not a non-empty string makes the file a
  broken entry ("has a bad quest").
- The start check refuses a scenario whose buff is not a produceable buff
  definition and stores nothing.

## Rules

- Production overlap: while at home for trip i the run orders the needs of
  trip i (the item total, or one per open grid) plus trip i+1 (all grids), minus stock and queued items.
  It leaves home only once no item of trip i or i+1 is in a production queue (any
  queued entry of that buff counts), the star menu holds the full amount trip i
  needs of each item (stock at least the needed amount, not merely some), and
  both still hold on a second read about 10 s later. Stock left from an earlier
  run never counts while that item is still queued. The wait has no limit and is
  logged once a minute as `waiting for production: ...`.
- Apply burst: all open wanted grids of one item go out together, back to back, from one
  star-menu stack, as autoTSO does. For an item with an amount every grid is offered the
  remaining trip total (`amount - taken over the trip`); each grid takes only what it needs
  and the rest stays in stock. The burst needs one stack holding that total: when the total
  stock is lower the run goes home for more first and sends nothing, and when the stock is
  split so that no stack holds it the run pauses BuffFailed (`no single stack of N`) before
  any packet. An item without an amount offers 1 per grid and the burst is cut to the
  largest stack, so the stack cannot run dry mid-burst; the other grids go in the next burst.
  After the burst the run waits 15 s (BURST_GAP_MS) before it reads the stock to verify, and
  the next burst goes out no sooner than 15 s after the last packet. Stock is logged before and
  after. One verified burst closes the item's grids of that burst.
- Burst checks: before the first packet the run reads the building standing at every grid
  of the burst again. If any differs from the one the target was chosen on (a ruin became a
  site, a building was removed or finished its destruction), nothing is sent for the whole
  burst. The log says `not sent, the building at the grid changed since the target was chosen
  (was X, now Y)`, and the grids are decided again about 10 s later on a fresh read.
  A grid that changes on every try pauses BuffFailed after three tries
  ("nothing sent after 3 tries"). Every item send also logs one line per grid
  (`item <buff> -> <grid>: entries ...`), see In-game checks.
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
  it is lost, so the scenario could run short. An item named only by a type-1
  trigger never counts, because such a quest may ask to produce it rather than
  apply it (Storm Recovery's Stinky Potion and Decomposer); only an applied,
  `onmap` or `buildingdestroyed` end condition on the item, or the building
  rules below, make it wanted. An item also counts as asked for
  when a running quest's open type-1 trigger (not a click trigger) names the
  building standing at the item's grid (e.g. Riches `buffad_sabotage`), or when
  its open `onmap` or `buildingdestroyed` end condition names that building (e.g.
  Storm Recovery `buffad_boulder_01` and `buffad_boulder_02`, which the dynamite
  clears). A binding (`quest`, see Format) narrows these rules to that quest. A
  bound quest that names neither the item nor the grid's building still counts
  while it runs, since some conditions cannot be read: it is held while it waits
  in the pool and done once finished. While the bound quest is missing, the item
  waits ("waiting for quest <name> for <buff>").
- Settle: Apply decides nothing within QUEST_SETTLE_MS (20 s) of the last quest
  the run read or claimed on the island. The next quest has then appeared before
  any item is sent or any grid is closed.
- While a scenario run (running or paused) has its island viewed, collect
  clicks only the quest objects and the collectibles that running quests count
  there, and no pattern collectibles. Apply and Trip log once "waiting for quest <name> to be
  running, mode N" for what waits only on its quest; the run's unread-quest
  reader keeps reading unread quests so they start. Trip and Clear count such
  objects as left, so the run picks them up before it goes home. Trip settles
  READ_LAG_MS from its entry and QUEST_SETTLE_MS (20 s) from the last quest the
  run read or claimed on the island, waits while a running quest's open
  buildingdestroyed pick-up is not on the map yet (its objects show some seconds
  after the read), and leaves once all of that has read clear for READ_LAG_MS.
  Then Trip leaves after TRIP_MAX_MS (5 min quiet) whatever is left, unless
  pick-ups are left and Produce found that the next trip's items wait for
  resources: then the run re-visits the island (jump home and back, which
  reloads the zone and its objects) after TRIP_REVISIT_MS (2 min) while a
  pick-up is not on the map yet, or after TRIP_MAX_MS otherwise, up to
  TRIP_REVISITS (2) times per trip, and then pauses on the island ("collect
  them, then Resume").
  Outside scenario runs collect and template runs
  keep the looser gate (any started, active quest that is not unread).
- Stock-out (fallback, since trips are produced in full): when an item runs out with grids still open, Apply first
  sends the other items a running quest wants that are in stock, skipping grids
  the out-of-stock item still owes so file order on a shared grid holds. Only
  when nothing else can go (only owed grids or waiting items are left) the run
  takes a return trip home (production is home-only), orders the rest and comes
  back to the same trip. No pause. A Trip re-visit (see the collect bullet)
  takes the same return trip, so it reloads the island too.
- Start trip: the count prompt accepts a trip number, so a run can begin on a
  map that is already open at a later trip.

## Steps

Scenario chain: Wait between maps, Produce items, Start map, Jump to the map,
Apply items, Quests and pick-ups, then more trips (jump home, produce, back) or
Clear, last quest, Close, Return home, Next map.

"Wait between maps" waits 180 s after the last map seen closed, counted again
right before the map start, and the time survives Stop, a new start and a client
restart.

Skipped for a scenario run: check and load generals, send generals, wait for
generals, pick up items, send all to the star, horseshoe, waves, pack, retrain.
The step list is the one run table; the run menu greys rows that do not apply.

## In-game checks

Diagnostics > Quests dump shows per-grid needs (end conditions with action and
item strings, trigger index and status) and the last-quest marker. If the
marker is missing, Clear pauses with "last quest not listed" and the dump shows
why.

Every item send logs one line before it goes out:
`item <buff> -> <grid>: entries <stacks>; building <name|none>[ (first seen
<name>)] grid <grid of the building>, buffs <n>, in destruction <t|f|?>; targets
<list|none> group <group|none> via <name|group|no|->`. `entries` lists each
star-menu stack as `<amount>[<unique id>]` (`?` for an unreadable entry). Read
this line first when a send was refused: it shows what the send saw. Each burst also logs
one core line (category `buffs`):
`item <buff> burst x<amount> -> <n> grid(s): <g>@+<ms>, ... (stack <amount>[<id>], stock <n>,
need <need>, first at <time>)`, with the ms offset of each packet from the first one, and
`; <g> failed; not sent <g,...>` when a packet failed. The verified or failed line ends
with `stock <before> -> <now>; buffs <g>:<n>,...`, the buff count of every grid. If the stock
fell, the server took the burst. If the buff counts grew with the stock unchanged, the client
is only late reading it. If both are unchanged, the server refused. Read the entries line
first, then the burst line, then this one.

## Known limits

- Burst take: the item's trip total is the sum of the burst takes. A verified burst
  closes every grid it covered, whatever it took, and nothing is sent to those grids
  again. A grid whose building is gone or being destroyed is done as before.
- Need is not reduced by what grids already took, so after a fallback stock-out
  home trip the run may reorder up to the already-taken count.
- A burst that took less than it offered closes all its grids, with a warn line and
  no top-up send. The takes of the single grids are not known, only their sum, which
  is booked on the burst's first grid. The item's quest then stays open until Clear
  pauses if the grids still owe something.
- A burst that fails part-way (a packet that cannot be sent) pauses BuffFailed and names
  the grids that went out. Resume sends every grid without a seen mark again, also the
  ones that already went out, so check the star menu stock first.
- Quest gating is per item, not per grid, so the grid order in the file decides
  which grid goes first (same as autoTSO). A quest matched by the building at the
  grid is read per grid instead: a grid whose building's condition is met is
  skipped while the item's other grids still go. After a client reload mid-trip
  a blasted grid's building is no longer known, so that grid waits like an item
  no quest wants.
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
- The client data does not say which resource a pick-up gives, so any
  next-trip shortfall with pick-ups left re-visits the island, not only a
  shortfall a pick-up covers.
- An item send that made no host call (its star-menu entry has no unique id)
  is tried again, 10 s apart, up to 3 times per grid, then BuffFailed pauses.
  A real packet failure still pauses at once.
- A map opened and closed by hand with no steward read in between is not seen, so
  it does not start the 180 s wait.
- The first map start after an update, a fresh install or an unreadable run file
  waits 180 s from the first look.
- A map start that was sent but never seen is never sent again. Resume waits or
  pauses, and Stop and a new start send after the 180 s gap.
- Start refuses while the own adventures cannot be read.
- A run file that cannot be read is left as it is until Start or Stop writes it.
  The map times of that session are then kept in memory only.

## Scenarios in queues

A scenario can be an entry of an adventure queue, mixed with templates; see
[QUEUES.md](QUEUES.md).
