# Steward

[![CI](https://github.com/rknall/steward/actions/workflows/ci.yml/badge.svg)](https://github.com/rknall/steward/actions/workflows/ci.yml)
[![Release](https://github.com/rknall/steward/actions/workflows/release.yml/badge.svg)](https://github.com/rknall/steward/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/rknall/steward?sort=semver)](https://github.com/rknall/steward/releases/latest)
[![License](https://img.shields.io/github/license/rknall/steward)](LICENSE)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/rknall)](https://github.com/sponsors/rknall)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-rpk79-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/rpk79)

Modular automation framework for [The Settlers Online](https://www.thesettlersonline.com/), shipped as one userscript for the Adobe AIR 32 TSO client. It is a clean-sheet replacement for [autoTSO](https://github.com/adly98/autoTSO) with the same runtime constraints, split into three layers:

- **Kernel**: priority and cooperative round-robin task scheduler, action queue, settings store, logger and the in-game UI shell.
- **Core library**: general TSO operations (zones, buildings, specialists, deposits, packets, locale, events) shared by every module.
- **Modules**: opt-in automation. Each module declares `isReady` and `plan`, and the kernel runs it.

Releases are built and published by the Release workflow; the badge above shows the latest one.

## Thanks

Steward stands on the work of others, and a big thank you goes to them:

- [fedorovvl](https://github.com/fedorovvl), creator of the community [The Settlers Online client](https://github.com/fedorovvl/tso_client) that steward runs in.
- [adly98](https://github.com/adly98), creator of the community project [autoTSO](https://github.com/adly98/autoTSO), which steward is modelled after.
- Blue Byte and ClipSoft, for creating The Settlers Online and keeping such a great game running.

## Modules

| Module | What it does |
|---|---|
| adventures | Runs adventure templates and scenario files as persisted series of maps, from home back to home, with pause and resume. |
| collect | Clicks map pickups on the home island and the quest objects open quests wait for on adventures. |
| diagnostics | Read-only probes on the Settings screen that dump kernel, host and specialist state to the log. |
| eventcalc | Read-only event calculator: explorer event-item estimate and refill calculator for event fields. |
| explorers | Sends idle explorers to the task chosen by the precedence chain in `docs/CORE_USAGE.md`. |
| geologists | Sends idle geologists to deposit-search tasks, up to the wanted number of deposits per type. |
| mining | Builds, upgrades, pauses and buffs the mines and masons on the home island. |
| rebuild | Rebuilds exhausted wells and fields with the chosen well and field type, one per free build-queue slot. |
| updater | Checks GitHub Releases, installs a chosen release and steps down to an older one. |

## Install

The first install is manual.

1. Download `user_steward.js` from the [latest release](https://github.com/rknall/steward/releases/latest).
2. Put it in the TSO client's `userscripts/` folder.
3. Reload scripts from the client menu or restart the client. The `~Steward~` menu appears in game.

## Updates

After the first install Steward updates itself. The controls are in the `~Steward~ > Updates` menu and in the Updates section of the Settings screen.

- **Check:** on start (on by default, at most once per hour) Steward looks for a newer release and posts a notice. Nothing installs without a confirm, unless the opt-in automatic install is on. Automatic install only replaces a plain release with a newer plain release.
- **Install:** the bundle is downloaded from the `rknall/steward` release asset only. Its size, the SHA-256 digest GitHub publishes and the version banner in the bundle are verified. The current profile's settings are backed up to `steward/backups/` (20 kept per profile), the old bundle is kept as `userscripts/user_steward.js.backup`, then the new bundle is written and scripts are reloaded.
- **Step down:** pick an older release from the version list. The settings backup taken when that version was left is restored; without an exact match the newest backup from an older version is used, and with none, settings stay as they are. Releases older than 0.12.0 have no updater, so stepping below it removes the updater. They are listed only when the `showOldReleases` setting is on (off by default).
- **Test releases** appear with the `showPrereleases` setting; a running test (prerelease) build always sees them.
- **Development builds** (git describe ahead of a tag, or a dirty tree) are shown as such and are alerted to newer releases like any build, but are never installed automatically. An unversioned `0.0.0` / `0.0.0-git` build is never offered an update.

## Develop

```bash
git clone https://github.com/rknall/steward.git
cd steward
npm ci                 # installs eslint, terser and the husky pre-commit hook
npm run lint           # AIR-compatible linting over src/
npm test               # zero-dependency test runner over tests/
npm run build          # produces build/user_steward.js
npm run release        # dry run: next version and release notes, changes nothing
```

The bundle is a single concatenated script. Source lives under `src/` split into kernel, core and modules, and the build concatenates it into one file because Adobe AIR has no module system. See [`docs/MODULE_GUIDE.md`](docs/MODULE_GUIDE.md) for how to add a module.

Steward targets Adobe AIR 32, which has an outdated JavaScript engine: no `let`/`const`, arrow functions, template literals, `Promise`, `Set`/`Map`, `.includes()`/`.startsWith()`/`.find()`, destructuring or spread in `src/`. ESLint enforces this in CI. Full reference: [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md).

The version comes from `git describe`; `package.json` holds the placeholder `0.0.0-git`. A `Bump: minor` or `Bump: major` trailer in a commit to main drives a CI release. See [`docs/RELEASING.md`](docs/RELEASING.md).

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/README.md`](docs/README.md) | Index of the documentation and a suggested reading order. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Kernel / core / module layering, lifecycle, bundle order. |
| [`docs/SCHEDULER.md`](docs/SCHEDULER.md) | Priority tiers, cooperative round-robin, tick model, queue contract. |
| [`docs/MODULE_GUIDE.md`](docs/MODULE_GUIDE.md) | Authoring a module from scratch. |
| [`docs/CORE_USAGE.md`](docs/CORE_USAGE.md) | Rules for calling `Steward.core.*`. |
| [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) | What Adobe AIR 32 supports and what it does not. |
| [`docs/TSO_API.md`](docs/TSO_API.md) | TSO client globals (`game`, `swmmo`, `loca`, `air.*`). |
| [`docs/LOGGING.md`](docs/LOGGING.md) | Category logger and file rotation. |
| [`docs/SCENARIOS.md`](docs/SCENARIOS.md) | Scenario runs: file format and known limits. |
| [`docs/WAVES.md`](docs/WAVES.md) | Wave runs: attack and buff lines within a wave. |
| [`docs/RELEASING.md`](docs/RELEASING.md) | Version sources, the `Bump:` trailer, CI and manual releases. |
| [`docs/analysis/HOST_INTEGRATION.md`](docs/analysis/HOST_INTEGRATION.md) | How the AIR client loads userscripts and which globals it provides. |
| [`docs/analysis/PLAN.md`](docs/analysis/PLAN.md) | The original v0.1 plan (historical). |

## Support

Steward is free. If it saves you time, you can support it through [GitHub Sponsors](https://github.com/sponsors/rknall) or [Ko-fi](https://ko-fi.com/rpk79).

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE).
