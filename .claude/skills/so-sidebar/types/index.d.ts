export type DiffStat = {
  branch: string | null
  files: number
  added: number
  removed: number
  untracked: number
}

export type IssueInfo = {
  branch: string | null
  issue: number | null
  pr: { number: number; state: string; title: string } | null
}

// Mirrors `status.mjs --json`; `task` is null when no ledger matches the branch.
export type PipelineInfo = {
  task: string | null
  percent?: number
  detail?: string
  running?: number
  failed?: boolean
  finished?: boolean
}

export type AgentRow = { id: string; type: string; description: string; status: string }

export type UsageInfo = {
  model: string | null
  ctx: number | null
  fiveHour: number | null
  sevenDay: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'so-sidebar': {
      diff: Shaped<DiffStat>
      issue: Shaped<IssueInfo>
      pipeline: Shaped<PipelineInfo>
      agents: Shaped<AgentRow[]>
      usage: Shaped<UsageInfo>
    }
  }
}
