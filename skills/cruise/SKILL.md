---
name: cruise
description: Autonomous end-to-end delivery of a feature or product idea in one run: plan, build, verify, review, report, with a Stop hook that keeps the run going until it is done. Use when the user says cruise, autopilot, "build me", "make me", "handle it all", "end to end", or wants hands-off execution of a multi-step task. Not for questions, brainstorming, or a one-line fix.
argument-hint: "<what to build> | resume | status | stop"
---

# cruise

You lead an autonomous run. A Stop hook keeps it alive: whenever you stop before the run is done, it tells you where you are and what comes next. State lives in `.cruise/run.json` and changes only through the `cruise` CLI, which is on PATH (`cruise help` lists it). Keep your messages short; detail goes in files.

## Start

Arguments: `$ARGUMENTS` (empty when the user asked in plain words; the request is then their message).

- `status` or `stop`: run that `cruise` command, report its output, stop.
- `resume`: run `cruise resume --session ${CLAUDE_SESSION_ID}`, read `.cruise/plan.md`, continue from the phase it prints.
- A request: `cruise start --session ${CLAUDE_SESSION_ID} "<the request in full>"`. If it reports an existing run, pick `cruise resume --session ${CLAUDE_SESSION_ID}` or `cruise start --force ...`.

## Phases

Move with `cruise phase <name>`: plan → build → verify → review → done. The CLI refuses a move whose conditions are unmet and says what is missing.

### plan

1. Spawn `cruise:navigator` with the request and the constraints the user gave. It reads the codebase and writes `.cruise/plan.md`: goal, assumptions, verification commands, tasks. Small request (at most 2 tasks and 3 files, obvious approach): skip the navigator and write the plan yourself in the shape `${CLAUDE_PLUGIN_ROOT}/agents/navigator.md` describes.
2. Read the plan. Every part of the request must map to a task, and no assumption may contradict what the user said; fix gaps by editing the plan yourself. No second planning agent.
3. `cruise plan import`, then `cruise phase build`.

### build

- One `cruise:builder` per task (sonnet; pass `model: "opus"` when the plan marks the task hard). Its prompt is the task's block from the plan, verbatim, plus the plan's test command. Launch independent tasks in parallel in one message; dependent ones after their prerequisites finish.
- A task touching at most 2 files you already have in context: do it yourself.
- After each result: `cruise task done <id...>`. A blocker: `cruise task block <id> --reason "..."`, then fix it, re-plan it, or `cruise task skip <id> --reason "..."`. Trust the builder's summary; do not re-read its files unless verify fails.
- All tasks resolved: `cruise phase verify`.

### verify

1. Run the plan's verification commands. Nothing to build or test in this project: `cruise verify pass "no checks"`.
2. Pass: `cruise verify pass`, then `cruise phase review`.
3. Fail: `cruise verify fail "<first error line>"`. Fix it yourself when the cause is clear, else one builder with the error text and the failing files. Re-run. The CLI pauses the run after 5 cycles or the same error 3 times; then report to the user and stop.

### review

1. Spawn one `cruise:reviewer` with the plan path and the changed files (`git status --short`, plus files created outside git). It returns `verdict: pass` or `verdict: fail (n blocking)` with findings rated blocking or minor.
2. Blocking findings: fix them (builder or yourself), re-run the verification commands, `cruise review fail "<n> blocking"`, then re-review only the fixed items. The CLI pauses after 2 failed rounds.
3. `verdict: pass`: `cruise review pass`, then `cruise phase done`.

### done

Report, briefly and in this order: assumptions the user may want to veto (from the plan), what was built (files), how it was verified (commands and results), minor findings left open, tasks blocked or skipped. Then stop.

## Rules

- A question for the user goes through `cruise pause "<question>"`; then stop. Their answer arrives as a message: run `cruise resume` and continue.
- The user says stop or cancel: `cruise stop`, report what is done, stop.
- An agent's prompt carries only what it needs: the task block, file paths, the check to run. Never the conversation.
- Commit nothing unless the request says to.
