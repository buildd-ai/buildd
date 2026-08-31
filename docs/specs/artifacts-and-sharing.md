---
title: Artifacts and Sharing
status: active
owner: max
last_verified: 2026-08-30
summary: Artifacts MUST be created private, be publicly readable only via an explicitly issued share token that revocation immediately invalidates, and be stored under an object key confined to the owning workspace's prefix.
domain: tasks
surfaces: [apps/web/src/app/api/artifacts/[artifactId]/share/route.ts, apps/web/src/app/api/share/[token]/route.ts, apps/web/src/app/api/artifacts/upload-url/route.ts, apps/web/src/lib/storage-keys.ts]
related: [mcp-action-contracts, team-namespace-scoping, mission-task-lifecycle, credential-isolation]
keywords: [sharetoken, visibility public, presigned put, r2, artifacts_share_token_idx, http 413, dataclass sensitive, upsert by key]
verified_by: [apps/web/src/app/api/artifacts/[artifactId]/share/route.test.ts, apps/web/src/app/api/share/[token]/route.test.ts, apps/web/src/app/api/artifacts/[artifactId]/route.test.ts, apps/web/src/app/api/artifacts/upload-url/route.test.ts, apps/web/src/app/api/workers/[id]/artifacts/route.test.ts, apps/web/src/app/api/missions/[id]/artifacts/route.test.ts]
supersedes: []
---
# Artifacts and Sharing

An **artifact** is the deliverable an agent attaches to its work: a summary, a
report, a data blob, a link, or an uploaded file. Artifacts are the only
first-class agent output besides a pull request, and the only one that can be
made readable **without a buildd session** — a share token turns agent output
into a public URL. That makes authorization and revocation the load-bearing
part of this contract, not the storage plumbing.

**The incident this spec exists to prevent recurring.** Until commit `a6f70f0d`
(migration `packages/core/drizzle/0098_magical_scourge.sql`), every artifact was minted with a `shareToken` at insert time
and `/share/[token]` had no gate at all: possession of a token — or of any API
response that contained one — was read access to agent output, for every
artifact that had ever been created. The fix added
`artifacts.visibility` (`NOT NULL DEFAULT 'private'`), backfilled every existing
row to private (deliberately breaking previously minted links, with no
grandfathering), and moved publication behind an explicit Share action. Two
write paths were **not** converted and still mint tokens at insert time; see
`## Verification gaps`.

Terminology: *publication* = setting `visibility = 'public'` and issuing a
token. *Revocation* = returning to `visibility = 'private'` and nulling the
token. A token is a bearer credential; nothing else authenticates a public read.

---

## 1. Artifact record and attachment points

**Capability statement**: An artifact row MUST carry the scope it was created
in — worker, workspace, mission, initiative — and a workspace-scoped `key` MUST
address at most one artifact, so repeated agent writes update in place instead
of accumulating near-duplicate deliverables.

**Invariants**:
- `artifacts.type` is free text at the DB level; the accepted vocabulary is
  enforced per write route, not by the column.
- `(workspaceId, key)` is unique (`artifacts_workspace_key_idx`). A second
  insert with the same non-null pair MUST fail rather than create a second row —
  every keyed write path therefore looks up the existing row and updates it. The
  index does not constrain rows with `workspaceId = NULL`, and the keyed-upsert
  branches only run when a workspace is resolved, so a keyed write on a
  workspace-less scope inserts unconditionally.
- `shareToken` is globally unique (`artifacts_share_token_idx`), so a token
  identifies at most one artifact.
- `workerId`, `workspaceId`, `missionId` and `initiativeId` are all nullable. A
  worker-created artifact inherits `missionId` from its worker's task; a
  mission- or initiative-level artifact has `workerId = NULL`.
- Deleting a worker or workspace cascades to its artifacts; deleting a mission
  or initiative sets the reference to NULL and MUST NOT delete the artifact.
- `GET /api/initiatives/[id]/artifacts` MUST return initiative-level artifacts
  **plus** the artifacts of every child mission in one response (the rollup is
  server-side; callers do not walk the tree).

**Acceptance criteria**:
- AC-1: GIVEN a worker whose task has `missionId = M` WHEN the worker creates an
  artifact THEN the stored row has `missionId = M`.
- AC-2: GIVEN a worker whose task has no mission WHEN the worker creates an
  artifact THEN the stored row has `missionId = NULL`.
- AC-3: GIVEN an artifact with `key = "mission-M"` in workspace W WHEN a second
  write arrives for the same `(W, "mission-M")` THEN the response carries
  `upserted: true` and the artifact count for that key remains 1.
- AC-4: GIVEN initiative I with child missions each holding artifacts WHEN
  `GET /api/initiatives/I/artifacts` is called THEN the response contains both
  the initiative-level artifacts and the child-mission artifacts.

**Code surface**:
- Model: `packages/core/db/schema.ts:1175` — `artifacts` table, indexes at
  `packages/core/db/schema.ts:1195`
- Type vocabulary: `packages/shared/src/types.ts:74` — `ArtifactType`
- Rollup: `apps/web/src/app/api/initiatives/[id]/artifacts/route.ts:72`
- Mission inheritance: `apps/web/src/app/api/workers/[id]/artifacts/route.ts:57`

**Out of scope**: Artifact deletion — no route deletes an artifact row or its
stored object; artifacts are removed only by cascade from a deleted worker or
workspace. Task attachments (`attachments/` prefix) are inputs, not artifacts,
and carry no artifact row.

---

## 2. Write authorization and type vocabulary

**Capability statement**: Every artifact write MUST be authorized against the
artifact's own scope — worker ownership for worker artifacts, team membership
for mission and initiative artifacts — and MUST reject a type outside the
route's accepted set with HTTP 400 before touching the database.

**Invariants**:
- `POST /api/workers/[id]/artifacts` requires an API key whose account owns the
  worker (`worker.accountId === account.id`); anything else is HTTP 403. There
  is no session path on this route.
- `POST /api/missions/[id]/artifacts` and `POST /api/initiatives/[id]/artifacts`
  accept an API key **or** a dashboard session, and require the resolved team
  set to contain the mission/initiative `teamId` — unless its workspace has
  `accessMode = 'open'`. A miss returns HTTP 404 (not 403): the existence of
  another team's mission is not disclosed.
- The worker route accepts only `DELIVERABLE_TYPES`; the mission and initiative
  routes accept that set plus `analysis` and `recommendation`. A type outside
  the route's set is HTTP 400 with the accepted list in the error.
- `type = 'link'` without `url` is HTTP 400. A missing or non-string `title` is
  HTTP 400 on all three routes.
- A caller-supplied `storageKey` MUST satisfy `isOwnedStorageKey(key,
  worker.workspaceId)` or the write is rejected HTTP 400 — including on the
  upsert-by-key branch. An unchecked key would later be signed for download.
- For a workspace with `dataClass = 'sensitive'`, the worker route MUST store
  `content = NULL` and `storageKey = NULL` and keep only the metadata stub.
- `PATCH /api/artifacts/[artifactId]` MUST accept only `title`, `content` and
  `metadata`. It MUST NOT be a path to change `visibility`, `shareToken`,
  `storageKey`, or any scope column.

**Acceptance criteria**:
- AC-5: GIVEN worker W owned by account A WHEN account B posts an artifact to
  `/api/workers/W/artifacts` THEN the response is HTTP 403 and no row is written.
- AC-6: GIVEN mission M owned by a team the caller is not a member of, whose
  workspace is not `accessMode = 'open'` WHEN the caller posts an artifact to
  `/api/missions/M/artifacts` THEN the response is HTTP 404.
- AC-7: WHEN `POST /api/workers/[id]/artifacts` is called with
  `type: "email_draft"` THEN the response is HTTP 400 naming the accepted types
  (the worker route's set is narrower than the MCP `create_artifact` vocabulary).
- AC-8: GIVEN worker W in workspace `ws-1` WHEN the body carries a `storageKey`
  whose second path segment is not `ws-1` THEN the response is HTTP 400 and no
  row is written.
- AC-9: GIVEN a workspace with `dataClass = 'sensitive'` WHEN a worker creates a
  `report` artifact with prose `content` THEN the stored row has `content = NULL`.

**Code surface**:
- Worker route: `apps/web/src/app/api/workers/[id]/artifacts/route.ts:10`
  (`DELIVERABLE_TYPES`), `:43` (ownership), `:85` (`isOwnedStorageKey`), `:174`
  (sensitive nulling)
- Mission route: `apps/web/src/app/api/missions/[id]/artifacts/route.ts:41`
  (`resolveAccountTeamIds` gate)
- Initiative route: `apps/web/src/app/api/initiatives/[id]/artifacts/route.ts:22`
- Update route: `apps/web/src/app/api/artifacts/[artifactId]/route.ts:95`
- MCP entry: `packages/core/mcp-tools.ts:2456` — `create_artifact` fans out to
  the initiative, mission, or worker route
- Key ownership helper: `apps/web/src/lib/storage-keys.ts:165`

**Out of scope**: The `outputRequirement` completion gate that *requires* an
artifact before a task may complete — it lives in
`apps/web/src/app/api/workers/[id]/route.ts:588` and is specified by
`mission-task-lifecycle`. Its artifact-facing detail is noted in
`## Verification gaps` because it counts only artifacts with a matching
`workerId`.

---

## 3. Object storage and upload grants

**Capability statement**: A presigned upload grant MUST be scoped to a single
object key inside the requesting workspace's prefix and to the exact byte
length the caller declared, so that neither the key nor the body size is
substitutable after signing.

**Invariants**:
- Every object key handed to `apps/web/src/lib/storage.ts` is assembled by
  `apps/web/src/lib/storage-keys.ts`. Caller input contributes only the trailing
  name segment, reduced by `safeObjectFilename`; structural segments are
  validated by `assertSafeKeySegment` and never sanitised.
- Artifact objects live at `artifacts/<workspaceId>/<uploadId>/<name>`; task
  attachments at `attachments/<workspaceId>/<uploadId>/<name>`. Only these two
  `TENANT_KEY_PREFIXES` are addressable by a caller-supplied key.
- `assertNormalizedObjectKey` MUST run before signing: a key is signed for the
  prefix it resolves to, so it must already be in resolved form (no `..`, no
  backslash, no leading `/`, charset-clean segments).
- `generateSizedUploadUrl` MUST sign `content-length`. A PUT with any other body
  length fails SigV4 verification at the bucket, before any byte is stored.
- `POST /api/artifacts/upload-url` requires a worker the calling account owns,
  refuses a worker with no `workspaceId` (there is no tenant segment to scope
  to), rejects a declared size that is not a positive safe integer with HTTP 400,
  and rejects a size above `MAX_ARTIFACT_UPLOAD_BYTES` with HTTP 413.
- Uploads to a `dataClass = 'sensitive'` workspace MUST be refused HTTP 403 —
  content must not leave the runner.
- `POST /api/attachments/upload` MUST verify the caller's access to the named
  `workspaceId` before signing, because that id becomes the tenant segment of
  every key it signs. Its ceiling is `MAX_ATTACHMENT_UPLOAD_BYTES`, and no more
  than 5 files per request.
- Both upload URLs expire in 10 minutes; `generateDownloadUrl` grants 1 hour.

**Acceptance criteria**:
- AC-10: GIVEN worker W in workspace `ws-1` WHEN an upload URL is requested THEN
  the signed key begins `artifacts/ws-1/`.
- AC-11: WHEN `filename` contains path separators or traversal segments THEN the
  resulting key still has exactly four segments of the form
  `artifacts/<workspaceId>/<uploadId>/<name>` with no `..` anywhere, and the
  caller's original name survives only in `metadata.filename` and the title.
- AC-12: WHEN `sizeBytes` exceeds `MAX_ARTIFACT_UPLOAD_BYTES` THEN the response
  is HTTP 413 and no artifact row is created.
- AC-13: GIVEN a worker whose workspace has `dataClass = 'sensitive'` WHEN an
  upload URL is requested THEN the response is HTTP 403.
- AC-14: GIVEN a caller with no access to workspace X WHEN
  `POST /api/attachments/upload` names `workspaceId: X` THEN the response is
  HTTP 403 and no URL is signed.

**Code surface**:
- Upload route: `apps/web/src/app/api/artifacts/upload-url/route.ts:21`
  (`MAX_ARTIFACT_UPLOAD_BYTES`), `:57` (size validation), `:83` (sensitive block),
  `:99` (workspace requirement)
- Attachments: `apps/web/src/app/api/attachments/upload/route.ts:50`
- Signing helpers: `apps/web/src/lib/storage.ts:38` (`generateSizedUploadUrl`),
  `apps/web/src/lib/storage.ts:111` (`generateDownloadUrl`)
- Key construction: `apps/web/src/lib/storage-keys.ts:17`
  (`TENANT_KEY_PREFIXES`), `:38` (`safeObjectFilename`), `:73`
  (`assertNormalizedObjectKey`), `:103` (`buildArtifactKey`)

**Out of scope**: Runner session diagnostics uploads
(`sessions/<teamId>/<workspaceId>/<workerId>/…` via `buildSessionArtifactKey`)
and role config bundles (`roles/…`) — server-derived keys with their own routes,
not artifacts. Bucket lifecycle, retention, and egress budgeting.

---

## 4. Share publication, public read, and revocation

**Capability statement**: An artifact MUST be unreadable without a buildd
session or API key unless a workspace-authorized principal has explicitly
published it, and revocation MUST make every previously issued link stop
resolving immediately.

**Invariants**:
- Artifacts are created `visibility = 'private'` with `shareToken = NULL` on the
  worker, mission and initiative routes. Publication happens only via
  `POST /api/artifacts/[artifactId]/share`.
- `authorizeShare` accepts an API-key account that owns the artifact's worker or
  has workspace access, **or** a session user whose `getUserWorkspaceIds`
  includes the artifact's `workspaceId`. Unauthenticated is HTTP 401;
  authenticated-without-access is HTTP 403. A nonexistent artifact is HTTP 404
  and is resolved **before** authorization, so a 404/403 pair distinguishes
  existence — acceptable only because artifact ids are unguessable UUIDs.
- Publication reuses a non-null `shareToken` and otherwise mints 24 random bytes
  (base64url). Tokens carry no expiry column: **a published artifact stays
  published until revoked.**
- Both public read paths — `GET /api/share/[token]` and the `/share/[token]`
  page — MUST filter on `shareToken = <token> AND visibility = 'public'`. Token
  possession alone is never sufficient. A private match returns HTTP 404 /
  `notFound()`, indistinguishable from an unknown token.
- `DELETE /api/artifacts/[artifactId]/share` MUST set `visibility = 'private'`
  **and** null the token. Because the token is nulled, re-publication mints a
  fresh one — a revoked link cannot be reactivated by re-sharing.
- The public payload is deliberately narrow: artifact `id`, `type`, `title`,
  `content`, `metadata`, `createdAt`, plus the originating task's `title` and
  `status`. It MUST NOT include ids of sibling artifacts, worker internals,
  costs, `storageKey`, or the workspace/team identity.
- `GET /api/artifacts/[artifactId]/download?token=…` MUST accept the token only
  when it matches `shareToken` **and** `visibility = 'public'`; otherwise
  HTTP 403. With no token it falls back to session/API-key auth.
- A route that returns a `shareUrl` MUST derive it from a **published** artifact.
  The mission, initiative and worker routes gate on
  `updated.shareToken && updated.visibility === 'public'`; the list routes do not
  (see `## Verification gaps`).

**Acceptance criteria**:
- AC-15: WHEN a worker creates an artifact THEN the stored row has
  `visibility = 'private'`, `shareToken = NULL`, and the response `shareUrl` is
  `null`.
- AC-16: GIVEN an unauthenticated caller WHEN `POST /api/artifacts/X/share` is
  called THEN the response is HTTP 401 and the artifact stays private.
- AC-17: GIVEN a session user who is not a member of the artifact's workspace
  WHEN `POST /api/artifacts/X/share` is called THEN the response is HTTP 403 and
  `visibility` is unchanged.
- AC-18: GIVEN a private artifact whose `shareToken` matches the requested token
  WHEN `GET /api/share/[token]` is called THEN the response is HTTP 404
  `{"error":"Not found"}`.
- AC-19: GIVEN a published artifact WHEN `DELETE /api/artifacts/X/share` is
  called by an authorized principal THEN the row becomes
  `visibility = 'private'` with `shareToken = NULL`, and a subsequent
  `GET /api/share/<old token>` returns HTTP 404.
- AC-20: GIVEN a private artifact with a stored file WHEN
  `GET /api/artifacts/X/download?token=<its own shareToken>` is called with no
  session THEN the response is HTTP 403 `{"error":"Invalid token"}`.

**Code surface**:
- Publish/revoke: `apps/web/src/app/api/artifacts/[artifactId]/share/route.ts:20`
  (`authorizeShare`), `:77` (publish), `:108` (revoke)
- Public API read: `apps/web/src/app/api/share/[token]/route.ts:18` (the
  visibility gate), `:43` (the exposed field set)
- Public page: `apps/web/src/app/share/[token]/page.tsx:14`
- Token-gated download: `apps/web/src/app/api/artifacts/[artifactId]/download/route.ts:33`
- Model: `packages/core/db/schema.ts:1188` — `visibility` column and its contract
  comment
- Dashboard control: `apps/web/src/components/ArtifactShareControl.tsx`,
  `apps/web/src/components/ArtifactViewer.tsx:145`

**Out of scope**: Connector share grants (`/api/connectors/[id]/shares`) — a
different mechanism over integration credentials. Per-recipient ACLs, passworded
links, view counts, and link expiry (none exist; the only states are private and
public).

---

## 5. Read scope and cross-team authorization

**Capability statement**: Every authenticated artifact read MUST resolve the
caller's team or workspace scope and return only artifacts inside it; a route
that identifies the caller but never resolves scope is a cross-team read.

**Invariants**:
- `GET /api/artifacts/[artifactId]` requires an API key (no session path) and
  authorizes by worker ownership or `verifyAccountWorkspaceAccess` on the
  artifact's `workspaceId`. An artifact with neither an owning worker nor a
  `workspaceId` is HTTP 403 — it belongs to no resolvable scope, so no caller is
  authorized to read it.
- `GET /api/artifacts` requires an **admin**-level API key or a session, and
  returns only artifacts whose `missionId` belongs to a mission in the caller's
  resolved team set. Worker artifacts with `missionId = NULL` are therefore never
  listed by this route.
- `GET /api/workspaces/[id]/artifacts` MUST verify workspace access —
  `verifyWorkspaceAccess` for sessions, `verifyAccountWorkspaceAccess` for API
  keys — and return HTTP 404 on a miss.
- `GET /api/workers/[id]/artifacts` requires the calling account to own the
  worker (HTTP 403 otherwise).
- `GET /api/tasks/[id]?include=artifacts` MUST apply the task's workspace access
  check before expanding artifacts, and MUST scope the expansion to workers of
  that task.
- Scope resolution is a **widening** function and its width is part of the
  contract: `verifyAccountWorkspaceAccess` returns true for any account when
  `workspaces.accessMode = 'open'` (the column default), and
  `resolveAccountTeamIds` maps an API account to *every team any member of its
  team belongs to*. A reader auditing tenancy must treat "workspace member" as
  "any authenticated caller" for open workspaces. Narrowing this is a
  `team-namespace-scoping` concern, not an artifact-route concern; what this spec
  requires is that no artifact route skip the resolution entirely.
- No artifact read path MUST be satisfiable by authentication alone. Identifying
  the caller is not authorizing them.

**Acceptance criteria**:
- AC-21: GIVEN an artifact owned by account A's worker in a non-open workspace
  WHEN account B calls `GET /api/artifacts/<id>` THEN the response is HTTP 403.
- AC-22: GIVEN an artifact with `workerId = NULL` and `workspaceId = NULL` WHEN
  any API key calls `GET /api/artifacts/<id>` THEN the response is HTTP 403.
- AC-23: GIVEN a worker-level API key (level below `admin`) WHEN
  `GET /api/artifacts` is called THEN the response is HTTP 403
  `{"error":"Requires admin-level API key"}`.
- AC-24: GIVEN a caller with no access to workspace X WHEN
  `GET /api/workspaces/X/artifacts` is called THEN the response is HTTP 404 and
  contains no artifact rows.

**Code surface**:
- Single read: `apps/web/src/app/api/artifacts/[artifactId]/route.ts:23`
- Team list: `apps/web/src/app/api/artifacts/route.ts:20` (admin gate), `:49`
  (mission-scoped filter)
- Workspace list: `apps/web/src/app/api/workspaces/[id]/artifacts/route.ts:38`
- Worker list: `apps/web/src/app/api/workers/[id]/artifacts/route.ts:225`
- Task expansion: `apps/web/src/app/api/tasks/[id]/route.ts:117`
- Scope helpers: `apps/web/src/lib/team-access.ts:57`
  (`verifyAccountWorkspaceAccess`), `apps/web/src/lib/team-access.ts:167`
  (`resolveAccountTeamIds`), `apps/web/src/lib/team-access.ts:91`
  (`getUserWorkspaceIds`)

**Out of scope**: How `accessMode` and the active-team cookie are resolved and
whether they should be narrowed — see `team-namespace-scoping`. Knowledge-store
mirroring of artifacts (`mirrorWorkProduct` / `buildArtifactCard`) and its
retrieval scoping — see `knowledge-store-retrieval`.

---

## Verification gaps

Each item is an invariant above, or a drift from one, that **no test asserts**.
Listed so a reader can tell a guarded claim from an unguarded one.

1. **The download route does not resolve caller scope.** The invariant is that
   a tokenless download MUST resolve the caller's access to the artifact's
   workspace before returning any bytes, and MUST reject a caller who fails that
   check — every other read path resolves scope. No test asserts it. Specifics
   are tracked privately until the guard lands.

2. **Two write paths still mint share tokens at insert time**, contradicting the
   post-`a6f70f0d` rule that a token exists only after an explicit Share:
   `apps/web/src/app/api/artifacts/upload-url/route.ts:113` and
   `apps/web/src/lib/artifact-helpers.ts:103` (`upsertAutoArtifact`, the
   auto-summary artifact written on worker completion). Both leave
   `visibility` at its `private` default, so the public gate still holds and the
   links they hand back (`upload-url` returns both a `downloadUrl?token=…` and a
   `shareUrl`) are dead on arrival — a 403 and a 404 respectively, surfaced to
   agents verbatim by `packages/core/mcp-tools.ts:2515`. The real cost is that a
   bearer token is published in API responses, telemetry and the knowledge
   mirror *before* any human publication decision, and
   `apps/web/src/app/api/artifacts/[artifactId]/share/route.ts:77` reuses an
   existing token on publish — so publishing later activates a credential that
   was already broadcast. No test asserts token absence on either path.

3. **List routes advertise `shareUrl` for private artifacts.**
   `apps/web/src/app/api/artifacts/route.ts:83`,
   `apps/web/src/app/api/workspaces/[id]/artifacts/route.ts:70`,
   `apps/web/src/app/api/tasks/[id]/route.ts:127` and
   `apps/web/src/app/api/artifacts/[artifactId]/route.ts:48` build the URL from
   `shareToken` alone, without the `visibility === 'public'` conjunct the
   create/upsert routes use. Combined with gap 2 this is how a pre-minted token
   reaches a caller. Untested.

4. **Sensitive-workspace content redaction is not enforced on every artifact
   write path.** The invariant, from commit `9b2bf156`, is that for a workspace
   with `dataClass = 'sensitive'` every path that writes an artifact MUST store
   `content = NULL` and `storageKey = NULL` — including the automatic
   completion-summary path. No test asserts it on any write path, the worker
   route's own nulling (AC-9) included. Specifics are tracked privately until
   the guard lands.

5. **`baseUrl` precedence bug survives in seven call sites.** The pattern
   `process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : <default>`
   parses as `(A || B) ? https://B : default`, so when `NEXT_PUBLIC_APP_URL` is
   set and `VERCEL_URL` is not, the emitted host is literally `undefined`, and on
   Vercel every share URL points at the per-deployment hostname rather than the
   configured app URL. `a6f70f0d` fixed only the new share route (which has a
   correct `baseUrl()` helper at
   `apps/web/src/app/api/artifacts/[artifactId]/share/route.ts:52`); the artifacts
   list, single-artifact, upload-url, worker, mission, initiative and workspace
   routes still carry the buggy form. `apps/web/src/app/api/tasks/[id]/route.ts:123`
   has the correct form, which is what makes this drift rather than design. No
   test pins share-URL host derivation.

6. **Type vocabulary drift between MCP and the routes.**
   `packages/core/mcp-tools.ts:2459` validates 12 types and its parameter
   description advertises them, but the worker route accepts 6
   (`DELIVERABLE_TYPES`) and the mission/initiative routes 8. `email_draft`,
   `social_post`, `alert` and `calendar_event` pass MCP validation and are then
   rejected HTTP 400 by every write route, while
   `apps/web/src/app/app/(protected)/artifacts/[id]/page.tsx:21` renders labels for
   them. `packages/shared/src/types.ts:74` declares 17. Four vocabularies, no
   single source; nothing tests them for agreement.

7. **The `artifact_required` completion gate counts only worker-owned
   artifacts.** `apps/web/src/app/api/workers/[id]/route.ts:588` queries
   `artifacts` by `workerId = <this worker>`, so an artifact the same agent wrote
   through `/api/missions/[id]/artifacts` (which stores `workerId = NULL`) does
   not satisfy the gate and completion is rejected HTTP 400. The satisfied path is
   tested; the HTTP 400 rejection path is not.

8. **Unguarded on the share surface generally**: the public endpoint has no rate
   limit or abuse control of any kind, and a share token is a bearer credential,
   so it MUST NOT be written to telemetry or any other external log sink. Token
   length (24 random bytes) is what makes the first acceptable; neither is
   asserted anywhere. Specifics are tracked privately until the guard lands.

9. **Dev-mode auth bypass.**
   `apps/web/src/app/api/workspaces/[id]/artifacts/route.ts:16` returns a `dev`
   principal that skips the workspace access check entirely when
   `NODE_ENV === 'development'` — and, unlike the API-key and session branches,
   it is reached without any credential at all. Intentional for local work; it
   means the AC-24 check is inert in a development build, and no test pins the
   branch to that build.
