# General Traits — Live Findings

> Status: **stub — not yet investigated**. The General family
> (Generals + Carriers + Admirals + AdmiralCarriers) is out of v1
> Steward scope. This file is a placeholder so the trait catalog has
> the same structure across all three specialist families.

## When to fill this in

Populate this file once a Steward module needs General routing —
likely when adventure / barracks / battle automation lands. Until
then, the host's own General-Camp UI is sufficient and we don't need
a per-trait recommendation.

## What we already know

`spec.GetSpecialistDescription().getBaseType() === 0` (which the host
collapses across both Generals and Admirals; differentiate by
`isTransportGeneral()` for the carrier flavour).

The 27 Generals in our 2026-04-27 dump carry traits with these
`name_string` values (deduped):

```
Trait_GhostGeneral
Trait_FrostyGeneral
Trait_Anniversary2019General
Trait_Halloween2019General
Trait_Xmas2019General
Trait_LonerGeneral
Trait_AssassinGeneral
Trait_GeneralJuan
Trait_NarcissisticGeneral
Trait_MaryDoubleXP
Trait_MadScientist
Trait_Boris
Trait_Vargus
Trait_Sylvana
Trait_Miraculous
Trait_Smuggling
Trait_Resolute
Trait_Nutcracker
Trait_GetHiredMilitary
Trait_MedicResurrectLosses
```

The 28-Apr `angrywolf_specialists` dump adds:

```
Trait_TrembleBeard
```

…plus likely more not-yet-captured types. Re-run
`docs/analysis/dump_specialists.js` on a roster that includes the
generals you care about, then use
`docs/analysis/parse-specialists-dump.js --family general` to list
them.

## Source dumps

- `docs/analysis/specialists-20260427-134729.json` — 27 generals,
  schema v2.
- `docs/analysis/user_provided/angrywolf_specialists-20260428-122935.json`
  — 27 generals plus 5 `baseType=12` and 2 `baseType=18` entries
  (carriers / admirals — the host collapses them under `baseType=0` in
  the generic family resolution; the categorisation needs verification).

## Next step

When opening this file for real work:

1. Walk both dumps with `parse-specialists-dump.js --family general`
   to enumerate GetTypes and traits.
2. Pull effect details with the same Node one-liner pattern used in
   the explorer/geologist analysis (see commit `827ada7` for the
   pattern; modify the `family ===` filter).
3. Document each trait with **GUESS** markers until confirmed by
   in-game testing.
