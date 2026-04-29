# TODO

Cross-cutting follow-ups that don't fit into a per-module file.

## Geologist

### Algorithm improvements

These came out of the corsair-dump analysis (2026-04-29). The current
ranking in `src/core/specialists/geologists.js`
(`geologistScoreFor` + `rankGeologistsForDeposit`) sorts by
`capacityFactor` primary and `timeFactor` tiebreak. That worked while
no single trait dominated capacity; the corsair additions break the
assumption in three concrete ways.

1. **Capacity-primary ranking collapses with `mummified` in the
   roster.** Mummified Geologist gives `cap×4 / time×3` on every
   deposit. Because the scorer ranks capacity first, Mummified now
   wins `bestGeologistForDeposit(D)` for *every* deposit `D`, even
   when a faster single-deposit specialist is in the pool
   (`iron_willed2` for Iron, `gold_hearted` for Gold, `sooty` for
   Coal, `Trait_LovelyGeologist` for Titanium/Salpeter). Fix:
   compose `capacityFactor` and `timeFactor` into a single score
   (e.g. `cap / time^α` for some α ∈ [0.3, 1]) so that the time cost
   actually trades against capacity instead of being a tiebreak.

2. **`(searchTime, searchDepositCapacity)` is no longer a sufficient
   state vector.** Three cases from the corsair dump push against
   that assumption:
   - **`description.GetTimeBonus` is unread.** Marathon Geologist's
     advertised 3× speed-up lives in `GetTimeBonus = 500`, not in a
     trait `searchTime` modifier. The scorer sees only the trait's
     `cap×0.5` penalty and ranks Marathon below vanilla. Sophisticated
     (`GetTimeBonus = 300`) is similarly invisible. Fold
     `GetTimeBonus` into the time component (e.g. effective time =
     trait time / (GetTimeBonus / 100)).
   - **`modifierEffect` chance is unscored.** Vesy's adventure-drop,
     Marathon's refill-drop, Stargazing's star-shard chance,
     Gingerbread's item chance, Vacational's guaranteed modifier — all
     ride on `modifierEffect chance=N`. Today they don't influence
     ranking. Add a third score axis (`modifierBonus = Σ chance per
     deposit`) and let callers choose whether to weight it.
   - **`findDeposit add=N` is unscored.** Conscientious Geologist's
     guaranteed extra deposit and Versed's half-chance extra are
     dropped on the floor. Same fix as `modifierEffect`: a small
     additive contribution to capacity, scaled by chance.

3. **Per-deposit specialists deserve a tier above universals.** Even
   after fixes 1 and 2, the routing should prefer a deposit-specific
   trait over a universal one when both score similarly — otherwise
   we burn the single-purpose `iron_willed2` on a Stone search and
   leave nothing for Iron. Likely shape: a small bonus to traits whose
   effect set is a strict subset of one or two deposits, applied only
   when scoring that deposit.

Concrete cases driving the design: Marathon (500%/cap×0.5),
Vesy (cap×1/time×3, adventure-drop), Mummified (cap×4 universal).
Verify any change against these three plus the existing
`stone_cold` / `iron_willed2` / `gold_hearted` / `sooty` baselines.

See `docs/traits/GEOLOGIST.md` for the per-trait effect data and the
current per-deposit best-trait map.
