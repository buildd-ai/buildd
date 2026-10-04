---
title: Cloud Egress Merge Guard
status: active
owner: max
last_verified: 2026-10-04
summary: The cloud runner's egress handler MUST refuse a direct GitHub PR merge or a push to a protected branch before attaching its installation token, independent of buildd's own merge-policy code paths.
domain: runners
surfaces: [apps/cloud-runner/src/outbound.ts, apps/cloud-runner/src/egress.ts, apps/web/src/app/api/runner/github-token/route.ts]
related: [worker-sandbox-isolation]
keywords: [merge guard, pushedProtectedBranch, graphqlMutationBlocked, git-receive-pack, mergePullRequest, enablePullRequestAutoMerge, protectedBranches, installation token]
verified_by: [apps/cloud-runner/src/outbound.test.ts, apps/web/src/app/api/runner/github-token/route.test.ts]
supersedes: []
---

# Cloud Egress Merge Guard

**Capability statement**: Every GitHub request a cloud-sandboxed container
sends MUST pass through the egress handler, which MUST refuse a direct PR
merge and a direct push to a protected branch before the task's GitHub App
installation token is ever attached — independent of, and in addition to,
buildd's own merge-policy code (`resolvePolicy` / `evaluateAutoMergeSafety` /
`pr-landing.ts`, `docs/SPEC.md` §4a).

---

## Problem

`docs/SPEC.md` §4a states that "every route to a merge runs the same gate":
auto-merge on green CI, the reviewer `approve` path, and the `merge_pr` MCP
action. That is true of buildd's own server-side code paths. It says nothing
about the credential a cloud-sandboxed agent actually holds.

The cloud runner's egress handler (`EgressHandler` in `egress.ts`) injects a
short-lived GitHub App installation token into the container's outbound
GitHub requests (`apps/cloud-runner/src/outbound.ts`). That token carries
`pull_requests:write` + `contents:write` (`apps/web/src/lib/
github-scoped-token.ts`) — enough, by itself, to call GitHub's own merge
endpoint or push straight over a protected branch, bypassing every one of the
three gated routes above. Policy was a buildd-side convention; nothing at the
credential layer enforced it.

---

## What is blocked, and where

All three checks run in `rewriteOutbound()` (`apps/cloud-runner/src/
outbound.ts`), before `githubAuthFor()` decides whether to attach the
installation token at all — so a blocked request never carries the
credential, even unobserved.

1. **REST merge**: `PUT /repos/{owner}/{repo}/pulls/{number}/merge`, matched by
   `isPrMergeRestRequest` against the literal path shape. Any other method on
   that path (`GET`, `POST`, `DELETE`) is untouched — those are read/comment
   endpoints, not the merge action.
2. **GraphQL mutation**: a `POST /graphql` to `api.github.com` whose body
   names `mergePullRequest` or `enablePullRequestAutoMerge`
   (`BLOCKED_GRAPHQL_MUTATIONS`, checked by `graphqlMutationBlocked`). This is
   a name match on a body prefix, not a parsed GraphQL AST walk: a request
   that merely mentions the name (e.g. inside an unrelated string) is blocked
   too. That false-positive direction is the safe one.
3. **Protected-branch push**: `POST .../git-receive-pack` to `github.com`
   whose pkt-line ref-update lines (`parseReceivePackPushedBranches`) name a
   branch in the grant's `protectedBranches` list (`pushedProtectedBranch`).

Each refusal is `403` with a message that names `merge_pr` as the way to
actually land the PR, and is counted in the run report with
`reason: 'merge_blocked'` (`run-report.ts` `REJECT_REASONS`).

## What is NOT blocked

- `git push` of any branch not in `protectedBranches` — the ordinary task
  branch flow.
- PR creation, comments, reviews, `GET` reads, and every other REST/GraphQL
  call. Only the three shapes above are inspected.
- A GraphQL request to `/graphql` that does not mention a blocked mutation
  name, or whose body egress.ts did not peek at all (`bodyPeek` absent) — see
  "Fails open" below.

---

## Where `protectedBranches` comes from

The grant's `protectedBranches` field (`GithubGrant.protectedBranches` in
`outbound.ts`) is set by `POST /api/runner/github-token`
(`apps/web/src/app/api/runner/github-token/route.ts`), computed as:

```ts
[...new Set([
  ...protectedBaseBranches({ gitConfig: ws.gitConfig, releaseConfig: ws.releaseConfig }),
  repo.defaultBranch,
].filter(Boolean))]
```

`protectedBaseBranches()` (`apps/web/src/lib/auto-merge-bound.ts`) is the same
function the auto-merge model-approve bound already uses — it returns
`['main', gitConfig.targetBranch, gitConfig.defaultBranch,
releaseConfig.prodBranch]`, deduped, with `'main'` included unconditionally.
This guard additionally folds in the GitHub repo's own `defaultBranch`
(synced from GitHub, `github_repos.default_branch`), which
`protectedBaseBranches()` deliberately omits for its own purpose (see its
docstring) — a raw push bypasses buildd's merge policy entirely, so this
guard is stricter.

The list travels in the grant response, parsed by `parseGithubGrant` and
cached in memory by the agent's `GithubTokenCache`, exactly like the
installation token itself — never written to Durable Object storage, never
handed to the container.

## Fails open, by design, in two places

- **No usable grant, or a grant with no `protectedBranches`** (an older
  buildd server, or a lookup failure): `pushedProtectedBranch` returns `null`
  and the push proceeds — the REST and GraphQL merge blocks are unconditional
  and still apply regardless.
- **An unparseable or gzip-compressed push body**: git does not compress a
  push body by default; nothing here decodes `Content-Encoding`.
  `parseReceivePackPushedBranches` returns `[]` when the pkt-line prefix does
  not parse (truncated read, non-pkt-line bytes), rather than guessing a
  branch name — an inconclusive read is never treated as a match.

Both are acceptable because this guard is defense in depth, not the only
gate: a push that slips through still has to land somewhere buildd's own
merge-policy code, or GitHub's own branch protection (if configured), can
still catch — see `docs/SPEC.md` §4a.

---

## Acceptance criteria

- **AC-1**: GIVEN a container request `PUT
  https://api.github.com/repos/{owner}/{repo}/pulls/{n}/merge`, WHEN the
  egress handler evaluates it, THEN it rejects with HTTP 403 and
  `reason: 'merge_blocked'`, and the installation token is never attached.
- **AC-2**: GIVEN a `POST https://api.github.com/graphql` body containing a
  `mergePullRequest` or `enablePullRequestAutoMerge` mutation, WHEN evaluated,
  THEN it rejects with HTTP 403 and `reason: 'merge_blocked'`.
- **AC-3**: GIVEN a `POST .../git-receive-pack` to `github.com` whose
  ref-update lines name a branch present in the grant's `protectedBranches`,
  WHEN evaluated, THEN it rejects with HTTP 403 naming that branch.
- **AC-4**: GIVEN the same push shape as AC-3 but targeting the task's own
  branch (not in `protectedBranches`), WHEN evaluated, THEN it forwards with
  the installation token attached (`github_basic`), unchanged from before
  this guard existed.
- **AC-5**: GIVEN a grant with no `protectedBranches` (absent field), WHEN a
  push to any branch is evaluated, THEN it is not blocked by the push check
  (fails open) — but a REST merge or blocked GraphQL mutation on the same
  grant is still rejected.
- **AC-6**: GIVEN a `GET`, `POST` or `DELETE` to
  `/repos/{owner}/{repo}/pulls/{n}/merge` (not `PUT`), WHEN evaluated, THEN it
  is forwarded normally — only the exact REST merge shape is blocked.

---

## Code surface

| Symbol | File | Purpose |
|---|---|---|
| `isPrMergeRestRequest` | `apps/cloud-runner/src/outbound.ts` | Matches the REST merge endpoint's method + path |
| `BLOCKED_GRAPHQL_MUTATIONS`, `graphqlMutationBlocked` | `apps/cloud-runner/src/outbound.ts` | Name-matches a blocked GraphQL mutation in a peeked body |
| `parseReceivePackPushedBranches`, `pushedProtectedBranch` | `apps/cloud-runner/src/outbound.ts` | Parses pushed ref names from a `git-receive-pack` pkt-line prefix; matches against the grant |
| `needsGithubBodyPeek`, `latin1Decode` | `apps/cloud-runner/src/outbound.ts` | Decide which requests need a body peek; decode the peeked bytes without throwing |
| `GithubGrant.protectedBranches` | `apps/cloud-runner/src/outbound.ts` | The branch names this guard protects, carried on the grant |
| `peekRequestBodyPrefix` | `apps/cloud-runner/src/egress.ts` | Reads a bounded prefix from `request.clone()`; the original stream forwards untouched either way |
| `POST /api/runner/github-token` | `apps/web/src/app/api/runner/github-token/route.ts` | Computes and returns `protectedBranches` for the grant |
| `protectedBaseBranches` | `apps/web/src/lib/auto-merge-bound.ts` | Reused, unmodified, as the base of the protected set |

---

## Out of scope

- **Self-hosted runners.** `apps/runner` agents now get a task-scoped GitHub
  token (the scoped-token rollout), but nothing in that path yet inspects a
  request shape the way this cloud egress guard does. The same three checks
  belong wherever that runner's own outbound GitHub traffic is intercepted,
  as a follow-on once the scoped-token rollout reaches `enforce` for a
  workspace — not duplicated here.
- **GitHub's own branch-protection rules API.** The installation token's
  permissions (`contents:write`, `pull_requests:write`) do not include
  `administration:read`, so this guard cannot ask GitHub which branches are
  actually protected. `protectedBranches` is buildd's own convention
  (workspace trunk, release branch, repo default branch), not a live read of
  GitHub's configured protection — a repo whose GitHub protection rules
  diverge from buildd's convention is not covered by this guard.
- **gzip/deflate-encoded push bodies.** Not decoded; see "Fails open" above.
- **Force-pushes, tag pushes, and non-`refs/heads/*` refs.** Only branch
  (`refs/heads/*`) ref-update lines are matched; a push to `refs/tags/*` or
  similar is not inspected by this guard.
