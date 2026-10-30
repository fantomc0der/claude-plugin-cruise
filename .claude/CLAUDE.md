# cruise: contributor instructions

cruise is a Claude Code plugin. It bundles a skill (`skills/cruise/`), three agent definitions (`agents/`), a zero-dependency Node CLI (`bin/cruise`, source in `src/`) that owns the run state and the settings hooks, and a mod (`hooks/register.ts`) that draws the run and answers `/helm`. `docs/design.md` is the design; keep it current when behavior changes.

## Layout rules the plugin loader imposes

- This file lives in `.claude/`, not at the repo root. A root `CLAUDE.md` is not loaded by the plugin and makes `claude plugin validate` warn.
- `bin/` is on the Bash tool PATH while the plugin is enabled, which is how the skill calls `cruise` as a bare command.
- `skills/cruise/SKILL.md` becomes `/cruise:cruise`; `agents/*.md` become `cruise:<name>`.
- `hooks/hooks.json` holds both the settings hooks (Stop, UserPromptSubmit, SessionStart, all routed to `bin/cruise hook <event>`) and the `modules` entry for the mod.
- The mod has no Node APIs. Anything that needs a process goes through `$.process.run` with an absolute path under `$.plugin.root`.

## Working on it

- Run the plugin from the checkout: `claude --plugin-dir .` (hot reloads the mod on each turn in an interactive session).
- Validate before every commit: `npm run validate` (`claude plugin validate . --strict`).
- Unit tests: `npm test` (`node --test` over `tests/unit`; the CLI and hooks run against a temporary project directory).
- Mod tests: `npm run test:mod` (`claude plugin test .`).
- Type check: `npm run typecheck` (`tsc -p .`) against `types/vendor/claude-code.d.ts`, the engine's own declaration files for `claude-code` and `claude-code-tools` concatenated. Refresh it after a Claude Code bump from `.claude-plugin/types/`, which the engine writes beside the mod on an interactive `claude --plugin-dir .` load (that folder is gitignored), and bump `CLAUDE_CODE_VERSION` in `ci.yml` to match its first line.

## Conventions

- Zero runtime dependencies. `typescript` is the only dev dependency.
- The token budget is the product. Every line in `skills/cruise/SKILL.md`, `agents/*.md`, and every string the hooks hand to the model is paid for on every run. Add a line only when a run goes wrong without it, and say what to do, not why.
- Mod rules the validator enforces: `$.env.get` takes string literals; a helper that receives the engine interface must be a top-level function declaration in `hooks/register.ts`, never an import; a hook that refuses something carries a `.catch` that still refuses.
- The CLI is the only writer of `.cruise/run.json`. Hooks read it and go through the same `src/` functions. Every subcommand prints one JSON document on stdout with `--json`, a short text summary otherwise, and `{ "error": { "code", "message", "hint" } }` on stderr with exit 1 on failure (2 for usage).
- Hook subcommands (`cruise hook stop|prompt|session-start`) never fail the event: on any error they print nothing and exit 0.
- Prose in markdown is never hard-wrapped; one paragraph is one line.
- Source comments describe current behavior, never the history of an edit.
- Do not touch whitespace on lines you are not otherwise changing. Do not run repo-wide formatters.
- Commit messages use conventional prefixes (`feat:`, `fix:`, `docs:`, `ci:`, `test:`, `chore:`).

## Versioning and release

- Versions move at release time, not per PR. A PR that changes what ships (`src/`, `bin/`, `hooks/` outside tests, `skills/`, `agents/`, `plugin.json`, `types/index.d.ts`) adds an entry under `## [Unreleased]` in `CHANGELOG.md`; CI's `release-gate` job fails without one unless the PR carries the `skip-changelog` label.
- `version` in `.claude-plugin/plugin.json`, `package.json`, and `package-lock.json` must match, and the newest `CHANGELOG.md` section must be that version. `npm run check:release` verifies this locally and in CI.
- To cut a release, on a branch run `npm run release -- <major|minor|patch|x.y.z>` (add `--dry-run` to preview). It bumps the three manifests, turns Unreleased into a dated `## [x.y.z]` section, and fixes the compare links; commit it as `chore: release vX.Y.Z` and open a PR. Once it lands, tag `vX.Y.Z` on `main` (`git tag vX.Y.Z && git push origin vX.Y.Z`), which triggers `release.yml`: it checks the tag against the manifests and publishes a GitHub release with the changelog section as the body.
