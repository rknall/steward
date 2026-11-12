/*
 * Adventures' entry in the production ledger: while a template run is
 * active, the troops stay with the run.
 *
 * Adventures counts queued troops as owned at the Snapshot and again after the
 * map, so a standing troop order placed in between would hide losses and the
 * retrain would come out short. The hold below tells the production manager
 * to leave unit orders alone for as long as such a run is Running or Paused.
 * A scenario run sends no generals and loses no troops, so it holds nothing.
 *
 * The provider reads S.modules.adventures.state each time it is pulled, so a
 * script reload needs no re-registration of anything cached. It loads after
 * away.js and before dialog.js in name order.
 */

(function (S) {

    if (!S.modules.adventures) S.modules.adventures = {};

    var OWNER = 'adventures';

    function empty() { return { needs: [], holds: [] }; }

    function provider() {
        var st = S.modules.adventures.state;
        var r = st && st.run && st.run();
        if (!r || st.isScenario(r)) return empty();
        if (r.status !== S.RunStatus.Running && r.status !== S.RunStatus.Paused) return empty();
        return {
            needs: [],
            // The label is the run's current wave or series step, not the
            // template name, so the Demand view shows where the run is.
            holds: [{
                key:   'troops',
                label: 'Adventure: ' + st.label() + ' (troops)',
                kind:  S.ProductionKind.Units
            }]
        };
    }

    if (S.core && S.core.production && S.core.production.demand) {
        S.core.production.demand.provide(OWNER, provider);
    }

}(Steward));
