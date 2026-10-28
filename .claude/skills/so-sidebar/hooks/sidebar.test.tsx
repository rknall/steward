import { expect, mock, test } from 'claude-code/testing'

import { bar, countLines, issueFromBranch, parseNumstat, parsePrList, pctColor } from './parse'

test('parseNumstat sums text files and counts binary ones', async () => {
  const out = parseNumstat('3\t1\tsrc/a.js\n10\t0\tsrc/b.js\n-\t-\tdocs/img.png\n\n')
  expect(out).toEqual({ files: 3, added: 13, removed: 1 })
  expect(parseNumstat('')).toEqual({ files: 0, added: 0, removed: 0 })
  expect(parseNumstat('warning: LF will be replaced\r\n1\t2\tx\r\n')).toEqual({ files: 1, added: 1, removed: 2 })
})

test('countLines ignores blank lines', async () => {
  expect(countLines('a\nb\n\n')).toBe(2)
  expect(countLines('')).toBe(0)
})

test('issueFromBranch reads leading numbers and degrades to null', async () => {
  expect(issueFromBranch('feature/123-mining-pause')).toBe(123)
  expect(issueFromBranch('fix/gh-42')).toBe(42)
  expect(issueFromBranch('issue-7_x')).toBe(7)
  expect(issueFromBranch('#99-thing')).toBe(99)
  expect(issueFromBranch('main')).toBe(null)
  expect(issueFromBranch('feature/mining-pause')).toBe(null)
  expect(issueFromBranch('feature/3d-view')).toBe(null)
    expect(issueFromBranch('build/v2-bundle')).toBe(null)
  expect(issueFromBranch('refactor/scheduler-p5')).toBe(null)
  expect(issueFromBranch(null)).toBe(null)
})

test('parsePrList takes the first PR or null', async () => {
  expect(parsePrList('[{"number":5,"state":"OPEN","title":"x"}]')).toEqual({ number: 5, state: 'OPEN', title: 'x' })
  expect(parsePrList('[]')).toBe(null)
  expect(parsePrList('not json')).toBe(null)
})

test('bar and pctColor', async () => {
  expect(bar(0)).toBe('░░░░░░░░')
  expect(bar(50)).toBe('████░░░░')
  expect(bar(100)).toBe('████████')
  expect(pctColor(10)).toBe('success')
  expect(pctColor(60)).toBe('warning')
  expect(pctColor(90)).toBe('error')
})

const PANE = {
  plugin: 'so-sidebar',
  component: 'Pane',
  requestId: 'steward',
  props: {
    title: 'steward',
    isFocused: false,
    bodyColumns: 30,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the pane draws defaults on every surface', async $ => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /no pipeline task/ }))?.text).toBe('no pipeline task')
    expect((await ui.find({ type: 'Text', text: /none running/ }))?.text).toBe('none running')
    await ui.unmount()
  }
})

test('session start fills the pane from git and the pipeline', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'so' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000, percent: 42 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv === 'git branch --show-current') return out('feature/12-pause\n')
    if (argv.startsWith('git merge-base')) return out('abc123\n')
    if (argv.startsWith('git diff --numstat')) return out('4\t2\tsrc/a.js\n')
    if (argv.startsWith('git ls-files')) return out('new.js\n')
    if (argv.startsWith('gh pr list')) return out('[{"number":34,"state":"OPEN","title":"Pause"}]')
    if (argv.startsWith('node ')) {
      return out('{"task":"pause","percent":43,"detail":"impl 1/3","running":1,"failed":false,"finished":false}')
    }
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({
    command: 'so', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 },
  })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /feature\/12-pause/ }))?.text).toBe('feature/12-pause')
    expect((await ui.find({ type: 'Text', text: /issue #12/ }))?.text).toBe('vs main · issue #12 · PR #34 open')
    expect((await ui.find({ type: 'Text', text: /impl 1\/3/ }))?.text).toBe('impl 1/3 ⟳1')
    expect((await ui.find({ type: 'Text', text: /ctx/ }))?.text).toBe('ctx 42%')
    await ui.unmount()
  }

  const inline = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline' } })
  expect((await inline.find({ type: 'Text', text: /\+4/ }))?.text).toBe('+4')
  expect(await inline.find({ type: 'Text', text: /agents/ })).toBeUndefined()
  await inline.unmount()
})
