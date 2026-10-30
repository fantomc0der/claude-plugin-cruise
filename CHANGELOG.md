# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Repository scaffold: plugin and marketplace manifests, CI, release workflow, Dependabot, contributor instructions.
- `bin/cruise`, a zero-dependency Node CLI that owns the run state in `.cruise/run.json`: start, status, phase transitions with guards, plan import from the plan file's task checklist, task status with the checkbox mirrored into the plan, verify and review records with cycle limits and repeated-error detection that pause the run, pause, resume, stop, and a log.
- The `cruise` skill (`/cruise:cruise`): the lead's playbook for a run in about seventy lines, with an inline mode for small requests, and three agents under 25 lines each: `cruise:navigator` (Opus, writes the plan), `cruise:builder` (Sonnet, one task at a time), `cruise:reviewer` (Opus, one combined pass rated blocking or minor).
- The mod (`hooks/register.tsx`): a status line under the prompt that follows the run (phase, tasks, verify and review counters), a toast on each transition, the `/helm` command (`status`, `pane`, `pause`, `resume`, `stop`, `log`) that runs at once without a model turn, and a pane that lists the tasks with resume and stop buttons. Inert when the project has no run or the run belongs to another session.
- Settings hooks routed through the CLI: a Stop hook that keeps an active run going with a three-line nudge and parks a run that makes no progress as stalled, a UserPromptSubmit hook that tells the model how a message relates to the run, and a SessionStart hook that points a fresh session at an unfinished run.

[Unreleased]: https://github.com/fantomc0der/claude-plugin-cruise/compare/main...HEAD
