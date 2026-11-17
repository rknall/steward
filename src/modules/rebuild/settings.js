/*
 * Default settings for the rebuild module.
 *
 * Settings live in host's settings.json under 'steward.rebuild'.
 * wellType and fieldType name the building placed on an exhausted well or
 * field; each must be a name from S.modules.rebuild.wells / .fields.
 */

(function (S) {

    if (!S.modules.rebuild) S.modules.rebuild = {};

    // Buildable wells and fields. id is the building number that is sent
    // with the rebuild; the client's lookup of the number by name appears
    // only in the rebuild's log line, as a check on this list.
    S.modules.rebuild.wells = [
        { name: 'Well',    id: 72,  label: 'Well' },
        { name: 'Well_03', id: 176, label: 'Deep Well' },
        { name: 'Well_04', id: 246, label: 'Bottomless Well' }
    ];
    S.modules.rebuild.fields = [
        { name: 'Farmfield',    id: 43,  label: 'Wheatfield' },
        { name: 'Farmfield_03', id: 247, label: 'Medium Wheatfield' },
        { name: 'Farmfield_04', id: 248, label: 'Tightly Sown Wheatfield' }
    ];

    // Names of the depleted shells an exhausted well or field leaves behind.
    S.modules.rebuild.depletedWell  = 'MineDepletedDepositWater';
    S.modules.rebuild.depletedField = 'MineDepletedDepositCorn';

    S.modules.rebuild.defaultSettings = {
        // Off by default: it spends resources and build-queue slots.
        enabled:     false,
        wellType:    'Well',
        fieldType:   'Farmfield'
    };

}(Steward));
