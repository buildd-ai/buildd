# `@buildd` Mentions in GitHub Comments

**Status:** Proposed
**Related:** `apps/web/src/app/api/github/webhook/route.ts`, `apps/web/src/lib/worker-instructions.ts`, `apps/web/src/app/api/workers/[id]/instruct/route.ts`, `apps/web/src/lib/repo-scope.ts`, `apps/web/src/lib/pr-activity-comment.ts`, `apps/web/src/auth.ts`, `docs/design/cron-wake-windows.md`

## Problem

A reviewer reading a buildd agent's PR has no way to answer it from where they
are. The agent's questions surface in the dashboard (`TaskQuestionFeed`) and
steering goes through `POST /api/workers/[id]/instruct`, so replying means
leaving the review, finding the task, and typing there. In practice the reply
doesn't happen — the review comment sits on the PR and the agent, which never
reads PR comments, waits or finishes without it.

Meanwhile `issue_comment` deliveries already arrive at the webhook and fall
through the switch to `default: console.log('Unhandled event')`. The signal is
being paid for and discarded.

## Current state

Every piece this needs already exists:

- **Identity link.** `users.githubId` is unique and indexed, and `auth.ts` sets
  it from `account.providerAccountId` — the *numeric* GitHub user id, not the
  login. A webhook's `comment.user.id` therefore maps to a buildd user exactly,
  and survives a GitHub rename (a login-based match would not).
- **Delivery.** `lib/worker-instructions.ts` (`enqueuePendingInstruction`,
  `appendInstructionHistory`, `isUnreachableWorkerStatus`) queues a message that
  the runner is handed on its next check-in and clears only on confirmation.
  `POST /api/workers/[id]/instruct` is the existing caller.
- **PR → worker resolution.** `workerOwnsPr(repoFullName, prNumber)` in
  `lib/repo-scope.ts`, already used by the `check_suite` handler.
- **Comment write-back.** `appendPrActivity` in `lib/pr-activity-comment.ts`.

So this is a routing change, not new machinery.

## How other projects do it

| Product | Trigger | Who may trigger | Notable |
|---|---|---|---|
| **Claude Code Action** | `@claude` in issue/PR comment | Repository **write access**, checked per event; `allowed_non_write_users` opts specific logins in; **bots blocked by default** (`allowed_bots`) | Strips HTML comments, invisible characters, image alt text and hidden attributes from comment bodies before the model sees them; restores `.claude/`, `CLAUDE.md`, `.mcp.json` from the base branch on PRs so config can't be injected by the PR under review |
| **Copilot coding agent** | `@copilot` in a PR comment | Repository **write access** only — added in response to feedback | Acks by adding a 👀 reaction to the triggering comment when the session starts |
| **Dependabot** | `@dependabot <command>` | Public docs specify a fixed command grammar but **state no permission rule** | Narrow verb list (`rebase`, `recreate`, `ignore …`) rather than free-form instruction — nothing to inject a prompt into |
| **CodeRabbit** | `@coderabbitai <command>` | Keyword commands; RBAC is a paid-tier feature | Cautionary tale: Kudelski showed a review bot that executed repo-supplied tooling could be driven to RCE with write access to ~1M repos |

Three things every mature implementation agrees on, and one split:

1. **Write access is the gate.** Both agentic implementations require it. Neither
   treats "commented on the repo" as authorization.
2. **Bots are excluded by default.** On a public repo anyone can install an App
   and emit comment events; Claude's docs call out that allowlisted bots skip
   the permission check entirely.
3. **Acknowledge synchronously.** A reaction on the comment tells the human the
   mention landed, before any slow work starts.
4. **The split is grammar.** Dependabot/CodeRabbit accept fixed verbs and are
   injection-proof by construction; Claude/Copilot accept free-form prose and
   pay for it with sanitisation. buildd wants free-form (it is a message to an
   agent), so it inherits the sanitisation burden.

## Proposal

Handle `issue_comment` (created) and `pull_request_review_comment` (created).
When the body mentions `@buildd`, resolve the comment to a live worker and
deliver the remaining text as an agent message through the existing instruction
queue.

Order of checks, cheapest and most restrictive first — each rejection is silent
except where noted:

1. `action !== 'created'` → return. Edits do not re-trigger.
2. Comment author is a bot (`user.type === 'Bot'`) → return. Non-negotiable:
   `appendPrActivity` writes as the App, so without this the bot can answer
   itself.
3. Body does not match `@buildd` → return, before any DB query. This is the
   common case for every unrelated comment.
4. `comment.user.id` resolves to a `users.githubId` row → else post a one-time
   reply pointing at sign-in. **Mentions from strangers are the default case on
   a public repo, so this branch, not the happy path, is what needs to be
   boring.**
5. Comment author has **write access** to the repo, verified against
   `GET /repos/{owner}/{repo}/collaborators/{login}/permission` via the
   installation token — not `author_association` from the payload, which
   reports `CONTRIBUTOR` for anyone with a merged PR and cannot distinguish a
   collaborator from a drive-by.
6. The buildd user's team must own the workspace the PR belongs to. A buildd
   account is not authorization for *this* repo's agent.
7. Sanitise the body (strip HTML comments, zero-width characters, image alt
   text) and deliver via `enqueuePendingInstruction`, then 👀 the comment.

**Crux: authorization is the intersection of "linked buildd user" and "write
access on this repo", and it is checked server-side per comment.** Everything
else here is plumbing. If that intersection is wrong — if a linked buildd
account is treated as sufficient, or `author_association` is trusted — then any
GitHub user who once landed a PR can drive an agent that holds this team's
credentials and push rights. That is the whole risk surface of the feature, and
it is why the identity match is on numeric id and the permission check costs a
real API call.

**Safety properties, all bounded:**

- **Idempotent per comment.** `comment.id` is recorded before delivery; a
  redelivery (GitHub retries non-2xx) delivers nothing twice.
- **One in-flight message per worker per comment**, and only to workers
  `isUnreachableWorkerStatus` accepts — a mention on a finished PR gets a reply
  saying so, never a silently dropped message.
- **Rate cap per PR per hour**, so a comment war cannot fan out into unbounded
  agent turns.
- **Ships disabled.** Gated on a workspace flag (`gitConfig.commentMentions`,
  default off), so merging this changes nothing until a workspace opts in.

## Implementation sketch

1. `lib/comment-mention.ts` — pure: detect the mention, strip it, sanitise the
   remainder, return `null` when there's nothing to send. Unit-testable with no
   I/O, and it is where the injection tests live.
2. `lib/comment-authorization.ts` — resolve `comment.user.id` → buildd user,
   check repo permission, check team owns the workspace. Returns a discriminated
   result (`ok` / `not_linked` / `no_write_access` / `wrong_team`) so the caller
   picks the reply, and so each branch is directly testable.
3. Webhook cases for `issue_comment` and `pull_request_review_comment`, wired to
   the existing `workerOwnsPr` lookup and `enqueuePendingInstruction`.
4. 👀 reaction + the `not_linked` reply via `appendPrActivity`.
5. Only then: task creation for a mention on a PR with no live worker.

## Non-goals

- **A command grammar.** No `@buildd rebase`. This is a message to an agent; if
  we later want verbs, they are a separate parser in front of step 1.
- **Reading comments the agent was not mentioned in.** No ambient context
  ingestion — that is the injection vector Claude's docs spend the most words on.
- **Issue comments on issues with no PR/worker.** Out of scope until step 5.
- **Replacing the dashboard question feed.** This is a second door to the same
  instruction queue, not a migration.
- **Cross-repo or fork-head trust.** A mention on a fork PR is authorized by the
  commenter's permission on the *base* repo, and nothing from the fork's head is
  read as instruction.

## Open questions

- **Should an unlinked mention reply at all?** Leaning yes, once per PR: silence
  reads as "buildd is broken" to a teammate who hasn't signed in. But any
  auto-reply on a public repo is a spam vector, hence once-per-PR rather than
  once-per-comment.
- **Write access, or a narrower buildd-side role?** Leaning write access to
  start, because it matches both prior implementations and needs no new UI. A
  workspace-level allowlist is the obvious escalation if a team wants a reviewer
  who can comment but not steer.
- **Does the permission API call need caching?** One call per authorized mention
  is negligible; the cheap gates run first. Worth revisiting only if mention
  volume ever rivals webhook volume, which the measured event mix says it won't.
