# Steward Documentation

Start here if you're new to the codebase.

## Architecture and design

| Doc | What it covers |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Kernel / core / module layering. Lifecycle. Bundle order. |
| [`SCHEDULER.md`](SCHEDULER.md) | Priority tiers, cooperative round-robin, tick model, queue contract. |
| [`MODULE_GUIDE.md`](MODULE_GUIDE.md) | How to author a Steward module from scratch. |
| [`CORE_USAGE.md`](CORE_USAGE.md) | Rules every module author follows when calling `Steward.core.*`. |

## Runtime reference

| Doc | What it covers |
|---|---|
| [`COMPATIBILITY.md`](COMPATIBILITY.md) | Adobe AIR 32 JavaScript constraints. What's allowed, what crashes. |
| [`TSO_API.md`](TSO_API.md) | TSO client globals: `game`, `swmmo`, `loca`, `air.*`, host UI helpers. |
| [`LOGGING.md`](LOGGING.md) | `Steward.kernel.log` contract, file rotation, configuration. |

## Planning

| Doc | What it covers |
|---|---|
| [`analysis/PLAN.md`](analysis/PLAN.md) | Architectural plan for v0.1. Phasing P0 → P3, file scopes, decisions and their rationale. |

## Reading order

If you've never seen Steward before:

1. [`../README.md`](../README.md) — what it is, install, dev quickstart.
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — the three-layer model.
3. [`SCHEDULER.md`](SCHEDULER.md) — how modules get to run.
4. [`MODULE_GUIDE.md`](MODULE_GUIDE.md) — write your first module.

If you're modifying core:

1. [`CORE_USAGE.md`](CORE_USAGE.md) — the rules you'll be enforcing.
2. [`TSO_API.md`](TSO_API.md) — what core sits on top of.
3. [`COMPATIBILITY.md`](COMPATIBILITY.md) — what you can't do in the source.
