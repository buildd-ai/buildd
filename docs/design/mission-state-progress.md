# Mission State & Projected Progress

**Status:** Proposed
**Related:** `docs/design/task-presentation.md`, `src/lib/mission-health.ts`, `packages/core/mission-helpers.ts`

---

## Problem

### 1. The status badge asserts things that are false

Mission `4281aa9b` is in `orchestrationMode: manual` — the orchestrator is idle by design. Its card renders:

```
ON SCHEDULE          Next run in 9m
```

There is no next run. Manual mode suppresses all orchestrator initiative: no heartbeat evaluation, no task spawning, no retrigger (memory d883107d). The card promises an event that will never fire, on a mission that was deliberately disarmed.

This is worse than showing nothing. A disarmed chain that reads "on schedule" will be left alone, and it will sit dead. Manual mode also disables the organizer's retry and PR-conflict coordination, so a stuck mission has nothing coming to rescue it.

### 2. "On schedule" is the wrong question

The badge renders `on_track` from `src/lib/mission-health.ts`, whose state vocabulary — `on_track`, `needs_attention`, `starting`, `complete` — was built for the dispatch UI rendering missions as "objectives" (memory 9da51433). It collapses two orthogonal axes into one word:

- **Armed** — will the orchestrator act? (auto vs manual, quiet hours, seats full, deferral)
- **Healthy** — are tasks failing, stalled, or blocked?

These are independent. A manual mission is disarmed and healthy. An auto mission can be armed and failing. One badge cannot express the pair, and the project-management phrasing ("on schedule") implies a completion-date claim the system never actually computes.

### 3. The bar shows the past but not the present

Progress renders completed/total. The task running *right now* — the thing that will change the number in the next few minutes — is invisible. The user cannot distinguish "25% and advancing" from "25% and dead."

### 4. Mission and task views don't cross-link

The mission card knows `1/4` but not *which* task is in flight. Home's Right Now knows the running task but (today) not its mission. The two halves of the same question live on different pages with no link between them.

---

## Design

### Badge: two slots, not one

Replace the single status badge.

**Slot 1 — drive state.** Always present. Answers "will anything happen without me?"

| State | Condition |
|---|---|
| `AUTO` | orchestrationMode auto, armed, next run scheduled |
| `MANUAL` | orchestrationMode manual — render "Disarmed · Run now to advance" |
| `QUIET HOURS` | within configured quiet window |
| `SEATS FULL` | deferred for capacity — use existing `lastDeferralReason` / `lastDeferredAt` |
| `COMPLETE` | terminal |

**Slot 2 — health.** Rendered **only when non-nominal**: `BLOCKED`, `FAILING`, `STALLED`. A badge that always says something reassuring is noise; silence is the healthy signal.

**Hard rule:** when drive state is `MANUAL`, suppress "Next run in Nm" entirely. Never render a countdown to an event that cannot occur.

### Progress bar: segmented, projected, shared vocabulary

The mission progress bar and the task chain strip (`docs/design/task-presentation.md`) are the same object at different zoom levels. They must use one visual language.

| Segment | Meaning |
|---|---|
| solid | completed **and** PR merged |
| half | completed, PR open — dependency gate unsatisfied |
| **ghost** (hatched) | in flight now — projected completion |
| empty | pending |
| notch | failed |

The ghost segment is the answer to "where will we be soon." It renders contiguous with solid so the eye reads *now → soon* without a legend. Multiple in-flight tasks ⇒ multiple ghost segments.

**Ghost must be distinguishable without color** — hatch or stipple, not a tint. The palette is near-monochrome and the distinction is load-bearing.

### Cross-link

Bidirectional, closing the loop the task-presentation spec opened:

- **Mission card** names and links its in-flight task(s): `▸ TaskCard component — 12m, 4 turns`
- **TaskCard** tier 1 names and links its mission (already specced)

When a mission has more in-flight tasks than fit, show the longest-running and a `+N` link to the mission's task list.

### Mobile / desktop

- **≤8 segments:** discrete glyphs. **>8:** continuous bar with proportional fills — a 30-task mission cannot render 30 glyphs at 340px.
- **Mobile:** badge row wraps, drive state first. Health badge only when non-nominal. In-flight task name truncates to one line. Ghost hatching needs a minimum segment width; below it, fall back to the continuous bar.
- **Desktop:** full segment run plus in-flight task line.

---

## Single source of truth

`computeMissionProgress()` in `packages/core/mission-helpers.ts` is canonical (memory 769a0b7f) — filters `isDeliverableTask()`, excludes cancelled so duplicate-killing cannot block 100%, counts failed against progress.

**Three call sites compute progress today:** the list route `/api/missions`, the detail route `/api/missions/[id]`, and the RSC page `missions/[id]/page.tsx`. The projected/ghost segment must be added to the helper once and consumed by all three — not implemented per surface. Verify no fourth site has appeared.

---

## Open questions

**Does a half segment belong on the mission bar?** The completed-but-unmerged state matters enormously for *task* chains (it's the dependency gate). At mission zoom it may be more noise than signal, since a mission's own completion doesn't gate on PR merge the same way. Leaning include-it-for-consistency, but a reviewer who disagrees has a case.

**Should `mission-health.ts` be rewritten or wrapped?** Its four-state vocabulary is consumed by the dispatch UI's objectives endpoint. Splitting into drive/health may break that consumer. Safer path is to add the new derivation alongside and migrate dispatch separately; confirm the objectives contract before changing the existing export.

---

## Acceptance

- No mission ever renders a "next run" countdown while `orchestrationMode = manual`.
- Drive state and health are separately legible; a disarmed-but-healthy mission is visually distinct from an armed-and-failing one.
- The currently-running task's contribution is visible on the bar, distinguishable without color.
- Mission card links to its in-flight task; task links to its mission.
- Progress projection lives in `computeMissionProgress()` only; no surface recomputes it.
- Segment vocabulary matches the task chain strip exactly.
