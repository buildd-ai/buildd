# User-owned agent credentials

**Status:** Proposed
**Related:** `packages/core/db/schema.ts` (`secrets`, `accounts`, `users`, `teamMembers`), `apps/web/src/lib/codex-credential.ts`, `apps/web/src/app/api/runner/credential-refresh/route.ts`, `apps/web/src/app/api/workers/claim/credential-injection.ts`, `docs/credentials-architecture.md`, `docs/specs/credential-refresh-lifecycle.md`

## Problem

An agent-backend OAuth credential is a **personal subscription** — one human's
ChatGPT or Claude login. The schema models it as a **team asset**:
`secrets.teamId` is `NOT NULL`, and every scoping tier
(`workspaceId` → `accountId` → team-wide) resolves *within* one team.

So a user who operates several teams from one runner must connect the same
subscription once per team. That produces two bad outcomes, and the tempting
shortcut is the worse one:

1. **N connects, N grants.** Each connect is a separate OAuth grant with its own
   refresh-token family. Functional, but the user reconnects N times, and N rows
   must each be swept, locked, leased and rotated independently.
2. **N rows, one grant** — pasting the same `auth.json` into each team. This is
   the shortcut a tired operator reaches for, and it is **destructive**: the
   provider rotates the refresh token on every use, so the first rotation
   consumes the token the other rows still hold. They all die with
   `invalid_grant`, permanently, and nothing warns first.

The model makes the unsafe path the convenient one. That is the failure this
design targets.

There is also a plain mismatch with how runners work. A runner authenticates as
one `accounts` row, but reaches workspaces beyond its own team through
`accountWorkspaces` and the claim route's `claimAcrossAccessible` option.
Credentials resolve from the *task's* team, so a runner doing cross-team work
needs a credential in a team it does not belong to — even though the compute,
the subscription and the human are all the same one.

## Current state

- `secrets.teamId` — `uuid ... .notNull()`, cascade on team delete. There is no
  scope above a team.
- Precedence is documented in `docs/credentials-architecture.md` and implemented
  per-backend (`scopeMatch` in `apps/web/src/lib/codex-credential.ts`): most
  specific of workspace / account / team-wide wins.
- `accounts` is **not a human**. Rows are per-device and per-service
  registrations — a laptop, a CLI install, a CI service. Its ownership edge is
  `teamId`, and it has **no `userId` column at all**.
- `users` and `teamMembers` already exist, and `teamMembers` is a genuine
  many-to-many: one user can own or belong to several teams today.
- `/api/runner/credential-refresh` and `/api/runner/credential-lease` authorize
  by comparing `credential.teamId` against the authenticated account's team.

## Proposal

Introduce **user ownership** as a fourth, least-specific scope for
agent-backend purposes only (`codex_credential`, `claude_credential`,
`oauth_token`, `anthropic_api_key`). A user-owned credential is resolved for any
task that user's own runner claims, in any team.

Resolution becomes, most specific first:

```
workspace-scoped (team T)  →  account-scoped (team T)  →  team-wide (team T)
                           →  user-owned (the runner's owner)
```

User-owned is the **fallback**, deliberately. Existing team rows keep winning,
so merging the change alters nothing for anyone who has already connected — the
default is a no-op. The personal credential fills only the gaps, which is
exactly the "one subscription, several teams" case.

### The crux

**The owner is `users`, not `accounts` — and the enabling prerequisite is that
`accounts` has no `userId`.**

Everything turns on this. `accounts` is per-device, so owning credentials by
account gives one credential *per machine* — strictly worse than today. `users`
is the right grain and already spans teams. But the runner presents an account
key, so the system cannot currently answer **"which human owns this runner?"**
That question must become answerable first; the rest is mechanical.

If the crux is wrong — if we pick `accounts` as the owner because it is the
thing that authenticates — we ship per-device credentials, multiply the number
of refresh-token families instead of reducing it, and make the rotation problem
worse while appearing to fix it.

### Safety property

A user-owned credential MUST be reachable **only through a runner belonging to
its owner**. Resolution keys off the *authenticated account's* user, never off
the task's author or the task's team. Without that bound, any member of a team
could author a task that spends another member's personal subscription.

Bound, stated concretely: for a user-owned row, authorization is
`credential.userId === <user of the authenticated account>`. This is strictly
narrower than the current team check, and team-owned rows keep the existing
check unchanged — so the security property moves monotonically and the tenancy
guard added in PR #2236 is not loosened.

## Implementation sketch

Load-bearing piece first.

1. **`accounts.userId`** — nullable uuid FK to `users`, no backfill required. A
   NULL `userId` means "unknown owner", and such an account resolves credentials
   exactly as it does today. New accounts created through an interactive login
   record the user; service accounts (`type = 'service'`) legitimately stay NULL
   forever, since no human owns them.
2. **`secrets.userId`** — nullable uuid FK, plus a CHECK that for agent-backend
   purposes exactly one of `teamId` / `userId` is non-null. This requires
   relaxing `secrets.teamId` to nullable, which is the one irreversible-feeling
   part of the migration; the CHECK is what keeps it honest.
3. **Unique index.** The existing partial unique index is
   `(teamId, accountId, workspaceId, purpose, label)` with `NULLS NOT DISTINCT`,
   over auth purposes only. Two user-owned rows for *different* users both have
   a NULL `teamId` and would collide under `NULLS NOT DISTINCT`. `userId` must
   join that index (or get a sibling partial index) or the second user to
   connect silently overwrites the first.
4. **Resolvers** — extend the precedence in the per-backend resolvers and in
   `apps/web/src/app/api/workers/claim/credential-injection.ts`, including
   `resolveAccountCredentialRefreshes` (added in PR #2235), which announces
   near-expiry credentials on every claim poll and must announce a user-owned
   one to its owner's runner.
5. **Authorization** — make the check in both runner routes two-branch, per the
   safety property above.
6. **Settings UI** — a personal-vs-team choice at connect time. Without it the
   feature is unreachable, and the default must remain team.
7. **Docs** — `docs/credentials-architecture.md` gains the tier;
   `docs/specs/credential-refresh-lifecycle.md` INV-7 changes from "belongs to
   the caller's team" to the two-branch form.

## Impact assessment

**Rotation safety — improves.** One row per user rather than one per team means
one refresh-token family, one lock, one lease holder. The duplicate-blob
footgun in the Problem section stops being tempting because the safe path
becomes the shorter one. This is the strongest argument for the change and it is
independent of convenience.

**Billing and attribution — the real tradeoff.** A personal subscription would
fund work in whatever team the task came from. For a single-operator deployment
that is precisely the intent. For a shared one it is a policy decision, which is
why user-owned is fallback-only and gated on the runner's owner: the exposure is
bounded to "my runner, my token, my choice of what it works on", not "any team
can spend my subscription".

**Blast radius — unchanged for existing rows, narrower for new ones.** Nothing
about team-owned resolution or authorization changes. See the safety property.

**Migration — additive, defaults to a no-op.** Two nullable columns and an index
change. Every existing row keeps `teamId` set and behaves identically; no
backfill is required, and users opt in by connecting once as personal. The
`accounts.userId` backfill is deliberately skipped rather than guessed: inferring
the owner from a team's sole `owner` member is ambiguous the moment a team has
two members, and a wrong guess here silently mis-routes a credential.

**What it does not touch.** Rotation-loss detection, the unlocked refresh grant
in `verifyCodexCredential`, MCP connector scoping, and the fact that a credential
whose rotation was already lost needs a manual reconnect.

## Open questions

- **Does team-owned or user-owned win when both exist?** I lean team-owned, as
  above, because it makes the change a no-op on merge and treats an explicitly
  configured team asset as intentional. The counter-argument is that a user who
  connects personally probably expects their own subscription to be used; if
  that turns out to be the common expectation, the order should flip — but it
  should flip deliberately, not by default.
- **What is `accounts.seatId` for?** It is an unindexed-by-FK `text` column with
  an index, currently unused in the data, and seat-based billing already
  distinguishes OAuth from API-key auth. If it was intended as the human-identity
  link, this design should use it rather than add `userId`. Needs an owner's
  answer before step 1 is built.
- **Should a user-owned credential be usable by a *service* account the user
  operates?** A CI runner has no human at the keyboard but does have an owner in
  practice. Leaving service accounts NULL is the safe default and blocks the
  case; allowing an explicit owner assignment would unblock it at the cost of a
  weaker bound.

## Non-goals

- Sharing a credential **between** users. This design gives a user one credential
  across their own teams; it does not introduce delegation or pooling.
- Changing MCP connector credential scoping, which has no single-use rotation and
  therefore none of this urgency.
- Consolidating duplicate teams or merging user identities. Related operationally,
  but a separate change with its own data-loss risk.
- Replacing the team scope. Teams remain the right owner for a credential a team
  genuinely owns, such as a company API key.
