import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunView } from '../types'
import { OPEN, ago, doneCount, parentDir, parseRun, splitArgs, statusColor, statusLine, taskColor, taskGlyph, transitionKey, transitionToast } from './lib/view'

const PANE = 'cruise'
const COMMAND = 'helm'
const POLL_INTERVAL_MS = 3000
const STATE_DIR = '.cruise'
const MAX_DEPTH = 12
const PANE_COLUMNS = 64

const runView = atom({ plugin: 'cruise', key: 'run' } as const, null as RunView | null)

const HELP = [
  '/helm status             where the run is and what comes next',
  '/helm pane               open the run pane',
  '/helm pause <question>   pause the run with a question for you to answer',
  '/helm resume             continue a paused or stalled run in this session',
  '/helm stop [reason]      stop the run after the current turn (Esc interrupts the turn)',
  '/helm log                the last run events',
].join('\n')

// Module state: the session this mod runs in and the run file it follows.
const state = {
  sessionId: null as string | null,
  cwd: null as string | null,
  runFile: null as string | null,
  // id, status, and phase of the run last shown, so a change becomes a toast.
  seen: null as string | null,
  polling: false,
}

type CliResult = { exitCode: number; stdout: string; error?: { code: string; message: string; hint?: string } }

const parseError = (text: string): CliResult['error'] => {
  try {
    return (JSON.parse(text) as { error?: CliResult['error'] }).error
  } catch {
    return undefined
  }
}

async function cli($: EngineInterface, args: string[], timeoutMs = 20_000): Promise<CliResult> {
  const run = await $.process.run(['node', `${$.plugin.root}/bin/cruise`, ...args], { timeoutMs })
  return { exitCode: run.exitCode, stdout: run.stdout.trim(), error: parseError(run.stderr) }
}

const reply = (r: CliResult, fallback: string) => (r.exitCode === 0 ? r.stdout || fallback : `cruise: ${r.error?.message ?? r.stdout ?? 'the command failed'}${r.error?.hint ? ` (${r.error.hint})` : ''}`)

// The CLI resolves the run as the nearest ancestor of the working directory that holds one.
async function locateRunFile($: EngineInterface): Promise<string | null> {
  if (state.runFile && (await $.fs.exists(state.runFile))) return state.runFile
  let dir: string | undefined = state.cwd ?? (await $.session.cwd())
  for (let depth = 0; dir && depth < MAX_DEPTH; depth++) {
    const candidate = `${dir.replace(/[\\/]+$/, '')}/${STATE_DIR}/run.json`
    if (await $.fs.exists(candidate)) {
      state.runFile = candidate
      return candidate
    }
    dir = parentDir(dir)
  }
  state.runFile = null
  return null
}

// A run bound to another session belongs to that session's mod; an unbound run is shown.
const mine = (sessionId: string | null) => !sessionId || !state.sessionId || sessionId === state.sessionId

async function poll($: EngineInterface): Promise<void> {
  if (state.polling) return
  state.polling = true
  try {
    const path = await locateRunFile($)
    const run = path ? parseRun(await $.fs.read(path)) : null
    if (!run || !path || !mine(run.session_id)) {
      if (state.seen !== null) {
        state.seen = null
        $.ui.status(undefined)
        await update($, runView, () => null)
      }
      return
    }
    const key = transitionKey(run)
    if (state.seen !== null && state.seen !== key) $.ui.toast(`cruise: ${transitionToast(run)}`)
    state.seen = key
    $.ui.status(OPEN.has(run.status) ? statusLine(run) : undefined)
    const now = await $.clock.now()
    await update($, runView, () => ({ ...run, path, polledAt: now }))
  } finally {
    state.polling = false
  }
}

const resumeArgs = () => (state.sessionId ? ['resume', '--session', state.sessionId] : ['resume'])

async function runAndRefresh($: EngineInterface, args: string[], fallback: string): Promise<string> {
  const r = await cli($, args)
  void poll($).catch(() => undefined)
  return reply(r, fallback)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    state.sessionId = await $.session.id()
    state.cwd = e.cwd
    $.clock.every(POLL_INTERVAL_MS, () => void poll($).catch(() => undefined))
    await poll($).catch(() => undefined)
    // The plugin's skill owns /cruise:cruise, and the engine refuses a command that shadows
    // the plugin's own namespace, hence a second word for the person's command.
    try {
      await $.command.register({
        name: COMMAND,
        description: 'cruise run: status, pane, pause, resume, stop, log',
        argumentHint: 'status | pane | pause <question> | resume | stop [reason] | log',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`cruise: /${COMMAND} not registered: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const { sub, rest } = splitArgs(e.args)
    switch (sub) {
      case undefined:
      case 'help':
        return { text: HELP }
      case 'status':
        return { text: await runAndRefresh($, ['status'], 'no output') }
      case 'pane': {
        const opened = await $.ui.open({ id: PANE, title: 'cruise', focus: true, closeOnEscape: true, columns: PANE_COLUMNS })
        void poll($).catch(() => undefined)
        return { text: opened.isPlaced ? 'cruise pane opened.' : `cruise pane is waiting: ${opened.reason}` }
      }
      case 'pause':
        if (!rest) return { text: 'cruise: /helm pause <question for you to answer>' }
        return { text: await runAndRefresh($, ['pause', rest], 'paused') }
      case 'resume':
        return { text: `${await runAndRefresh($, resumeArgs(), 'resumed')}\nSend a message (even "go") so the model picks the run back up.` }
      case 'stop':
        return { text: `${await runAndRefresh($, rest ? ['stop', '--reason', rest] : ['stop'], 'stopped')}\nThe model stops at the end of this turn; press Esc to interrupt it now.` }
      case 'log':
        return { text: await runAndRefresh($, ['log', '--n', '15'], '(empty)') }
      default:
        return { text: `cruise: unknown subcommand '${sub}'.\n${HELP}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const run = await read($, runView)
    if (!run) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No cruise run in this project. Start one with /cruise &lt;what to build&gt;.</Text>
        </Box>
      )
    }
    const now = await $.clock.now()
    const open = OPEN.has(run.status)
    const press = (args: string[]) => () => void cli($, args).then(() => poll($)).catch(() => undefined)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
            <Box flexShrink={0}>
              <Text bold>cruise {run.id}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={statusColor(run.status)}>{run.status}</Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              · {run.phase}
            </Text>
          </Box>
          {e.props.bodyColumns >= 48 && (
            <Box flexShrink={0}>
              <Text dimColor>updated {ago(now, run.polledAt)} ago</Text>
            </Box>
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {run.task}
          </Text>
        </Box>
        {run.tasks.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>No tasks yet: the plan is being written.</Text>
          </Box>
        )}
        {run.tasks.map((t, i) => (
          <Box key={`task-${t.id}`} flexDirection="row" gap={1} marginTop={i === 0 ? 1 : 0}>
            <Text color={taskColor(t.status)}>{taskGlyph(t.status)}</Text>
            <Text dimColor>T{t.id}</Text>
            <Text wrap="truncate-end" dimColor={t.status === 'skipped'}>
              {t.title}
              {t.note ? ` (${t.note})` : ''}
            </Text>
          </Box>
        ))}
        <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
          <Text dimColor>tasks</Text>
          <Text>
            {doneCount(run)}/{run.tasks.length}
          </Text>
          <Text dimColor>· verify</Text>
          <Text color={run.verify.last === 'fail' ? 'red' : undefined}>
            {run.verify.cycles}/{run.verify.max}
          </Text>
          <Text dimColor>· review</Text>
          <Text color={run.review.last === 'fail' ? 'red' : undefined}>
            {run.review.rounds}/{run.review.max}
          </Text>
        </Box>
        {run.status === 'paused' && (
          <Box marginTop={1}>
            <Text color="yellow">paused: {run.pause_reason ?? 'waiting for you'}</Text>
          </Box>
        )}
        {run.status === 'stalled' && (
          <Box marginTop={1}>
            <Text color="red">stalled: no progress across several stops.</Text>
          </Box>
        )}
        {run.status === 'stopped' && run.stop_reason && (
          <Box marginTop={1}>
            <Text dimColor>stopped: {run.stop_reason}</Text>
          </Box>
        )}
        {open && (
          <Box flexDirection="row" gap={1} marginTop={1}>
            {run.status !== 'active' && <Button key="resume" label="resume" onPress={press(resumeArgs())} />}
            <Button key="stop" label="stop" onPress={press(['stop', '--reason', 'stopped from the pane'])} />
          </Box>
        )}
      </Box>
    )
  })
}
