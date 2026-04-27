/*
 * Fake-specialist factories for tests.
 *
 * core/specialists/* reads specialists via host calls (game.def('Enums::SPECIALIST_TYPE'),
 * spec.GetType(), spec.GetSkills_vector(), etc). These factories produce objects
 * implementing just enough of that surface for planner-decision tests.
 *
 * Specialist type IDs are sentinel numbers — any consistent value works as long
 * as the test's stub `game.def('Enums::SPECIALIST_TYPE')` returns matching
 * constants. Geologist=2 and Explorer=3 are the autoTSO conventions.
 */

'use strict';

var TYPE = {
    GENERAL:   0,
    CARRIER:   1,
    GEOLOGIST: 2,
    EXPLORER:  3,
    ADMIRAL:   4
};

function makeSkill(opts) {
    opts = opts || {};
    var levelVector = opts.levelVector || [];
    return {
        getId:         function () { return opts.id || 'Unknown'; },
        getLevel:      function () { return typeof opts.level === 'number' ? opts.level : 1; },
        getDefinition: function () {
            return {
                level_vector:  levelVector,
                effect_vector: opts.effects || []
            };
        }
    };
}

function makeSpec(opts) {
    opts = opts || {};
    var typeId  = (typeof opts.type === 'number') ? opts.type : TYPE.GENERAL;
    var uid     = opts.uid || ('spec-' + Math.random().toString(36).slice(2, 8));
    var name    = opts.name || 'Specialist';
    var task    = opts.task || null;
    var skills  = (opts.skills || []).map(makeSkill);

    return {
        GetType:     function () { return typeId; },
        GetUniqueID: function () {
            return {
                toKeyString: function () { return uid; },
                toString:    function () { return uid; }
            };
        },
        GetTask:     function () { return task; },
        IsInUse:     function () { return !!task; },
        GetName_string: function () { return name; },
        GetName:     function () { return name; },
        getName:     function () { return name; },
        GetSkills_vector: function () { return skills; },
        skills: {
            getItems_vector: function () { return skills; }
        },
        getIconID:   function () { return opts.iconID || null; },
        GetSpecialistDescription: function () {
            return {
                getName_string:     function () { return name; },
                getBaseType:        function () { return typeId; },
                isTransportGeneral: function () { return false; }
            };
        }
    };
}

function geologist(opts) {
    opts = opts || {};
    opts.type = TYPE.GEOLOGIST;
    if (!opts.name) opts.name = 'Geologist';
    return makeSpec(opts);
}

function explorer(opts) {
    opts = opts || {};
    opts.type = TYPE.EXPLORER;
    if (!opts.name) opts.name = 'Explorer';
    return makeSpec(opts);
}

function task(typeId, subTypeId, remainingMs) {
    return {
        GetType:          function () { return typeId; },
        GetSubType:       function () { return subTypeId; },
        GetRemainingTime: function () { return typeof remainingMs === 'number' ? remainingMs : 0; }
    };
}

module.exports = {
    TYPE:      TYPE,
    geologist: geologist,
    explorer:  explorer,
    spec:      makeSpec,
    skill:     makeSkill,
    task:      task
};
