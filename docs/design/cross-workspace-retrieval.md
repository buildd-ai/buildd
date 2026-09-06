# Cross-Workspace Retrieval

**Status:** Proposed
**Related:** `packages/core/mcp-tools.ts` (`spec_compare`), `apps/web/src/lib/knowledge-context.ts`,
`packages/core/knowledge-store/ingest-filter.ts` (`classifyIngestCorpus`),
`packages/core/knowledge-store/pg-vector-store.ts` (`buildNamespace`),
`apps/web/src/lib/team-access.ts` (`getTeamWorkspaceIds`),
`apps/web/src/app/api/mcp/route.ts` (`resolveWorkspaceDataClass`),
`apps/web/src/lib/untrusted-text.ts`, `.claude/skills/spec-sync/SKILL.md`,
`docs/design/reviewer-evidence-and-verification.md`

## Problem

The product's code and the product's documentation live in different repos, and
therefore in different buildd workspaces. Retrieval is scoped to one workspace,
so nothing can compare them.

The knowledge store keys every namespace by workspace:
`buildNamespace(workspaceId, corpus)` → `{workspaceId}:{corpus}`. `spec_compare`
queries `{wsId}:code` and `{wsId}:docs` for a single resolved `wsId`. So run from
the workspace holding the application repo, it compares that repo's code against
that repo's own `docs/**` — and cannot see the published documentation repo at
all, because those chunks live under a different workspace's `docs` namespace.
Being in the same **team** does not help: only `memory` is team-scoped
(`{teamId}:memory`); `code` and `docs` are not.

This is not hypothetical. A recent audit found a published docs page describing a
role's `allowedTools` as "Tool restrictions (empty = all tools)" while the runtime
applies that list only to skill subagents and never narrows the primary agent.
Code in one workspace, a sentence contradicting it in another, and a drift tool
that structurally cannot put them side by side. It was found by a human reading
both repos.

The failure mode is the expensive one: the drift loop **runs, returns evidence and
looks like it worked**. Its verdicts (`documented-not-built`,
`shipped-not-documented`) both require doc evidence from the repo that publishes
the docs, so the two verdicts most worth having are the two it can never reach.

The workaround people reach for — teaching each repo about the other in its
`CLAUDE.md` — fails differently. `CLAUDE.md` is per-repo and per-checkout, so the
relationship has to be declared twice, maintained by hand, and it rots silently
the moment a repo is renamed or a page moves.

## Current state

| Fact | Where |
|---|---|
| Namespaces are per-workspace | `buildNamespace(workspaceId, corpus)` |
| `memory` is already team-scoped | `buildNamespace(teamId, 'memory')` in `knowledge-context.ts` |
| Corpora written by ingestion are `code` and `docs` only | `classifyIngestCorpus` returns `'code' \| 'docs' \| null` |
| Ingestion is event-driven, per merged PR, per bound workspace | `enqueueMergedPrIngestJobs` in the GitHub webhook |
| A per-workspace sensitivity class exists, and fails closed | `workspaces.dataClass` (`standard \| sensitive`); `resolveWorkspaceDataClass` returns `sensitive` on DB failure |
| That class already gates a cross-scope read | `if (teamId && !sensitive)` in `buildCorporaHint` / `buildKnowledgeContext` |
| The claim path already resolves it per task | `apps/web/src/app/api/workers/claim/context-injection.ts` passes `{ sensitive }` |
| Team membership is already resolvable | `getTeamWorkspaceIds` in `team-access.ts` |

So the primitive for "this scope may not be read from here" exists, is used, and
fails closed. What is missing is a rule for the *direction* of a cross-workspace
read, and provenance on what comes back.

## Prerequisite: the key is unset everywhere

`workspaces.dataClass` has **one writer in the whole tree** (the workspace PATCH
route), the create path never sets it, and no dashboard control exists. So every
workspace holds the column default `standard`.

Applied to the permission table below, rows 2 and 4 are the only reachable ones
and both are *allow*. The single denial — `standard` reading `sensitive` — cannot
fire. The check would resolve a class, permit the read, and look like
enforcement. That is the same failure this document accuses the drift loop of, so
it is a prerequisite rather than an open question:

1. Surface `dataClass` on the workspace config page.
2. Default it from the linked repo's visibility at link time (`private ⇒ sensitive`).
3. **Restrict `dataClass` transitions to workspace owner/admin.** The class
   decides what a workspace may *read* under this design, so whoever can raise it
   can widen its reach. It must not be settable at member authority.

Until 1–3 land, this design is a no-op wearing a safety property.

## Proposal

Let a workspace's retrieval reach sibling workspaces in the same team — **docs
corpus only, one direction, with provenance, and never for an agent holding
untrusted input.**

**The crux: the permission is directional, keyed on the publicity of the
workspace doing the reading, not on team membership.**

A maintainer's cross-repo view is safe because their judgment sits between
reading and publishing. An agent's does not. An agent working a **public** repo
that can retrieve from a **private** workspace has, in this system, at least four
publish channels: the PR body, commit messages, PR review comments
(`appendPrActivity`), and `learn` writes into a corpus other agents then read.
Retrieval is also invisible in the output — a private chunk gets paraphrased into
public prose with no marker, so no reviewer can tell where it came from. That is
the same shape as a production statistic sitting in a public spec: it reads as
ordinary prose, which is exactly why it survives review.

So the rule is an asymmetry, not a sharing switch:

| Reader | Source | Allowed |
|---|---|---|
| `sensitive` workspace | `standard` sibling | **yes** — no leak direction exists |
| `standard` workspace | `standard` sibling | **yes** |
| `standard` workspace | `sensitive` sibling | **no** |
| `sensitive` workspace | `sensitive` sibling | **yes** |

If the crux is wrong — if publicity is not the right key — the failure is a
private sentence appearing in a public artifact with no provenance trail, which
is unrecoverable once pushed (a force-push does not retract it). That is why the
default is deny and the resolution fails closed.

**Second bound, independent of the first: an agent whose context includes
untrusted external input gets no cross-workspace read at all, whatever the
classes say.** The reviewer agent reads an attacker-influenced contributor diff
and writes PR comments. Giving that agent a wider corpus hands an injected
instruction both a larger thing to exfiltrate and a channel to publish it on.
Per-workspace isolation is not an accident of the schema for that agent; it is
load-bearing. `docs/design/reviewer-evidence-and-verification.md` argues the same
threat model, and `sanitizeUntrustedText` is where the untrusted inputs are
already identified.

**Third: every cross-workspace chunk carries its origin.** A retrieved chunk
labelled with the workspace it came from lets a human reviewing the resulting PR
ask "why does this reference a repo the task never touched". Without provenance
the read is unauditable, which makes the first two bounds unverifiable in
practice rather than merely unenforced.

**Docs corpus only.** The concrete win is comparing published prose against code.
Opening `code` across workspaces multiplies the blast radius for no gain the
drift loop needs, and source is the more sensitive corpus of the two.

## Implementation sketch

Load-bearing piece first.

0. **Prerequisites 1–3 above.** Without a set `dataClass` the rest is a no-op.
1. **`resolveReadableWorkspaces(readerWorkspaceId, teamId)`** — new, pure where
   it can be: takes the reader's `dataClass` and the team's workspaces, returns
   the sibling IDs whose class the reader dominates. Note `getTeamWorkspaceIds`
   selects `id` only today, so it needs `dataClass` too. Deny on any unresolved
   class, matching `resolveWorkspaceDataClass`'s existing fail-closed behaviour.
   Returns `[]` when the caller is flagged untrusted-input.
2. **A `crossWorkspaceDocs` flag on the retrieval call sites**, defaulting off, so
   merging changes nothing. `spec_compare` is the first opt-in.
3. **Fan out the docs query** over `[readerWs, ...readable]`, tag each result
   with its source workspace, and merge by score. Cap the fan-out (a team with
   many workspaces should not turn one retrieval into N).
4. **Render provenance** in `spec_compare` output and in
   `buildKnowledgeContext`'s sources list — the workspace name next to each
   chunk, not just the path.
5. **Untrusted-input plumbing** — thread the existing signal through to step 1
   rather than re-deriving it. Not optional: see the granularity consequence below.
6. **The invariant test** tying a class-crossing read to `learn` being
   unavailable, plus a `gitConfig` round-trip test proving an unrelated config
   save does not clear the flag.

## Resolved decisions

Three of the four original open questions were answered against the code. What
each turned on is recorded here because the reasoning is load-bearing.

### The key stays `dataClass`; repo visibility seeds and audits it

`github_repos.private` is **client-supplied on the main write path** — the
workspace create route writes it from the request body, defaulting to public when
omitted. A key a caller can set by passing a field is not an authorization key.
It is also stale by construction: the GitHub webhook has no `repository` case, so
`privatized` / `publicized` fall through unhandled and a repo that flips private
keeps its old value indefinitely — precisely the leak direction this design
exists to prevent.

`dataClass` is `NOT NULL DEFAULT 'standard'`, needs no join or fetch, and already
keys the one existing cross-scope read. So it is the runtime check; repo
visibility becomes the initializer (prerequisite 2) and the subject of a
reconciliation warning when the two disagree.

Two corrections this surfaced, both required before the check is trustworthy:

- **Fail-closed has the wrong polarity for a *source*.**
  `resolveWorkspaceDataClass` returns `sensitive` on a thrown DB error but
  `'standard'` for a missing or unreadable row. Correct for a *reader* (an
  unresolved reader gets fewer rights); fail-**open** for a source, because an
  unresolvable sibling would be classified readable. `resolveReadableWorkspaces`
  must deny on an unresolved sibling rather than reuse that default.
- **Two `dataClass` fields exist and disagree.** The column, and a jsonb
  `WorkspaceGitConfig.dataClass` carrying its own migrate-to-a-column TODO. Task
  creation reads the jsonb one; every sensitivity gate reads the column. A new
  gate must read both, or the split should be closed first.

### `learn` is NOT blocked. The scenario is already impossible

This reverses the lean recorded in the first draft, on two findings.

**It is unenforceable.** The MCP server is constructed per request and stateless
(`sessionIdGenerator: undefined`), the memory action's context carries no tool
history, and the only durable per-agent key is a caller-supplied `?worker=` query
param that is already optional. A "this session did a cross-workspace read" flag
either fails open when the param is omitted or denies `learn` to every non-worker
caller. And paraphrase provenance is not observable server-side: the handler sees
a title and a string.

**More importantly, the write is already denied.** `learn` writes team-scoped
(`{teamId}:memory`) and is removed from the tool list, blocked at dispatch, and
blocked again in the handler for a `sensitive` workspace. Under the permission
table above, the only readers granted a *class-crossing* read are `sensitive`
workspaces — which cannot call `learn` at all. `standard → standard` reads stay
inside a class the design already declares mutually readable. So "read from a
private sibling, write into a public corpus" cannot occur without a bug in the
direction check itself, and provenance is the wrong instrument for that.

`spec_compare` is not sensitivity-gated, so the retrieval win survives the write
gate — a `sensitive` workspace can still run the comparison it needs.

That linkage is an invariant, and it must be a **test**, not a comment: *any
workspace granted a class-crossing read must be one where `learn` is
unavailable.* The `learn` gate exists for compliance reasons unrelated to this
threat model, so if it is ever relaxed the invariant evaporates silently. A test
turns that into a red suite.

What ships instead of a block: **best-effort origin metadata** on the learn
mirror and on retrieved chunks. Not a gate — an audit trail, because neither
`knowledge_chunks` nor `memories` records a source workspace today, so laundering
is currently undetectable after the fact. `metadata` is jsonb, so this needs no
migration; absent origin must read as *unknown*, never as *native*.

### Opt-in is per workspace, in `gitConfig`, written through the admin-gated route

**The role is not knowable where retrieval happens.** The MCP action context
carries `workerId`, `workspaceId`, `teamId` — no role and no task — and
`spec_compare` resolves scope from `getWorkspaceId()` alone. The only route to a
role is `workerId`, an optional URL param that other tools already refuse when
absent. So a per-role flag would fail open for every non-worker caller: stored,
displayed, ignored. That is the `allowedTools` defect exactly, and this repo has
just finished paying for it.

Per team is a real pattern (`teams.enabledBackends` has a per-workspace
counterpart) but wrong as the *only* level: the direction rule keys on the
reader's `dataClass`, which is per workspace, so a team switch would enable reads
for workspaces whose class nobody reviewed. It belongs later as a default layer
beneath the workspace flag, in `resolvePolicy`'s precedence idiom.

Two hazards on the write path:

- **Use `POST /api/workspaces/[id]/config`, which requires owner or admin.** The
  workspace `PATCH` route authorises without a required role.
- **That config handler rebuilds `gitConfig` from form fields and preserves only
  an explicit allowlist.** A new field not added to it is silently cleared by any
  unrelated config save — a governance model that erases itself. The round trip
  needs its own test.

**Consequence for the second bound.** Per-workspace granularity means one
drift-checking task turns the wider corpus on for every agent in that workspace,
including a reviewer reading an attacker-influenced diff. That makes the
untrusted-input denial **load-bearing rather than defence in depth**: if it does
not ship, per-workspace is the wrong granularity.

## Open questions

- **Should the reconciliation warning (repo visibility vs `dataClass`) block or
  warn?** Leaning warn. Blocking on a mismatch means a stale GitHub read can
  disable a workspace's retrieval, and the webhook gap makes staleness likely.
- **`dataClass` is overloaded.** Setting `sensitive` today also disables artifact
  uploads, strips instruct/command text, strips note labels, gates MCP tools, and
  drops team memory. So an operator cannot say "this workspace is public,
  siblings may read it" without accepting structured-only retention. Splitting a
  read-direction class out of the retention class is the clean answer and is a
  larger change than this design; the `crossWorkspaceDocs` flag is a partial
  mitigation, not a fix.
- **Does cross-repo agent-to-agent messaging follow?** No, and that is already
  decided in code: `send_worker_message` refuses on a workspace mismatch with
  "Cross-workspace messaging is not allowed." Retrieval is read-only over
  published prose and one-directional; messaging opens a bidirectional channel
  between two running agents in different tenancy scopes, which is strictly
  worse. Recorded here so the two are not conflated later.

## Non-goals

- **Cross-workspace `code` retrieval.** Not in this design. Source is the more
  sensitive corpus and the drift loop does not need it.
- **Cross-team retrieval.** The team is the boundary. Nothing here crosses it.
- **Making `CLAUDE.md` aware of sibling repos.** The point is to avoid a
  hand-maintained relationship, not to formalise one.
- **Fixing doc staleness itself.** `docs/**` refreshes only when a merged PR
  touches it in a bound repo, so a slow-cadence docs repo goes stale quietly.
  Real, separate, and visible in the workspace config's Knowledge Health section.
- **Enforcing that retrieved prose is *correct*.** This makes contradictory
  documentation *reachable* by the drift loop. Judging it remains the loop's job,
  and per `.claude/skills/spec-sync/SKILL.md`, scores surface while a judge
  decides.
