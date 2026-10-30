import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bump, cutChangelog, setVersion } from '../../scripts/release.mjs'
import { checkChangelog, checkDiff, checkManifests, isShipped } from '../../scripts/check-release.mjs'

const REPO = 'https://github.com/fantomc0der/claude-plugin-cruise'

const FIRST = ['# Changelog', '', 'Intro.', '', '## [Unreleased]', '', '### Added', '', '- The CLI.', '- The mod.', '', `[Unreleased]: ${REPO}/compare/main...HEAD`, ''].join('\n')

const LATER = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Fixed',
  '',
  '- A bug.',
  '',
  '## [0.1.0] - 2026-10-01',
  '',
  '### Added',
  '',
  '- Everything.',
  '',
  `[Unreleased]: ${REPO}/compare/v0.1.0...HEAD`,
  `[0.1.0]: ${REPO}/releases/tag/v0.1.0`,
  '',
].join('\n')

test('bump handles the three keywords and an explicit version above the current one', () => {
  assert.equal(bump('0.1.0', 'patch'), '0.1.1')
  assert.equal(bump('0.1.9', 'minor'), '0.2.0')
  assert.equal(bump('1.4.2', 'major'), '2.0.0')
  assert.equal(bump('0.1.0', '0.3.0'), '0.3.0')
  assert.throws(() => bump('0.2.0', '0.1.5'), /below the current/)
  assert.throws(() => bump('0.1.0', 'huge'), /not major, minor, patch/)
})

test('bump releases the current version as is only when it was never released', () => {
  assert.throws(() => bump('0.1.0', '0.1.0'), /already released/)
  assert.equal(bump('0.1.0', '0.1.0', { allowCurrent: true }), '0.1.0')
})

test('setVersion rewrites only the version fields and keeps the rest of the file byte for byte', () => {
  const text = '{\n  "name": "x",\n  "version": "0.1.0",\n  "engines": { "node": ">=18" }\n}\n'
  assert.equal(setVersion(text, '0.1.0', '0.2.0'), text.replace('"version": "0.1.0"', '"version": "0.2.0"'))
  const lock = '{"version": "0.1.0", "packages": {"": {"version": "0.1.0"}, "node_modules/a": {"version": "0.1.0"}}}'
  const out = setVersion(lock, '0.1.0', '0.2.0', 2)
  assert.equal(JSON.parse(out).packages['node_modules/a'].version, '0.1.0')
  assert.throws(() => setVersion(text, '0.1.0', '0.2.0', 2), /expected 2/)
})

test('cutChangelog turns the first Unreleased into a tagged section and a release link', () => {
  const out = cutChangelog(FIRST, '0.1.0', '2026-10-11', REPO)
  assert.match(out, /## \[Unreleased\]\n\n## \[0\.1\.0\] - 2026-10-11\n\n### Added\n\n- The CLI\.\n- The mod\.\n\n\[Unreleased\]/)
  assert.ok(out.includes(`[Unreleased]: ${REPO}/compare/v0.1.0...HEAD\n[0.1.0]: ${REPO}/releases/tag/v0.1.0\n`))
  assert.ok(!out.includes('compare/main...HEAD'))
})

test('cutChangelog compares a later release against the previous tag and keeps older sections', () => {
  const out = cutChangelog(LATER, '0.1.1', '2026-10-11', REPO)
  assert.match(out, /## \[Unreleased\]\n\n## \[0\.1\.1\] - 2026-10-11\n\n### Fixed\n\n- A bug\.\n\n## \[0\.1\.0\] - 2026-10-01/)
  assert.ok(out.includes(`[Unreleased]: ${REPO}/compare/v0.1.1...HEAD\n[0.1.1]: ${REPO}/compare/v0.1.0...v0.1.1\n[0.1.0]: ${REPO}/releases/tag/v0.1.0\n`))
})

test('cutChangelog refuses an empty Unreleased section', () => {
  const cut = cutChangelog(LATER, '0.1.1', '2026-10-11', REPO)
  assert.throws(() => cutChangelog(cut, '0.1.2', '2026-10-12', REPO), /no entries/)
})

test('checkManifests wants one version across plugin, package, and lock', () => {
  const lock = v => ({ version: v, packages: { '': { version: v } } })
  assert.deepEqual(checkManifests({ plugin: { version: '0.1.0' }, pkg: { version: '0.1.0' }, lock: lock('0.1.0') }), [])
  assert.equal(checkManifests({ plugin: { version: '0.1.0' }, pkg: { version: '0.2.0' }, lock: lock('0.1.0') }).length, 1)
  assert.equal(checkManifests({ plugin: { version: '0.2.0' }, pkg: { version: '0.2.0' }, lock: lock('0.1.0') }).length, 2)
  assert.deepEqual(checkManifests({ plugin: { version: '0.1.0' }, pkg: { version: '0.1.0' }, lock: undefined }), [])
})

test('checkChangelog accepts no sections before the first release and the newest section matching the version', () => {
  assert.deepEqual(checkChangelog(FIRST, '0.1.0'), [])
  assert.deepEqual(checkChangelog(LATER, '0.1.0'), [])
  assert.match(checkChangelog(LATER, '0.2.0')[0], /newest CHANGELOG.md section is 0\.1\.0/)
  assert.match(checkChangelog(cutChangelog(LATER, '0.1.1', '2026-10-11', REPO), '0.1.0')[0], /bump them/)
  assert.match(checkChangelog('# Changelog\n\n## [0.1.0] - 2026-10-01\n', '0.1.0')[0], /no "## \[Unreleased\]"/)
})

test('isShipped names what a user of the plugin receives', () => {
  for (const p of ['src/cli.mjs', 'bin/cruise', 'hooks/register.ts', 'hooks/lib/view.ts', 'skills/cruise/SKILL.md', 'agents/builder.md', '.claude-plugin/plugin.json', 'types/index.d.ts']) assert.ok(isShipped(p), p)
  for (const p of ['hooks/register.test.ts', 'tests/unit/cli.test.mjs', 'README.md', 'package.json', '.github/workflows/ci.yml', 'types/vendor/claude-code.d.ts']) assert.ok(!isShipped(p), p)
})

test('checkDiff wants a changelog entry with shipped changes unless skipped', () => {
  const base = { baseVersion: '0.1.0', version: '0.1.0', changelog: LATER }
  assert.deepEqual(checkDiff({ ...base, changed: ['README.md'] }), [])
  assert.deepEqual(checkDiff({ ...base, changed: ['src/cli.mjs', 'CHANGELOG.md'] }), [])
  assert.match(checkDiff({ ...base, changed: ['src/cli.mjs'] })[0], /without a CHANGELOG.md entry/)
  assert.deepEqual(checkDiff({ ...base, changed: ['src/cli.mjs'], skip: true }), [])
})

test('checkDiff wants a dated section and an empty Unreleased when the version moves', () => {
  const cut = cutChangelog(LATER, '0.1.1', '2026-10-11', REPO)
  const changed = ['.claude-plugin/plugin.json', 'package.json', 'package-lock.json', 'CHANGELOG.md']
  assert.deepEqual(checkDiff({ changed, baseVersion: '0.1.0', version: '0.1.1', changelog: cut }), [])
  const errors = checkDiff({ changed, baseVersion: '0.1.0', version: '0.1.1', changelog: LATER })
  assert.equal(errors.length, 2)
  assert.match(errors[0], /no "## \[0\.1\.1\]" section/)
  assert.match(errors[1], /still has entries under Unreleased/)
})
