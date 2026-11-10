# Wave runs

A wave run takes the waves of a run one after the other, from Gate to Confirm.
Within a wave, Attack and Buff lines go out in parsed order: the first at once,
and each later one its `time` after the previous send.

## Buff lines

A `buff_*` line with `type: "buff"` and `target` set to a camp grid is applied
from the star menu. It counts as seen when its stock drops, not when the camp
dies, so a buff that only weakens a camp does not hold the wave. A later line on
a camp that a buff killed is dropped: its general is not moved or loaded.

Supported:

- A buff kill in a wave before the attack waves. This also works when the kill
  opens the path to a later camp: Settle waits until the path reads.
- A wave that mixes Buff and Attack lines aimed at different camps.

## Known limits

- Same wave, an Attack line whose path opens only when a Buff line of that wave
  kills a blocking camp. Reach checks the path before any line is sent, so the
  wave waits in Settle and pauses Unreachable after the quiet limit. Put the buff
  kill in an earlier wave.
- Same wave, a Buff and then an Attack on the same camp, where the buff kills
  it. The attack is refused ("no building at") and the run pauses AttackRefused.
  Drop the attack line from the file, or move the buff to an earlier wave.

## Template steps

A template's `waves` list holds battle-file paths mixed with step entries, in
run order. Steps run between two waves, never inside a battle file (the battle
parser rejects unknown keys). The file format stays `version` 1 and only gains
entries; an older build drops the step entries when it loads the template.

```
"waves": [
  "C:/.../wave01.txt",
  { "step": "unload", "generals": ["12.345"] },
  "C:/.../wave02.txt",
  { "step": "pause", "message": "Check the boss camp" },
  { "step": "home",  "generals": ["12.346"] },
  { "step": "wait",  "minutes": 5 },
  "C:/.../wave03.txt"
],
"starAll": true
```

`generals` holds loadout keys (uids), not names, because a name is not unique.
Waves keep their numbers 1..M and count battle files only; a step row is named
after the wave it follows (`Unload after wave 1`, or `before wave 1` when no
wave precedes it).

Kinds:

- **Unload**: the named generals' troops go back to the pool. Each general
  stays on his grid. A busy general is waited for; one missing from the island
  pauses GeneralMissing after the usual grace.
- **Send home**: the named generals travel home now. Later waves and the
  end-of-map steps leave them out (Arrive, Send all to the star, pack plan,
  Clear). Arrive home still waits for them to be listed home and idle.
- **Pause**: the run pauses here with the pause sound. Resume run goes on with
  the next entry. It is one-shot: a resumed Pause counts as done.
- **Pause x min**: a timed wait of 1 to 120 whole minutes. It plays no sound
  and goes on by itself. Resume while it waits restarts the minutes, because
  Resume clears a start that was not seen.

Every pause a run raises plays the pause sound, except the Pause button.

Start check rules (fatal, shown in the template window and at run start): a
step names at least one general, every general is in the loadout, a general sent
home is not named by a later step and not used by a later wave file, and the
minutes are a whole number in range.

Steps run only on the adventure island under a wave step, so a step between
waves runs after the previous wave is confirmed and before the next one is
prepared.

Start at wave k: k = 1 starts at the first entry, so leading steps run. k > 1
starts at the k-th battle file and skips the steps before it, because they
belong to the part of the map already played. Edge: a general an earlier
session already sent home has no mark in the new run, so the island steps
still list him; they tolerate a loadout general that is not on the island, and
nothing seeds the mark.

## Send all to the star

After arrival every general goes to the star empty, so each wave loads from a
known state. The template has a switch for this, default on (a template
without the key reads as on). When it is off the step moves on at once and the
run menu shows `Send all to the star   not used`; the generals then walk from
wherever they arrived to their wave grids. A scenario run never uses it.
