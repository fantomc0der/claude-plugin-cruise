import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const STATE_DIR = '.cruise'
export const RUN_FILE = 'run.json'
export const PLAN_FILE = 'plan.md'
export const LOG_FILE = 'log.jsonl'

const isDir = p => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// The directory a run lives in: the nearest ancestor (or cwd itself) that already holds a
// run, else the git top level, else cwd. The CLI and the hooks resolve the same way, so a
// command run from a subdirectory and a hook fired with the project cwd meet at one file.
export function findRoot(cwd = process.cwd()) {
  let dir = resolve(cwd)
  let gitRoot
  for (;;) {
    if (existsSync(join(dir, STATE_DIR, RUN_FILE))) return dir
    if (gitRoot === undefined && existsSync(join(dir, '.git'))) gitRoot = dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return gitRoot ?? resolve(cwd)
}

export const stateDir = root => join(root, STATE_DIR)
export const runPath = root => join(root, STATE_DIR, RUN_FILE)
export const planPath = root => join(root, STATE_DIR, PLAN_FILE)
export const logPath = root => join(root, STATE_DIR, LOG_FILE)
export const historyDir = root => join(root, STATE_DIR, 'history')

// `.git/info/exclude` keeps the state directory out of the user's repository without
// touching their .gitignore. A worktree has a `.git` file instead of a directory; skipped.
export const gitExcludePath = root => (isDir(join(root, '.git')) ? join(root, '.git', 'info', 'exclude') : undefined)
