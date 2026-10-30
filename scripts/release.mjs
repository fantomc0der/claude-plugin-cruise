#!/usr/bin/env node
// Cuts a release: bumps the version in every manifest, turns the changelog's Unreleased
// section into a dated section for the new version, and optionally commits and tags.
//
//   node scripts/release.mjs <major|minor|patch|x.y.z> [--dry-run] [--commit] [--tag] [--date YYYY-MM-DD]
//
// Pure helpers are exported for the unit tests; the command runs only when executed directly.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const PLUGIN = '.claude-plugin/plugin.json'
export const PACKAGE = 'package.json'
export const LOCK = 'package-lock.json'
export const CHANGELOG = 'CHANGELOG.md'

const VERSION_RE = /^\d+\.\d+\.\d+$/

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

// The versions that have a section in the changelog, newest first.
export function releasedVersions(text) {
  return text
    .split('\n')
    .map(l => /^## \[(\d+\.\d+\.\d+)\]/.exec(l)?.[1])
    .filter(Boolean)
}

// `allowCurrent` lets the manifests' own version be released as is: the first release,
// where the manifests already say 0.1.0 and no section or tag exists for it yet.
export function bump(current, spec, { allowCurrent = false } = {}) {
  if (!VERSION_RE.test(current)) throw new Error(`current version '${current}' is not x.y.z`)
  const [major, minor, patch] = current.split('.').map(Number)
  switch (spec) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
    default: {
      if (!VERSION_RE.test(spec)) throw new Error(`'${spec}' is not major, minor, patch, or x.y.z`)
      const delta = compareVersions(spec, current)
      if (delta < 0) throw new Error(`${spec} is below the current version ${current}`)
      if (delta === 0 && !allowCurrent) throw new Error(`${spec} is already released; pick a version above it`)
      return spec
    }
  }
}

// Replaces the first `count` occurrences of the version field so the file's own formatting survives.
export function setVersion(text, current, next, count = 1) {
  const needle = `"version": "${current}"`
  let out = text
  for (let i = 0; i < count; i++) {
    const at = out.indexOf(needle)
    if (at < 0) throw new Error(`expected ${count} "version": "${current}" field(s), found ${i}`)
    out = out.slice(0, at) + `"version": "${next}"` + out.slice(at + needle.length)
  }
  return out
}

const isHeading = line => /^## \[/.test(line)
const isLink = line => /^\[[^\]]+\]: \S/.test(line)
const isEntry = line => /^\s*[-*]\s+\S/.test(line)

// The lines of the Unreleased section (after its heading, before the next heading or the link block).
export function unreleasedSection(lines) {
  const head = lines.findIndex(l => /^## \[Unreleased\]/i.test(l))
  if (head < 0) throw new Error(`${CHANGELOG} has no "## [Unreleased]" section`)
  let end = lines.findIndex((l, i) => i > head && (isHeading(l) || isLink(l)))
  if (end < 0) end = lines.length
  return { head, end, body: lines.slice(head + 1, end) }
}

export const hasEntries = lines => lines.some(isEntry)

// Moves everything under Unreleased into a dated section for `version` and refreshes the compare links.
export function cutChangelog(text, version, date, repo) {
  const lines = text.split('\n')
  const { head, end, body } = unreleasedSection(lines)
  if (!hasEntries(body)) throw new Error('the Unreleased section has no entries to release')
  const previous = /^## \[(\d+\.\d+\.\d+)\]/.exec(lines[end] ?? '')?.[1]
  let first = 0
  while (first < body.length && body[first].trim() === '') first++
  let last = body.length
  while (last > first && body[last - 1].trim() === '') last--
  const out = [...lines.slice(0, head + 1), '', `## [${version}] - ${date}`, '', ...body.slice(first, last), '', ...lines.slice(end)]
  const link = out.findIndex(l => /^\[Unreleased\]: /i.test(l))
  const compare = previous ? `${repo}/compare/v${previous}...v${version}` : `${repo}/releases/tag/v${version}`
  const unreleased = `[Unreleased]: ${repo}/compare/v${version}...HEAD`
  if (link >= 0) out.splice(link, 1, unreleased, `[${version}]: ${compare}`)
  else out.push('', unreleased, `[${version}]: ${compare}`)
  return out.join('\n')
}

const today = () => new Date().toISOString().slice(0, 10)

function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout.replace(/\r/g, '')
}

export function main(argv) {
  const flags = new Set()
  let spec
  let date = today()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--date') date = argv[++i] ?? ''
    else if (a.startsWith('--date=')) date = a.slice('--date='.length)
    else if (a.startsWith('--')) flags.add(a)
    else spec = a
  }
  if (!spec) {
    console.error('usage: node scripts/release.mjs <major|minor|patch|x.y.z> [--dry-run] [--commit] [--tag] [--date YYYY-MM-DD]')
    return 2
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`--date must be YYYY-MM-DD, got '${date}'`)
    return 2
  }
  const dryRun = flags.has('--dry-run')
  const read = file => readFileSync(join(root, file), 'utf8')
  const plugin = JSON.parse(read(PLUGIN))
  const current = plugin.version
  const repo = String(plugin.repository ?? '').replace(/\.git$/, '').replace(/\/$/, '')
  if (!repo) throw new Error(`${PLUGIN} has no repository URL for the changelog links`)
  const changelog = read(CHANGELOG)
  const next = bump(current, spec, { allowCurrent: !releasedVersions(changelog).includes(current) })
  if ((flags.has('--commit') || flags.has('--tag')) && git(['status', '--porcelain']).trim()) {
    throw new Error('the working tree must be clean before --commit or --tag')
  }
  if (git(['tag', '--list', `v${next}`]).trim()) throw new Error(`tag v${next} already exists`)

  const changes = [
    [PLUGIN, setVersion(read(PLUGIN), current, next)],
    [PACKAGE, setVersion(read(PACKAGE), current, next)],
    [LOCK, setVersion(read(LOCK), current, next, 2)],
    [CHANGELOG, cutChangelog(changelog, next, date, repo)],
  ]
  const lock = JSON.parse(changes[2][1])
  if (lock.version !== next || lock.packages?.['']?.version !== next) throw new Error(`${LOCK} did not take the new version cleanly`)

  console.log(`${current} -> ${next} (${date})${dryRun ? ' [dry run]' : ''}`)
  for (const [file, text] of changes) {
    console.log(`  ${dryRun ? 'would write' : 'wrote'} ${file}`)
    if (!dryRun) writeFileSync(join(root, file), text)
  }
  if (dryRun) return 0
  if (flags.has('--commit')) {
    git(['add', ...changes.map(([file]) => file)])
    git(['commit', '-m', `chore: release v${next}`])
    console.log(`  committed chore: release v${next}`)
  }
  if (flags.has('--tag')) {
    git(['tag', `v${next}`])
    console.log(`  tagged v${next}; push it with: git push origin v${next}`)
  } else {
    console.log(`  next: land this on main, then on main run: git tag v${next} && git push origin v${next}`)
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    console.error(`release: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
}
