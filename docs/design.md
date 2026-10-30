# cruise: design

cruise recreates the useful core of oh-my-claudecode's autopilot (an idea goes in, verified code comes out, nobody has to babysit the session) with a fraction of the prompt surface. This document records what a run is made of, where the tokens go, and what was dropped on purpose.

## The shape of a run

A run is one state file, one plan file, and one session that the Stop hook keeps working until the run is done.

```text
/cruise <request>
   │
   ▼
cruise start ──► .cruise/run.json  { phase: plan, tasks: [], verify, review, nudge }
   │
   ▼  plan      navigator (Opus, read-only) writes .cruise/plan.md; the lead checks it; cruise plan import
   ▼  build     one builder (Sonnet) per task, parallel when independent; cruise task done <id>
   ▼  verify    the lead runs the plan's build, lint, and test commands; cruise verify pass|fail
   ▼  review    one reviewer (Opus, read-only), findings rated blocking or minor; cruise review pass|fail
   ▼  done      cruise phase done; the lead reports; the Stop hook lets the turn end
```

Every time the model ends its turn, Claude Code fires the `Stop` hook. The hook reads `run.json`; if the run is active and bound to this session it answers with three lines (where the run is, what comes next, how to pause or stop) and the conversation continues. It never parses the transcript and never re-injects the phase instructions: the skill is already in context, and the nudge names the skill's path for the case where compaction dropped it.

## Pieces

| Piece | Where | Runs in | Context cost |
| :- | :- | :- | :- |
| Skill | `skills/cruise/SKILL.md` | The lead's context, once per run | About 1.1k tokens |
| Agents | `agents/navigator.md`, `builder.md`, `reviewer.md` | Each spawn's system prompt | 250 to 450 tokens each |
| CLI | `bin/cruise`, `src/*.mjs` | The Bash tool and the hooks | One short line of output per call |
| Settings hooks | `hooks/hooks.json` → `cruise hook stop|prompt|session-start` | Claude Code's hook runner | Three lines on each Stop during a run; one line on a prompt during a run; one line at session start when a run is unfinished; nothing otherwise |
| Mod | `hooks/register.tsx` | Claude Code's process | None: it only draws |

The CLI is the only writer of the state. The model changes state by running `cruise ...` in Bash, which costs one short tool call, and the hooks read the same file through the same `src/` functions. That is the whole protocol: no magic completion strings, no transcript scanning, no MCP server, no per-tool-call hooks.

## The state file

`.cruise/run.json` holds one run per project. `cruise start` writes it at the git top level (or the working directory) and adds `.cruise/` to `.git/info/exclude`, so it never lands in the user's repository or their `.gitignore`.

| Field | Meaning |
| :- | :- |
| `id` | Six hex characters, for the status line and the history |
| `session_id` | The session the run belongs to. The skill passes `--session ${CLAUDE_SESSION_ID}`; an unbound run is claimed by the first session whose Stop hook sees it. `cruise resume` rebinds (or unbinds) so a new session can pick a run up |
| `status` | `active`, `paused` (waiting for the user), `stalled` (parked by the hook), `stopped`, `done` |
| `phase` | `plan`, `build`, `verify`, `review`, `done` |
| `tasks` | `{ id, title, status, note? }`, imported from the plan's `## Tasks` checklist; `cruise task done` ticks the checkbox back into the plan |
| `verify` | `cycles`, `max`, `last`, and the normalized `signature` of the last error with its `repeats` count |
| `review` | `rounds`, `max`, `last` |
| `rev` | Bumped by every CLI mutation; the Stop hook compares it to the `rev` of its last nudge to tell progress from a model that keeps stopping |
| `nudge` | `count`, `rev`, `max`: the hook's own bookkeeping, written without bumping `rev` |

A finished or replaced run is archived under `.cruise/history/`, and every transition is appended to `.cruise/log.jsonl`.

## Guards and limits

The CLI, not the prompt, enforces the order of work. `cruise phase verify` refuses while tasks are open, `cruise phase review` refuses until verify passed, and `cruise phase done` refuses until every task is done or skipped, verify passed, and review passed. `--force` with a reason is always available, and the refusal message says what is missing, so a model that gets ahead of itself is corrected by a tool result instead of by more prompt text.

| Limit | Default | Override | What happens |
| :- | :- | :- | :- |
| Verify cycles | 5 | `CRUISE_MAX_VERIFY_CYCLES` | The run pauses with a `verify limit` reason |
| Same error in verify | 3 | fixed | The run pauses; error signatures ignore numbers, paths, and case |
| Review rounds | 2 | `CRUISE_MAX_REVIEW_ROUNDS` | The run pauses with a `review limit` reason |
| Stops without progress | 3 | `CRUISE_MAX_IDLE_NUDGES` | The run is parked as `stalled` and the turn ends with a system message |
| Consecutive Stop continuations | 8 | `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (Claude Code's own) | Resets on every tool call, so a working run never hits it |

A paused run is not nudged. The user's next message arrives with one line from the prompt hook that says what the run was waiting for and tells the model to `cruise resume`. `cruise resume` also gives the run its verify and review budget back, because a person intervened.

## Where the tokens go, and why cruise spends fewer

oh-my-claudecode's autopilot is good at the job; the cost comes from how much text surrounds each decision. Measured on the `oh-my-claudecode` checkout at v5.7.21 and the installed v4.13.4 with `claude plugin details`:

| | oh-my-claudecode autopilot | cruise |
| :- | :- | :- |
| Skill loaded per run | 12 KB (about 3.7k tokens), including workflow profiles, team runtimes, and interview pipelines that most runs never use | 4.3 KB (about 1.1k tokens) |
| Agent definitions used | analyst 6 KB, architect 8 KB, critic 22 KB, executor 8 KB, debugger, code-reviewer 15 KB, security-reviewer 10 KB; paid on every spawn | navigator 1.8 KB, builder 1 KB, reviewer 1.3 KB |
| Spawns on a clean run | Analyst + Architect (expansion), Architect + Critic with up to 5 rounds (planning), executors, Architect + Debugger per QA failure, three Opus reviewers with up to 3 rounds | Navigator, one builder per task, one reviewer; the lead fixes obvious failures itself |
| Stop hook | Re-injects a full phase prompt from a 435-line template file; the hook itself scans the transcript for completion signals | Three lines read off the state file |
| Per-tool-call hooks | PreToolUse, PostToolUse, SubagentStart/Stop, and more, each adding reminders to context | None |
| Always-on context | About 2.3k tokens of skill and agent listings for the whole plugin | About 100 tokens (one skill, three agents) |

Three design choices do most of the saving:

1. **One planner, one reviewer.** The Analyst, Architect, and Critic trio becomes one navigator that writes a plan in a fixed shape, and the lead reads it with a three-point checklist. The three Opus reviewers become one reviewer with a four-point checklist whose findings are rated so only blocking ones cost another round.
2. **Inline mode.** A request that fits in two tasks and three files is planned and built by the lead itself. autopilot spawns its full pipeline for everything it is asked to do.
3. **Short replies by contract.** Every agent definition ends with a word limit and a fixed reply shape, and the skill tells the lead to trust the summary rather than re-read the files. Most of a long autonomous run is agents reporting back; keeping those reports under 150 words keeps the lead's context small for the whole run.

## What was dropped on purpose

- **Workflow profiles, team execution, Cursor workers, company-context MCP calls, the deep-interview and ralplan pipelines.** Each is a separate product; none is needed to turn a request into verified code.
- **A critic loop on the plan.** The lead's own check against the request catches the gaps that matter, and a wrong plan surfaces in verify or review anyway.
- **Transcript scanning for completion signals.** State transitions are explicit CLI calls, which are also what makes the hook simple enough to trust.
- **A separate cancel skill.** `cruise stop` is one CLI call, and `/helm stop` does it without a model turn.
- **A HUD script.** The mod draws the status line and the pane inside Claude Code instead.

## Why a mod, and only this much of one

A mod runs inside Claude Code and can draw, so it is the right tool for the two things a settings hook cannot do: show the run without spending tokens, and act on it without a model turn. The mod never touches the model's context (it registers no tools, injects no prompt sections) and the run works without it: the Stop hook, the CLI, and the skill are the whole mechanism. That keeps `claude -p` runs, sessions with mods disabled, and the Desktop app's WSL sessions on exactly the same path.

What the mod does:

- A status line under the prompt while the run is open: `build · tasks 3/7 · verify 1/5`.
- A toast on each transition: a new phase, a pause with its question, a stall, done.
- `/helm status | pane | pause <question> | resume | stop [reason] | log`, registered as immediate so `/helm stop` lands while the model is working.
- A pane with the task list, counters, and resume and stop buttons.

Two uses were considered and left out. Injecting the current phase's instructions as a system-prompt section would survive compaction better than the skill text, but it costs tokens on every request and makes the run depend on the mod loading; the Stop hook's one-line pointer to the skill file covers the compaction case for free. Registering `cruise_*` tools for state changes would read nicer than Bash calls, but every registered tool's schema is sent with every request, while a Bash call costs only when it is made.

## Measured on a sample project

A headless run (`claude -p`, Claude Code 2.1.314, other plugins and MCP servers disabled) against a two-file Node library with the request "add multiply and divide, a stats module with mean and median, tests for all four, and README docs":

| | |
| :- | :- |
| Plan | Navigator wrote 3 tasks with 8 assumptions, 3 of them marked `[veto?]` |
| Build | 3 builders, the first two in parallel; every task marked done through the CLI and ticked in the plan |
| Verify and review | Passed on the first cycle and the first round |
| Turns, time, cost | 21 API turns, 124 seconds, about $1.40 with Opus-class models for the lead, navigator, and reviewer |
| Context | 5.5k output tokens over the whole run; 519k input tokens served from the prompt cache, 31k written to it |
| Result | 5 tests passing, nothing committed, a report that led with the assumptions to veto |

The Stop hook never had to nudge on that run: the lead worked through every phase in one turn. A second headless probe exercised it on purpose: with an unbound run on disk and a prompt that asked for a one-word reply, the hook fired on the first stop, claimed the run for that session, nudged, and the model followed the nudge; the run's log reads `start, claim, nudge, stop`. The stall and session-mismatch paths are covered by the unit tests, which feed the hook the same payloads Claude Code sends.

## Resuming and running headless

- A session that starts in a project with an unfinished run gets one line from the SessionStart hook; `/cruise resume` rebinds the run to that session and continues at its phase.
- `claude -p "/cruise:cruise <request>"` works unchanged: the Stop hook continues the conversation in print mode too. Give the run `--max-turns` or `--max-budget-usd` as a backstop.
- Two sessions in one project cannot both run: `cruise start` refuses while a run is open, and a run bound to one session is invisible to the hooks and the mod of another.
