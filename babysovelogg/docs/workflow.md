# Agent Workflow

How agents work in this repo. Read this once when you start a session;
it codifies the loop the project uses for non-trivial work.

## TL;DR

For each unit of meaningful work:

1. **Check `followups.md` for uncommitted state first.** Run
   `git status -- docs/followups.md`. If the doc has uncommitted edits
   that aren't part of your unit, commit those separately BEFORE
   starting your unit so your code commit doesn't bundle unrelated
   process churn. The followups.md edits that belong to YOUR unit (the
   ones removing what's now done, adding what surfaced) ship WITH your
   unit's code commit.
2. **Test-first when possible.** Write the invariant or scenario. Watch
   it fail. Then fix the engine. Snapshots come last — invariants pin
   the contract that `--update-snapshots` can't paste away.
3. **Run the full validation:**
   - `bun run test:unit` — bun:test units
   - `bun run test:integration` — integration tests
   - `bun run lint` — oxlint
   - `bun run typecheck` — svelte-check
   - For UI / route / E2E-relevant changes also: `bun run build && bun run test:e2e`
     (E2E runs against the production server, so it needs a fresh build).
4. **Codex pair-review before committing** for any non-trivial change
   (engine logic, scoring weights, time math, multi-day behavior). Use
   the `codex:rescue` agent. See "Codex pair-review" below.
5. **Lateral-thinking pass** for engine fixes. See checklist below.
6. **Update `followups.md`:** remove what's done, add what surfaced.
7. **Commit and push.** The user expects this — don't wait to be asked.

The sequence is: test → fix → validate → review → followups → commit/push.

For cross-layer changes (events, projections, API shape, optimistic
sync, prediction logic), read [`agent-guide.md`](./agent-guide.md)
first — it has the repo map and common change paths.

## `followups.md` is the durable todo

`docs/followups.md` is **the** place for tracked work that's ready for
work but not yet done. Don't reinvent: don't make `TODO.md`, `BACKLOG.md`,
`NEXT.md`, sticky-note comments, etc. Add to followups.md.

What goes in:
- Real bugs surfaced by review or testing, with enough context to act on.
- Engine design questions that need a lateral-thinking pass.
- Test/infrastructure improvements with concrete leverage.
- Coverage gaps the team has identified.

What does NOT go in:
- Speculative ideas. Capture in commit messages or memory.
- Process rules (lateral-thinking checklist, etc.). Those live in this file.
- Generic refactor wishlists. Concrete enough to act on, or not in.

After shipping a unit: edit followups.md to remove the entries that
landed, add what surfaced. Commit it WITH the unit's code so the
followup state matches the code state in history.

## Codex pair-review

Codex is a second opinion on non-trivial work. Use the `codex:rescue`
agent (subagent). Available via `Skill: codex:rescue` or by spawning the
`codex:codex-rescue` subagent type.

**When to use:**
- Engine logic changes that affect predictions.
- New invariants or test architecture.
- Anything where "is this the right design?" is a real question.
- After each unit of work, before committing, ask Codex to review.

**When to skip:**
- Snapshot updates without behavior change.
- Pure refactors with mechanical equivalence.
- Doc-only changes.

**How to brief Codex well:**
- Self-contained prompt — Codex starts cold each time.
- Cite line numbers. Codex returns more useful feedback when it can
  trace your changes against the existing code.
- Ask numbered questions. "What's the right cap value? Should this be
  in `recommendBedtime` or `selectBestPlan`? Did backtest MAE improve?"
- Use `run_in_background: true` for design / investigation prompts that
  may use parallel subagents internally; foreground for quick critiques.
- Run Codex in PARALLEL with your own work when the task is design-heavy
  ("ask codex for design help in parallel" is a standing instruction).
  Spawn the agent in background, continue your investigation, merge
  findings when both complete.

**Codex limitations to keep in mind:**
- Codex can't see chat history; brief from scratch.
- Codex sometimes recommends architecturally cleaner alternatives that
  are too big for the current unit. Treat its recommendations as design
  candidates — pick the one that fits the unit's scope, document the
  others as followups.

## Lateral-thinking checklist (engine changes)

Before committing a non-trivial engine fix, run through these:

1. **Does this serve the parent's experience over multiple days, not
   just today's snapshot output?**
2. **Are there asymmetries** (easier vs harder directions, baby's cycle,
   age-dependent tolerances) the fix should respect?
3. **Does the test setup capture the multi-day mechanic**, or only
   single-day? If single-day, is that the right granularity?
4. **What's the worst case from the baby's perspective** if this fix is
   slightly wrong? (Tolerable nudge, or "baby cries every night"?)

When the answer surfaces a real product risk, capture it in
`followups.md` as a separate followup section. When it doesn't, no doc
entry needed.

This is a checklist, not a blocker on every fix. The first version of a
target_bedtime cap (15 → 60 → asymmetric 30/15) iterated on this
exactly: each iteration was locally correct but kept solving the wrong
problem because we didn't think about parent/baby experience over days.

## Multi-day / over-time testing

Time-dependent behavior (target_bedtime convergence, learning windows,
strategy hysteresis) needs multi-day tests. Single-day snapshots show
"the engine produced X today" but not "X gets closer to ideal over a
week of acting on the suggestions."

The pattern (see
`tests/unit/engine-scenarios.unit.ts` "target_bedtime convergence: 14-day simulation"):

1. Build a starting history.
2. Loop N days: assemble state, take the prediction, append the predicted
   plan (naps + night) as that day's actual sleep, advance now to the
   next day's wake.
3. Snapshot the trail (per-day prediction line, e.g. `day 5: bedtime=18:43`).
4. Pin invariants:
   - Convergence direction (slides toward target, doesn't drift away).
   - No regressions ≥X min in the wrong direction between days.
   - Final state within Y min of target.

Faithful simulation matters. If the test only appends nights (not naps),
the learning window starves of nap data after a week and natural drifts
to defaults — that's a test artifact, not engine behavior. Append the
WHOLE plan each day.

## Snapshot tests

Read [`docs/testing.md`](./testing.md) for the canonical guidance. The
two principles that matter most:

1. **Render full visible state**, not field fragments. A renderer that
   produces a multi-line block; assert that block. New fields appear in
   the diff automatically.
2. **Pin invariants AFTER the snapshot but in the same `it()`** so
   `--update-snapshots` cannot bypass them. Examples in
   `tests/unit/engine-scenarios.unit.ts:assertInvariants`.

For non-trivial helpers: round float values in renderers (avoid
`ww=183.07692307692307m` noise); render times in local TZ with deltas;
use `none` for absent values rather than `null` / `undefined`.

## Unit-of-work flow (concrete example)

Sketch of what a unit looks like end-to-end, from the recent
target_bedtime convergence work:

1. **Prior state:** Codex review surfaced "target_bedtime is ignored"
   in `followups.md`. Diagnosis: `selectBestPlan`'s 15-min cap made
   target cosmetic.
2. **Plan unit:** Lift the cap. Single-line change.
3. **Iterate (the user pushed back twice):**
   - 60 min symmetric → too aggressive, 1h jumps disrupt baby.
   - Asymmetric 45/15 → user said "cycle alignment, gradual, lateral thinking."
   - Final: asymmetric 30/15 + multi-day convergence test.
4. **Surface deeper bug via test:** the multi-day test showed engine
   doesn't actually converge. New unit (target-nudged candidate) fixed it.
5. **Codex parallel review of the fix:** "this works but cleaner design
   is to put target into `recommendBedtime`."
6. **Refactor unit:** moved soft-anchor into recommendBedtime.

Each unit: code change + tests + Codex review + followups update +
commit/push. Every commit message describes the WHY, not just the WHAT,
and notes the Codex review outcome when applicable.

## Other rules captured along the way

- **Always commit and push after a unit of work** — the user expects
  this without being asked.
- **The user has high pain tolerance for raw test data.** Don't
  over-optimize for snapshot brevity at the cost of catching bugs.
  Render details; let helpers reduce visual noise where it's real
  noise.
- **Default to writing no comments.** Add comments only when the WHY is
  non-obvious — a hidden constraint, a subtle invariant, a workaround
  for a specific bug, behavior that would surprise a reader. Don't
  explain WHAT the code does; well-named identifiers do that. Don't
  reference the current task / fix / callers ("used by X", "added for
  the Y flow") — those belong in the PR description and rot as the
  codebase evolves. NEVER write multi-paragraph docstrings or multi-
  line comment blocks.
- **Don't add features beyond what the task requires.** If a fix
  surfaces an adjacent design question, document it in `followups.md`
  rather than expanding scope.
- **Engine changes affecting wall-clock time** must thread `now`
  through. The engine should be deterministic when `data.now` is
  supplied. (See `state.ts:buildContext` for the pattern.)
