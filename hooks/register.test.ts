import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parentDir, splitArgs, statusLine, transitionToast } from './lib/view'
import type { RunFile } from '../types'

const CWD = 'C:\\proj'

const sample = (over: Partial<RunFile> = {}): RunFile => ({
  id: 'ab12cd',
  session_id: 'lead',
  task: 'Add a --json flag to the export command',
  status: 'active',
  phase: 'build',
  tasks: [
    { id: 1, title: 'Parse the flag', status: 'done' },
    { id: 2, title: 'Emit JSON', status: 'todo' },
    { id: 3, title: 'Test it', status: 'blocked', note: 'no runner' },
  ],
  verify: { cycles: 0, max: 5, last: null },
  review: { rounds: 0, max: 2, last: null },
  pause_reason: null,
  stop_reason: null,
  updated_at: '2026-10-30T00:00:00.000Z',
  ...over,
})

const isRunFile = (path: string) => path.replace(/\\/g, '/').endsWith('/.cruise/run.json')

// Every noun the mod touches, answered from memory: the run file, the session, the CLI.
function world(on: On, { file = JSON.stringify(sample()) as string | null, sessionId = 'lead', cliStdout = 'cruise ab12cd · stopped · phase build' } = {}) {
  const files = { text: file }
  const status: Array<string | undefined> = []
  const toasts: string[] = []
  const ran: string[][] = []
  const registered: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('fs.exists', (_$, e) => ({ value: files.text !== null && isRunFile(e.path) }))
  on('fs.read', (_$, e) => (files.text !== null && isRunFile(e.path) ? { value: files.text } : { deny: `ENOENT ${e.path}` }))
  on('ui.status', (_$, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: cliStdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { files, status, toasts, ran, registered }
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

const helm = ($: Engine, args: string) => $.command.run({ command: 'helm', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

const PANE = {
  plugin: 'cruise',
  component: 'Pane',
  requestId: 'cruise',
  surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: { title: 'cruise', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

describe('helpers', () => {
  test('statusLine shows the phase, the task count, and the counters in play', async () => {
    expect(statusLine(sample())).toBe('build · tasks 1/3')
    expect(statusLine(sample({ phase: 'verify', verify: { cycles: 2, max: 5, last: 'fail' } }))).toBe('verify · tasks 1/3 · verify 2/5')
    expect(statusLine(sample({ status: 'paused', phase: 'review', verify: { cycles: 1, max: 5, last: 'pass' }, review: { rounds: 1, max: 2, last: 'fail' } }))).toBe('paused · review · tasks 1/3 · verify 1/5 · review 1/2')
  })

  test('transitionToast names what changed', async () => {
    expect(transitionToast(sample({ phase: 'verify' }))).toBe('phase verify')
    expect(transitionToast(sample({ status: 'paused', pause_reason: 'Postgres or SQLite?' }))).toBe('paused: Postgres or SQLite?')
    expect(transitionToast(sample({ status: 'done', phase: 'done' }))).toBe('run done')
  })

  test('parentDir walks both separators up to the root', async () => {
    expect(parentDir('C:\\proj\\src')).toBe('C:\\proj')
    expect(parentDir('C:\\proj')).toBe('C:\\')
    expect(parentDir('C:\\')).toBeUndefined()
    expect(parentDir('/home/u/proj')).toBe('/home/u')
    expect(parentDir('/home')).toBeUndefined()
  })

  test('splitArgs separates the subcommand from the rest of the line', async () => {
    expect(splitArgs('')).toEqual({ sub: undefined, rest: '' })
    expect(splitArgs('  pause  Which DB?  ')).toEqual({ sub: 'pause', rest: 'Which DB?' })
    expect(splitArgs('stop')).toEqual({ sub: 'stop', rest: '' })
  })
})

describe('the mod', () => {
  test('registers /helm and shows the run on the status line as it changes', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on)
    await start($)
    expect(w.registered).toEqual(['helm'])
    expect(w.status.at(-1)).toBe('build · tasks 1/3')
    expect(w.toasts).toEqual([])
    w.files.text = JSON.stringify(sample({ phase: 'verify', verify: { cycles: 1, max: 5, last: 'fail' } }))
    await clock.advance(3000)
    expect(w.status.at(-1)).toBe('verify · tasks 1/3 · verify 1/5')
    expect(w.toasts).toEqual(['cruise: phase verify'])
    w.files.text = JSON.stringify(sample({ status: 'paused', phase: 'verify', pause_reason: 'Which DB?' }))
    await clock.advance(3000)
    expect(w.status.at(-1)).toBe('paused · verify · tasks 1/3 · verify 0/5')
    expect(w.toasts.at(-1)).toBe('cruise: paused: Which DB?')
    w.files.text = JSON.stringify(sample({ status: 'done', phase: 'done' }))
    await clock.advance(3000)
    expect(w.status.at(-1)).toBeUndefined()
    expect(w.toasts.at(-1)).toBe('cruise: run done')
  })

  test('ignores a run bound to another session and clears when the file goes away', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { sessionId: 'someone-else' })
    await start($)
    expect(w.status).toEqual([])
    w.files.text = JSON.stringify(sample({ session_id: null }))
    await clock.advance(3000)
    expect(w.status.at(-1)).toBe('build · tasks 1/3')
    w.files.text = null
    await clock.advance(3000)
    expect(w.status.at(-1)).toBeUndefined()
  })

  test('/helm stop, pause, and resume run the CLI, and resume binds this session', async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await start($)
    const stop = await helm($, 'stop the user changed their mind')
    expect(stop.text).toContain('stopped')
    expect(w.ran.at(-1)?.slice(0, 2)[0]).toBe('node')
    expect(w.ran.at(-1)?.[1]?.replace(/\\/g, '/')).toMatch(/\/bin\/cruise$/)
    expect(w.ran.at(-1)?.slice(2)).toEqual(['stop', '--reason', 'the user changed their mind'])
    const pause = await helm($, 'pause')
    expect(pause.text).toContain('/helm pause <question')
    await helm($, 'pause Which DB?')
    expect(w.ran.at(-1)?.slice(2)).toEqual(['pause', 'Which DB?'])
    const resume = await helm($, 'resume')
    expect(resume.text).toContain('Send a message')
    expect(w.ran.at(-1)?.slice(2)).toEqual(['resume', '--session', 'lead'])
    const help = await helm($, '')
    expect(help.text).toContain('/helm status')
    const unknown = await helm($, 'dance')
    expect(unknown.text).toContain("unknown subcommand 'dance'")
  })

  test('the pane lists the tasks, the counters, and a stop button while the run is open', async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await start($)
    await helm($, 'pane')
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Text', text: /Emit JSON/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Test it \(no runner\)/ })).toBeDefined()
    expect(await ui.find({ key: 'stop' })).toBeDefined()
    expect(await ui.find({ key: 'resume' })).toBeUndefined()
    await ui.press({ key: 'stop' })
    expect(w.ran.at(-1)?.slice(2)).toEqual(['stop', '--reason', 'stopped from the pane'])
    await ui.unmount()
  })

  test('the pane offers resume while the run is paused and explains an empty project', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { file: JSON.stringify(sample({ status: 'paused', pause_reason: 'Which DB?' })) })
    await start($)
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Text', text: /paused: Which DB\?/ })).toBeDefined()
    expect(await ui.find({ key: 'resume' })).toBeDefined()
    await ui.unmount()
    w.files.text = null
    await clock.advance(3000)
    const empty = await $.ui.mount(PANE)
    expect(await empty.find({ type: 'Text', text: /No cruise run in this project/ })).toBeDefined()
    await empty.unmount()
  })
})
