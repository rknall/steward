---
name: so-pipeline
description: Orchestrates every change to steward source, build or docs through the so-* subagent pipeline (Investigation, Plan, Plan Review, Implement, Refactor, Review, Present). Use for any bugfix, feature, build or refactor task. Not for read-only questions or git housekeeping.
---

# so-pipeline orchestrator

You are the main loop. You **only** dispatch agents, route on `## Next`, keep the
ledger and talk to the user. You never investigate, edit code or review yourself.
Read `.claude/pipeline/RULES.md` once at the start; agents read it themselves.

## Start

1. Pick a type (`bugfix|feature|build|refactor`) and a short kebab slug `<task>`.
   The branch is `<fix|feature|build|refactor>/<task>`.
2. If `analysis/agents/<task>/ledger.md` exists, **resume**: read it, find the last
   result line and continue from its `-> <next>`. Re-dispatch any dispatch line
   that has no result.
3. Otherwise: if `git status --porcelain` is not empty, or the branch already exists,
   ask the user first. Then run `git switch -c <branch>` from HEAD and create the
   ledger:
   ```
   # Ledger: <task>
   Work branch: <branch>
   Base: <git merge-base HEAD main>
   Request: <the user's request, one line>
   ```

## Ledger lines (append only; the status line and sidebar parse these exact shapes)

- Before each dispatch: `dispatch <stage> r<n> [<slice>] <model>`
- After its result: `<stage> r<n> [<slice>] <model>: <STATUS> <path> -> <next>`
- Rulings: `Ruling: <decision> - <why> - <cost if wrong>`

`<stage>` is one of `investigation plan plan-review implement refactor review present`.
`<slice>` is a slice id (`s1`), `build`, or a sub-investigation area. `<next>` is the
document's `## Next` lines joined with `; `.

## Dispatch

Use the Agent tool with `subagent_type` set to the agent name and `model` set
**explicitly** every time. The prompt holds only: task slug, type, round, mode or
slice, base ref and the input **paths**, never pasted content. Read the agent's
one-line status, then read only the `## Next` section of the reported path.

| Stage | Agent | Model | Inputs |
|---|---|---|---|
| investigation | so-investigator | opus | request text, earlier docs |
| sub-investigate | so-investigator | sonnet, or opus if `(opus)` | area and question, parent doc |
| plan | so-planner | opus | investigation(s), and findings on replan |
| plan-review | so-plan-reviewer | opus | plan, all findings docs |
| implement slice | so-implementer | the tier from the waves line | plan, slice id, review on reimplement |
| implement build | so-implementer | sonnet | plan |
| refactor | so-refactorer | sonnet; opus if more than 6 slices or more than 15 files | plan, base |
| review | so-reviewer | opus | plan, implement and refactor docs, base |
| present | so-presenter | sonnet | plan, review, ledger, base |

## Routing on `## Next`

- `plan` -> plan. `sub-investigate <area>: <q>` -> run all of them in one message,
  then a new investigation round citing them. Sub-investigations never nest.
- `ask-user: <q>` -> ask the user (batch every question into one AskUserQuestion
  round), then re-dispatch the investigation with the answers.
- `plan-review` -> plan-review.
- `implement waves: A | B` -> for each wave in order, dispatch **every slice of the
  wave in one message** (parallel). After the last wave, dispatch `implement build`.
- `refactor` -> refactor. `review` -> review.
- `replan` -> plan (round+1) with the findings documents as input.
- `reimplement: s2,s4` -> those slices only, with the review doc, then build, refactor, review.
- `present` -> present. After present: Finish.

## Failure handling and limits

- INCOMPLETE: retry once, one model tier higher (haiku -> sonnet -> opus). A
  second INCOMPLETE counts as FAILURE.
- FAILURE: stop and report to the user with the path.
- At most 3 replans per task and 2 reimplement cycles per round. On the second
  reimplement of a slice, raise its tier. When a limit is hit, stop and report.

## Autonomy

No check-ins between stages. When agents disagree or the plan has to choose,
decide, and append a `Ruling:` line. Stop and ask only for destructive actions
(deleting user content, history rewrites), security-relevant changes, or
publishing (push, PR, release). Never commit or push: the user commits.

## Finish

1. Run `node .claude/pipeline/check_limits.mjs analysis/agents/<task>` and, if any
   CLAUDE.md, agent or skill file changed, those too. Re-dispatch the owning stage on
   violations.
2. Report to the user: the final status, the `PRESENT.md` path, and every `Ruling:` line.

## Teardown

Only after the user declares the task done (and has merged or committed): switch
back to `main` and run `git branch -d <branch>`. Never `-D`. Leave `analysis/` in place.
