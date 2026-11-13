# Storehouse categories (warehouse tabs)

How the game sorts resources into storehouse tabs (Basic, Intermediate, Advanced, Expert, Elite, …),
as worked out from tso_client, plus what Steward is missing.

## Source field: `group_string`

The tab comes from **`group_string`**. `category_string` is a different axis: production
types like `Intermediates`, `BuildingMaterials`, `Food`, `Weapons`. It does not map to tabs.

`group_string` is present on both:
- definitions: `ServerState::gEconomics.mResourceDefaultDefinition_vector`, or one at a time with
  `GetResourcesDefaultDefinition(name)`
- player resources: `game.getResources().GetResources_Vector()` (see tso_client `5-settings.js:18-29`)

Confirmed by the home storehouse dump (2026-11-13): the held vector
`GetPlayerResources_vector('')` returns every one of the 163 definitions (58 held at 0). Its items
carry the same `group_string` as the definition for all 163, but no `category_string` (null), so
the category comes from the definition only. Every definition has a group: CL1 12, CL2 15, CL3 24,
CL4 23, CL5 13, Event 26, `''` 49, DEF_MODE 1 (DefensePoint). No item has an empty group with a
category set, so the trader's category fallback never fires on this server.

## Mapping

| `group_string` | Tab label key (`loca.GetText('LAB', key)`) | Tier |
|---|---|---|
| `CL1` | WarehouseTab1 | Basic |
| `CL2` | WarehouseTab2 | Intermediate |
| `CL3` | WarehouseTab3 | Advanced |
| `CL4` | WarehouseTab4 | Expert |
| `CL5` | WarehouseTab8 | Elite |
| `Event` | WarehouseTab6 | Event |
| `""` (empty) | WarehouseTab7 | Collectibles |
| `Collectibles` | WarehouseTab7 | Collectibles |
| `DEF_MODE` | (left out) | Defense mode |

Shared lookup in tso_client: `ResourceGroupToWarehouseTab`, `client/files/content/scripts/0-common.js:65-73`.
The dump confirms the global exists at runtime with exactly these seven keys (CL5 -> WarehouseTab8).
It has no `''` key: an empty group goes to WarehouseTab7 by rule, not by the map.

The English tier names are ours. Labels are read at runtime with
`loca.GetText('LAB', 'WarehouseTabN')` (`S.core.locale.lab`).

## How `user_shortcut_trader.js` uses it

Upstream `GameDataSource.getResourceList` (`userscripts/user_shortcut_trader.js:1160-1454`,
`fedorovvl/tso_client` master as read on 2026-11-13):

- It keeps only `tradable` items and skips event items whose event has not started.
- The tab rule includes Collectibles, mapped to tab 7.
- The fixed tab order is 1, 2, 3, 4, 8, 6, 7 (Basic, Intermediate, Advanced, Expert, Elite, Event,
  Collectibles); any other key is appended after them.
- Items inside a tab are sorted by localized name.
- Names: `loca.GetText("LAB", tab)` for tabs, `loca.GetText("RES", name)` for items.

The copy in the local clone (`:339-385`) is older: it sorts the tab names. Steward uses the upstream
order above.

The in-game storehouse also shows non-tradable items (Star Dust, Star Shards, CrystalShard, Adventure
Tale, Manuscript, Tome, Codex, Star Coins), so a storehouse view must not apply the tradable filter.

Event items: `requiredEventName_string` can hold a comma list (GuildFestCommendation:
`GuildFest_Content,GuildFest_Shop,Anniversary2018plus_Content`), so a live check splits it.
`game.gi.mEventManager.isEventStarted(name)` agreed with `GetActiveEventNames()` for every event
item. Six group `''` collectibles also carry an event (Christmas and Easter_Old items).

## Collectibles and the mayor's house

The mayor's house card is `S.core.resources.uncategorized()` (category `''`, amount above 0).
Collectibles are items with group `''` or `'Collectibles'`. The home dump: every held Collectible
(17) is on the card, and the card also lists 9 held items the storehouse files in another tab:
GuildCoins, MapPart, Population (Basic), AdventureTale, Manuscript (Intermediate), Tome (Advanced),
Codex, StarCoin (Expert), HalloweenResource (Event). Category `''` is therefore not "not in the
storehouse"; the tab is the group. CrystalShard is group CL1 (Basic), not a stray tab.

## Caps

One warehouse cap, `game.getResources().GetWareHouseCapacity()`, applies to every tab; room is
cap - `GetResourceAmount(name)`. Home dump: cap 1 443 500, and AdventureTale (group CL2, category
`''`, not tradable) is held at exactly 1 443 500 with 2 000 029 more in the star, so the cap binds
category-less items too. Star Dust (`StarfallStarDust`) and Star Shards (`StarfallStarShards`), both
group CL1, have caps of their own. No per-item getter is known: the resources object is a sealed
AS3 class, so `for..in` lists none of its methods (only `GetPlayerID` was found by name).

## Icons

The host `utils.getImage(bitmapData, w, h)` builds a data-URI `<img>`. Bitmaps come from
`assets.GetResourceIcon(name)` (autoTSO) or `assets.GetBitmapData(name)`. Encoding is costly, so
cache per name and size, fill lazily and keep it off the tick refresh. Home dump: both
`assets.GetResourceIcon(name)` (an object with `.bitmapData`) and `assets.GetBitmapData(name)` returned
a real bitmap (25-30 px) for all 163 items.

## Gap in Steward

- `group_string` is not read in `src` yet.
- `S.core.resources.list()` keeps name and amount only.
- `buildStorehousePayload` and `docs/superpowers/ecoadvisor/` are not on main.
- The `src/core/resources.js` header says the storehouse does not show uncategorized items. That is
  wrong, because the storehouse has a Collectibles tab; it is fixed with the Economy work.

## Next steps

1. Settings > Diagnostics > Dump storehouse writes `steward/dumps/storehouse-<zone>-<ms>.json`
   with definitions, held and star rows, caps, icon sizes and the trader-vs-mayor differences
   (run at home on 2026-11-13; the facts above come from it).
2. A core tab reader derived from `group_string`: one ordered list of the seven tab keys, labels
   from loca, no English tier map.
3. The economic advisor is deferred.
