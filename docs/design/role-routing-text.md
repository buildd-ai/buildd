# Role Routing Text: `whenToUse` / `notFor` for every role

**Status:** Proposed
**Related:** `docs/design/role-routing.md` (§2 defines the fields and limits, §3 the candidate set), `docs/design/decision-calls.md` (Point 7, rules for writing label sets), `apps/web/src/lib/default-roles.ts` (the seeded text, `routing` on each `DEFAULT_ROLES` entry), `apps/web/src/lib/default-roles.test.ts` (limits and coverage)

---

## Problem

`role-routing.md` §2 makes `whenToUse` / `notFor` the only thing the role decision call reads about a role. A role without `whenToUse` is never a candidate. So until someone writes the text, no live role can be picked, and the text someone writes *is* the classifier. Overlapping text between neighbours (builder and architect, researcher and consolidator) is a coin flip that no threshold fixes (`decision-calls.md` Point 7 rule 3).

This file is the text for review. Nothing here has been applied. The seeded defaults are in `default-roles.ts` and new teams get them at creation. Live rows are applied by hand with `update_skill` after review. Existing rows never pick up a change to `default-roles.ts`, because seeding is `onConflictDoNothing`.

## Proposal

**The crux:** each role's text has to separate it from its nearest neighbour by **task shape and output** (a PR, a report, a plan, a verdict), not by subject. Subject overlaps: a researcher and a builder can both be "about" the claim route. Output does not overlap: one ends in a report, the other in a PR. If this is wrong, the benchmark in `role-routing.md` §6(b) shows the pair as confused, and the fix is to reword the pair, not to lower the threshold.

How the text was written:

- Each role's text is based on what it actually ran in the last 30 days: its recent completed tasks, its `content`, its tools, and per-role success from `get_usage_stats groupBy=role`.
- `notFor` names the neighbour role in parentheses, `(builder)`, so the model sees the alternative and not only the exclusion. `default-roles.test.ts` enforces this for the seeded set.
- `notFor` has no trailing period, because it is rendered as `<whenToUse> Not for: <notFor>.`
- A role that should never be inferred gets `routing: { disabled: true }` rather than no text. §3 filters `disabled` ahead of text, so the role stays excluded even if someone later adds a `whenToUse` to it, and the row shows the exclusion was deliberate rather than never done.

### Seeded defaults (`default-roles.ts`)

The live `buildd` team has no `writer` or `analyst`. That is why the seeded text below differs from the live text for the same slugs: each `notFor` names a neighbour that exists in its own set.

| Slug | `whenToUse` | `notFor` |
|---|---|---|
| `organizer` | Breaks a goal into ordered tasks with a role each, or reconciles and re-sequences existing tasks. The output is a plan, not the work itself. | Doing any one planned step: code (builder), an investigation (researcher), prose (writer) |
| `builder` | Changes code, config or tests in the repo and ends in a pull request: features, bug fixes, refactors, migrations, dependency bumps, CI fixes. | Investigating without changing code (researcher); prose-only docs (writer); splitting a goal into tasks (organizer) |
| `researcher` | Answers an open question without changing the repo: investigations, comparisons, feasibility checks, how something works or why it failed. The output is a findings report or recommendation. | Fixing what it finds (builder); questions answered by querying data or metrics (analyst); checking code against a spec (spec-validator) |
| `writer` | Writes or edits prose with no code change: user docs, READMEs, design docs, release notes, changelogs, PR descriptions, announcements. | Code or config changes, even when the title says docs (builder); research whose output is a recommendation (researcher) |
| `analyst` | Pulls data, metrics or usage numbers by query or API and reports what they show, with the query, sample size and time range. | Building the dashboard or pipeline itself (builder); questions answered from docs or code rather than data (researcher) |
| `spec-validator` | Checks shipped code against an existing spec or design doc and reports drift claim by claim: matches, documented but not built, built but not documented, contradicted. Report only. | Open questions with no spec to check against (researcher); fixing the drift it finds (builder) |
| `reviewer` | *disabled* | |
| `visual-auditor` | *disabled* | |

### Live `buildd` team and workspace roles (apply with `update_skill` after review)

| Slug | Routable | `whenToUse` | `notFor` |
|---|---|---|---|
| `builder` | yes | Changes code, config or tests in the repo and ends in a pull request: features, bug fixes, refactors, migrations, dependency bumps, CI and release-PR fixes. | Design docs or proposals written before any code exists (architect); investigating without changing code (researcher); planning a split (organizer) |
| `architect` | yes, see Open questions | Writes a design doc or spec for something not yet built: the problem, the proposed shape, alternatives and a task breakdown, delivered as a docs-only PR. | Implementing an approved design (builder); checking whether shipped code still matches a spec (spec-validator) |
| `organizer` | yes | Breaks a mission or multi-step goal into ordered tasks with a role each, or reconciles and re-sequences existing tasks. The output is a plan, not the work itself. | Doing any one planned step: code (builder), an investigation (researcher), a design doc (architect) |
| `researcher` | yes | Answers an open question without changing the repo: investigations, comparisons, feasibility checks, how something works or why it failed. The output is a findings report or recommendation. | Fixing what it finds (builder); checking code against a spec (spec-validator); deduplicating or archiving knowledge entries (consolidator) |
| `spec-validator` | yes | Checks shipped code against an existing spec or design doc and reports drift claim by claim: matches, documented but not built, built but not documented, contradicted. Report only. | A verdict on one PR's diff (reviewer, not routable); open questions with no spec to check against (researcher); fixing the drift (builder) |
| `consolidator` | yes | Maintains the knowledge base: finds duplicate or decayed memories and task outcomes, merges or archives them, and reports what changed. | Researching a question and writing up findings (researcher); recording one new lesson, which any role does with learn |
| `concierge` | yes | Carries out a personal-assistant instruction: adds calendar events, creates or updates planner items and reminders, or looks something up and reports back. | Triage runs over the inbox (email-agent); transactions, subscriptions or spending (finance); any change to a code repo (builder) |
| `email-agent` | yes | Triages the personal inbox: classifies new emails as actionable, informative or noise, creates linked action items, and mutes repeat noise senders. | A one-off instruction to act on calendar or planner (concierge); bills and transactions as money rather than email (finance) |
| `finance` | yes | Classifies bank transactions, audits subscriptions and recurring charges, and reports on spending, anomalies or compliance through the finance tools. | Token spend or cost of buildd itself (researcher); reminders and calendar entries (concierge) |
| `reviewer` | **no**, `disabled` | | |
| `visual-auditor` | **no**, `disabled` | | |
| `ops` | **no**, `disabled` | | |
| `builder-nocbm` | **no**, `disabled` | | |

### Why four roles are excluded

- **`reviewer`**: Every reviewer task is created by `createReviewerTask`, which sets the slug and the verdict `outputSchema` the reviewer prompt depends on. The role is read-only (`allowedTools: ['mcp__buildd__buildd']`). A human who wants a PR reviewed calls `request_pr_review`. A free-text "review PR #N" task routed to this role would run without the PR context and output schema the prompt expects. So there is no role-less work it should win. This matches `role-routing.md` §2. The reviewer/spec-validator boundary still matters, so `spec-validator`'s live `notFor` names the reviewer.
- **`visual-auditor`**: It is an `EXPLICIT_ROLE_SLUGS` entry, which §3.2 excludes anyway, and the surface-audit pipeline creates its tasks with the slug already set.
- **`builder-nocbm`**: The CBM trial control arm. I chose **explicit exclusion** (`disabled: true`) over no text. Its content is a copy of `builder`, so whoever edits it next is likely to copy `builder`'s routing text as well. `disabled` wins over text in the §3 filter, so the copy stays harmless. Routed traffic into a control arm would also bias the trial: the arm has to receive only the tasks the trial assigns.
- **`ops`**: See the next section.

### Ops: recommend not routable

No `ops` task succeeded in the last 30 days, and the few that ran recorded no token usage, which suggests they died before doing any work. Meanwhile the work ops is named for is being done elsewhere. CI failures on release PRs come back as `[builder · after CI #n]` retry tasks, and `[degraded] Release …` health-check tasks have completed successfully, including one that shipped a fix PR.

Things to check before ops is made routable:

- The live `ops` row is a workspace override whose `mcpServers` is `{}`. Every other buildd role mounts the buildd MCP server. If the runner does not inject buildd MCP on its own, an ops worker cannot report progress or complete the task, and the pattern above is what that would look like. I have not confirmed that this is the cause.
- Its tasks come from the health watcher, which already sets `roleSlug` (`role-routing.md` §1). So routing would add no reach, only the risk of sending more work to a role with a 0% success rate.

**Recommendation:** `disabled: true` now. Then either fix the ops role and prove it on health-watcher tasks, or retire it and point the health watcher at `builder`. Do not make it routable while its success rate is 0%.

## Open questions

1. **`spec-validator` routable, against `role-routing.md` §2.** §2 excludes it as "created by its own pipeline". I made it routable because it has a filer-vocabulary shape with no other owner: "check whether spec X still matches the code". Its scheduled weekly drift check is filed as free text (schedules carry no `roleSlug`, §1 row 11). Without text, that work falls to `researcher`, which has no spec-drift protocol. **Lean:** routable. If the benchmark confuses it with `researcher`, disable it and give the schedule a `roleSlug` instead.
2. **`architect` is not in this workspace's `list_skills`.** `get_skill slug=architect` returns not-found for the buildd workspace, and it ran only once in 30 days. The text above describes the role as its name implies, not from observed work. **Lean:** apply it only where the row actually exists. Otherwise design docs stay with `builder`, which is what happens today, and `builder`'s `notFor` should drop the `(architect)` clause.
3. **The personal-assistant roles are team-level.** `concierge`, `email-agent` and `finance` have `workspaceId = NULL`, so they are candidates in every workspace of the team, including code workspaces. §3.3 does not check legacy `mcpServers`. Their text is scoped to calendar, inbox and money, so a code task should score them low. **Lean:** apply the text team-wide and measure in the §6(a) shadow first. Add a per-workspace `routing: { disabled: true }` override in code workspaces only if the shadow picks them there.
4. **`consolidator` has a schedule.** Its weekly run is also free text, so it needs `whenToUse` to be inferred at all. Its only confusable neighbour is `researcher`. The two are separated by output: an archive/merge pass versus a findings report.

## Non-goals

- Applying any of this to live rows. Max runs `update_skill` after review.
- The backfill script for existing seeded rows (`role-routing.md` §2). Seeding writes `metadata.routing` for new teams only.
- The decision call, candidate filter or `update_skill` params. They are specified in `role-routing.md` and built separately.
- Re-wording role `content` or `description`. Neither is read by the classifier.
