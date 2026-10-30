import type { RunFile, TaskStatus } from '../../types'

export const OPEN = new Set(['active', 'paused', 'stalled'])

export const parseRun = (text: string): RunFile | null => {
  try {
    const run = JSON.parse(text) as RunFile
    return run && typeof run === 'object' && typeof run.phase === 'string' && Array.isArray(run.tasks) ? run : null
  } catch {
    return null
  }
}

// The directory above `dir`, or undefined at a root, for either separator.
export function parentDir(dir: string): string | undefined {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (at <= 0) return undefined
  const parent = trimmed.slice(0, at)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
}

export const doneCount = (run: RunFile) => run.tasks.filter(t => t.status === 'done').length

// The line under the prompt while a run is open: the phase, the task count, and the counters
// that are in play.
export function statusLine(run: RunFile): string {
  const parts = [run.phase, `tasks ${doneCount(run)}/${run.tasks.length}`]
  if (run.phase === 'verify' || run.verify.cycles > 0) parts.push(`verify ${run.verify.cycles}/${run.verify.max}`)
  if (run.phase === 'review' || run.review.rounds > 0) parts.push(`review ${run.review.rounds}/${run.review.max}`)
  if (run.status !== 'active') parts.unshift(run.status)
  return parts.join(' · ')
}

export const transitionKey = (run: RunFile) => `${run.id}|${run.status}|${run.phase}`

// The toast for a run that just changed status or phase.
export function transitionToast(run: RunFile): string {
  switch (run.status) {
    case 'paused':
      return `paused: ${run.pause_reason ?? 'waiting for you'}`
    case 'stalled':
      return 'stalled: no progress across several stops. /helm resume continues it.'
    case 'stopped':
      return 'run stopped'
    case 'done':
      return 'run done'
    default:
      return `phase ${run.phase}`
  }
}

export const statusColor = (status: string) => (status === 'active' ? 'green' : status === 'done' ? 'cyan' : status === 'paused' ? 'yellow' : 'red')

export const taskGlyph = (status: TaskStatus) => (status === 'done' ? '✓' : status === 'doing' ? '▶' : status === 'blocked' ? '✗' : status === 'skipped' ? '–' : '○')

export const taskColor = (status: TaskStatus) => (status === 'done' ? 'green' : status === 'doing' ? 'yellow' : status === 'blocked' ? 'red' : status === 'skipped' ? 'gray' : undefined)

export const ago = (now: number, at: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}

// Splits a slash command's argument string into the subcommand and the rest of the line.
export function splitArgs(args: string): { sub: string | undefined; rest: string } {
  const trimmed = args.trim()
  if (!trimmed) return { sub: undefined, rest: '' }
  const at = trimmed.search(/\s/)
  return at < 0 ? { sub: trimmed, rest: '' } : { sub: trimmed.slice(0, at), rest: trimmed.slice(at + 1).trim() }
}
