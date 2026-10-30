import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CliError } from './errors.mjs'
import { appendTask, parseTasks, tickTask } from './plan.mjs'
import { gitExcludePath, historyDir, logPath, planPath, runPath, stateDir, STATE_DIR, PLAN_FILE } from './paths.mjs'

export const PHASES = ['plan', 'build', 'verify', 'review', 'done']
export const STATUSES = ['active', 'paused', 'stalled', 'stopped', 'done']
export const TASK_STATUSES = ['todo', 'doing', 'done', 'blocked', 'skipped']
// Statuses under which the run still wants attention.
export const OPEN = new Set(['active', 'paused', 'stalled'])

const DEFAULTS = { verify: 5, review: 2, nudges: 3 }

const limit = (env, name, fallback) => {
  const raw = env[name]
  const n = Number(raw)
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : fallback
}

export function limitsFrom(env = process.env) {
  return {
    verify: limit(env, 'CRUISE_MAX_VERIFY_CYCLES', DEFAULTS.verify),
    review: limit(env, 'CRUISE_MAX_REVIEW_ROUNDS', DEFAULTS.review),
    nudges: limit(env, 'CRUISE_MAX_IDLE_NUDGES', DEFAULTS.nudges),
  }
}

const now = () => new Date().toISOString()

export function readRun(root) {
  const path = runPath(root)
  if (!existsSync(path)) return null
  try {
    const run = JSON.parse(readFileSync(path, 'utf8'))
    return run && typeof run === 'object' && typeof run.phase === 'string' ? run : null
  } catch {
    return null
  }
}

// Every CLI mutation goes through here and bumps `rev`, which is how the Stop hook tells
// progress from a model that keeps stopping. The hook's own bookkeeping passes `bump: false`.
export function writeRun(root, run, { bump = true } = {}) {
  if (bump) run.rev = (run.rev ?? 0) + 1
  run.updated_at = now()
  mkdirSync(stateDir(root), { recursive: true })
  const path = runPath(root)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n')
  renameSync(tmp, path)
  return run
}

export function log(root, ev, detail) {
  try {
    mkdirSync(stateDir(root), { recursive: true })
    appendFileSync(logPath(root), JSON.stringify({ at: now(), ev, ...(detail ? { detail } : {}) }) + '\n')
  } catch {
    // The log is a convenience; a run never fails on it.
  }
}

export function readLog(root, n = 20) {
  try {
    const lines = readFileSync(logPath(root), 'utf8').split('\n').filter(Boolean)
    return lines.slice(-n).map(l => JSON.parse(l))
  } catch {
    return []
  }
}

function excludeFromGit(root) {
  const path = gitExcludePath(root)
  if (!path) return
  try {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (existing.split('\n').some(l => l.trim() === `${STATE_DIR}/` || l.trim() === STATE_DIR)) return
    mkdirSync(join(root, '.git', 'info'), { recursive: true })
    appendFileSync(path, `${existing.length && !existing.endsWith('\n') ? '\n' : ''}${STATE_DIR}/\n`)
  } catch {
    // Best effort: the user can ignore the directory themselves.
  }
}

function archive(root, run) {
  try {
    mkdirSync(historyDir(root), { recursive: true })
    const stamp = (run.updated_at ?? now()).replace(/[:.]/g, '-')
    writeFileSync(join(historyDir(root), `${stamp}-${run.id}-${run.status}.json`), JSON.stringify(run, null, 2) + '\n')
  } catch {
    // History is a convenience.
  }
}

export function startRun(root, { task, session, force = false, env = process.env }) {
  if (!task || !task.trim()) throw new CliError('usage', 'cruise start needs the task text', { exitCode: 2 })
  const existing = readRun(root)
  if (existing && OPEN.has(existing.status) && !force) {
    throw new CliError('run-exists', `a ${existing.status} run already exists: ${existing.task}`, {
      hint: 'continue it with `cruise resume`, or replace it with `cruise start --force "<task>"`',
      data: { run: existing },
    })
  }
  if (existing) archive(root, existing)
  const limits = limitsFrom(env)
  const run = {
    version: 1,
    id: randomBytes(3).toString('hex'),
    session_id: session ?? null,
    task: task.trim(),
    status: 'active',
    phase: 'plan',
    started_at: now(),
    updated_at: now(),
    rev: 0,
    plan: `${STATE_DIR}/${PLAN_FILE}`,
    tasks: [],
    verify: { cycles: 0, max: limits.verify, last: null, signature: null, repeats: 0 },
    review: { rounds: 0, max: limits.review, last: null },
    pause_reason: null,
    stop_reason: null,
    nudge: { count: 0, rev: 0, max: limits.nudges },
  }
  writeRun(root, run)
  excludeFromGit(root)
  log(root, 'start', { id: run.id, task: run.task })
  return run
}

export function requireRun(root) {
  const run = readRun(root)
  if (!run) throw new CliError('no-run', 'no cruise run in this project', { hint: 'start one with `cruise start "<task>"`' })
  return run
}

export const openTasks = run => run.tasks.filter(t => t.status === 'todo' || t.status === 'doing')
export const doneTasks = run => run.tasks.filter(t => t.status === 'done')
const resolvedTasks = run => run.tasks.filter(t => t.status === 'done' || t.status === 'skipped')

export function setPhase(root, run, phase, { force = false } = {}) {
  if (!PHASES.includes(phase)) throw new CliError('usage', `unknown phase '${phase}'`, { hint: `one of ${PHASES.join(', ')}`, exitCode: 2 })
  const open = openTasks(run)
  if (!force) {
    if (phase === 'verify' && open.length) {
      throw new CliError('tasks-open', `${open.length} task(s) still open: ${open.map(t => `T${t.id}`).join(', ')}`, { hint: 'finish them (`cruise task done <id...>`), mark them `cruise task skip <id> --reason "..."`, or pass --force' })
    }
    if (phase === 'verify' && run.tasks.length === 0) {
      throw new CliError('no-tasks', 'the run has no tasks', { hint: 'write the plan and run `cruise plan import`, or pass --force' })
    }
    if (phase === 'review' && run.verify.last !== 'pass') {
      throw new CliError('verify-not-passed', 'verify has not passed', { hint: 'run the checks and record `cruise verify pass`, or pass --force' })
    }
    if (phase === 'done') {
      const missing = []
      if (resolvedTasks(run).length !== run.tasks.length || run.tasks.length === 0) missing.push('all tasks done or skipped')
      if (run.verify.last !== 'pass') missing.push('verify pass')
      if (run.review.last !== 'pass') missing.push('review pass')
      if (missing.length) throw new CliError('not-finished', `done needs: ${missing.join(', ')}`, { hint: 'record them, or pass --force with --reason "..."' })
    }
  }
  const from = run.phase
  run.phase = phase
  run.nudge.count = 0
  if (phase === 'done') {
    run.status = 'done'
    run.finished_at = now()
  } else if (run.status === 'done') {
    run.status = 'active'
    delete run.finished_at
  }
  writeRun(root, run)
  log(root, 'phase', { from, to: phase, ...(force ? { force: true } : {}) })
  return run
}

export function importTasks(root, run, text) {
  const parsed = parseTasks(text)
  if (!parsed.length) throw new CliError('no-tasks', 'no tasks found under a "## Tasks" heading', { hint: 'tasks are lines like `- [ ] T1: title`' })
  const previous = new Map(run.tasks.map(t => [t.id, t]))
  run.tasks = parsed.map(t => {
    const old = previous.get(t.id)
    const status = t.done ? 'done' : old && old.title === t.title ? old.status : 'todo'
    return { id: t.id, title: t.title, status, ...(old?.note ? { note: old.note } : {}) }
  })
  writeRun(root, run)
  log(root, 'plan', { tasks: run.tasks.length })
  return run
}

function findTask(run, id) {
  const task = run.tasks.find(t => t.id === id)
  if (!task) throw new CliError('no-task', `no task T${id}`, { hint: '`cruise task list` shows the ids' })
  return task
}

export function setTasks(root, run, ids, status, note) {
  if (!TASK_STATUSES.includes(status)) throw new CliError('usage', `unknown task status '${status}'`, { exitCode: 2 })
  const tasks = ids.map(id => findTask(run, id))
  for (const task of tasks) {
    task.status = status
    if (note) task.note = note
    else if (status === 'done' || status === 'todo') delete task.note
  }
  writeRun(root, run)
  log(root, 'task', { ids, status, ...(note ? { note } : {}) })
  syncPlan(root, run, tasks)
  return tasks
}

// Mirrors task state into the plan's checkboxes. Nothing depends on it, so it never fails.
function syncPlan(root, run, tasks) {
  const path = planPath(root)
  if (!existsSync(path)) return
  try {
    let text = readFileSync(path, 'utf8')
    for (const task of tasks) text = tickTask(text, task.id, task.status === 'done')
    writeFileSync(path, text)
  } catch {
    // The run state is authoritative.
  }
}

export function addTask(root, run, title) {
  const id = run.tasks.reduce((n, t) => Math.max(n, t.id), 0) + 1
  run.tasks.push({ id, title, status: 'todo' })
  writeRun(root, run)
  log(root, 'task', { ids: [id], status: 'added', title })
  const path = planPath(root)
  try {
    const text = existsSync(path) ? readFileSync(path, 'utf8') : `# Plan: ${run.task}\n`
    writeFileSync(path, appendTask(text, id, title))
  } catch {
    // The run state is authoritative.
  }
  return run.tasks[run.tasks.length - 1]
}

// Collapses an error message to what repeats between runs: no numbers, paths, or case.
export const signatureOf = text =>
  (text ?? '')
    .toLowerCase()
    .replace(/[a-z]:\\[^\s:]+|\/[^\s:]+/g, 'PATH')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)

export function recordVerify(root, run, verdict, detail) {
  if (verdict !== 'pass' && verdict !== 'fail') throw new CliError('usage', 'cruise verify pass|fail [error]', { exitCode: 2 })
  const v = run.verify
  v.last = verdict
  v.cycles += 1
  let limitHit = null
  if (verdict === 'pass') {
    v.signature = null
    v.repeats = 0
  } else {
    const sig = signatureOf(detail)
    v.repeats = sig && sig === v.signature ? v.repeats + 1 : 1
    v.signature = sig || null
    if (v.repeats >= 3) limitHit = `the same error failed ${v.repeats} times: ${detail ?? ''}`.trim()
    else if (v.cycles >= v.max) limitHit = `${v.cycles} verify cycles used; the last error: ${detail ?? ''}`.trim()
  }
  log(root, 'verify', { verdict, cycle: v.cycles, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) })
  if (limitHit) pauseRun(root, run, `verify limit: ${limitHit}`, { auto: true })
  else writeRun(root, run)
  return { run, limitHit }
}

export function recordReview(root, run, verdict, detail) {
  if (verdict !== 'pass' && verdict !== 'fail') throw new CliError('usage', 'cruise review pass|fail [summary]', { exitCode: 2 })
  const r = run.review
  r.last = verdict
  r.rounds += 1
  let limitHit = null
  if (verdict === 'fail' && r.rounds >= r.max) limitHit = `${r.rounds} review rounds used; still failing: ${detail ?? ''}`.trim()
  log(root, 'review', { verdict, round: r.rounds, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) })
  if (limitHit) pauseRun(root, run, `review limit: ${limitHit}`, { auto: true })
  else writeRun(root, run)
  return { run, limitHit }
}

export function pauseRun(root, run, reason, { auto = false } = {}) {
  run.status = 'paused'
  run.pause_reason = reason || 'waiting for the user'
  run.nudge.count = 0
  writeRun(root, run)
  log(root, 'pause', { reason: run.pause_reason, ...(auto ? { auto: true } : {}) })
  return run
}

// A person intervened, so the run gets its verify and review budget back. The session binding
// moves to the given session, or is dropped so that the next Stop claims the run for whichever
// session resumed it.
export function resumeRun(root, run, { session } = {}) {
  if (run.status === 'done' || run.status === 'stopped') {
    throw new CliError('run-closed', `the run is ${run.status}`, { hint: 'start a new one with `cruise start "<task>"`' })
  }
  run.status = 'active'
  run.pause_reason = null
  run.nudge.count = 0
  run.verify.cycles = 0
  run.verify.repeats = 0
  run.verify.signature = null
  run.review.rounds = 0
  run.session_id = session ?? null
  writeRun(root, run)
  log(root, 'resume', { phase: run.phase })
  return run
}

export function stopRun(root, run, reason) {
  run.status = 'stopped'
  run.stop_reason = reason || null
  run.nudge.count = 0
  run.finished_at = now()
  writeRun(root, run)
  log(root, 'stop', reason ? { reason } : undefined)
  return run
}

// One line a person or the model can read at a glance.
export function summary(run) {
  const done = doneTasks(run).length
  const parts = [`cruise ${run.id}`, run.status, `phase ${run.phase}`, `tasks ${done}/${run.tasks.length} done`, `verify ${run.verify.cycles}/${run.verify.max}`, `review ${run.review.rounds}/${run.review.max}`]
  return parts.join(' · ')
}

// What the model should do now, in one sentence, for the Stop hook and `cruise status`.
export function nextStep(run) {
  if (run.status === 'paused') return 'tell the user why the run paused and what you need; `cruise resume` continues it once they answer.'
  if (run.status === 'stalled') return 'stalled: no progress across several stops. `cruise resume` continues, `cruise stop` abandons.'
  if (run.status === 'stopped') return 'stopped. Start another run with `cruise start "<task>"`.'
  if (run.status === 'done' || run.phase === 'done') return 'done. Report to the user.'
  switch (run.phase) {
    case 'plan':
      return 'write the plan to .cruise/plan.md (cruise:navigator, or yourself for a small request), run `cruise plan import`, then `cruise phase build`.'
    case 'build': {
      const open = openTasks(run)
      const blocked = run.tasks.filter(t => t.status === 'blocked')
      if (!run.tasks.length) return 'no tasks imported yet: run `cruise plan import`, then build.'
      if (!open.length && blocked.length) return `no open tasks, but ${blocked.map(t => `T${t.id}`).join(', ')} blocked: unblock and finish, or \`cruise task skip <id> --reason "..."\`, then \`cruise phase verify\`.`
      if (!open.length) return 'all tasks are done: run `cruise phase verify`.'
      return `finish ${open.map(t => `T${t.id}`).join(', ')} (one cruise:builder each, parallel when independent, inline when tiny), mark them with \`cruise task done <id...>\`, then \`cruise phase verify\`.`
    }
    case 'verify':
      if (run.verify.last === 'pass') return 'verify passed: run `cruise phase review`.'
      return "run the project's build, lint, and tests; record `cruise verify pass` or `cruise verify fail \"<error>\"`; fix failures; then `cruise phase review`."
    case 'review':
      if (run.review.last === 'pass') return 'review passed: run `cruise phase done` and report to the user.'
      return 'spawn one cruise:reviewer with the plan and the changed files; fix blocking findings and record `cruise review fail "<n blocking>"`, or `cruise review pass`; then `cruise phase done`.'
    default:
      return ''
  }
}

export function taskLines(run) {
  if (!run.tasks.length) return ['(no tasks imported)']
  return run.tasks.map(t => `T${t.id} ${t.status.padEnd(7)} ${t.title}${t.note ? ` (${t.note})` : ''}`)
}
