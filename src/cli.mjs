import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseArgs } from './args.mjs'
import { CliError, usage } from './errors.mjs'
import { HOOKS } from './hooks.mjs'
import { findRoot, planPath, stateDir } from './paths.mjs'
import * as run from './run.mjs'

const HELP = `cruise: autonomous plan, build, verify, review runs

  cruise start "<task>" [--session ID] [--force]
  cruise status [--json]
  cruise phase plan|build|verify|review|done [--force --reason "..."]
  cruise plan import [path]
  cruise task list | done <id...> | start <id...> | block <id> --reason "..." | skip <id> --reason "..." | add "<title>"
  cruise verify pass|fail ["<error>"]
  cruise review pass|fail ["<summary>"]
  cruise pause "<question for the user>"
  cruise resume [--session ID]
  cruise stop [--reason "..."]
  cruise log [--n N]
  cruise hook stop|prompt|session-start   (the hook payload on stdin)

Text on stdout, or the run as JSON with --json. Errors are JSON on stderr; exit 1 failed, 2 usage.`

const taskIds = list => {
  if (!list.length) throw usage('missing task id')
  return list.map(s => {
    const m = /^t?(\d+)$/i.exec(s)
    if (!m) throw usage(`'${s}' is not a task id`)
    return Number(m[1])
  })
}

const view = r => ({ ...r, summary: run.summary(r), next: run.nextStep(r) })

function statusText(r, extra = []) {
  const lines = [run.summary(r), `task: ${r.task}`, ...extra]
  if (r.status === 'paused') lines.push(`paused: ${r.pause_reason}`)
  lines.push(`next: ${run.nextStep(r)}`)
  return lines.join('\n')
}

const answer = (r, extra) => ({ text: statusText(r, extra), json: view(r) })

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function hook(name) {
  const handler = HOOKS[name]
  if (!handler) throw usage(`unknown hook '${name}'`, `one of ${Object.keys(HOOKS).join(', ')}`)
  let payload = {}
  try {
    const raw = await readStdin()
    payload = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    payload = {}
  }
  let out = null
  try {
    out = handler(payload)
  } catch {
    out = null
  }
  return { text: out ? JSON.stringify(out) : '', exitCode: 0, raw: true }
}

async function dispatch(argv) {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { text: HELP, exitCode: cmd === undefined ? 2 : 0 }
    case 'hook':
      return hook(rest[0])
    case 'start': {
      const { positionals, options } = parseArgs(rest, { booleans: ['force'] })
      const root = findRoot()
      const r = run.startRun(root, { task: positionals.join(' '), session: options.session, force: Boolean(options.force) })
      return answer(r, [`state: ${stateDir(root)}`])
    }
    case 'status':
      return answer(run.requireRun(findRoot()))
    case 'phase': {
      const { positionals, options } = parseArgs(rest, { booleans: ['force'] })
      const root = findRoot()
      const r = run.setPhase(root, run.requireRun(root), positionals[0], { force: Boolean(options.force) })
      if (options.force && options.reason) run.log(root, 'force', { phase: positionals[0], reason: options.reason })
      if (r.phase === 'done') return { text: `${run.summary(r)}\nReport to the user: assumptions to veto, what was built, how it was verified, open findings.`, json: view(r) }
      return answer(r)
    }
    case 'plan': {
      const [sub, file] = rest
      if (sub !== 'import') throw usage('cruise plan import [path]')
      const root = findRoot()
      const path = file ? resolve(file) : planPath(root)
      if (!existsSync(path)) throw new CliError('no-plan', `no plan at ${path}`, { hint: 'write the plan first; tasks go under a "## Tasks" heading as `- [ ] T1: title`' })
      const r = run.importTasks(root, run.requireRun(root), readFileSync(path, 'utf8'))
      return { text: [`imported ${r.tasks.length} task(s)`, ...run.taskLines(r), `next: ${run.nextStep(r)}`].join('\n'), json: view(r) }
    }
    case 'task': {
      const [sub, ...args] = rest
      const root = findRoot()
      const r = run.requireRun(root)
      const { positionals, options } = parseArgs(args)
      switch (sub) {
        case 'list':
        case undefined:
          return { text: run.taskLines(r).join('\n'), json: view(r) }
        case 'done':
        case 'start':
        case 'block':
        case 'skip': {
          const status = { done: 'done', start: 'doing', block: 'blocked', skip: 'skipped' }[sub]
          if ((sub === 'block' || sub === 'skip') && !options.reason) throw usage(`cruise task ${sub} <id> --reason "..."`)
          run.setTasks(root, r, taskIds(positionals), status, options.reason ?? options.note)
          return { text: [run.taskLines(r).join('\n'), `next: ${run.nextStep(r)}`].join('\n'), json: view(r) }
        }
        case 'add': {
          const title = positionals.join(' ').trim()
          if (!title) throw usage('cruise task add "<title>"')
          const t = run.addTask(root, r, title)
          return { text: `added T${t.id}: ${t.title}`, json: view(r) }
        }
        default:
          throw usage(`unknown task command '${sub}'`, 'list | done | start | block | skip | add')
      }
    }
    case 'verify':
    case 'review': {
      const [verdict, ...words] = rest
      const root = findRoot()
      const r = run.requireRun(root)
      const detail = words.join(' ') || undefined
      const record = cmd === 'verify' ? run.recordVerify : run.recordReview
      const { limitHit } = record(root, r, verdict, detail)
      const extra = []
      if (limitHit) extra.push(`LIMIT: ${limitHit}`, 'The run is paused. Tell the user what is wrong and what you need; `cruise resume` continues after they answer.')
      else if (cmd === 'verify' && verdict === 'fail') extra.push(`verify cycle ${r.verify.cycles}/${r.verify.max}${r.verify.repeats > 1 ? ` · same error ${r.verify.repeats}×` : ''}`)
      else if (cmd === 'review' && verdict === 'fail') extra.push(`review round ${r.review.rounds}/${r.review.max}`)
      return answer(r, extra)
    }
    case 'pause': {
      const root = findRoot()
      const r = run.pauseRun(root, run.requireRun(root), rest.join(' '))
      return { text: `paused: ${r.pause_reason}\nTell the user, then stop. The run continues with \`cruise resume\` after they answer.`, json: view(r) }
    }
    case 'resume': {
      const { options } = parseArgs(rest)
      const root = findRoot()
      return answer(run.resumeRun(root, run.requireRun(root), { session: options.session }))
    }
    case 'stop': {
      const { options } = parseArgs(rest)
      const root = findRoot()
      const r = run.stopRun(root, run.requireRun(root), options.reason)
      return { text: `${run.summary(r)}\nReport what was done and what remains, then stop.`, json: view(r) }
    }
    case 'log': {
      const { options } = parseArgs(rest)
      const entries = run.readLog(findRoot(), Number(options.n ?? 20))
      return { text: entries.map(e => `${e.at} ${e.ev}${e.detail ? ' ' + JSON.stringify(e.detail) : ''}`).join('\n') || '(empty)', json: { entries } }
    }
    default:
      throw usage(`unknown command '${cmd}'`, 'run `cruise help`')
  }
}

export async function main(argv = process.argv.slice(2)) {
  const wantJson = argv.includes('--json')
  const args = argv.filter(a => a !== '--json')
  try {
    const out = await dispatch(args)
    if (out.raw) {
      if (out.text) process.stdout.write(out.text + '\n')
    } else if (wantJson && out.json) process.stdout.write(JSON.stringify(out.json, null, 2) + '\n')
    else if (out.text) process.stdout.write(out.text + '\n')
    return out.exitCode ?? 0
  } catch (e) {
    if (args[0] === 'hook') return 0
    const err = e instanceof CliError ? e : new CliError('internal', e instanceof Error ? e.message : String(e))
    process.stderr.write(JSON.stringify(err.toJSON()) + '\n')
    return err.exitCode
  }
}
