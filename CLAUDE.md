# steward

Modular automation framework for The Settlers Online: a scheduling kernel, a
core TSO library and pluggable modules, shipped as one userscript bundle for the
prebuilt **Adobe AIR 32** TSO client. Plain JavaScript, with no TypeScript and no
transpiler.

## Commands

- `npm ci` first in a fresh clone (`node_modules/` is not committed).
- `npm run build` produces `build/user_steward.js`, the only artefact, in the
  only build directory.
- `npm test` runs the zero-dependency runner over `tests/<area>/*.test.js`.
- `npm run lint` runs ESLint with the AIR ruleset (`scripts/lint-air.js`).
  `npm run lint:fix` fixes what it can.
- CI runs lint, build and test on every push and PR and must end green. Locally,
  never run lint (CI and the husky pre-commit hook on staged `src/**/*.js` cover
  it) and run only the test files you added or changed (`node tests/runner.js
  <file>`); CI runs the rest.
- Build locally only when the user needs a bundle before CI finishes. Every PR's
  CI attaches the bundle as an artifact, linked from a sticky PR comment with its
  version (see [docs/RELEASING.md](docs/RELEASING.md), "PR builds").

## Hard rule: `src/` is ES5-era, AIR-safe JavaScript

`'use strict'`, `var`, `function` expressions. **Never** use arrow functions,
`let`/`const`, template literals, ES modules, `Promise`, `Set`/`Map`,
`.includes()`/`.startsWith()`/`.find()`, destructuring or spread. Details:
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). `scripts/` and `tests/` are
CommonJS Node. Follow each file's existing style.

Never create a second source of truth. Derive from the existing list, enum
(`src/kernel/15_enums.js`), constant or function.

## Running it

There is no host build. Copy `build/user_steward.js` into the TSO client's
`userscripts/` directory (`C:\Users\Roland\AppData\Local\tso_portable\`) and
reload scripts from the client menu. Runtime output goes to
`tso_portable/steward/` (`logs/console.log`, `dumps/`).

## Where to read

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): kernel / core / module layers, lifecycle, bundle order.
- [docs/MODULE_GUIDE.md](docs/MODULE_GUIDE.md): authoring a module.
- [docs/CORE_USAGE.md](docs/CORE_USAGE.md): rules for calling `Steward.core.*`.
- [docs/SCHEDULER.md](docs/SCHEDULER.md): priority tiers, tick and queue contract.
- [docs/analysis/HOST_INTEGRATION.md](docs/analysis/HOST_INTEGRATION.md): how the AIR client loads userscripts and which globals it provides.
- [docs/SCENARIOS.md](docs/SCENARIOS.md): scenario runs, file format, known limits.
- [docs/TSO_API.md](docs/TSO_API.md), [docs/LOGGING.md](docs/LOGGING.md).

## Workflow

Every change to source, build or docs goes through the **so-pipeline** skill
(`.claude/skills/so-pipeline/`) automatically: it dispatches the `so-*` agents
and keeps a ledger under the git-excluded `analysis/`. Answer read-only questions
and git housekeeping directly, without the pipeline.
Human-facing mockups and explainers are review sets built from
`.claude/skills/so-pipeline/review-shell/` (see its README). A considerable UI/UX
change needs a mockup set approved by the user before any UI is implemented. The
orchestrator shows sets in the user's Chrome through `node scripts/review-set.js
serve`, and the page's Submit writes the verdicts next to the set (Copy feedback
pasted into the chat is the fallback; a published private link is optional).

Agents commit and push testable work at once as a Draft PR against main, never
leaving it only local: as soon as there is code for the user to test, commit it
on the task branch, push it and open (or update) the Draft PR, whose CI comment
carries the bundle. The user marks it ready and merges. Commit subjects are
short and topic-prefixed (`mining: ...`) with no `; v0.x.y` suffix. Trailers, in
order: `Fixes #N`/`Refs #N`, an optional `Bump:` line, then `Assisted-by: Claude`.
main is protected: every change lands through a PR, squash-merged. Bring a
branch up to date by rebasing on `origin/main` (then force-push), never by
merging main into it.

Versioning: tasks never edit `package.json` `version` or `package-lock.json`.
The build versions itself from `git describe` (`0.10.14-3-gabc1234[-dirty]`),
and `STEWARD_VERSION` overrides it. A new module or a massive redesign puts a
`Bump: minor` line in the commit body (`Bump: major` is rare); anything else
carries no Bump line, which means patch. A merge to main with a pending minor or
major bump is released by CI, with notes built from the commit subjects. Patch
releases are manual. See [docs/RELEASING.md](docs/RELEASING.md).

Line limits on agent-facing markdown (this file at most 200 lines, agents 100,
SKILL.md 160, handoff/todo notes 70) are enforced by a local hook; see
`.claude/pipeline/RULES.md` when present.
