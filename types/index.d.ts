export type TaskStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'skipped'

export type RunTask = {
  id: number
  title: string
  status: TaskStatus
  note?: string
}

// The shape of .cruise/run.json as the CLI writes it; the fields the mod reads.
export type RunFile = {
  id: string
  session_id: string | null
  task: string
  status: 'active' | 'paused' | 'stalled' | 'stopped' | 'done'
  phase: 'plan' | 'build' | 'verify' | 'review' | 'done'
  tasks: RunTask[]
  verify: { cycles: number; max: number; last: 'pass' | 'fail' | null }
  review: { rounds: number; max: number; last: 'pass' | 'fail' | null }
  pause_reason: string | null
  stop_reason: string | null
  updated_at: string
}

export type RunView = RunFile & {
  // Where the file was read from, for the pane's footer.
  path: string
  polledAt: number
}

declare module 'claude-code' {
  interface PluginState {
    cruise: { run: RunView | null }
  }
}
