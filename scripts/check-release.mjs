#!/usr/bin/env node
// Checks that the manifests, the changelog, and (for a pull request) the diff agree on
// versioning: every manifest carries one version, the newest changelog section is that
// version, a change to shipped files comes with a changelog entry, and a version bump
// comes with its dated section and an empty Unreleased.
//
//   node scripts/check-release.mjs [--base <git ref>]
//
// SKIP_CHANGELOG=1 waives the changelog-entry rule for one run (CI sets it from the
// `skip-changelog` label). Pure helpers are exported for the unit tests.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CHANGELOG, LOCK, PACKAGE, PLUGIN, compareVersions, hasEntries, releasedVersions, root, unreleasedSection } from './release.mjs'

export { releasedVersions }

// Paths whose change ships to a user of the plugin, so a pull request touching them owes a changelog entry.
const SHIPPED = [/^(src|bin|skills|agents)\//, /^hooks\/(?!.*\.test\.tsx?$)/, /^\.claude-plugin\/plugin\.json$/, /^types\/index\.d\.ts$/]

export const isShipped = path => SHIPPED.some(re => re.test(path.replace(/\\/g, '/')))

export function checkManifests({ plugin, pkg, lock }) {
  const errors = []
  const version = plugin.version
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) errors.push(`${PLUGIN} version '${version}' is not x.y.z`)
  if (pkg.version !== version) errors.push(`${PACKAGE} is ${pkg.version} but ${PLUGIN} is ${version}`)
  if (lock && lock.version !== version) errors.push(`${LOCK} is ${lock.version} but ${PLUGIN} is ${version}`)
  if (lock && lock.packages?.['']?.version !== version) errors.push(`${LOCK} root package is ${lock.packages?.['']?.version} but ${PLUGIN} is ${version}`)
  return errors
}

export function checkChangelog(text, version) {
  const errors = []
  try {
    unreleasedSection(text.split('\n'))
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)]
  }
  const released = releasedVersions(text)
  const newest = released[0]
  if (newest && newest !== version) {
    errors.push(
      compareVersions(newest, version) > 0
        ? `${CHANGELOG} has a section for ${newest} but the manifests say ${version}; bump them with scripts/release.mjs`
        : `the manifests say ${version} but the newest ${CHANGELOG} section is ${newest}; cut the release with scripts/release.mjs`,
    )
  }
  for (let i = 1; i < released.length; i++) {
    if (compareVersions(released[i - 1], released[i]) <= 0) errors.push(`${CHANGELOG} sections are out of order at ${released[i]}`)
  }
  return errors
}

// Rules over a pull request's diff against its base.
export function checkDiff({ changed, baseVersion, version, changelog, skip = false }) {
  const errors = []
  const files = changed.map(p => p.replace(/\\/g, '/'))
  const shipped = files.filter(isShipped)
  const touchedChangelog = files.includes(CHANGELOG)
  if (shipped.length > 0 && !touchedChangelog && !skip) {
    errors.push(`${shipped.length} shipped file(s) changed without a ${CHANGELOG} entry (${shipped.slice(0, 3).join(', ')}${shipped.length > 3 ? ', ...' : ''}); add one under Unreleased or label the pull request skip-changelog`)
  }
  if (baseVersion !== version) {
    if (!releasedVersions(changelog).includes(version)) errors.push(`the version moved ${baseVersion} -> ${version} but ${CHANGELOG} has no "## [${version}]" section`)
    try {
      if (hasEntries(unreleasedSection(changelog.split('\n')).body)) errors.push(`the version moved to ${version} but ${CHANGELOG} still has entries under Unreleased`)
    } catch {
      // The missing Unreleased section is already reported by checkChangelog.
    }
  }
  return errors
}

function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout.replace(/\r/g, '')
}

export function main(argv) {
  const at = argv.indexOf('--base')
  const base = at >= 0 ? argv[at + 1] : undefined
  if (at >= 0 && !base) {
    console.error('usage: node scripts/check-release.mjs [--base <git ref>]')
    return 2
  }
  const read = file => readFileSync(join(root, file), 'utf8')
  const plugin = JSON.parse(read(PLUGIN))
  const changelog = read(CHANGELOG)
  let lock
  try {
    lock = JSON.parse(read(LOCK))
  } catch {
    lock = undefined
  }
  const errors = [...checkManifests({ plugin, pkg: JSON.parse(read(PACKAGE)), lock }), ...checkChangelog(changelog, plugin.version)]
  if (base) {
    const changed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean)
    let baseVersion = plugin.version
    try {
      baseVersion = JSON.parse(git(['show', `${base}:${PLUGIN}`])).version
    } catch {
      // No plugin manifest at the base: nothing to compare the version against.
    }
    errors.push(...checkDiff({ changed, baseVersion, version: plugin.version, changelog, skip: Boolean(process.env.SKIP_CHANGELOG) }))
  }
  for (const e of errors) console.error(process.env.GITHUB_ACTIONS ? `::error::${e}` : `error: ${e}`)
  if (errors.length === 0) console.log(`release check ok: version ${plugin.version}${base ? `, diff against ${base}` : ''}`)
  return errors.length === 0 ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    console.error(`check-release: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
}
