# Plan — Linear Phase 1 (make linking real + token refresh)

**Status:** ✅ Shipped (PR #1459, merged to `dev`) — migration `0093`, `external_links` + helper, `POST /api/missions/[id]/link`, `link_tracker` MCP action, `getConnectorAccessToken` refresh wiring, `deriveStatus` reconnect fix + CTA. Archived.
**Design:** `docs/design/linear-hierarchy-ingest.md` (Phase 1)
**Spec:** `docs/specs/work-tracker-integration.md` (§3 inbound webhook is a Phase-3 prereq, not Phase 1)
**Scope:** Two independent, individually shippable workstreams. **Zero behaviour change for any team without a Linear connector installed** — `external_links` is empty and the refresh path is a no-op.

> Phase 1 = the *link layer* between buildd's native tier (shipped: initiatives →
> missions → tasks) and Linear. It does **not** read progress back (Phase 2) or
> import the Linear graph (Phase 3). It makes a link *exist, persist, and stay
> authenticated*.

---

## Ground truth (verified against code 2026-07-25)

Corrections to the design doc's assumptions — read before building:

1. **`external_links` does NOT exist.** The design doc folded it into Phase 0, but
   shipped Phase 0 (PR #1446 + #1452) created only `initiatives`,
   `missions.initiativeId`, `artifacts.initiativeId`, and the initiative KB corpus.
   **Phase 1 owns the `external_links` table.**
2. **`/link-linear` is a live dead-end.** `work-tracker.ts:240` posts a mission note
   telling users to *"Run `/link-linear <project-url>` in a task"* — but there is
   **no handler** for it anywhere (no slash-command mechanism, no route, no MCP
   action). Advertised, unimplemented.
3. **Token refresh is built but unwired.** `getConnectorAccessToken`
   (`work-tracker.ts:27-53`) returns `null` the moment `tokenExpiresAt` is in the
   past — no refresh attempt. `refreshMcpConnectorCredential`
   (`mcp-connector-refresh.ts`) is complete and correct (optimistic 60-min lock,
   rotates refresh token, marks dead creds) but **nothing on the read path calls
   it**.
4. **The reconnect signal is miswired (bug).** On a hard refresh failure the
   refresher sets `secrets.tokenExpiresAt = null` + `lastVerificationError = <detail>`
   to "show the reconnect banner." But `deriveStatus`
   (`api/connectors/route.ts:49-53`) returns `'expired'` **only** when
   `tokenExpiresAt < now`; a `null` expiry falls through to **`'connected'`**. So a
   dead Linear token renders green and the banner never fires. Phase 1 must fix this.

### What already exists and is reused (no new invention)

- **Connectors model:** `connectors` (team-scoped, `authMode='oauth'`,
  `discoveredMetadata.authorizationServer.token_endpoint`, `clientId`,
  `encryptedClientSecret`), `connectorWorkspaces` (per-workspace enable),
  `connectorShares` (cross-team). Linear is just an OAuth MCP connector.
- **Credentials:** `secrets` with `purpose='mcp_connector_credential'`,
  `label = connectorId`, `encryptedValue = {access_token, refresh_token?}`,
  `tokenExpiresAt`, `lastRefreshedAt`, `lastVerificationError`. (Per CLAUDE.md:
  **do not** add a Linear-specific credential table.)
- **Workspace link config:** `workspaces.workTrackerConfig`
  (`{ provider: 'linear'|'github', connectorId?, inboundLabel? }`, schema.ts:388).
- **Push path (already live):** PR merge → `postWorkTrackerCompletionUpdate` →
  `postLinearCompletionComment` (comment + state flip). Reads `externalIssueId`
  from the **mission column** and `connectorId` from `workTrackerConfig`.
- **Linear GraphQL client:** `linearGraphQL()` in `work-tracker.ts`.
- **Connector status API + UI:** `api/connectors/route.ts` `deriveStatus`,
  `settings/ConnectorsSection.tsx` (`status: connected|expired|not_connected`).

---

## Workstream 1a — Real linking (`external_links` + a link action)

### Schema (additive; `bun db:generate`, commit files)

`external_links` — the generic provider mapping from design §Schema:

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `teamId` | uuid → teams `onDelete: cascade` notNull | scoping + cleanup |
| `provider` | text notNull `$type<'linear'\|'github'>` | extensible |
| `builddEntityType` | text notNull `$type<'initiative'\|'mission'\|'task'>` | **polymorphic** |
| `builddEntityId` | uuid notNull | no cross-table FK (points at one of 3 tables) |
| `externalId` | text | Linear project/issue id |
| `externalUrl` | text | |
| `externalUpdatedAt` | timestamptz | Phase 3 echo-suppression watermark |
| `lastPushedHash` | text | Phase 3 echo-suppression |
| `createdAt` / `updatedAt` | timestamptz | |

Indexes:
- **Partial unique** `(provider, externalId) WHERE external_id IS NOT NULL` —
  idempotent `ON CONFLICT DO UPDATE`; allows many rows with null externalId.
- `(builddEntityType, builddEntityId)` — reverse lookup ("links for this mission").
- `(teamId)` — team scoping.

**Polymorphic FK caveat:** `builddEntityId` cannot be a real FK (it targets one of
three tables). Enforce existence in app code on write; on entity delete, best-effort
delete matching links from the initiative/mission/task DELETE routes (orphan rows
are harmless — filtered on read — so this is cleanup, not correctness). Team-cascade
covers team deletion.

**Migration safety:** additive, no backfill, no NOT NULL on live rows. Confirm the
new migration's journal `when` is current (`db:generate` stamps it) — see memory
*migration-journal-timestamp-skip*: the migrator applies by `when` high-water-mark,
so a low-`when` migration silently never runs in prod.

### Link action (retire the dead-end)

Advertised "in a task", so the primary surface is an **MCP action** (web affordance
can follow in a later slice):

- Add `link_tracker` (name TBD) to the `buildd` MCP tool — inputs
  `{ entityType: 'mission'|'initiative'|'task', entityId, url }`. Phase 1 ships
  **mission ↔ Linear project** (the advertised flow); the action + table are generic
  so task/initiative links are a later add, not a redesign.
- Resolve the workspace's Linear connector from `workTrackerConfig.connectorId`
  (error clearly if provider ≠ linear or unset).
- Parse the Linear URL → resolve the project/issue **id** via `linearGraphQL`
  (Linear project URLs carry a slug, not the id — a lookup is required).
- **Idempotent upsert** into `external_links` (`INSERT … ON CONFLICT (provider,
  external_id) DO UPDATE`). No `db.transaction()` (neon-http).
- **Dual-write** `missions.externalIssueId`/`externalIssueUrl` so the existing push
  path keeps working unchanged (see Reconciliation).
- Replace the `work-tracker.ts:240` note body to reference the real action (or drop
  the note if the web flow lands first) — no more advertising a missing command.

### Reconciliation with the existing push path

`postWorkTrackerCompletionUpdate` reads the mission column + `workTrackerConfig`.
**Decision:** make `external_links` the canonical store, but in Phase 1 **dual-write**
the mission column so the push path needs no change (lowest risk). Refactor the push
path to resolve the connector/issue via `external_links` in **Phase 2**, when the
read-back panel already needs that lookup. Flag: do not let the two stores drift —
the link action must write both, atomically-enough (write link first, then mission
column; a crash between leaves the canonical row correct).

---

## Workstream 1b — Token refresh on the read path + reconnect banner

Independent of 1a (fixes the live push path too). Three concrete changes:

1. **Wire refresh into `getConnectorAccessToken`** (`work-tracker.ts:27`):
   - Select `encryptedValue` too (currently only `id`, `tokenExpiresAt`).
   - Treat "expired" as `tokenExpiresAt` within a small skew (e.g. `< now + 60s`) so
     an about-to-expire token is renewed proactively, not just after death.
   - On expiry → `await refreshMcpConnectorCredential(secretRow.id)`:
     - `'refreshed'` → re-read the row, return the new `access_token`.
     - `'expired'` → return `null` (refresher already set the reconnect signal).
     - `'locked'` → another caller is refreshing; return the current token if still
       nominally usable, else `null`.
     - `'error'`/`'skipped'`/`'no_credential'` → return `null`.
2. **Fix the reconnect signal (bug from Ground truth #4)** in `deriveStatus`
   (`api/connectors/route.ts:49`): also select `lastVerificationError` and return
   `'expired'` when `tokenExpiresAt IS NULL AND lastVerificationError IS NOT NULL`
   (dead credential after a failed refresh), in addition to the existing
   `tokenExpiresAt < now` case. Update `connectors/route.test.ts` accordingly.
3. **Distinguish reconnect from transient error in the UI**
   (`ConnectorsSection.tsx`): `'expired'` → a clear "Reconnect Linear" affordance
   (re-run the OAuth `connectors/callback` flow), visually distinct from a
   transient/network error. (Status plumbing largely exists; this is a copy/CTA pass.)

---

## Tests (TDD — write first)

- **external_links** (core or route unit): idempotent upsert (duplicate
  `(provider, externalId)` → one row, fields updated); reverse lookup by
  `(entityType, entityId)`; partial-unique permits multiple `externalId IS NULL`.
- **link action**: parses URL + resolves id (mock `linearGraphQL`); writes the
  `external_links` row **and** the mission column; re-linking the same URL is
  idempotent; errors cleanly when the workspace has no Linear connector.
- **getConnectorAccessToken**: not-expired → **no** refresher call (spy);
  expired + refreshable → refresher called, returns new token; expired +
  `invalid_grant` → `null` + reconnect signal persisted; `'locked'` → returns
  existing token.
- **deriveStatus**: `tokenExpiresAt` future → connected; past → expired;
  `null` + `lastVerificationError` set → expired (regression for the bug);
  `null` + no error → connected.

Co-locate route tests as `route.test.ts`; core helpers in `packages/core/__tests__`.

---

## Rollout order

1. `external_links` migration + schema types + core upsert helper + tests.
2. Link MCP action + dual-write + retire the `/link-linear` advertisement + tests.
3. `getConnectorAccessToken` refresh wiring + tests (shippable alone — improves the
   live push path immediately).
4. `deriveStatus` reconnect-signal fix + `ConnectorsSection` reconnect CTA + tests.
5. PR → `dev`; verify build + Retrieval gate; merge.

Each of 3 and 4 is independently shippable and valuable even before 1–2 land.

---

## Open questions (lean answers; confirm before building)

- **Link granularity for P1.** Mission↔project only, or also task↔issue /
  initiative↔Linear-initiative? *Lean: mission↔project (the advertised flow); keep
  table + action generic so the rest is additive.*
- **Link surface.** MCP action vs web UI vs both. *Lean: MCP action first (matches
  the in-task advertisement); web affordance on `missions/[id]` as a fast-follow.*
- **Dual-write vs push-path refactor.** *Lean: dual-write in P1; refactor push path
  to read `external_links` in P2.*
- **Skew window for proactive refresh.** *Lean: 60s; tune if Linear tokens are
  short-lived.*

## Out of scope (Phase 2+)

Read-back (`fetchProgress` + tracking panel), inbound webhook + graph import
(`fetchGraph`, `POST /api/webhooks/linear`), two-way status sync, initiative↔Linear
reconcile authority/conflict UI, blanket workspace sync.
