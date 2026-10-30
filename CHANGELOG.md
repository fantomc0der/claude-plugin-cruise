# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Repository scaffold: plugin and marketplace manifests, CI, release workflow, Dependabot, contributor instructions.
- `bin/cruise`, a zero-dependency Node CLI that owns the run state in `.cruise/run.json`: start, status, phase transitions with guards, plan import from the plan file's task checklist, task status with the checkbox mirrored into the plan, verify and review records with cycle limits and repeated-error detection that pause the run, pause, resume, stop, and a log.
- Settings hooks routed through the CLI: a Stop hook that keeps an active run going with a three-line nudge and parks a run that makes no progress as stalled, a UserPromptSubmit hook that tells the model how a message relates to the run, and a SessionStart hook that points a fresh session at an unfinished run.

[Unreleased]: https://github.com/fantomc0der/claude-plugin-cruise/compare/main...HEAD
