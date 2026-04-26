# Steward

Modular automation framework for [The Settlers Online](https://www.thesettlersonline.com/) — a scheduling kernel and general TSO library that hosts pluggable automation modules. Runs as a userscript inside the Adobe AIR TSO client.

> **Status:** pre-alpha. The repository is being scaffolded. There is no usable bundle yet. See [`docs/analysis/PLAN.md`](docs/analysis/PLAN.md) for the v0.1 roadmap.

Steward is a clean-sheet replacement for [autoTSO](https://github.com/rknall/autoTSO). The runtime constraints are identical (Adobe AIR 32 / ES5+), but the monolith is broken into:

- **Kernel** — priority + cooperative round-robin task scheduler, action queue, settings store, logger, in-game UI shell.
- **Core library** — general TSO operations: zones, buildings, specialists, deposits, packets, locale, events. Shared by every module.
- **Modules** — opt-in automation (collect, mail, adventures, …). Each module declares `isReady`/`plan` and the kernel runs it.

## Install (end users)

> Not yet released. The instructions below describe the target installation flow once v0.1 ships.

1. Download `user_steward.js` from the latest [GitHub Release](https://github.com/rknall/steward/releases).
2. Drop it into your TSO client's `userscripts/` folder.
3. Restart the client. The **Steward** menu entry will appear in-game.

Steward is safe to run alongside autoTSO — the namespaces don't collide.

## Develop

```bash
git clone https://github.com/rknall/steward.git
cd steward
npm install            # installs eslint + husky pre-commit hook
npm run lint           # AIR-compatible linting over src/
npm run build          # produces build/user_steward.js
```

The bundle is a single concatenated script. During development, source lives under `src/` split into kernel / core / modules; the build step concatenates everything into one file because Adobe AIR has no module system. See [`docs/MODULE_GUIDE.md`](docs/MODULE_GUIDE.md) for how to add a module.

### Adobe AIR JavaScript constraints

Steward targets Adobe AIR 32, which has an outdated JavaScript engine. **No `let`, no arrow functions, no template literals, no `Promise`, no `Set`/`Map`, no `.includes()`/`.startsWith()`/`.find()`, no destructuring, no spread.** ESLint enforces this in CI; violations fail the build. Full reference: [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md).

### Documentation

| Doc | What it covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Kernel / core / module model, lifecycle, tick. |
| [`docs/SCHEDULER.md`](docs/SCHEDULER.md) | Priority tiers and the cooperative round-robin contract. |
| [`docs/MODULE_GUIDE.md`](docs/MODULE_GUIDE.md) | Authoring a module from scratch. |
| [`docs/CORE_USAGE.md`](docs/CORE_USAGE.md) | Rules for using the core library safely. |
| [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) | What Adobe AIR 32 supports and what it doesn't. |
| [`docs/TSO_API.md`](docs/TSO_API.md) | TSO client globals (`game`, `swmmo`, `loca`, `air.*`). |
| [`docs/LOGGING.md`](docs/LOGGING.md) | Category logger and file rotation. |
| [`docs/analysis/PLAN.md`](docs/analysis/PLAN.md) | Architectural plan for v0.1. |

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE).
