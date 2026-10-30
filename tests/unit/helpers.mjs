import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const bin = join(root, 'bin', 'cruise')

// A throwaway project directory with the CLI bound to it. `run` spawns the real binary the way
// the Bash tool does; `hook` feeds a settings-hook payload on stdin the way Claude Code does.
export function project({ git = false, env: extraEnv = {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cruise-')))
  if (git) mkdirSync(join(dir, '.git'))
  const env = { ...process.env, ...extraEnv }
  for (const k of ['CRUISE_MAX_VERIFY_CYCLES', 'CRUISE_MAX_REVIEW_ROUNDS', 'CRUISE_MAX_IDLE_NUDGES', 'CLAUDE_PLUGIN_ROOT']) if (!(k in extraEnv)) delete env[k]
  const spawn = (args, input) => {
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env, cwd: dir, input })
    let json
    try {
      json = JSON.parse(r.stdout)
    } catch {
      json = undefined
    }
    let error
    try {
      error = JSON.parse(r.stderr).error
    } catch {
      error = undefined
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, error }
  }
  const run = (...args) => spawn(args)
  const hook = (name, payload) => spawn(['hook', name], JSON.stringify({ cwd: dir, hook_event_name: name, ...payload }))
  const state = () => JSON.parse(readFileSync(join(dir, '.cruise', 'run.json'), 'utf8'))
  const plan = text => {
    mkdirSync(join(dir, '.cruise'), { recursive: true })
    writeFileSync(join(dir, '.cruise', 'plan.md'), text)
  }
  const read = rel => readFileSync(join(dir, rel), 'utf8')
  return { dir, run, hook, state, plan, read }
}

export const PLAN = ['# Plan: thing', '', '## Goal', 'A thing.', '', '## Tasks', '- [ ] T1: Parse the flag', '  - files: src/cli.mjs', '- [ ] T2: Emit JSON', '- [ ] T3: Test it', ''].join('\n')
