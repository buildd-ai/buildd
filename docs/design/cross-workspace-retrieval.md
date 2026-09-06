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

1. **`resolveReadableWorkspaces(readerWorkspaceId, teamId)`** — new, pure where
   it can be: takes the reader's `dataClass` and the team's workspaces, returns
   the sibling IDs whose class the reader dominates. Deny on any unresolved
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
   rather than re-deriving it.

## Open questions

- **Is `dataClass` the right key, or should the read be keyed on repo visibility
  from the GitHub side?** I lean on `dataClass`: it is already resolved
  fail-closed, already gates team memory, and it decouples the decision from a
  GitHub API call on a hot path. But it is a *workspace* setting, and nothing
  currently forces it to match the linked repo's actual visibility — so a public
  repo in a `sensitive` workspace would read siblings it arguably should not. A
  reconciliation check (warn when `dataClass` disagrees with repo visibility)
  may be the honest answer, as a separate gate.
- **Should `learn` be blocked from writing a cross-workspace-derived fact?** I
  lean yes and have not designed it. A fact retrieved from a private sibling and
  then written into a public workspace's corpus launders the origin permanently —
  worse than the PR-body case, because the next agent reads it as native.
- **Opt-in granularity: per workspace, per team, or per role?** I lean
  per-workspace to start (one flag, one owner). Per-role is more precise and
  matches how `allowedTools` was *supposed* to work — but see
  `docs/design/reviewer-evidence-and-verification.md` on shipping a governance
  model before enforcement exists.
- **Does this make cross-repo agent-to-agent messaging desirable too?** Out of
  scope here, and the axes are different: this is artifact awareness, messaging
  is coordination. Worth keeping separate so one does not smuggle in the other.

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
