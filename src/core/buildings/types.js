/*
 * Curated building-type enum.
 *
 * Steward.Building.<Name> === 'Building<Name>' so the literal value is
 * unambiguous if it ever leaks into a log or settings file.
 *
 * This is a curated subset — extend when a module needs a building type that
 * isn't here. The game's internal name (the value) must match what
 * GetBuildingName_string() returns.
 */

(function (S) {

    function add(name, internal) {
        S.Building[name] = internal || ('Building' + name);
    }

    // Provision / production
    add('ProvisionHouse',   'ProvisionHouse');
    add('ProvisionHouse2',  'ProvisionHouse2');
    add('Barracks',         'Barracks');
    add('Bookbinder',       'Bookbinder');
    add('Tavern',           'Tavern');

    // Resource collectors
    add('WoodcutterHut',    'WoodcutterHut');
    add('Forester',         'Forester');
    add('Stonemason',       'Stonemason');
    add('Fisherman',        'Fisherman');
    add('Hunter',           'Hunter');
    add('Farm',              'Farm');

    // Mines
    add('GoldMine',         'GoldMine');
    add('IronMine',         'IronMine');
    add('CoalMine',         'CoalMine');
    add('CopperMine',       'CopperMine');
    add('MarbleMine',       'MarbleMine');
    add('GraniteMine',      'GraniteMine');
    add('TitaniumMine',     'TitaniumMine');
    add('SaltpeterMine',    'SaltpeterMine');

    // Smelters / refineries
    add('IronoreSmelter',   'IronoreSmelter');
    add('GoldSmelter',      'GoldSmelter');
    add('SteelSmelter',     'SteelSmelter');
    add('TitaniumSmelter',  'TitaniumSmelter');

    // Time-limited / collectible
    add('FlyingHouse',          'FlyingHouse');
    add('GiftChristmasTree',    'GiftChristmasTree');
    add('GiftGhostShip',        'GiftGhostShip');
    add('BalloonMarket_mini',   'BalloonMarket_mini');

    // Storage / infra
    add('Warehouse',        'Warehouse');
    add('Storehouse',       'Storehouse');
    add('Residence',        'Residence');
    add('Headquarters',     'Headquarters');
    add('Storeyard',        'Storeyard');

}(Steward));
