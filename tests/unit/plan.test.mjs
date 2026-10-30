import { test } from 'node:test'
import assert from 'node:assert/strict'

import { appendTask, parseTasks, tickTask } from '../../src/plan.mjs'
import { signatureOf } from '../../src/run.mjs'

const PLAN = ['# Plan', '', '## Tasks', '- [ ] T1: First', '  - files: a.js', '* [x] T2 - Second', '- [ ] not a task', '- [ ] T3. Third', '', '## Notes', '- [ ] T9: outside the section', ''].join('\n')

test('parseTasks reads the Tasks section only and accepts the common separators', () => {
  assert.deepEqual(parseTasks(PLAN), [
    { id: 1, title: 'First', done: false },
    { id: 2, title: 'Second', done: true },
    { id: 3, title: 'Third', done: false },
  ])
  assert.deepEqual(parseTasks('# Plan\nno tasks here\n'), [])
  assert.deepEqual(parseTasks(PLAN.replace(/\n/g, '\r\n'))[0], { id: 1, title: 'First', done: false })
})

test('tickTask changes one checkbox and nothing else', () => {
  const out = tickTask(PLAN, 1)
  assert.ok(out.includes('- [x] T1: First'))
  assert.equal(out.replace('- [x] T1: First', '- [ ] T1: First'), PLAN)
  assert.ok(tickTask(out, 1, false).includes('- [ ] T1: First'))
  assert.equal(tickTask(PLAN, 42), PLAN)
})

test('appendTask adds to the end of the Tasks section or creates it', () => {
  const out = appendTask(PLAN, 4, 'Fourth')
  const lines = out.split('\n')
  assert.equal(lines[lines.indexOf('- [ ] T3. Third') + 1], '- [ ] T4: Fourth')
  assert.ok(out.includes('## Notes'))
  assert.match(appendTask('# Plan\n', 1, 'Only'), /## Tasks\n\n- \[ \] T1: Only\n$/)
})

test('signatureOf keeps what repeats between failures', () => {
  const a = signatureOf('TypeError: x is not a function at C:\\proj\\src\\cli.mjs:12')
  const b = signatureOf('TypeError: X is not a function at /home/u/proj/src/cli.mjs:19')
  assert.equal(a, b)
  assert.notEqual(a, signatureOf('ReferenceError: y is not defined'))
  assert.equal(signatureOf(undefined), '')
})
