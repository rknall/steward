# Adventure queues

A queue is an ordered list of entries, each an adventure template or a
scenario with its own run count. The adventures module runs them one after
another inside its normal run state machine (same run record, same pauses,
same restart handling). The whole queue can loop. Typical use: run a short map
while the generals of a long map travel home.

## File format

One JSON file per queue in `<steward>/adventures/queues/<id>.json`. The file
name is the id (same id and file rules as templates; a stored `id` field is
ignored, any valid file dropped in is a queue):

```json
{
  "version": 1,
  "label": "Short then long",
  "entries": [
    { "kind": "template", "id": "<template id>", "count": 3 },
    { "kind": "scenario", "id": "<scenario id>", "count": 1 }
  ],
  "loop": true,
  "passes": 0,
  "early": false,
  "retrain": "settings",
  "noMap": "pause",
  "saved": 0
}
```

- `kind`: `template` or `scenario`. An entry holds only its kind and id; its
  label and adventure come from the template or scenario record, so renaming
  one needs no queue edit. A kind this build does not know (a later `venture`)
  is kept when the file loads, so an older build never rewrites a newer file;
  the entry shows as broken and the queue cannot start until it is removed.
- `count`: runs of that entry, at least 1.
- `loop`, `passes`: `loop` repeats the whole queue; `passes` limits the
  repetitions (0 = until End repetition or Stop).
- `early`: start the next entry while the finished entry's generals travel
  home (default off).
- `retrain`: `settings` (follow Settings > Adventures, default), `on` or `off`
  for every entry. A scenario entry retrains nothing either way.
- `noMap`: `pause` (default) or `skip`, see below.
- A file that cannot be read is listed as a broken entry so it can be deleted.

A queue that fails validation (empty label, missing template or scenario,
unknown kind, no entries) does not start. A label used by another queue is
refused at Save only; Start does not check it.

## Edit and start

Queues are edited in the **Queues** view of the Run templates window (switch
Templates | Queues). Add entry is one select grouped Adventures / Scenarios.

Queues are started from the **Queues** folder at the end of
`~Steward~ > Adventures`, after the Scenarios folder. A row reads
`<label> (<K> entries)` with the map count of the entry Start would begin with;
it is greyed when that count is 0, and broken files are disabled rows last.
While adventure definitions load the folder is one greyed `Queues (loading...)`
row.

Start begins at the first entry only, with that kind's prompts (start wave for
an open template map, start trip for an open scenario map) and no count prompt.

A started queue runs a copy of the file. Edits saved while it runs apply at the
next start; the edit view of a running queue warns about this and names the
entry running now.

## Hand-over between entries

When an entry's last run is done the run state machine hands over at Next:

- **Wait.** If the next entry's generals are not home yet, it waits in queue
  order (the Muster gather).
- **Early.** With `early` on, when a template entry finishes and the next
  entry uses a different template (or is a scenario), the finished entry's
  retrain is skipped and the next entry starts while the generals travel home.
- **Retrain.** The `retrain` option decides for the whole queue; `settings`
  reads the module setting as before.
- **No map left.** With `noMap` `pause`, a missing map pauses at StartMap as
  for a single run (Skip entry moves on). With `skip`, an entry whose map count
  is 0 in the star menu is stepped over at hand-over with a log line and a
  notice; runs left in an entry that runs out of maps are dropped with a note.
  If every entry has no map while looping, the queue pauses with "no map for
  any queue entry". At Start, `skip` begins at the first entry with a map and
  names the entries stepped over; with `pause`, Start refuses as for a single
  run.
- **Broken entry.** An entry that cannot start at hand-over (record missing,
  unknown kind, start check failed) pauses the queue at Next. Resume repeats
  the hand-over; Skip entry steps over it. Definitions or the specialist list
  not readable yet make the hand-over wait instead.

Any pause pauses the queue; Resume continues the entry. A stop-type end stops
the queue. End repetition ends the queue after the current run.

## Skip entry

Command Skip entry in `~Steward~ > Adventures`, enabled only in a queue, paused
and at home:

- Before the entry's map is out (up to StartMap, map not open, and at StartMap
  neither a not-observed pause nor a seen map mark): the entry's remaining runs
  are dropped uncounted and the next entry begins. A scenario run paused at
  Produce qualifies.
- At Next with a broken-entry pause: that entry is stepped over and the run
  resumes by itself, so no separate Resume is needed.

In the first case the next entry must be able to begin. If it cannot (record
not readable, start check failed), a notice says why and the run stays paused.

## Status

The status text and title read `<queue label> <k>/<K>[, pass p/P]: ` before
the run text; the pass part appears only for a looping queue and reads `p/∞`
without a pass limit. A queue with an entry or pass still to come is never
settled, so its run file is kept (a restart resumes it) and a new start asks
before replacing it. The run menu keeps one fixed row set for the whole queue (wave rows padded to the
widest template entry).

## Restart

The running copy is saved with the run, so a client restart mid-queue resumes
on the entry (template or scenario) it was on; an old run file without a queue
loads as a single run.

## Known limits

- The running copy never re-reads its file; edits apply at the next start.
- Ventures are not queueable yet; `kind` is the extension point. The Add entry
  select does not offer them.
- The "Next step" command (#80) is not implemented; its place follows Skip entry.
