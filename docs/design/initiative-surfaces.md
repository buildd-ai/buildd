# Initiative Surfaces

**Status:** Proposed
**Related:** `apps/web/src/app/app/(protected)/home/page.tsx`, `apps/web/src/app/app/(protected)/initiatives/[id]/page.tsx`, `apps/web/src/components/MissionProgress.tsx`, `apps/web/src/components/SegmentStrip.tsx`, `packages/core/mission-helpers.ts`, `apps/web/src/app/api/initiatives/route.ts`, `docs/design/mission-state-progress.md`
**Design artboards** (`buildd-mobile.pen`, Brutalist system — kit on board `n56H3V`): rail + arc-aware headline added to `c18a1` (Web Dashboard) & `CZXce` (Missions Feed); `Initiatives List` `jRBl7` (desktop) / `ERdN9` (mobile); `Initiative Detail` `y4vcA` (desktop) / `yOHmp` (mobile). New reusable modules: `C/InitiativeProgressBar` `jSwIH` (the shared segment primitive — the crux), `C/InitiativeCard` `qIsJa`, `C/InitiativeRail` `LbZbx`, `C/LinearBadge` `h243m`, `C/FilterChipBar` `PWTWZ`. See `docs/design/mobile-feed-spec.md` §0/§2.

---

## Problem

Home's unit of narrative is "what ran in the last 12 hours." The greeting subheading is computed as a raw throughput count:

```ts
// home/page.tsx:855
const subheading = completedLast12h > 0
  ? `Your agents shipped ${completedLast12h} thing... ${timePeriod}`
  : 'Your agents are standing by';
```

`completedLast12h` is a single `COUNT(*)` over `workers` completed in the trailing 12h (`home/page.tsx:240-251`). It answers "how busy was last night," never "how are the durable arcs going." Missions and tasks are ephemeral; **initiatives** — the execution-free planning container above missions (`schema.ts:645`) — are the durable arc, and Home does not mention them anywhere. The mission fetch on Home doesn't even select `initiativeId` (`home/page.tsx:435`).

Meanwhile the initiative feature is already half-built, and the built half diverges from the shared renderer:

- The **detail page** exists (`initiatives/[id]/page.tsx`) but renders its child-mission list with a **bespoke** row — a status dot plus `{completedTasks}/{totalTasks} · {progress}%` text (`:166-178`) — and its rollup as a **flat status-colored bar** (`:129-134`). It ignores the `segments` the API already computes and the shared `MissionProgress` / `SegmentStrip` primitives that every other mission surface uses. This is exactly the segment-renderer divergence `docs/design/mission-state-progress.md` and PR #1388 existed to prevent, reintroduced on a new page.
- There is **no list/index page** (`initiatives/page.tsx` is absent) and **no nav entry** — the detail page is only reachable by direct URL.

So initiatives exist in the data model, the API, and the MCP surface, but the human-facing dashboard neither summarizes them nor renders them consistently.

## Current state

Already shipped — do **not** rebuild:

| Surface | Location | Notes |
|---|---|---|
| Initiatives table | `schema.ts:645` | Pure planning container; `progressCache` column exists but has **no writer** — see crux |
| Rollup helper | `computeInitiativeProgress` `mission-helpers.ts:135` | Returns `{totalMissions, completedMissions, totalTasks, completedTasks, progress, status}`; status `empty\|active\|blocked\|paused\|completed` |
| List API | `GET /api/initiatives` | Returns each initiative with light `missions` index (`{id,title,status}`) + `progress` rollup; orders by `priority DESC, createdAt DESC` |
| Detail API | `GET /api/initiatives/[id]` | Returns child missions each with `{totalTasks,completedTasks,progress,segments}` + initiative `artifacts` + rollup |
| Artifact rollup | `GET /api/initiatives/[id]/artifacts` | `or(initiativeId, inArray(missionId, childIds))` — initiative + child artifacts in one query |
| Detail page | `initiatives/[id]/page.tsx` | Exists; renderer diverges (see Problem) |
| Create form | `initiatives/new/` | Exists |
| MCP `manage_initiatives` | `mcp-tools.ts:2529` | `list/create/get/update/…`; `get` builds the KB brief |
| Shared renderers | `MissionProgress`/`MissionBadges` `MissionProgress.tsx`, `SegmentStrip` `SegmentStrip.tsx` | Segment vocab `solid\|half\|ghost\|empty\|notch` from `mission-helpers.ts:4` |
| Linear panel | `TrackerProgressPanel` mounted on detail page (`:140`) | Gated on ≥1 child-mission linear link; `link_tracker` action is mission-only (`mcp-tools.ts:2654`) though `externalLinks` supports `'initiative'` (`schema.ts:1864`) |

## Proposal

Three layers, primary → secondary, plus reconciling the divergence that already shipped.

**1. Initiative rail on Home (primary).** A compact strip of initiative cards above the ephemeral Missions section: name, `progress%`, rolled-up `completedMissions/totalMissions`, a status dot (`blocked` floats to warning), Linear badge when linked, and last-motion timestamp. A rail *summarizes*; a filter chip cannot — a row of four initiative names tells you nothing about state. The rail consumes the existing light list payload (tallies only, no per-task segments) — no new fetch shape, no over-fetch.

**2. List/index page + nav.** `initiatives/page.tsx` rendering the same cards as the rail, full-width, with the create-form entry point, plus a nav link. Pure read over `GET /api/initiatives`.

**3. Reconcile the detail page (the divergence fix).** Replace the bespoke child-mission rows (`:166-178`) with `MissionProgress`, fed by the `segments` the detail API already returns. Replace the flat rollup bar (`:129-134`) with an **aggregate** `SegmentStrip` in `continuous` mode, built by concatenating child `segments`. Net-new code is a thin `computeInitiativeSegments(children)` that flattens per-child `segments` in child order — it renders through the *same* `SegmentStrip`, not a parallel bar.

**4. Arc-aware headline.** Replace throughput-only copy with a priority order: initiative milestone crossed > blocked / waiting-on-you > overnight count. E.g. `"Merge Gate crossed 80% — 15 ships overnight, 3 waiting on you."` Computed from initiative rollup deltas, same editorial-headline pattern already used on Home.

**5. Chips (secondary) + Linear symmetry (deferred).** Filter chips scope the activity feed and waiting-on-you queue by initiative — right role for chips: scoping, not grouping. Initiative↔Linear-initiative linking (extend `link_tracker` past its mission-only gate) is a natural Phase 2 given the data layer is already initiative-ready; out of scope here.

**Crux:** *every initiative progress indicator renders through the shared `SegmentStrip` / `computeInitiativeProgress` primitives, computed at read time — no parallel renderer, no materialized `progressCache`.* If this is wrong — if we ship a bespoke initiative bar (as the detail page already did) or start writing `progressCache` from a background job — we get renderer drift (the exact bug PR #1388 killed) and a denormalized rollup that goes stale the moment a child task changes without a writer to catch it. The whole design leans on "the primitives already produce this; we only need to call them from new surfaces."

## Safety property

- **Empty-collapse is the no-op default.** With zero initiatives the rail, the headline's initiative clause, and the chips render **nothing** — Home is byte-for-byte unchanged. Most missions have no `initiativeId` today; the default path must alter nothing until someone files a mission under an initiative.
- **No PR #1032 regression.** Grouping missions by initiative must never hide a mission that lacks one. Un-filed missions stay in the current Missions section untouched, and the `soonScheduled` surfacing (`home/page.tsx:1204`, all scheduled missions, not just <24h) is preserved verbatim — this is the same class of bug PR #1032 fixed.
- **Read-time rollup, bounded.** Rollup stays a pure `computeInitiativeProgress` recompute per request (already true in all three call sites). No cache write path is added; `progressCache` stays dormant.

## Decisions (resolved)

Locked after the design pass (artboards named in the header) surfaced places the mock outran the data layer. These are contract decisions the build must not re-litigate:

- **Rail/list ordering & `lastMotionAt` — client-side, no contract change.** The list API returns no motion timestamp. Derive `lastMotionAt = max(child mission.updatedAt)` from the existing light `missions` payload and sort **blocked-first, then `lastMotionAt` desc**, in the component. The "moved 2h ago / shipped 1d ago / no activity yet" labels format off that value. `GET /api/initiatives` is **not** changed for ordering. Initiatives with zero missions sort last (no motion).
- **Initiative "blocked" = `rollup.status` verbatim (v1).** `computeInitiativeProgress` returns `blocked` only when a child mission is `budget_exhausted` (`mission-helpers.ts:145`). The card's BLOCKED chip and the blocked-floats-to-top sort both key off `rollup.status` — nothing else. The mock's *broader* "a child needs input / failed ⇒ blocked" reading is **deferred**: it requires a per-child health input added to `computeInitiativeProgress`, which is a follow-up, not v1. Until then, needs-input stays surfaced by the existing NEEDS INPUT section, never by promoting the initiative to BLOCKED.
- **Linear badge is payload-driven.** The rail/list badge renders off a new `hasLinearLink: boolean` on the `GET /api/initiatives` list payload — computed as one batched existence query over all child mission ids against `externalLinks` (provider `linear`), not per-card. The detail page keeps its own `hasLinearLink` gate. No badge is rendered without the flag.
- **Status chip is `rollup.status`, motion text is separate.** A card must never show a status chip that contradicts its motion line (the mock's "ACTIVE … blocked 40m ago" and "ACTIVE … 100% shipped 1d ago" are label bugs). Chip = `rollup.status` (`empty|active|blocked|paused|completed`); the timestamp line is independent metadata.

## Still open

- **Should `progressCache` ever get a writer?** Lean **no** — scale doesn't justify it and a writer is a staleness liability. Documenting so a future reader doesn't "fix" the empty column by materializing it. If it ever lands, it must be invalidated on every child-mission/task mutation, not on a timer.
- ~~**Arc-aware headline priority / milestone detection.**~~ **Resolved & shipped (phase 5).** Two-line treatment matching the approved mock: the **H1** is a genuine milestone *crossing* (`<Initiative> crossed X%`) when one occurred since the user's last visit, else the normal time greeting; the **subheading** composes `"{N} ships {overnight|today} · {M} waiting on you"`. Crossing is real, not current-%: a new per-user snapshot table `initiativeProgressSeen` stores the last-seen rollup progress; `crossedMilestone(prev, curr)` (`mission-helpers.ts`, thresholds 25/50/75/90/100) returns the highest threshold with `prev < m <= curr`. A first-ever view seeds the baseline silently (no headline); the snapshot refreshes to current on every render. This table is UI memory only — it is **not** `progressCache` and does not reintroduce a rollup writer.

## Non-goals

- Building the detail page, create form, CRUD/artifact APIs, or MCP actions — they exist.
- Materializing `progressCache` or adding a rollup writer.
- Auto-filing orphan missions into initiatives — filing stays opt-in.
- Initiative↔Linear-initiative linking (Phase 2; data layer ready, action gate is mission-only).
- Mobile-specific redesign beyond: rail is horizontally scrollable cards at iOS width; detail/list inherit existing mission-list mobile behaviour.

## Implementation sketch

Ordered, load-bearing first:

1. **`computeInitiativeSegments(children)`** in `mission-helpers.ts` — flatten child `segments` in child order. The one shared primitive the aggregate bar depends on; unit-tested alongside `computeInitiativeProgress`. ✅ *done — 4 tests.*
2. **Reconcile detail page (single-column core)** — swap bespoke rows → `MissionProgress`; swap flat rollup bar → aggregate `SegmentStrip`; child-mission chips come from `MissionBadges` (drive/health), never invented labels. Mission/task links keep full UUIDs (the zero-pad 404 lesson). ✅ *done.*
   Then **desktop two-column layout** (from the `y4vcA` artboard): child missions left, a right rail with the PINNED-artifacts corner-bracket panel + the Linear `TrackerProgressPanel`. Additive to the reconciliation above; single-column stacks on mobile.
3. **`InitiativeCard`** shared component + **`initiatives/page.tsx`** list + nav entry. ✅ *done.*
   - Extracted a shared **`loadInitiativeList()`** (`lib/initiative-list.ts`) so the list route and the list page can't diverge; `GET /api/initiatives` now returns `segments`, `lastMotionAt`, and **`hasLinearLink`** (one batched `externalLinks` existence query over all child mission ids). Aggregate segments are computed from already-loaded tasks (no extra query; workers not loaded, so ghost/half collapse to solid/empty — the detail page carries live nuance).
   - Pure **`lib/initiative-presentation.ts`** (unit-tested): `sortInitiatives` (blocked-first, then `lastMotionAt` desc, no-motion sinks), `initiativeStatusChip` (token-only, driven by `rollup.status`), `motionLabel` (verb from status so it can't contradict the chip). Sorting runs in the server page over the loaded payload — no API order change.
   - `InitiativeCard` renders progress through the shared `SegmentStrip`; card is a single link (no inner anchors). Empty-collapse: zero initiatives → a single "start the first one" prompt, no list chrome.
   - Nav: `Initiatives` added to `NAV_ITEMS` (target icon), `desktopOnly` so the mobile bottom bar stays uncrowded — mobile reaches it via the Home rail; `isNavActive` prefix-matches `/app/initiatives` so the detail page highlights it too.
4. **Home rail** — ✅ *done.* `InitiativeRail` mounts directly under the greeting (above the ephemeral feed), team-scoped + workspace-filtered via the shared `loadInitiativeList` + `sortInitiatives`, capped at 6, horizontally scrollable. Empty-collapses to nothing. It's purely additive — it does not touch the mission fetch/grouping, so PR #1032's `soonScheduled` behaviour is untouched; `home-missions.test.ts` (the grouping guard) still passes unchanged.
5. **Arc-aware headline** — ✅ *done.* H1 = a real milestone *crossing* (`crossedMilestone` over a per-user `initiativeProgressSeen` snapshot) else the time greeting; subheading = `"{N} ships {overnight|today} · {M} waiting on you"`. New additive migration `0100` for the snapshot table; `crossedMilestone` unit-tested in `initiative-helpers.test.ts`.
6. **Chips** — ✅ *done (Waiting-on-you queue).* `InitiativeFilterChips` scopes the queue via a `?initiative=` search param (server-side, same pattern as `WorkspaceFilter`; no client state), reusing the existing `.filter-pill` utility. Queue items are tagged with their mission's initiative via a `missionId → initiative` map built from the loaded list; the section gates on the *unfiltered* queue so a filter that empties it can still be cleared. Renders nothing with <2 initiatives present. Extending the same scope to the shipped/activity feed is a follow-up.
