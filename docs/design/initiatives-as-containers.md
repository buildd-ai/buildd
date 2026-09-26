# Initiatives as containers

**Status:** Implemented
**Related:** `docs/specs/initiatives.md` (the contract), `docs/specs/surface-ia-home-missions-initiatives.md`, `docs/design/linear-hierarchy-ingest.md`, `apps/web/src/lib/initiative-view.ts`, `apps/web/src/lib/initiative-cards.ts`, `apps/web/src/components/initiatives/InitiativeCard.tsx`

Supersedes `docs/design/initiative-surfaces.md` and the derived verdict in the
surface-IA spec.

## Problem

The Initiatives list graded every initiative with a derived word, and the words
contradicted the rows they sat on. On a real team the header read
`7 arcs · 1 losing · 2 stuck · 1 ready to close`, and:

- `LOSING` sat on an initiative at 4/4 missions, 19/19 tasks, 100%. A KPI
  evaluated as failing after the last mission closed. The row never said which
  KPI, in which direction, or since when.
- `STUCK` sat on initiatives at 100% with `1 held` on its own line. The ladder
  counted `isHeld` on every mission, finished ones included, and gave
  `Ready to close` only to initiatives whose status was `active`. A paused
  initiative with a finished mission that kept its hold flag fell through to
  `Stuck`.
- `READY TO CLOSE · unverified` sat at 1/1 missions and 3/4 tasks. The
  percentage counted missions, the task count counted tasks, and nothing
  explained the fourth task.
- Beside every `100%` sat a dashed line. It was a 14-day token sparkline, not a
  progress bar; an initiative with no work this fortnight draws 14 hairlines.
- "Arcs" appeared in the header and nowhere else in the product.

The owner's verdict: the derived-health layer offers little benefit. Initiatives
were meant to be the top of the hierarchy, a named container like a Linear
initiative.

## Proposal

An initiative is a title, a description, an owner, an optional target date, a
status a person sets (`planned`, `active`, `paused`, `completed`, plus
`archived`), and its missions. Nothing derives the status.

**The crux:** attention comes from missions, never from a grade on the
initiative. Each mission already has one status word on the Missions tab
(`buildMissionListCard`). The initiative card reuses that model per mission and
states facts: `1 mission needs you`, `1 mission held`, `All 4 missions done`,
each linked. If this were wrong, an initiative could need you with no mission
saying so; the model rules that out because every fact names a mission.

Progress is missions done over missions, drawn as one bar segment per mission. A
done mission is a solid segment and an open one fills to its tasks done, so the
count of solid segments equals the `n` in `n/N missions done`. The card shows
no percentage.

The card offers one next action: answer the first ask, arm the first held
mission, mark the initiative completed, add a first mission, or open it. The
list groups cards as Needs you, Active, Planned, Paused, Completed, with
Completed collapsed.

Schema: two nullable columns, `initiatives.owner_user_id` (FK users, set null)
and `initiatives.target_date` (date). `planned` needs no migration because
`status` is a text column.

## What was removed, and what stayed

Removed: the verdict ladder and confidence (`initiative-pulse.ts`,
`verdict-presentation.ts`), the list zones and dismissal, the Home pulse line,
the effort sparkline, `GET /api/initiatives/effort`, the detail page's verdict
block, KPI panel and close control, and the display-status helpers in
`initiative-presentation.ts`.

Deprecated, still working: initiative KPIs (`kpis`, `kpiState`, `autoVerify`,
the evaluate route, MCP `evaluate` and `get_kpi_state`). Buildd cannot enforce a
metric that lives outside it, and mission goal criteria cover what it can check.
A follow-up removes them and starts the column-drop protocol for `kpis`,
`kpi_state`, `auto_verify` and the never-written `progress_cache`.

Kept: `loadInitiativeList` for `GET /api/initiatives` and Home's
`<title> crossed 75%` headline; the Linear tracking panel; initiative artifacts.

## Open questions

- Initiative updates, Linear-style periodic notes. Lean: skip until someone asks.
  Mission notes do not map onto them cheaply.
- An owner picker in the dashboard. The API and MCP accept `ownerUserId`; the
  form defaults the owner to the creator. Lean: add the picker when a team has
  more than one person creating initiatives.

## Non-goals

- A declared health (`On track`, `At risk`).
- Any automatic status change, including closing an initiative when its
  missions finish. The card offers `Mark completed`; a person presses it.
