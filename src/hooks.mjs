// The settings hooks: Stop keeps an active run going, UserPromptSubmit tells the model how a
// message relates to the run, SessionStart points a fresh session at an unfinished run. Each
// returns the hook's JSON output, or null when the hook has nothing to say.
import { findRoot } from './paths.mjs'
import { OPEN, log, nextStep, readRun, summary, writeRun } from './run.mjs'

// A run bound to a session answers only that session; an unbound run is claimed by the
// first Stop it sees, which is the session that started it.
const ownedBy = (run, sessionId) => !run.session_id || !sessionId || run.session_id === sessionId

const rootOf = payload => findRoot(payload.cwd || process.cwd())

export function stopHook(payload, { env = process.env } = {}) {
  const root = rootOf(payload)
  const run = readRun(root)
  if (!run || run.status !== 'active' || run.phase === 'done' || !ownedBy(run, payload.session_id)) return null
  if (!run.session_id && payload.session_id) {
    run.session_id = payload.session_id
    log(root, 'claim', { session: payload.session_id })
  }
  // Progress is a CLI mutation since the last nudge. A model that stops again without one
  // is nudged `max` times, then the run is parked so the loop cannot spend tokens for nothing.
  if (run.nudge.rev === run.rev) run.nudge.count += 1
  else {
    run.nudge.rev = run.rev
    run.nudge.count = 1
  }
  if (run.nudge.count > run.nudge.max) {
    run.status = 'stalled'
    writeRun(root, run, { bump: false })
    log(root, 'stall', { nudges: run.nudge.max, phase: run.phase })
    return { systemMessage: `cruise: no progress across ${run.nudge.max} stops, so the run is parked as stalled. /cruise resume continues it; cruise stop abandons it.` }
  }
  writeRun(root, run, { bump: false })
  log(root, 'nudge', { count: run.nudge.count, phase: run.phase })
  const skill = env.CLAUDE_PLUGIN_ROOT ? `${env.CLAUDE_PLUGIN_ROOT}/skills/cruise/SKILL.md` : null
  const lines = [
    `${summary(run)}. The run is not finished, so continue instead of stopping.`,
    `Next: ${nextStep(run)}`,
    `Need the user? \`cruise pause "<question>"\`. Abandon? \`cruise stop\`.${skill ? ` Instructions: ${skill} (read it if the cruise skill is no longer in context).` : ''}`,
  ]
  return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: lines.join('\n') } }
}

export function promptHook(payload) {
  const root = rootOf(payload)
  const run = readRun(root)
  if (!run || !OPEN.has(run.status) || !ownedBy(run, payload.session_id)) return null
  let text
  if (run.status === 'paused') text = `cruise run ${run.id} is paused on: ${run.pause_reason}. If this message answers it, run \`cruise resume\` and continue the run from phase ${run.phase}.`
  else if (run.status === 'stalled') text = `cruise run ${run.id} is stalled in phase ${run.phase}. If this message asks to continue, run \`cruise resume\`; to abandon, \`cruise stop\`.`
  else text = `${summary(run)}. If this message asks to stop, run \`cruise stop\`; otherwise fold it into the run and keep going.`
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }
}

export function sessionStartHook(payload) {
  const root = rootOf(payload)
  const run = readRun(root)
  if (!run || !OPEN.has(run.status)) return null
  const text = `cruise: an unfinished run exists here: "${run.task.slice(0, 160)}" (${summary(run)}). \`/cruise resume\` continues it; \`cruise stop\` abandons it.`
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }
}

export const HOOKS = { stop: stopHook, prompt: promptHook, 'session-start': sessionStartHook }
