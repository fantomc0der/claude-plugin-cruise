import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PLAN, project } from './helpers.mjs'

const context = r => r.json?.hookSpecificOutput?.additionalContext

test('the Stop hook is silent without a run, after done, and for another session', () => {
  const p = project()
  assert.equal(p.hook('stop', { session_id: 's1' }).stdout, '')
  p.run('start', '--session', 's1', 'x')
  assert.equal(p.hook('stop', { session_id: 's2' }).stdout, '')
  p.run('phase', 'done', '--force')
  assert.equal(p.hook('stop', { session_id: 's1' }).stdout, '')
})

test('the Stop hook nudges an active run with the summary, the next step, and the skill path', () => {
  const p = project({ env: { CLAUDE_PLUGIN_ROOT: '/plugins/cruise' } })
  p.run('start', '--session', 's1', 'Add a flag')
  const r = p.hook('stop', { session_id: 's1', stop_hook_active: false })
  assert.equal(r.status, 0)
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'Stop')
  const text = context(r)
  assert.match(text, /^cruise [0-9a-f]{6} · active · phase plan · tasks 0\/0 done/)
  assert.match(text, /continue instead of stopping/)
  assert.match(text, /Next: write the plan/)
  assert.match(text, /cruise pause "<question>"/)
  assert.match(text, /\/plugins\/cruise\/skills\/cruise\/SKILL\.md/)
  assert.equal(p.state().nudge.count, 1)
  assert.match(p.run('log').stdout, /nudge \{"count":1,"phase":"plan"\}/)
})

test('an unbound run is claimed by the first session that stops', () => {
  const p = project()
  p.run('start', 'x')
  assert.equal(p.state().session_id, null)
  assert.ok(context(p.hook('stop', { session_id: 'first' })))
  assert.equal(p.state().session_id, 'first')
  assert.equal(p.hook('stop', { session_id: 'second' }).stdout, '')
})

test('nudges without progress park the run as stalled, and progress resets the count', () => {
  const p = project({ env: { CRUISE_MAX_IDLE_NUDGES: '2' } })
  p.run('start', '--session', 's1', 'x')
  const stop = () => p.hook('stop', { session_id: 's1' })
  assert.ok(context(stop()))
  assert.ok(context(stop()))
  const third = stop()
  assert.equal(third.json.hookSpecificOutput, undefined)
  assert.match(third.json.systemMessage, /no progress across 2 stops/)
  assert.equal(p.state().status, 'stalled')
  assert.equal(stop().stdout, '')
  assert.match(context(p.hook('prompt', { session_id: 's1' })), /stalled in phase plan/)
  p.run('resume')
  assert.equal(p.state().nudge.count, 0)
  assert.ok(context(stop()))
  p.plan(PLAN)
  p.run('plan', 'import')
  assert.ok(context(stop()))
  assert.equal(p.state().nudge.count, 1)
  assert.equal(p.state().status, 'active')
})

test('the Stop hook stays quiet while the run is paused and the prompt hook relays the question', () => {
  const p = project()
  p.run('start', '--session', 's1', 'x')
  p.run('pause', 'Postgres or SQLite?')
  assert.equal(p.hook('stop', { session_id: 's1' }).stdout, '')
  const r = p.hook('prompt', { session_id: 's1' })
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(context(r), /paused on: Postgres or SQLite\?/)
  assert.match(context(r), /cruise resume/)
  assert.equal(p.hook('prompt', { session_id: 's2' }).stdout, '')
})

test('the prompt hook describes an active run and says how to stop it', () => {
  const p = project()
  p.run('start', '--session', 's1', 'x')
  const r = p.hook('prompt', { session_id: 's1' })
  assert.match(context(r), /active · phase plan/)
  assert.match(context(r), /cruise stop/)
  p.run('stop')
  assert.equal(p.hook('prompt', { session_id: 's1' }).stdout, '')
})

test('the session-start hook points any session at an unfinished run', () => {
  const p = project()
  assert.equal(p.hook('session-start', { session_id: 's1', source: 'startup' }).stdout, '')
  p.run('start', '--session', 's1', 'Ship the feature')
  const r = p.hook('session-start', { session_id: 'other', source: 'startup' })
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(context(r), /unfinished run exists here: "Ship the feature"/)
  assert.match(context(r), /\/cruise resume/)
  p.run('phase', 'done', '--force')
  assert.equal(p.hook('session-start', { session_id: 's1', source: 'startup' }).stdout, '')
})

test('hooks never fail the event', () => {
  const p = project()
  p.run('start', 'x')
  const bad = p.run('hook', 'stop')
  assert.equal(bad.status, 0)
  const garbage = p.hook('stop', {})
  assert.equal(garbage.status, 0)
  const unknown = p.run('hook', 'nope')
  assert.equal(unknown.status, 0)
  assert.equal(unknown.stdout, '')
})
