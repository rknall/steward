# General Traits — Live Findings

> Status: **catalogued, not yet integrated.** The General family
> (Generals + Carriers + Admirals + AdmiralCarriers) is out of v1
> Steward scope — none of the routing modules read general traits
> today. This file maps `name_string` → in-game wiki name so future
> modules (adventure / barracks / battle automation) have a starting
> point.

## Identification

`spec.GetSpecialistDescription().getBaseType() === 0` covers Generals
*and* Admirals; differentiate by `isTransportGeneral()` for the carrier
flavour. Trait identity comes from `spec.skills` (id ≠ 301).

## Captured trait skills

Sourced from the three available dumps:

- `docs/analysis/specialists-20260427-134729.json` (27 generals).
- `docs/analysis/user_provided/angrywolf_specialists-20260428-122935.json`
  (27 generals + 5 `baseType=12` and 2 `baseType=18`).
- `docs/analysis/user_provided/corsair_specialists-20260428-194029.json`
  (33 generals — adds Trembling Beard, Anslem, Nusala, Loudmouth,
  Brohmann beyond what the earlier dumps held).

Display names cross-referenced with
[settlersonlinewiki.eu/en/military/general/](https://settlersonlinewiki.eu/en/military/general/),
[en.tsomaps.com](https://en.tsomaps.com/handbook/generals/) and
[settlersportal.com](https://settlersportal.com/specialists/generals).

| GetType | Display name | Trait name_string | Effect summary | Source / event |
|---|---|---|---|---|
| 0/3/7/8/9/13/15/16/25 | Vanilla generals | (no trait) | `friendpremiumbuff1` only; tier varies via `description.GetTimeBonus` (100/200%) | Tavern + recruitment |
| 29 | Vargus | `Trait_Vargus` | Combat modifiers (Player offense) | Premium |
| 30 | Champion Anslem | `Trait_Anslem` | Single Enemy `CombatModifier mul=0` — reduces enemy accuracy/attack to minimum | Premium / Island of Pirates |
| 31 | Champion Nusala | `Trait_Nusala` | 2× Player Offense `CombatModifier mul=1` — supplies offensive units with special ammunition | Premium |
| 33 | Mary Christmas | `Trait_MaryDoubleXP` | Double XP from defeated enemy units | Christmas Event |
| 36 | Medic | `Trait_MedicResurrectLosses` | Resurrects a portion of fallen units after victory | Premium |
| 37 | Mad Scientist | `Trait_MadScientist` | Custom combat modifiers | Premium |
| 43 | Boris | `Trait_Boris` | Combat modifiers | Premium |
| 47 | Anniversary General 2019 | `Trait_Anniversary2019General` | Combat modifiers + adventure speed | Anniversary 2019 |
| 50 | Halloween General 2019 | `Trait_Halloween2019General` | Combat + recovery modifiers | Halloween 2019 |
| 52 | Christmas General 2019 | `Trait_Xmas2019General` | Combat + recovery modifiers | Christmas 2019 |
| 56 | Assassin General | `Trait_AssassinGeneral` | Stealth combat modifiers; 300% time bonus | Premium |
| 57 | Sylvana | `Trait_Sylvana` | Combat modifiers | Premium |
| 60 | Tremble Beard | `Trait_TrembleBeard` | "Travels twice as quickly to adventures. Recovers twice as quickly from defeat. 200% Increased XP gained from enemy units defeated by his army" | Anniversary Event 2025 |
| 63 | Ghost General | `Trait_GhostGeneral` | Halloween-themed combat modifiers; 300% time bonus | Halloween |
| 64 | Frosty General | `Trait_FrostyGeneral` | Christmas-themed combat modifiers | Christmas |
| 67 | Loner General | `Trait_LonerGeneral` | Combat modifiers favouring solo dispatch | Premium |
| 72 | General Loudmouth | `Trait_Loudmouth` | Multiple Enemy `CombatModifier` (mul=1, mul=0.9 ×2) + `GeneralRecoverySpeed mul=0.67`. Wiki: "Enemy units deal 10% less damage and cannot attack your weakest units first; travels twice as quickly to adventures and recovers twice as quickly from defeat" | Anniversary Event 2021 |
| 75 | Nutcracker | `Trait_Nutcracker` | Christmas-themed combat modifiers | Christmas |
| 77 | Miraculous | `Trait_Miraculous` | Combat modifiers | Premium |
| 79 | Resolute | `Trait_Resolute` | Combat modifiers | Premium |
| 85 | General Juan | `Trait_GeneralJuan` | Combat modifiers | Premium |
| 88 | Brohmann, The Raider | `Trait_Brohmann` | `Cavalry +30, Knight +30 ×2, CombatGeneral mul=450 val=292`. Wiki: "Cavalry and Knights get +30 damage; Knights also get Flanking; travels twice as quickly to adventures, recovers twice as quickly from defeat." 400% time bonus | Christmas Event 2024 |
| 96 | Narcissistic General | `Trait_NarcissisticGeneral` | Combat modifiers; 300% time bonus | Premium |

> Effect summaries for the older entries are abbreviated — only
> general/30/31/60/72/88 have been walked at the per-effect level for
> this writeup. Full per-effect data lives in the dumps; re-run
> `parse-specialists-dump.js --family general` if you need details.

## Other tokens worth knowing

The 27-Apr roster dump also surfaced these `Trait_<X>` strings that don't
appear above. They correspond to skill-tree nodes attached to *vanilla*
generals (i.e. the universal General skill tree, not per-type traits):

```
Trait_Smuggling          (Carrier-related)
Trait_GetHiredMilitary   (Mercenary recruitment)
```

Tracking them here so the next investigator doesn't mistake them for
per-type identifiers.

## Next step

When opening this file for real work:

1. Walk all dumps with `parse-specialists-dump.js --family general` to
   confirm GetType coverage hasn't drifted.
2. Pull effect details with the same Node one-liner pattern used in the
   explorer/geologist analyses (modify the `family ===` filter).
3. Decide which subset of generals Steward needs to route — most likely
   Anslem / Nusala / Vargus for adventure dispatch, Brohmann + Loudmouth
   for cavalry-heavy missions.
