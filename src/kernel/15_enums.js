/*
 * Shared enums.
 *
 * Access path is short and namespaced (Steward.Priority.Normal); the literal
 * value is prefixed (e.g. 'PriorityNormal') so it's unambiguous if it ever
 * appears alone in logs or settings JSON.
 *
 * This file declares the slots. Per-domain enums (Steward.Building,
 * Steward.SpecialistType, …) are populated by their respective core files.
 */

(function (S) {

    S.Priority = {
        Critical: 'PriorityCritical',
        Normal:   'PriorityNormal',
        Idle:     'PriorityIdle'
    };

    // Ordered priority list for scheduler walks (highest first).
    S.kernel.PRIORITY_ORDER = [
        S.Priority.Critical,
        S.Priority.Normal,
        S.Priority.Idle
    ];

    S.kernel.PRIORITY_VALID = {};
    for (var i = 0; i < S.kernel.PRIORITY_ORDER.length; i++) {
        S.kernel.PRIORITY_VALID[S.kernel.PRIORITY_ORDER[i]] = true;
    }

    // Slots for domain enums populated by core files.
    if (!S.Building)            S.Building            = {};
    if (!S.SpecialistType)      S.SpecialistType      = {};
    if (!S.SpecialistStatus)    S.SpecialistStatus    = {};
    if (!S.SkillModifier)       S.SkillModifier       = {};
    if (!S.ExplorerTask)        S.ExplorerTask        = {};
    if (!S.GeologistTask)       S.GeologistTask       = {};
    if (!S.Deposit)             S.Deposit             = {};

}(Steward));
