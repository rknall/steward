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
