/*
 * Geologist-specific helpers.
 *
 * Companion to `core/specialists.js` for behaviour that only applies to
 * the geologist family. Filename sort puts this after `specialists.js`,
 * so the parent `S.core.specialists.*` namespace is fully populated by
 * the time we extend it here.
 *
 * What lives here:
 *   - pickDeposits(geologist) — host-aware deposit-type recommendation
 *     (per-spec override → events → host default → empty)
 *   - (more to come) ranking helpers used by the geologists module
 *     once it lands.
 *
 * What stays in `core/specialists.js`:
 *   - generic listing / classification / status (geologists() listing
 *     sugar, isGeologist(), isProspecting())
 *   - GEOLOGIST_TASK_PACKET — the dispatch-level enum→packet mapping
 *     consumed by the unified send() function alongside its explorer
 *     counterpart. That table is a packet detail, not a behaviour, and
 *     belongs with send().
 */

(function (S) {

    if (!S.core.specialists) S.core.specialists = {};

    function pickDeposits(geologist) {
        // Returns an ordered list of deposit type names the geologist should
        // prioritize. Precedence:
        //   1. mainSettings.geoDefTaskByType[<name>] — per-spec host override
        //   2. event-aware deposit modifiers
        //   3. mainSettings.geoDefTask              — host's global default
        //   4. []                                    — caller falls back to own config
        //
        // The host stores defaults as a single deposit-type index (not a list)
        // so when only the host default applies we return a one-element array.
        // Per-geologist skill weighting plugs in here once the routing module
        // lands.
        var out = [];
        if (!geologist) return out;

        // 1. Per-spec host override (returns a single index → wrap as one-elem list).
        if (S.kernel.host) {
            var perName = S.kernel.host.geoDefTaskByName(S.core.specialists.name(geologist));
            if (typeof perName === 'number') return ['' + perName];
        }

        // 2. Event-aware deposit modifiers.
        try {
            var active = S.core.events.active();
            for (var i = 0; i < active.length; i++) {
                var ev = active[i];
                var data = S.core.events.data && S.core.events.data.events[ev.code];
                if (!data || !data.depositModifier) continue;
                var keys = Object.keys(data.depositModifier);
                for (var k = 0; k < keys.length; k++) out.push(keys[k]);
            }
            if (out.length > 0) return out;
        } catch (e) {
            S.kernel.warn('specialists', 'pickDeposits event eval threw:', e);
        }

        // 3. Host global default.
        if (S.kernel.host) {
            var global = S.kernel.host.geoDefTaskGlobal();
            if (typeof global === 'number') return ['' + global];
        }

        return out;
    }

    S.core.specialists.pickDeposits = pickDeposits;

}(Steward));
