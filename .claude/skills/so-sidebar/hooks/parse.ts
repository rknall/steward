// Pure parsers for the sidebar. No `$`, so the tests can call them directly.

export type Numstat = { files: number; added: number; removed: number }

// `git diff --numstat` lines: `<added>\t<removed>\t<path>`; binary files show
// `-\t-\t<path>` and count as a file with no lines.
export function parseNumstat(text: string): Numstat {
  const out = { files: 0, added: 0, removed: 0 }
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t./.exec(line)
    if (!m) continue
    out.files += 1
    if (m[1] !== '-') out.added += Number(m[1])
    if (m[2] !== '-') out.removed += Number(m[2])
  }
  return out
}

export function countLines(text: string): number {
  return text.split(/\r?\n/).filter(line => line.trim() !== '').length
}

// The issue number a branch name carries, or null. Only a number that opens
// the name (after an optional `type/` prefix and `gh-`, `issue-` or `#`) and is
// followed by `-`, `_` or the end counts, so `feature/3d-view`, `build/v2` and
// topic names without numbers degrade to "no issue" instead of a wrong one.
export function issueFromBranch(branch: string | null | undefined): number | null {
  if (!branch) return null
  const m = /^(?:[a-z]+\/)?(?:gh-|issue-|#)?(\d{1,6})(?:[-_]|$)/i.exec(branch)
  return m ? Number(m[1]) : null
}

// `gh pr list --json number,state,title` output, first entry or null.
export function parsePrList(text: string): { number: number; state: string; title: string } | null {
  try {
    const list = JSON.parse(text)
    const first = Array.isArray(list) ? list[0] : null
    if (!first || typeof first.number !== 'number') return null
    return { number: first.number, state: String(first.state ?? ''), title: String(first.title ?? '') }
  } catch {
    return null
  }
}

export function bar(percent: number, cells = 8): string {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

export function pctColor(p: number): 'success' | 'warning' | 'error' {
  return p < 50 ? 'success' : p < 80 ? 'warning' : 'error'
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
