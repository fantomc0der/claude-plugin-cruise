# cruise

Autonomous plan, build, verify, review runs for Claude Code that stay lean on tokens.

cruise is a Claude Code plugin. Give it a feature or a product idea and it plans the work, builds it with one small agent per task, runs the project's checks until they pass, has the result reviewed once, and reports back, without you steering each step. A Stop hook keeps the run going whenever the model would otherwise end its turn, so a run finishes on its own or pauses with a question for you. It does what oh-my-claudecode's autopilot does, with a prompt surface about a tenth the size: one short skill, three agents under 25 lines each, a settings hook that reads a state file instead of the transcript, and no per-tool-call hooks. `docs/design.md` has the numbers.

```text
> /cruise Add CSV export to the reports page, with a unit test for the formatter

● cruise start --session … "Add CSV export …"      ⚠ cruise: plan · tasks 0/0
● navigator writes .cruise/plan.md (4 tasks)
● cruise plan import; cruise phase build            ⚠ cruise: build · tasks 0/4
● builder T1, builder T2 (parallel) … cruise task done 1 2
● builder T3, T4 … cruise task done 3 4             ⚠ cruise: build · tasks 4/4
● npm test … cruise verify pass; cruise phase review ⚠ cruise: review · tasks 4/4
● reviewer: verdict: pass, 1 minor
● cruise review pass; cruise phase done
  Assumptions you may want to veto: … Built: … Verified: … Open: …
```

## Install

```text
/plugin install cruise --marketplace fantomc0der/claude-plugin-cruise
```

Answer `y` to add the marketplace, then pick the user scope. To run from a checkout instead: `claude --plugin-dir /path/to/claude-plugin-cruise`.

## Requirements

- Claude Code 2.1.314 or newer (tested there; the Stop hook uses `additionalContext`, and the mod needs 2.1.287 or newer).
- Node.js 18 or newer. The `cruise` CLI has no dependencies.

## Use

Ask in plain words, or use the skill directly:

```text
/cruise Build a CLI that tracks daily habits with streak counting, in TypeScript
/cruise resume
/cruise status
/cruise stop
```

"autopilot", "build me", "make me", "handle it all", and "end to end" also trigger the skill. The run then goes through five phases:

| Phase | Who | What happens | Moves on when |
| :- | :- | :- | :- |
| plan | `cruise:navigator` (Opus, read-only), or the lead for a small request | Reads the codebase, writes `.cruise/plan.md`: goal, assumptions, verification commands, tasks with files and a done-when check | The lead has checked the plan against the request and imported the tasks |
| build | One `cruise:builder` (Sonnet) per task, in parallel when independent; the lead does tiny tasks itself | Each builder changes only its task's files, runs the task's check, and reports in under 120 words | Every task is done, or skipped with a reason |
| verify | The lead | Runs the plan's build, lint, and test commands; fixes failures itself or with one builder | The checks pass. After 5 cycles, or the same error 3 times, the run pauses |
| review | One `cruise:reviewer` (Opus, read-only) | One pass for completeness against the plan, correctness, security on new inputs, and tests; findings rated blocking or minor | No blocking findings. After 2 failed rounds, the run pauses |
| done | The lead | Reports: assumptions you may want to veto, what was built, how it was verified, open minor findings | The turn ends |

A question for you pauses the run; your answer resumes it. Say "stop" at any time, or use `/helm stop`.

### Watching a run

With the mod loaded (it is, by default), a line under the prompt follows the run, a toast marks each transition, and `/helm` answers at once, even while the model is working:

| Command | Does |
| :- | :- |
| `/helm status` | Where the run is and what comes next |
| `/helm pane` | A pane with the task list, the counters, and resume and stop buttons |
| `/helm pause <question>` | Pause the run with a question you want answered first |
| `/helm resume` | Continue a paused or stalled run in this session |
| `/helm stop [reason]` | Stop the run after the current turn (Esc interrupts the turn itself) |
| `/helm log` | The last run events |

The mod only draws. The run works the same without it, including in `claude -p`.

### The CLI

The model drives the run through `cruise`, which is on the Bash tool's PATH while the plugin is enabled. You can use it too, from a shell in the project:

```text
cruise start "<task>" [--session ID] [--force]
cruise status [--json]
cruise phase plan|build|verify|review|done [--force --reason "..."]
cruise plan import [path]
cruise task list | done <id...> | start <id...> | block <id> --reason "..." | skip <id> --reason "..." | add "<title>"
cruise verify pass|fail ["<error>"]
cruise review pass|fail ["<summary>"]
cruise pause "<question>"
cruise resume [--session ID]
cruise stop [--reason "..."]
cruise log [--n N]
```

State lives in `.cruise/` at the project root (`run.json`, `plan.md`, `log.jsonl`, `history/`). `cruise start` adds `.cruise/` to `.git/info/exclude`, so it stays out of your repository without touching `.gitignore`.

### Limits

| Variable | Default | Meaning |
| :- | :- | :- |
| `CRUISE_MAX_VERIFY_CYCLES` | 5 | Verify failures before the run pauses |
| `CRUISE_MAX_REVIEW_ROUNDS` | 2 | Failed review rounds before the run pauses |
| `CRUISE_MAX_IDLE_NUDGES` | 3 | Stops without a state change before the run is parked as stalled |

Set them in the `env` block of your Claude Code settings, or in the shell that runs `cruise start`. They are read when a run starts.

### Headless

```bash
claude -p "/cruise:cruise Add CSV export to the reports page" --permission-mode acceptEdits --max-turns 60 --max-budget-usd 10
```

The Stop hook continues the conversation in print mode too. The turn and budget caps are the backstop.

## How it keeps going

The model ends a turn; Claude Code fires the Stop hook; `cruise hook stop` reads `.cruise/run.json`. If the run is active, bound to this session, and not done, the hook answers with three lines (the run's summary, the next step for its phase, how to pause or stop) and the conversation continues. If the model stops three times without changing the state, the run is parked as stalled rather than looping. The hook prints nothing when there is no run, when the run is paused or finished, or when it belongs to another session. Two more hooks add one line each: on a prompt during a run (how the message relates to the run) and at session start when a run is unfinished (how to resume it).

## Troubleshooting

- **The run does not continue after the model stops.** Check `cruise status` in the project: a `paused` run waits for you, a `stalled` run needs `/helm resume` or `/cruise resume`, and a run bound to another session (`cruise status --json` shows `session_id`) is ignored by this one; `cruise resume --session <this session's id>` rebinds it, or `/cruise resume` does it for you.
- **The model asks a question without pausing.** Answer it; the prompt hook tells the model the run is active and it carries on. Mention "pause" if you want it to use `cruise pause` next time.
- **`cruise` is not found in Bash.** The plugin's `bin/` directory is on the Bash tool's PATH only while the plugin is enabled; from your own shell, call `node <plugin dir>/bin/cruise`.
- **A run from an old session is in the way.** `cruise stop` or `cruise start --force "<task>"` (the old run is archived under `.cruise/history/`).

## Development

`.claude/CLAUDE.md` has the conventions and `docs/design.md` the design. `npm run validate`, `npm test`, `npm run typecheck`, `npm run test:mod`, and `npm run check:release` are what CI runs. Releases are cut with `npm run release -- <major|minor|patch|x.y.z>` and a `vX.Y.Z` tag on `main`.

## License

MIT
