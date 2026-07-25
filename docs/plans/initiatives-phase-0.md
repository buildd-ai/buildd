# Plan — Initiatives Phase 0 (native tier + MCP + UI)

**Status:** Shipped (PR #1446, merged to `dev`) — schema+rollup, /api/initiatives,
MCP `manage_initiatives` + initiativeId, web UI. Follow-up **also shipped**: the
initiative KB corpus (§6 / design §4d) — `knowledgeChunks.corpus`/`knowledgeEntities.kind`
turned out to be plain `text` (not pgEnum), so no migration; added `buildInitiativeCard`
mirrored via `mirrorWorkProduct` on create/update into the **team-scoped** `{teamId}:initiative`
namespace (initiatives are team-level, like `memory`), plus `initiative` in the recall /
query_knowledge scope enums and recency/authority tables. Archive to `docs/plans/archive/`.
**Design:** `docs/design/linear-hierarchy-ingest.md` (Native Initiatives Tier + Optional Linear Sync)
**Scope:** Phase 0 only — the native, execution-free initiatives tier + its MCP surface + UI/IA.
**Zero Linear.** Must be fully useful with no connector installed. Linear (Phases 1-4) is out of scope here.

---

## 0. Guardrails (from CLAUDE.md + adversarial review)

- **TDD:** failing test first for every behavioural change. New tables/routes get route/unit tests.
- **Migrations:** `cd packages/core && bun db:generate`, commit files in `packages/core/drizzle/`. CI fails otherwise.
- **No `db.transaction()`** on neon-http — atomic `UPDATE...WHERE` / `INSERT...ON CONFLICT` with `.returning()`.
- **All schema additive/nullable** — no `NOT NULL` on live `missions`/`tasks`/`artifacts` rows, no backfill.
- **Defaults no-op** — existing missions have `initiativeId = null` and behave identically. Mission list/health payload (`/api/missions`) stays **append-only** (external `/api/buildd/objectives` / dispatch UI consumes `deriveMissionHealth`'s shape — do not change existing fields).
- **`tasks.initiativeId` is intentionally NOT added** — a task's initiative is derived via `mission.initiativeId`. Avoids denormalization drift.

---

## 1. Schema (`packages/core/db/schema.ts`)

New table **`initiatives`** — a pure planning container, **no orchestration columns** (this is the safety property: an initiative structurally cannot trip the orchestrator/heartbeat/release/budget engine):

```
initiatives
  id             uuid PK
  teamId         uuid NOT NULL → teams (cascade)     -- primary scoping, mirrors missions.teamId
  workspaceId    uuid → workspaces (set null)        -- nullable: an initiative may span repos
  title          text NOT NULL
  description    text
  status         text NOT NULL default 'active'      -- active|paused|completed|archived
  priority       integer default 0
  progressCache  jsonb                               -- denormalized rollup, refreshed on child change
  contextArtifactIds jsonb  default '[]'             -- curated artifact-id pointers (mirrors missions.contextArtifactIds:567)
  createdByUserId uuid
  createdAt / updatedAt
  -- indexes: teamIdx, workspaceIdx, statusIdx
```

Column additions (nullable, additive):
- **`missions.initiativeId`** uuid → initiatives (`onDelete: 'set null'`), index `missions_initiative_idx`. This is the entire coupling to missions.
- **`artifacts.initiativeId`** uuid → initiatives (`onDelete: 'set null'`), index `artifacts_initiative_idx` — for **initiative-level** artifacts (roadmap/spec) not tied to a mission. (`artifacts` already has `missionId` + `missionIdx`, schema:815-835.)

Types: export `Initiative` / `NewInitiative`; relations (`initiatives.missions: many`, `missions.initiative: one`, `artifacts.initiative: one`).

Generate + commit the migration. Single additive migration; no data backfill.

---

## 2. Rollup helper (`packages/core/mission-helpers.ts`)

`computeMissionProgress` is flat (tasks only) — there is **no** sub-mission/initiative rollup today. Add:

```ts
computeInitiativeProgress(childMissionProgress: MissionProgress[]): InitiativeProgress
// sums completedTasks / totalTasks across child missions; derives % + a status roll (all shipped, some active, blocked…)
```

- Pure function over already-computed child `computeMissionProgress` results (callers pass child missions' progress; helper does not query).
- Write to `initiatives.progressCache` on child-mission change (task complete / mission status change) — best-effort, recompute on read if stale.
- Unit tests: empty initiative (0 missions → 0%, not NaN), mixed states, all-complete → 100%.

---

## 3. API routes (`apps/web/src/app/api/initiatives/`)

Mirror the missions route structure (`apps/web/src/app/api/missions/`):
- `route.ts` — `GET` (list team initiatives + rolled-up progress via `computeInitiativeProgress`), `POST` (create).
- `[id]/route.ts` — `GET` (initiative + child missions + progress + linked artifacts index), `PATCH`, `DELETE` (set-null children, don't cascade-delete missions).
- `[id]/artifacts/route.ts` — `GET` returns initiative-level artifacts **plus** rolled-up child-mission artifacts (join on `missions.initiativeId`); `POST` creates an initiative-level artifact.
- Extend `missions` `POST`/`PATCH` to accept `initiativeId` (assign/reassign mission to initiative).
- Extend `list_artifacts`' workspace/mission artifact routes to accept `initiativeId` filter.

Auth: same session/API-key gating as missions routes.

---

## 4. MCP surface (`packages/core/mcp-tools.ts`) — the agent-facing requirement

Agents must **read** initiatives (KB-optimized), **fetch their artifacts** efficiently, and **create** initiatives + missions under them.

### 4a. `manage_initiatives` (new admin action)
- Add `'manage_initiatives'` to `adminActions` (mcp-tools.ts:83-99) → inherits the structured-403 admin gate automatically.
- Add schema string to the params-description map (~line 145), mirroring `manage_missions`:
  ```
  manage_initiatives: '{ action: "list"|"create"|"get"|"update"|"delete"|"link_mission"|"unlink_mission",
    initiativeId?, title?, description?, workspaceId?, status?, priority?, missionId? } [admin]'
  ```
- Add `case 'manage_initiatives'` mirroring the missions switch (2257-2394), hitting `/api/initiatives`.
- **`get` returns the compact initiative brief** (see 4d) — this is the primary "read an initiative" path for agents.
- `link_mission` / `unlink_mission` → `PATCH /api/missions/{id}` `{ initiativeId }`.

### 4b. Create missions under an initiative
- Add `initiativeId?` to `manage_missions` create + update bodies (mcp-tools.ts:2280-2304 / 2338-2363) and its schema string (line 145). No other change — missions already flow through `/api/missions`.

### 4c. Efficient artifact retrieval scoped to an initiative
- Add `initiativeId?` param to **`create_artifact`** (route to `/api/initiatives/{id}/artifacts` when present, mirroring the `missionId` branch at 1902-1913) and to **`list_artifacts`** (thread through as a query filter, 1975-2019).
- `list_artifacts { initiativeId }` returns initiative-level + rolled-up child-mission artifacts — one call, no tree-walking by the agent.

### 4d. KB-optimized read — `buildInitiativeContext` + recall
- **Structured brief:** new `buildInitiativeContext(initiativeId)` in `apps/web/src/lib/mission-context.ts`, returning the same `{ description, context }` contract as `buildMissionContext` (216). `context` rolls up:
  ```
  { initiativeId, initiativeTitle, status, progress,
    missions: [{ id, title, status, progress }],
    recentCompletions, priorArtifacts (initiative-scoped), availableRoles }
  ```
  Reuse `initiatives.contextArtifactIds` for curated context (mirrors `missions.contextArtifactIds`). This is what `manage_initiatives get` returns.
- **Semantic recall (KB):** thread `metadata.initiativeId` into the KB card builders (`packages/core/knowledge-store/cards.ts` — they already thread `missionId` into `metadata`, e.g. cards.ts:64/129/171/209/268). **Zero migration** (`metadata` is free-form jsonb). Agents can then `recall` across `task|pr|artifact|memory` corpora filtered by `initiativeId`.
- **Dedicated corpus — SHIPPED (follow-up):** added `'initiative'` to `knowledgeEntities.kind` and a dedicated `initiative` corpus + `buildInitiativeCard` mirrored via `mirrorWorkProduct` on initiative create/update, so the initiative's own description/rollup is embedded and recall-able. `knowledgeChunks.corpus` and `knowledgeEntities.kind` are plain `text` (verified — **not** pgEnum), so **zero migration**. Scoping: initiatives are team-level (workspaceId nullable), so the corpus is **team-scoped** `{teamId}:initiative` (like `memory`), NOT `{workspaceId}:initiative` as originally sketched. Touched: `Corpus` type, `knowledgeChunks.corpus`/`knowledgeEntities.kind` `$type`, `CORPUS_AUTHORITY`/`HALF_LIFE_DAYS` (recency-authority.ts), and the scope enums (`buildd-mcp-server.ts` recall, `mcp-tools.ts` recall/query_knowledge namespacing + error messages).

---

## 5. Web UI / IA — no new nav tab

**Constraint:** `nav-config.tsx` `NAV_ITEMS` feeds *both* the desktop rail (`MissionsSidebar.tsx`) and the mobile bottom bar (`MissionsBottomNav.tsx`) — they "cannot drift," and mobile is already at 5 items. A 6th tab crowds mobile. So initiatives live **inside the Missions surface**:

- **Missions list (`missions/page.tsx`): add a "group by initiative" view + an initiative filter.** Reuse the `WorkspaceFilter` dropdown pattern (missions/page.tsx:276) and the existing `missionsWhere` scoping (103-108) — add an `initiativeId` scope. Missions with no initiative fall into an "Ungrouped" bucket. Collapsible initiative headers carry the `computeInitiativeProgress` bar.
- **Initiative detail: new route `/app/initiatives/[id]` reachable by drill-down, NOT in nav.** Rollup header + filtered mission list + initiative-level artifacts. Reuse the mission-detail page shell.
- **Breadcrumbs** become `Initiatives / {initiative} / {mission}`, extending the existing pattern at `missions/[id]/page.tsx:377`.
- **Create initiative:** `+ New` on the Missions list grouped view (reuse `missions/new` form shell) and a "New mission → under initiative" selector on mission create.
- **Mobile:** unchanged item count. Initiatives are collapsible section headers / drill targets, never a bottom-tab destination.

No change to `NAV_ITEMS`.

---

## 6. Onboarding — explicitly untouched

- Initiatives require **no connector**, so they do **not** enter the "Getting Started" checklist (`dashboard/OnboardingChecklist.tsx`).
- Keep the established discipline: trackers (Linear/GitHub-as-tracker) stay deferred in Settings/workspace config with a "Later" affordance — never a first-run gate.
- **Adjacent cleanup (optional, note only):** GitHub is currently asked in ~4 places (onboarding checklist, dashboard header chip, dashboard banner `dashboard/page.tsx:288-310`, workspace-new). Consider consolidating to reduce the "asked everywhere" friction the user flagged. Not part of Phase 0 delivery; tracked as a separate follow-up.

---

## 7. Test plan (TDD — write first)

- **Schema/migration:** migration generated + committed; a smoke test that `initiatives` CRUD round-trips and `missions.initiativeId` sets/clears.
- **Rollup:** `computeInitiativeProgress` unit tests (empty / mixed / all-done / blocked).
- **API:** `route.test.ts` for `/api/initiatives` (list/create/get/patch/delete, team-scoping/auth) and `/api/initiatives/[id]/artifacts` (rollup of child-mission artifacts). Regression test: `/api/missions` payload shape unchanged (golden snapshot guarding the `/objectives` contract).
- **MCP:** action tests for `manage_initiatives` (admin-gate 403 for non-admin token), `manage_missions` accepting `initiativeId`, `list_artifacts { initiativeId }` rollup, `create_artifact { initiativeId }`.
- **Brief:** `buildInitiativeContext` returns `{ description, context }` with rolled-up missions.

---

## 8. Sequencing (each step shippable)

1. Schema migration + types + relations (additive) → commit.
2. `computeInitiativeProgress` + tests.
3. `/api/initiatives` routes + `initiativeId` on missions/artifacts routes + tests (+ `/objectives` golden snapshot first).
4. MCP: `manage_initiatives`, `initiativeId` on `manage_missions`/`create_artifact`/`list_artifacts`, `buildInitiativeContext`, `metadata.initiativeId` cards.
5. Web UI: group-by-initiative view, initiative detail route, breadcrumbs, create flows.
6. ✅ initiative KB corpus + `buildInitiativeCard` (team-scoped, zero-migration) — shipped as a follow-up.

---

## 9. Out of scope (later phases, per design doc)

- All Linear sync (link, read-back panel, inbound webhook, import) — Phases 1-4.
- `external_links` table — lands in Phase 1 (first Linear consumer). Not needed for Phase 0.
- Generic work-item tree / portfolios / OKRs; two-way status; cycles/sub-projects.
- GitHub-prompt consolidation (noted §6, separate follow-up).
