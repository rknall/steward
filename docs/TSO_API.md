# TSO Client API

The host TSO client exposes a number of globals to userscripts. This document is a working reference for the surface Steward depends on. It is _descriptive_ — the client is the source of truth and these names may shift between client builds.

## Globals

| Global       | Source                                | What it is                                          |
|--------------|---------------------------------------|-----------------------------------------------------|
| `air`        | Adobe AIR runtime                     | File system, events, native windows.                |
| `game`       | TSO client                            | Main game controller (`gi`, `quests`, `auto`, …).  |
| `swmmo`      | TSO client                            | ActionScript bridge / app entrypoint.               |
| `loca`       | TSO client                            | Localization.                                       |
| `assets`     | TSO client                            | Bitmap / icon registry.                             |
| `globalFlash`| TSO client                            | Bridge to Flash UI (`gui.mMailWindow`, `gui.mQuestBook`). |
| `$`          | jQuery (loaded by client)             | Used for DOM and iteration helpers.                |
| `debug`      | TSO client                            | Original logging hook used by tso_client itself.    |

Steward modules **must not rely on globals introduced by other userscripts** (e.g. autoTSO's `aSettings`). Use only the host client globals listed above.

## Adobe AIR — file system

```js
air.File.applicationDirectory                       // installed app dir (READ-ONLY in production)
air.File.applicationStorageDirectory                // writable, persistent — use this for settings/logs
air.File.documentsDirectory                         // user docs
air.File.userDirectory
```

Steward writes settings through the host's `settings` global (see [`HOST_INTEGRATION.md`](analysis/HOST_INTEGRATION.md)) and writes logs to a `steward/logs/` subfolder of `applicationStorageDirectory`:

```js
// Settings — delegate to the host:
var s = settings.read(null, 'steward.collect');
settings.store({ enabled: false }, 'steward.collect');

// Logs — Steward owns this path:
var logDir = air.File.applicationStorageDirectory.resolvePath('steward/logs');
if (!logDir.exists) logDir.createDirectory();
var logFile = logDir.resolvePath('console.log');
```

### Reading

```js
var file = air.File.applicationStorageDirectory.resolvePath('steward/settings.json');
if (file.exists) {
    var stream = new air.FileStream();
    stream.open(file, air.FileMode.READ);
    var content = stream.readUTFBytes(file.size);
    stream.close();
    var data = JSON.parse(content);
}
```

### Writing

```js
var file   = air.File.applicationStorageDirectory.resolvePath('steward/settings.json');
var stream = new air.FileStream();
stream.open(file, air.FileMode.WRITE);          // overwrites
stream.writeUTFBytes(JSON.stringify(data, null, 2));
stream.close();
```

### Appending

```js
var stream = new air.FileStream();
stream.open(logFile, air.FileMode.APPEND);
stream.writeUTFBytes('[' + new Date().toISOString() + '] ' + msg + '\n');
stream.close();
```

### Important: writability

`applicationDirectory` is read-only in production. **Never write to subdirectories of the application directory.** Always use `applicationStorageDirectory`.

## `game`

The main game controller. Lots of it; only the parts Steward uses are listed here.

### Identity / current state

```js
game.gi                                  // game interface
game.gi.mCurrentPlayer                   // player object for the currently viewed zone
game.gi.mCurrentPlayerZone               // zone object for the currently viewed zone
game.gi.mHomePlayer                      // home player
game.gi.mCurrentViewedZoneID             // zone ID
game.gi.isOnHomzone()                    // true on home island
game.zone                                // shorthand for current zone
game.player                              // shorthand for current player
```

### Navigation

```js
game.gi.visitZone(zoneId);
game.zone.ScrollToGrid(grid);
game.gi.SelectBuilding(building);
```

### Server actions

```js
game.gi.SendServerAction(actionId, p1, p2, p3, data);
game.gi.mClientMessages.SendMessagetoServer(messageId, zoneId, payload, responder);
```

### Class lookup

```js
game.def(className)                                  // resolve an ActionScript class
game.def('Communication.VO::dIntegerVO', true)       // create a new instance
swmmo.getDefinitionByName(className)
```

### Utilities

```js
game.chatMessage(text, channel);
game.showAlert(text);
game.getTracker(name, callback);                     // observe a property
game.quests.getQuest(name);
game.quests.GetQuestPool().GetQuest_vector();
game.gi.mClientMessages.GetClientTime?.();
swmmo.application.mGameInterface.GetClientTime();
```

## Zones and buildings

```js
var zone = game.gi.mCurrentPlayerZone;
zone.mStreetDataMap.GetBuildings_vector();                   // all buildings on this zone
zone.mStreetDataMap.getBuildingsByName_vector('ProvisionHouse');
zone.mStreetDataMap.getBuildingByName('FlyingHouse');
zone.GetBuildingFromGridPosition(grid);
zone.UpgradeBuildingOnGridPosition(grid);
zone.SendDestructBuildingCommand(building, source);

// Specialists
zone.GetSpecialists_vector();

// Deposits
zone.mStreetDataMap.mDepositContainer;                       // iterate
zone.mStreetDataMap.getDeposits_vectorByType('IronOre');
```

### Building accessors

```js
b.GetBuildingName_string();
b.GetGrid();
b.GetUpgradeLevel();
b.GetGOContainer();           // .mIsAttackable, .mIsLeaderCamp, .ui ('enemy'|'friend'|...)
b.getPlayerID();              // -1 = neutral/enemy, 0 = home
b.GetArmy();                  // null or army; .HasUnits()
b.mIsSelectable;
b.IsUpgradeAllowed(true);
b.productionQueue;            // .mTimedProductions_vector, .mProductionType
```

### Specialist accessors

```js
s.getName(false);
s.GetType();                  // 0 general/carrier, 1 explorer, 2 geologist
s.GetTask();                  // .GetSubType(), .GetType()
s.getPlayerID();
```

## Localization (`loca`)

```js
loca.GetText(category, key);
```

Common categories:

| Category | Meaning              |
|----------|----------------------|
| `LAB`    | Labels / UI text     |
| `BUI`    | Building names       |
| `RES`    | Resource names       |
| `MEL`    | Mail messages        |
| `ALT`    | Alerts               |
| `QUL`    | Quest titles         |
| `ADN`    | Adventure names      |
| `SHG`    | Shop / guild text    |
| `ACL`    | Action labels        |
| `SHI`    | Shop items           |
| `QTG`    | Quest tags           |
| `HIL`    | Help / info labels   |

`Steward.core.locale` wraps these and adds shorthands (`.bui()`, `.res()`, `.lab()`, `.adn()`, `.qul()`).

## UI helpers (provided by host client)

```js
createModalWindow(id, title, removeOnHide);
$('#myModal').modal({ backdrop: 'static' });
$('#myModal').modal('hide');

new Modal(id, title, removeOnHide);
modal.create(); modal.show(); modal.hide();
modal.Body(); modal.Title(); modal.Footer(); modal.Data();

createTableRow([[4, 'Col1'], [4, 'Col2'], [4, 'Col3']], false);
createSwitch('id', true, function () { /* on change */ });

getImageTag('Coin', '24px');
assets.GetResourceIcon('Coin');
```

## Time

```js
swmmo.application.mGameInterface.GetClientTime();   // server-synced epoch ms
new window.runtime.Date(timestamp);                 // game's Date constructor
```

## Where to look in autoTSO for working examples

| Concern                | autoTSO file              |
|------------------------|---------------------------|
| File I/O               | `user_auto.js` `aUtils.file.*` |
| Settings persistence   | `user_auto.js:1046` `aSettings` |
| Server packets         | `user_auto.js` `aUtils.game.*`, `aQueue.actions.*` |
| Building search        | `user_auto.js:5021` `aBuildings` |
| Specialist dispatch    | `user_auto.js` `aSpecialists`, `aUtils.game.sendSpecialistPacket` |
| Modal UI               | `user_auto.js:1971` `aUI` |
| Logger                 | `user_auto.js:358` `aDebug` + `aConsoleLogger` |
