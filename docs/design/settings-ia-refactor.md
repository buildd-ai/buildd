# Settings IA Refactor (SPEC)

> **Status: authoritative design spec.** This is the plan of record for the
> Settings information architecture refactor. Agents implementing any of the
> follow-on tasks below MUST follow these decisions — do not re-derive the
> IA from first principles. The two recon tasks that produced this spec are
> linked in §7.
>
> **Scope:** Dashboard routes and components only. No schema changes, no API
> surface changes beyond the account-model hygiene noted in §5.
> **Derived from:** code audit of `apps/web/src/app/app/(protected)/settings/`,
> `apps/web/src/app/app/(protected)/you/`, `apps/web/src/components/`, and
> `apps/web/src/app/api/accounts/`, as of **2026-06-25**.

---

## 1. Problem

`apps/web/src/app/app/(protected)/settings/page.tsx` is a 448-line server
component that stacks four fundamentally different kinds of content into one
scroll:

| Kind | Examples on the page |
|---|---|
| **Config you edit** | Agent Backends, API Keys, GitHub, Vercel, Notifications |
| **Read-only telemetry** | Runners list, Usage (30 d) |
| **Navigation shortcuts** | Workspaces list, Browse artifacts link |
| **One-time setup docs** | Connect Claude (workspace MCP URL) |

Every visit scrolls past three modes to reach one. This produces a page where
the average user reads ≈25% of the content they see on each visit.

`/app/you` is a 5-line redirect stub — it unconditionally redirects to
`/app/settings`. It carries no account-specific content and could not serve as
a coherent "me" page.

The KB claim that PR #409 merged settings into `/you` is **false** — `/you`
redirects into `/settings`, not the reverse.

---

## 2. Target IA — three cohesive surfaces

### 2.1 ACCOUNT  →  `/app/you`  (make it a real page)

**What it holds:** everything about the logged-in user as a person.

| Section | Content | Current location |
|---|---|---|
| Profile | Avatar, name, email | Settings → profile area |
| Sign out | `SignOutButton` | Settings |
| Teams list | Member counts, role badges per team, +New Team | Settings (currently under Workspaces?) |
| Mobile team switcher | `TeamSwitcher` rendered `md:hidden`, only when user belongs to >1 team | Currently surfaced in primary nav only |

**Acceptance criteria:**

- AC-1: WHEN a user navigates to `/app/you`, THEN the page renders their
  profile, sign-out affordance, and their team memberships — it does NOT
  redirect elsewhere.
- AC-2: GIVEN a user in exactly one team, WHEN `/app/you` renders on mobile,
  THEN the team switcher is hidden (no switcher rendered when redundant).
- AC-3: GIVEN a user in >1 team, WHEN `/app/you` renders on mobile
  (`< md` breakpoint), THEN `TeamSwitcher` is visible and usable.
- AC-4 (error): GIVEN an unauthenticated request to `/app/you`, THEN the
  response is a redirect to the login page (not a 500).

### 2.2 CONNECTIONS  →  `/app/settings`  (rebuilt, same route)

**What it holds:** everything that authenticates the team's runners and their
model backends — all under the single auth boundary ("the team is the auth
boundary"). The page keeps the same route so existing deep-links still work.

Three subsections:

#### Agent Backends  (UNCHANGED)

Claude OAuth/API key, Codex auth.json, provider routing toggle, scope
selector. This is the authoritative model-credential store (`secrets` table).
No changes to functionality or UI.

**Code surface:** `apps/web/src/app/app/(protected)/settings/AgentBackendsSection.tsx`

#### Runner Tokens  (RENAME from 'API Keys')

Rename the 'API Keys' section to 'Runner Tokens' throughout.

Content:
- Account list — `bld_` key prefix, type/level, concurrency limits.
- Per-account: regenerate key, delete account.
- MCP setup snippet (the `bld_` key as the MCP credential).
- +New Runner Token → `/app/accounts/new`.
- Explanatory copy (new): *"Runner tokens authenticate your runner to buildd —
  they don't contain model credentials. Set model credentials in Agent
  Backends."*

**Remove (dead code):** the OAuth Set / Rotate / Revoke buttons that write
`accounts.oauthToken`. This column is deprecated — the claim route never
reads it (verified in recon; see §7). Removing these buttons does not break
any active auth flow.

**Acceptance criteria:**

- AC-1: WHEN `/app/settings` loads, THEN the section previously labelled
  'API Keys' is labelled 'Runner Tokens' in heading and all in-page copy.
- AC-2: WHEN the Runner Tokens section renders, THEN the OAuth Set / Rotate /
  Revoke buttons are absent from the DOM.
- AC-3: GIVEN a `bld_` key account, WHEN the user clicks Regenerate, THEN a
  new key is issued and the old key is immediately invalidated.
- AC-4 (error): GIVEN an attempt to call the removed OAuth Set/Rotate/Revoke
  endpoints directly, THEN those code paths MUST NOT be reachable from the
  new UI (the endpoints may remain for back-compat but are not surfaced).

#### GitHub  (UNCHANGED)

`GitHubSection` — installations, sync, connect org. No changes.

#### Vercel  (UNCHANGED)

`VercelSection` — team-level tokens. No changes.

**Acceptance criteria (Connections page overall):**

- AC-5: GIVEN a user navigates to `/app/settings`, THEN the page renders
  Agent Backends, Runner Tokens, GitHub, and Vercel sections and nothing else
  (no telemetry, no workspace list, no Connect Claude).
- AC-6: WHEN the page loads, THEN it resolves the active team from the
  `buildd-team` cookie server-side and scopes all credential reads to that
  team (no data from other teams leaks).
- AC-7 (error): GIVEN a `buildd-team` cookie referencing a team the current
  user is not a member of, WHEN `/app/settings` loads, THEN the page falls
  back to the user's default team and does NOT expose another team's secrets.

### 2.3 NOTIFICATIONS  →  `/app/settings/notifications`  (UNCHANGED, team-scoped)

Pushover/webhook channels + event toggles
(`taskClaimed`, `taskCompleted`, `taskFailed`, `credentialExpired`).

No functional changes. Currently lives inside the settings scroll; extract it
into its own nested route or tab within `/app/settings` so it is reachable
without a full-page scroll.

**Acceptance criteria:**

- AC-1: WHEN a user navigates to the Notifications section, THEN they see
  channel configuration (Pushover, webhook) and per-event toggles.
- AC-2: WHEN the page saves a notification channel, THEN it writes to the
  team scoped by the active `buildd-team` cookie (not the user's personal
  account).
- AC-3 (error): GIVEN two teams both with Pushover configured, WHEN a user
  views Notifications for team A, THEN team B's Pushover token is NOT visible
  or modifiable.

---

## 3. Removed from `/app/settings`

These items are removed from the Settings scroll because they belong elsewhere.
They are NOT deleted — they are relocated.

### 3.1 Runners list + Usage (30 d)  →  `/app/health`

Both are read-only telemetry (nothing to configure). The Runners list is
already echoed at `/app/health`; Usage can be placed there too.

**Extraction work required:**
- Runners list is currently inline server JSX in `settings/page.tsx`. Extract
  into a `getRunnerHeartbeats(userId: string)` helper in
  `apps/web/src/lib/runner-helpers.ts` (or co-locate in `health/`) so both
  `/app/health` and any future health page can import it without duplicating
  the query.
- Usage (30 d) query needs only workspace IDs (`getUserWorkspaceIds(userId)`)
  — add to `/app/health` as a collapsible or secondary card.

### 3.2 Connect Claude  →  `/app/workspaces/[id]/config`

`ConnectClaudeSection` is a workspace-scoped MCP connector URL generator.
It is pure client-side URL construction with no API coupling — the URL is
derived from the workspace ID.

Relocation approach:
- Add to `apps/web/src/app/app/(protected)/workspaces/[id]/config/page.tsx`
  (or create the page if it does not yet exist).
- Pass the route's `params.id` as a single-element array; the workspace
  dropdown that exists in the Settings version is dropped (workspace is known
  from the route).

### 3.3 Workspaces list + Browse (Artifacts link)  →  Sidebar nav

Pure navigation, not configuration. These belong in the primary sidebar
(`MissionsSidebar.tsx`) or as top-level nav links, not inside Settings.

---

## 4. Dead code to delete

The following files in `apps/web/src/app/app/(protected)/settings/` are
imported nowhere (verified in recon). Delete without replacement:

| File | Why dead |
|---|---|
| `DiscordSection.tsx` | Never imported from `settings/page.tsx` or anywhere else in the app |
| `SlackSection.tsx` | Same — workspace Discord/Slack config was removed from the UI |
| `HeartbeatSection.tsx` | Superceded by `/app/health`; not imported |
| `SkillsSection.tsx` | Moved to the Team page; import removed and not re-added |

Verify with `grep -r "DiscordSection\|SlackSection\|HeartbeatSection\|SkillsSection"` before
deleting to confirm no new importers.

---

## 5. Cross-cutting concerns

### 5.1 Navigation active-state

Three nav components link `/app/settings`:
- `apps/web/src/components/MissionsSidebar.tsx` — desktop sidebar
- `apps/web/src/components/UserAvatarMenu.tsx` — user avatar dropdown
- `apps/web/src/components/MissionsBottomNav.tsx` — mobile bottom nav

`MissionsBottomNav.tsx` lines ~79–82 hard-code `/app/you`, `/app/artifacts`,
`/app/teams`, `/app/accounts` as the paths that trigger the 'settings'
active-state indicator. With the `/app/you` → real page split, this logic
must be updated so:
- `/app/you` → active-state on the Account tab
- `/app/settings` → active-state on the Connections tab

The user avatar menu in `UserAvatarMenu.tsx` currently links 'Settings' to
`/app/settings`. After the split, it should offer two entries or link to
whichever is more commonly useful (recommendation: keep 'Settings' →
`/app/settings` for Connections; add 'Account' → `/app/you`).

### 5.2 Team scoping across the split

`/app/settings` (Connections) and `/app/settings/notifications`
(Notifications) are both team-scoped via the `buildd-team` cookie.

After the route split, each page MUST independently resolve the active team
server-side. The correct approach is **per-page re-derive** (read and validate
the cookie in each page's server component), matching the existing pattern in
`apps/web/src/app/app/(protected)/layout.tsx`. Do NOT attempt to thread the
resolved team through a shared layout context — Next.js server component
context is not a reliable pass-down for cookie-dependent values across page
boundaries.

### 5.3 Client/server extraction

`AgentBackendsSection`, `GitHubSection`, and `VercelSection` are already
`'use client'` components with their own fetches — they can be lifted into
the new Connections page with no structural changes.

`NotificationsSection` is also `'use client'`. Same pattern — lift directly.

The Runners list and Usage are inline **server JSX** in `settings/page.tsx`
(the most tightly coupled parts). Relocating them to `/app/health` requires
extracting the data-fetch logic into the `getRunnerHeartbeats` helper noted in
§3.1 so the page is not the data layer.

### 5.4 Account-model hygiene  (fold into Task 6 or a sibling task)

The following account API issues were found in recon 2 (see §7):

1. `POST /api/accounts` writes `oauthToken` in plaintext to the
   `accounts.oauthToken` column (deprecated). Remove this write — credentials
   are stored in `secrets`.
2. `PATCH /api/accounts/[id]` has a code path that updates `oauthToken`. Fix
   or delete this path — it is unreachable from the new UI and writes to a
   deprecated column.
3. `/app/accounts/new` form includes an OAuth field that was never meaningful.
   Remove the field.

Future migration (out of scope for this refactor): drop
`accounts.anthropicApiKey` and `accounts.oauthToken` columns after the above
writes are removed and a migration window has passed.

---

## 6. Implementation breakdown

Suggested task order with dependencies. The mission will hire these tasks
after this spec is approved; agents MUST read this spec before starting any
task in this group.

### Task 1 — Make `/app/you` a real page; move Account sections

**What:** Replace the redirect stub at
`apps/web/src/app/app/(protected)/you/page.tsx` with a server component that
renders: profile, SignOutButton, mobile TeamSwitcher (`md:hidden`, when >1
team), Teams list with member counts and role badges, +New Team affordance.

**Source of truth:** §2.1 acceptance criteria.

**Dependencies:** none (first task, no other task output required).

**Verification:** `bun test` passes; navigate to `/app/you` and confirm it
does not redirect; confirm mobile switcher hidden for single-team users.

---

### Task 2 — Rebuild `/app/settings` as Connections; rename Runner Tokens; remove dead OAuth buttons

**What:**
- Strip Runners, Usage, Workspaces list, Browse link, Connect Claude from
  `settings/page.tsx`.
- Rename 'API Keys' → 'Runner Tokens' section (heading + copy).
- Remove OAuth Set/Rotate/Revoke buttons from the accounts section.
- Add explanatory copy about runner tokens vs. model credentials.
- Ensure Notifications section is still reachable (tab or nested route within
  `/app/settings`).

**Source of truth:** §2.2 acceptance criteria.

**Dependencies:** none (can run in parallel with Task 1).

**Verification:** `/app/settings` renders four subsections only (Agent
Backends, Runner Tokens, GitHub, Vercel) plus the Notifications tab/route.
OAuth buttons absent from DOM.

---

### Task 3 — Relocate telemetry to `/app/health`; extract `getRunnerHeartbeats` helper

**What:**
- Extract runner heartbeat query from `settings/page.tsx` into
  `apps/web/src/lib/runner-helpers.ts` as `getRunnerHeartbeats(userId: string)`.
- Add Usage (30 d) card to `/app/health`, using `getUserWorkspaceIds(userId)`.
- Remove Runners and Usage server JSX from `settings/page.tsx`.

**Source of truth:** §3.1.

**Dependencies:** Task 2 (settings page must have had the inline JSX removed
from its page component first, to avoid a merge conflict on the same file).

**Verification:** `/app/health` shows Runners + Usage; `/app/settings` does
not.

---

### Task 4 — Move Connect Claude to workspace config page

**What:**
- Add `ConnectClaudeSection` (or equivalent) to
  `apps/web/src/app/app/(protected)/workspaces/[id]/config/` (create page if
  absent), passing `params.id` directly as the workspace ID.
- Remove `ConnectClaudeSection` import and usage from `settings/page.tsx`.
- Drop the workspace dropdown from the section (workspace is known from the
  route).

**Source of truth:** §3.2.

**Dependencies:** none (independent of Tasks 1–3, no shared file conflicts
unless Task 2 has already modified settings/page.tsx — if so, take Task 2's
output as the starting point).

**Verification:** `/app/workspaces/[id]/config` shows the MCP URL for the
specific workspace; `/app/settings` does not show Connect Claude.

---

### Task 5 — Delete orphaned settings components; fix nav active-state

**What:**
- Delete `DiscordSection.tsx`, `SlackSection.tsx`, `HeartbeatSection.tsx`,
  `SkillsSection.tsx` after confirming no importers (run the grep in §4 first).
- Update `MissionsBottomNav.tsx` (~79–82) active-state logic for the
  Account (`/app/you`) / Connections (`/app/settings`) split.
- Update `UserAvatarMenu.tsx` to offer 'Account' → `/app/you` alongside or
  instead of the single 'Settings' link.

**Source of truth:** §4, §5.1.

**Dependencies:** Tasks 1 and 2 must be merged first (need the routes to
exist before nav links can be validated).

**Verification:** `grep -r "DiscordSection\|SlackSection\|HeartbeatSection\|SkillsSection"` returns
zero results. Bottom nav active state is correct when visiting `/app/you` vs
`/app/settings`.

---

### Task 6 — Account-model hygiene (API cleanup)

**What:**
- Remove `oauthToken` write from `POST /api/accounts`
  (`apps/web/src/app/api/accounts/route.ts`).
- Fix or delete the `PATCH /api/accounts/[id]` `oauthToken` code path
  (`apps/web/src/app/api/accounts/[id]/route.ts`).
- Remove the OAuth field from the `/app/accounts/new` form.

**Source of truth:** §5.4.

**Dependencies:** Task 2 (Runner Tokens UI is the surface that links to
`/app/accounts/new` — confirm the form change is coherent with the new UI
copy before Task 2 ships, or ship as a follow-on).

**Verification:** `POST /api/accounts` no longer writes `oauthToken`. The
OAuth field is absent from `/app/accounts/new`. Existing `bld_` key accounts
still claim tasks normally.

---

## 7. Background & references

**Recon 1 — Settings/account page IA: current route + component reality**

**Recon 2 — Accounts vs Secrets: can API Keys collapse into Agent Backends?**

**Related spec:** `docs/credentials-architecture.md` — the authoritative pattern
for credential storage that underlies the Agent Backends / Runner Tokens split
in this refactor.

**Related spec:** `docs/specs/auth-oauth-boundaries.md` — the auth model
(dual api/oauth auth, account types) that explains why Runner Tokens and Agent
Backends are distinct subsections.
