// The plan file's task list. The navigator writes it, `cruise plan import` reads it, and
// `cruise task done` ticks the box so a person reading the plan sees the same progress
// as the run state.
//
//   ## Tasks
//   - [ ] T1: Add the parser
//     - files: src/parse.mjs
//   - [x] T2: Wire the flag

const TASK_RE = /^(\s*)[-*]\s+\[( |x|X)\]\s+T(\d+)\s*[:.)-]\s*(.+?)\s*$/

export function parseTasks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(l => /^##\s+Tasks\b/i.test(l))
  if (start < 0) return []
  const tasks = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s/.test(line)) break
    const m = TASK_RE.exec(line)
    if (!m) continue
    tasks.push({ id: Number(m[3]), title: m[4], done: m[2] !== ' ' })
  }
  return tasks
}

// Rewrites the checkbox of task `id` and leaves every other byte alone.
export function tickTask(text, id, done = true) {
  return text
    .split('\n')
    .map(line => {
      const m = TASK_RE.exec(line)
      if (!m || Number(m[3]) !== id) return line
      return line.replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]')
    })
    .join('\n')
}

// Appends a task line at the end of the Tasks section, or adds the section when missing.
export function appendTask(text, id, title) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(l => /^##\s+Tasks\b/i.test(l))
  const entry = `- [ ] T${id}: ${title}`
  if (start < 0) {
    const trimmed = lines.join('\n').replace(/\n*$/, '')
    return `${trimmed}\n\n## Tasks\n\n${entry}\n`
  }
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (end < 0) end = lines.length
  while (end > start + 1 && lines[end - 1].trim() === '') end--
  lines.splice(end, 0, entry)
  return lines.join('\n')
}
