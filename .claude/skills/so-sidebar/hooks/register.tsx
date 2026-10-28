import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, DiffStat, IssueInfo, PipelineInfo, UsageInfo } from '../types'
import {
  bar,
  countLines,
  issueFromBranch,
  parseNumstat,
  parsePrList,
  pctColor,
  sameValue,
} from './parse'

const PANE = 'steward'
const TITLE = 'steward'
const BASE = 'main'

const DIFF_MS = 15_000
const PIPELINE_MS = 5_000
const AGENTS_MS = 3_000
const PR_MS = 5 * 60_000

// Bump a shape tag when that value's fields change: a reload keeps what the
// earlier code stored, and the tag makes the new code read it as the initial.
const diff = atom({ plugin: 'so-sidebar', key: 'diff' } as const,
  { branch: null, files: 0, added: 0, removed: 0, untracked: 0 } as DiffStat, { shape: 'diff-1' })
const issue = atom({ plugin: 'so-sidebar', key: 'issue' } as const,
  { branch: null, issue: null, pr: null } as IssueInfo, { shape: 'issue-1' })
const pipeline = atom({ plugin: 'so-sidebar', key: 'pipeline' } as const,
  { task: null } as PipelineInfo, { shape: 'pipeline-1' })
const agents = atom({ plugin: 'so-sidebar', key: 'agents' } as const,
  [] as AgentRow[], { shape: 'agents-1' })
const usage = atom({ plugin: 'so-sidebar', key: 'usage' } as const,
  { model: null, ctx: null, fiveHour: null, sevenDay: null } as UsageInfo, { shape: 'usage-1' })

type $ = EngineInterface

// Module variables start over on a reload; session.start runs again and resets them.
const session = { cwd: '', lastBranch: undefined as string | null | undefined, lastPrAt: 0 }

// Every refresh writes its atom only when the value changed (sameValue), so a
// drawing re-runs only on a real change.

async function run($: $, cwd: string, argv: string[], timeoutMs = 15_000): Promise<string | null> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}

async function refreshDiff($: $, cwd: string): Promise<string | null> {
  const branch = (await run($, cwd, ['git', 'branch', '--show-current']))?.trim() || null
  const base = (await run($, cwd, ['git', 'merge-base', 'HEAD', BASE]))?.trim()
  // Without a merge base (no `main` locally) diff against HEAD: the working tree alone.
  const numstat = parseNumstat((await run($, cwd, ['git', 'diff', '--numstat', base || 'HEAD'])) ?? '')
  const untracked = countLines((await run($, cwd, ['git', 'ls-files', '--others', '--exclude-standard'])) ?? '')
  const nextDiff: DiffStat = { branch, ...numstat, untracked }
  if (!sameValue(await read($, diff), nextDiff)) await update($, diff, () => nextDiff)
  return branch
}

async function refreshIssue($: $, cwd: string, branch: string | null): Promise<void> {
  let pr: IssueInfo['pr'] = null
  if (branch && branch !== BASE) {
    const out = await run($, cwd, ['gh', 'pr', 'list', '--head', branch, '--state', 'all',
      '--limit', '1', '--json', 'number,state,title'], 20_000)
    pr = out ? parsePrList(out) : null
  }
  const nextIssue: IssueInfo = { branch, issue: issueFromBranch(branch), pr }
  if (!sameValue(await read($, issue), nextIssue)) await update($, issue, () => nextIssue)
}

async function refreshPipeline($: $, cwd: string): Promise<void> {
  // status.mjs is local-only; a clone without it shows no pipeline task.
  const out = await run($, cwd, ['node', `${cwd}/.claude/pipeline/status.mjs`, '--json', cwd])
  let info: PipelineInfo = { task: null }
  try {
    if (out) {
      const j = JSON.parse(out)
      info = {
        task: j.task ?? null, percent: j.percent, detail: j.detail,
        running: j.running, failed: j.failed, finished: j.finished,
      }
    }
  } catch { /* keep "no task" */ }
  if (!sameValue(await read($, pipeline), info)) await update($, pipeline, () => info)
}

async function refreshAgents($: $): Promise<void> {
  let rows: AgentRow[] = []
  try {
    rows = (await $.agent.list())
      .filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
      .map(a => ({ id: a.id, type: a.type, description: a.description, status: a.status }))
  } catch { /* none */ }
  if (!sameValue(await read($, agents), rows)) await update($, agents, () => rows)
}

async function refreshUsage($: $): Promise<void> {
  try {
    const [u, model] = await Promise.all([$.session.usage(), $.session.model()])
    const limit = (kind: string) => u.rateLimits.find(r => r.kind === kind)?.percentUsed ?? null
      const nextUsage: UsageInfo = {
      model: model.replace(/^claude-/, ''),
      ctx: u.context.percent ?? null,
      fiveHour: limit('five_hour'),
      sevenDay: limit('seven_day'),
    }
    if (!sameValue(await read($, usage), nextUsage)) await update($, usage, () => nextUsage)
  } catch { /* leave as is */ }
}

async function openPane($: $) {
  return $.ui.open({ id: PANE, title: TITLE, columns: 30, rows: 3 })
}

async function tickDiff($: $, forcePr = false) {
  const branch = await refreshDiff($, session.cwd)
  const now = await $.clock.now()
  // gh is a network call: only on branch change, every 5 minutes, or on /so.
  if (forcePr || branch !== session.lastBranch || now - session.lastPrAt >= PR_MS) {
    session.lastBranch = branch
    session.lastPrAt = now
    await refreshIssue($, session.cwd, branch)
  }
}

async function refreshAll($: $, forcePr = false) {
  await Promise.all([tickDiff($, forcePr), refreshPipeline($, session.cwd), refreshAgents($), refreshUsage($)])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    session.cwd = e.cwd
    session.lastBranch = undefined
    session.lastPrAt = 0
    await $.command.register({ name: 'so', description: 'Open and refresh the steward sidebar' })
    if (e.isInteractive) void openPane($)
    void refreshAll($)
    $.clock.every(DIFF_MS, () => void tickDiff($))
    $.clock.every(PIPELINE_MS, () => void refreshPipeline($, session.cwd))
    $.clock.every(AGENTS_MS, () => void refreshAgents($))
    return result
  })

  on('command.run', { command: 'so' }, async $ => {
    await refreshAll($, true)
    const opened = await openPane($)
    return { text: opened.isPlaced ? 'steward sidebar refreshed.' : `steward sidebar refreshed (not placed: ${opened.reason}).` }
  })

  // Reopen the pane on the person's prompt when it is not placed.
  on('prompt.submit', async ($, e, next) => {
    try {
      const panes = await $.ui.panes()
      if (!panes.some(p => p.id === PANE && p.isPlaced)) void openPane($)
    } catch { /* never hold up a prompt */ }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    void refreshUsage($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const d = await read($, diff)
    const i = await read($, issue)
    const p = await read($, pipeline)
    const a = await read($, agents)
    const u = await read($, usage)

    const diffLine = (
      <Box flexDirection="row" gap={1}>
        <Text color="claude" bold wrap="truncate-end">{d.branch ?? '(detached)'}</Text>
        <Text dimColor>{d.files}f</Text>
        <Text color="diffAdded">+{d.added}</Text>
        <Text color="diffRemoved">-{d.removed}</Text>
        {d.untracked > 0 && <Text color="warning">?{d.untracked}</Text>}
      </Box>
    )

    const pipeColor = p.failed ? 'error' : p.running ? 'warning' : 'success'
    const pipeLine = p.task
      ? (
        <Box flexDirection="row" gap={1}>
          <Text color={pipeColor}>{bar(p.percent ?? 0)}</Text>
          <Text>{p.percent ?? 0}%</Text>
          <Text dimColor wrap="truncate-end">{p.detail ?? ''}{p.running ? ` ⟳${p.running}` : ''}</Text>
        </Box>
      )
      : <Text dimColor>no pipeline task</Text>

    const pct = (label: string, v: number | null) =>
      v == null ? null : <Text color={pctColor(v)}>{label} {Math.round(v)}%</Text>
    const usageLine = (
      <Box flexDirection="row" gap={1}>
        {u.model && <Text dimColor wrap="truncate-end">{u.model}</Text>}
        {pct('ctx', u.ctx)}
        {pct('5h', u.fiveHour)}
        {pct('7d', u.sevenDay)}
      </Box>
    )

    if (e.props.placement === 'inline') {
      return (
        <Box flexDirection="column">
          {diffLine}
          {pipeLine}
          {usageLine}
        </Box>
      )
    }

    const issueText = [
      i.issue != null ? `issue #${i.issue}` : 'no issue',
      i.pr ? `PR #${i.pr.number} ${i.pr.state.toLowerCase()}` : 'no PR',
    ].join(' · ')

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {diffLine}
          <Text dimColor wrap="truncate-end">vs {BASE} · {issueText}</Text>
          {i.pr && <Text dimColor wrap="truncate-end">{i.pr.title}</Text>}
        </Box>
        <Box flexDirection="column">
          {p.task && <Text bold wrap="truncate-end">{p.task}</Text>}
          {pipeLine}
        </Box>
        <Box flexDirection="column">
          <Text bold>agents {a.length > 0 ? a.length : ''}</Text>
          {a.length === 0 && <Text dimColor>none running</Text>}
          {a.map(row => (
            <Text color={row.status === 'running' ? 'warning' : 'subtle'} wrap="truncate-end">
              {row.type}: {row.description}
            </Text>
          ))}
        </Box>
        {usageLine}
      </Box>
    )
  })
}
