# Split the MCP `instructions` block into a orientation stub + a consumer skill

**Status:** Proposed
**Related:**
- `apps/web/src/app/api/mcp/route.ts` — the `instructions` string (today ~2.4k
  chars / ~600 tokens, lines 270–290) and the `buildd://workspace/skills`
  resource (currently a placeholder string, lines 837–844)
- `docs/specs/mcp-action-contracts.md` — auth/transport/action-set contract for
  this same server
- `docs/specs/human-in-the-loop-protocol.md` — the blocked-vs-question channels
  this skill must describe correctly
- `docs/specs/mission-task-lifecycle.md` — the two branch shapes (§ "One task,
  one branch, one PR — in every branch shape")
- `docs/specs/mcp-connectors-and-roles.md` — how an agent reaches an MCP server
  at all (connectors, not roles) — the axis this design does not touch
- `.claude/skills/buildd-workflow/SKILL.md` — the sibling skill for buildd's
  own contributor loop; this design's skill is the generic, workspace-agnostic
  counterpart
- `apps/web/src/lib/role-config.ts`, `apps/web/src/app/api/workers/claim/skill-and-role-injection.ts`,
  `apps/runner/src/roles.ts` — the existing `register_skill` /
  `workspaceSkills` / role-bundle materialization pipeline this design
  deliberately does not build on (see "Why not `register_skill`" below)
- `docs/design/DESIGN-FORMAT.md` — the format this doc follows

---

## Problem

The MCP server's `instructions` field (`apps/web/src/app/api/mcp/route.ts:270`)
is ~2,437 characters (~600 tokens by the usual chars/4 estimate). It is pinned
into every conversation that mounts the buildd connector — not sent once, sent
on every turn, for every client, forever, whether or not the session ever
calls a `buildd` tool.

Observed directly: in a live Claude Code session with the connector mounted,
this block arrives **truncated mid-sentence**. Clients pay for the whole
thing and still don't receive the end of it — the token cost and the content
loss are simultaneous, not a trade-off against each other.

The content itself is also the wrong shape for a resident block. It's the full
worker lifecycle (recall → claim → progress → PR → artifact → learn →
complete), the blocked-vs-question distinction, and knowledge-tool guidance —
procedure that only matters once an agent has decided to act on a task. A
client that mounts the connector to do one thing — "what's got a `[friction]`
tag right now," a phone message that says "file this as a bug" — pays the
full procedural cost to ask a question the procedure never touches.

## Proposal

**Crux:** which parts of the current block are things a client needs
correct *before it can call a single tool* (and therefore must be resident,
unconditionally, no matter how small that makes the number), versus which
parts only matter once the client has committed to doing task work (and can
therefore be loaded on demand). Get this split wrong in either direction and
the fix is worse than the problem: leave a load-bearing rule out of
`instructions` and a client breaks a tool call before it can even discover the
skill exists; leave a load-bearing rule in the skill body under the
misapprehension that clients always read skill bodies before their first
call, and mobile — the client this whole problem is about — gets it wrong for
its very first message.

### What stays in `instructions`

1. **Server identity** — one line: this is buildd, a task coordination
   system; the tool names (`buildd`, `recall`, `learn`; `buildd_memory`
   deprecated).
2. **Token level and what it gates** — `${accountLevel}` and the one-line
   explanation that determines which `buildd` actions exist, and that a
   privilege failure looks like `{"error":"forbidden"}`, not an expired-token
   error. This has to stay resident: a client that doesn't know its own level
   will burn a call discovering by trial and error which actions 403, and
   will misdiagnose the 403 as an auth problem rather than a level problem
   (this exact confusion is why `mcp-action-contracts.md` AC-3 exists as a
   spec-level guarantee — the instructions text is the client-facing mirror
   of that guarantee).
3. **A pointer to the skill**, with a resource fallback for a client that has
   no skill installed at all.

Nothing about the *procedure* (claim order, milestones, PR conventions,
blocked-vs-question, friction dedupe, branch strategy) needs to be resident.
A client can call `list_tasks` or `create_task` correctly with zero procedural
knowledge — the tool's own parameter description (`buildParamsDescription` in
`packages/core/mcp-tools.ts`) already documents its shape. Procedure is what
you need once you've decided to *work* a task, which is exactly the moment a
skill's progressive disclosure is supposed to trigger the body load.

**Proposed replacement text** (~709 chars / ~177 tokens by the same chars/4
estimate — roughly a 3.4x reduction, and comfortably clear of whatever length
triggered the observed truncation):

```
Buildd is a task coordination system for AI coding agents. Tools: `buildd` (task actions), `recall` (read knowledge), `learn` (write knowledge). `buildd_memory` is deprecated.

**Token level:** ${accountLevel} — gates which `buildd` actions you can call (trigger ⊂ worker ⊂ admin). A call outside your level returns `{"error":"forbidden",...}`, not an expired-token error.

**Before your first task action**, load the buildd-mcp-consumer skill for the full workflow (claim → progress → PR → artifact → learn → complete), the blocked-vs-question rule, friction reporting, and branch strategy. No skill installed? Read the `buildd://workspace/skills` resource for the same content, or ask a human to install it.
```

### What moves into the skill

- The task lifecycle (claim → progress at milestones → PR → artifact →
  learn → complete) — currently `instructions` steps 1–6.
- The blocked-vs-question rule: `AskUserQuestion` parks a task without
  recording a failure, versus `post_note` with `defaultChoice` for a
  non-blocking flagged decision. (`docs/specs/human-in-the-loop-protocol.md`
  is the underlying contract; the skill states the agent-facing rule, not the
  server mechanics.)
- Friction reporting, including the dedupe-signature convention: create a
  `[friction] <short description>` task via `create_task`, and when the
  friction traces to a known pattern, call `get_error_traces` /
  `get_failure_analytics` first and pass the returned `frictionSignature` /
  `frictionExcerpt` in `context` so a recurring failure appends to one task
  instead of filing a duplicate (`packages/core/mcp-tools.ts` — the
  `get_failure_analytics` description, and `docs/design/friction-dedup-serialization.md`).
- Artifact and knowledge discipline: `create_artifact` before `complete_task`
  (type=`summary`, or type=`impl_plan` for a plan a later task consumes by
  `key`), and `learn`/`recall` usage — what's worth saving (gotcha, pattern,
  decision, discovery) versus what isn't (task-specific detail, anything
  already in docs).
- The two branch strategies, worker-facing: by default a task's PR targets
  the workspace trunk; under a mission with `integrationBranchEnabled`, the
  PR targets the mission's integration branch (`mission/<slug>-<id8>`)
  instead, and the mission reaches trunk through exactly one PR from that
  branch. An agent filing or working a task under a mission needs to know
  *which* shape it's under (visible from the claimed task's `baseBranch`/
  mission context) and that either way, one task still means one branch and
  one PR — see `docs/specs/mission-task-lifecycle.md`.

### What must NOT move

Nothing beyond identity + token level + pointer. Every other candidate line I
considered keeping resident turned out to be either (a) not needed before a
first tool call (procedure, described above) or (b) already covered by a
tool's own schema (`register_skill`'s remote-mode restriction, the specific
action-name enum) and so redundant to restate in prose that a client may
never load. The one rule that's genuinely tempting to leave resident —
blocked-vs-question — is *not* required before a client's first successful
tool call; it only matters once an agent is already stuck, by which point
it has almost certainly loaded the skill (see Q4: the skill is one unit, not
split by moment-of-need).

---

## Q1 — Where does the skill live, and how is it distributed?

Three tracks exist that reach three different populations. None of them is a
strict superset of the others, so the recommendation is to ship the ones that
actually reach the two populations named in the Problem section (a live
Claude Code session with the connector mounted; a phone client with the
connector mounted), and to explicitly *not* build on a fourth mechanism that
looks tempting but doesn't reach either.

| Track | Mechanism | Reaches | Claude Code | Claude desktop | Claude mobile |
|---|---|---|---|---|---|
| **B — repo-committed** | `.claude/skills/buildd-mcp-consumer/SKILL.md`, git-tracked in *this* repo, same convention as `buildd-workflow` | A session with buildd's own repo checked out | Yes | Yes, if the desktop app is pointed at a local project folder with `.claude/skills` | No — no filesystem |
| **C — published skill** | Upload the same content as an installable Skill on the user's/team's Claude account, independent of any repo | Any session where the account has installed it, regardless of what (if any) repo is open | Yes | Yes | Only if the mobile app supports Skills at all — **unverified, see Open Questions** |
| **D — MCP resource** | `buildd://workspace/skills` resource, content sourced from the same file as B | Any client that reads MCP resources on its own initiative, or is told to by the `instructions` pointer | Yes (Claude Code surfaces server resources) | Yes | Only if the mobile MCP client surfaces resources at all — **unverified** |

**Recommendation: ship B + D now, and D is what actually keeps the promise
made to a client with no skill installed.** Ship C as a fast-follow once
Track C's mobile-support question (below) is answered, because C is the only
one of the three that reaches a phone with no repo and no prior resource-read
instinct — which is the second scenario named in the Problem section.

Do not build the primary fix on **Track A**: `register_skill` writes a
`workspaceSkills` row, which the claim route can bundle into a claimed task's
`context.skillBundles` and the runner materializes to disk for native SDK
discovery (`apps/runner/src/roles.ts` `syncRoleToLocal`,
`overlayRoleFiles`). This is real, and it does reach an arbitrary customer
repo without that repo committing anything — but it is gated on the claimed
task carrying a `roleSlug` (`skill-and-role-injection.ts`'s `attachRoleConfig`
does `if (!roleSlug) continue`, so a task with none gets no bundle at all),
and — found while researching this design — `overlayRoleFiles` writes the
overlaid `.claude/skills/*` files into the shared base clone *before*
`setupWorktree` cuts the actual per-task git worktree
(`apps/runner/src/workers.ts:1496`); `git worktree add` only checks out
git-tracked content, so those untracked overlay files may never reach the
directory the agent SDK actually reads from whenever the default worktree
branching strategy is in effect. That gap is unconfirmed/unfixed as of this
writing (flagged as a `gotcha` memory alongside this task, not filed as a
task — it's a real risk for a future skill-distribution project, not a
blocker for this one). Track A also only ever reaches a *runner-dispatched,
role-tagged* task — never a human's or an agent's ad hoc MCP session before
any task is claimed, which is exactly the moment the truncation was observed.
Building this design's distribution story on Track A would mean the fix
doesn't ship for the scenario that motivated it.

## Q2 — Can the MCP server itself serve the skill, so mounting the connector is enough?

No — not in the sense of replicating a Skill's progressive disclosure, and
this is a spec fact, not a judgment call. The Model Context Protocol defines
exactly three server-side primitives a client can consume: **tools**
(model-invoked functions), **resources** (addressable data the client
attaches or fetches, at the client's or user's discretion), and **prompts**
(user-invoked templates, typically surfaced as slash commands). None of the
three carries "keep a one-line description resident at near-zero cost, and
autonomously load the full body only when a natural-language task matches
it" semantics — that contract is implemented by the Claude client itself
(Claude Code, the API's Skills mechanism), on top of a plain file/name lookup,
not by anything MCP defines. A resource has to already be known about and
explicitly read; a prompt has to be explicitly invoked. Mounting a connector
that exposes either one does not make a client that has no Skill machinery
start behaving as if it does.

What the server *can* and should do: serve the same skill content as the
`buildd://workspace/skills` resource (today a placeholder string,
`apps/web/src/app/api/mcp/route.ts:837–844`), sourced from the same file as
Track B (see Q3), so that the one-line pointer in `instructions` — "no skill
installed? read this resource" — is actually true. This is a fallback, not a
replacement: a client has to already know to read it (which is exactly the
one line of `instructions` that survives, unconditionally, for this purpose)
and pays a tool round-trip to fetch it. It is not free the way a resident
Skill description is free, but it is the only thing in reach of a client that
mounted nothing but the connector.

This server does not declare a `prompts` capability today (only
`tools: {}, resources: {}` — `route.ts:266–269`). Recommend not adding one for
this: a prompt is user-invoked, which is no better fit for "should activate
automatically when the moment is right" than a resource is, and it would be a
second surface to keep in sync with the skill file for no behavioral gain
over the resource that already exists.

## Q3 — How does the skill stay in sync with the server?

**One canonical file, everything else derived from it, checked by CI.**

Make `.claude/skills/buildd-mcp-consumer/SKILL.md` (Track B) the source of
truth — not code-generated from the tool schemas, because this content is
procedure and judgment (blocked-vs-question, branch strategy, what's worth
saving to memory), not a parameter shape; `buildParamsDescription` in
`packages/core/mcp-tools.ts` is already the generated-from-schema source for
argument shapes, and this skill should cite it rather than duplicate it.

- **Track D (the MCP resource)** should read this file's content directly
  (e.g. `readFileSync` at request time, or a small build step that inlines it
  into a generated constant if Next.js's serverless file tracing drops a
  gitignored-but-force-added path — verify which at build time; either way,
  the resource's *content* must never be a hand-maintained second copy).
  Whichever mechanism is chosen, sync between B and D becomes true by
  construction rather than by discipline.
- **Track C (the published skill)** is necessarily a manual upload step — no
  API exists to keep an account-level Skill in continuous sync with a repo
  file. Treat it the same way `spec-sync` treats the doc/site repos: a
  runbook step ("re-upload after any change to this file") plus a CI check
  that at least catches drift in the input, even if it can't push the output.
- **Drift-detection CI check** (extend the pattern in
  `scripts/skills-listed.test.ts`, which already enforces that CLAUDE.md's
  skill index matches `git ls-files`): a new check parses every backticked
  action name in the skill body (`claim_task`, `update_progress`,
  `create_pr`, `create_artifact`, `complete_task`, `post_note`, `create_task`,
  `get_error_traces`, `get_failure_analytics`, …) and resolves each against
  `triggerActions`/`workerActions`/`adminActions`/`allActions` in
  `packages/core/mcp-tools.ts`. This is the same technique
  `docs/specs/SPEC-FORMAT.md` rule 7 already uses for specs (a backticked
  identifier is a claim the linter verifies); a skill making the same kind of
  claim should be held to the same standard. An action renamed or removed
  without a matching skill edit fails the build instead of shipping a skill
  that quietly tells agents to call something that no longer exists.
- A `last_verified`-style date is optional prose, not enforced — the action
  check above is the actual guard; a date only tells you someone *looked*
  recently, not that they were right.

## Q4 — One skill, or several?

**One skill: `buildd-mcp-consumer`.** Splitting into `file-a-task` /
`work-a-task` / `operate-missions` was the obvious alternative and I
considered it seriously, because the phone-one-liner problem in the Problem
section sounds exactly like "the loaded skill body is still too big for a
one-sentence request." It isn't, for the same reason the trimmed
`instructions` block doesn't need to carry procedure either: progressive
disclosure already puts the phone scenario in the right place. The
frontmatter `name` + `description` — a single resident line, on the order of
15–20 tokens — is what a client sees before deciding to load anything; the
full body only loads when the model judges the current task matches the
description. "File this as a task" from a phone is answered by `create_task`
and its own parameter description; it never needs the skill body to load at
all, split or not. Splitting mainly optimizes for a load that a well-scoped
one-line description already prevents.

Against splitting: the lifecycle sections don't decompose cleanly.
Blocked-vs-question, friction dedupe, and artifact/knowledge discipline all
apply equally whether the current step is "I just filed a task" or "I'm mid
task, PR up, deciding what to save." A three-way split would either duplicate
those sections three times (drift risk — the exact failure mode the task
brief warns against: "a skill that documents a tool vocabulary the server has
changed is worse than no skill," and three copies triple the places a change
can land in only two of them) or force one skill to `@`-reference another
mid-body, which no client resolves automatically.

Revisit this only if a measured body-token cost, not a hypothetical one,
shows the single skill is too large for the cheapest real use case. Nothing
in this design produces that evidence yet.

## Q5 — This is not `register_skill`

`register_skill` (`packages/core/mcp-tools.ts:2449`, backed by the
`workspaceSkills` table, `isRole` flag) creates or updates a **workspace
role** — an agent persona (Builder, Researcher, Organizer, or a custom one) —
with a model preference, tool allowlist, delegation rules, and a bundled
`CLAUDE.md` + skill set assembled by `role-config.ts` and injected at claim
time. It is a buildd *product* feature: a database row, scoped to a
workspace, that determines **who the agent is** for tasks routed to that
role.

The thing this design proposes is an Anthropic **Skill** — a `SKILL.md` file
with the frontmatter and progressive-disclosure contract Claude clients
implement natively. It determines **what procedural knowledge is available**
to whichever client has it installed, independent of any buildd workspace,
role, or task. It requires no buildd-side storage beyond the optional
resource mirror in Q3.

Same word, unrelated concept, and the overlap is real enough to cause actual
confusion: a `workspaceSkills` row *can* be named `isRole: false` and *is*
called a "skill" throughout the product's own UI and MCP tool descriptions
(`list_skills`, `get_skill`, `update_skill`, `delete_skill` all operate on
this table). A reader of this doc who goes looking for "the skill" in the
database will find real rows and reasonably conclude this design is asking
them to add one there. It is not — see Q1's Track A discussion for exactly
why that table's delivery mechanism doesn't reach this design's target
audience today.

---

## Non-goals

- Changing `register_skill`, `workspaceSkills`, or the role-config bundling
  pipeline. Track A's gaps are noted because they're relevant to *why this
  design doesn't use them*, not because this design intends to fix them.
- Fixing the `overlayRoleFiles`/worktree-branching gap found while
  researching Q1. Recorded as a memory for whoever picks up
  register_skill-based skill distribution next; out of scope here.
- Declaring an MCP `prompts` capability (see Q2).
- Committing to a mobile ship date for Track C — gated on an open question
  below, not a decision this doc makes.
- Rewriting `buildd-workflow` (the sibling skill for buildd's own contributor
  loop) to share a file with this one. They serve different audiences
  (buildd's own dev loop vs. any workspace's workers) and already diverge in
  content (TDD enforcement, `bun run test` conventions, schema-migration
  rules — none of which apply to a generic buildd workspace).

## Open questions

1. **Does Claude's mobile app support Skills (or reading MCP resources) at
   all today?** I could not verify this from the codebase or the design
   docs available to me, and I'm not treating an unverified claim as a
   decision. I lean toward assuming **not yet**, given the connector's
   `instructions` pointer is the only thing that reaches such a client
   reliably right now. Recommendation: ship Track B + D unconditionally (they
   improve the Claude-Code/desktop case today regardless of mobile), and gate
   Track C's rollout on confirming mobile support — don't block B/D on
   answering this.
2. **Should Track A (register_skill-based delivery) be pursued as a
   fast-follow once the worktree-overlay gap is fixed?** Leaning yes, since
   it's the only mechanism that reaches an arbitrary customer repo without
   that repo committing anything — but it solves a narrower problem
   (runner-dispatched, role-tagged tasks only) than the one in this ticket,
   so it's explicitly not required for this deliverable.

## Implementation sketch (for the build task)

1. Write `.claude/skills/buildd-mcp-consumer/SKILL.md` (frontmatter: `name`,
   `description` written to match on "buildd MCP tools are available" /
   "task coordination," not on any single verb, so it doesn't over- or
   under-fire) covering: task lifecycle, blocked-vs-question, friction
   reporting + dedupe convention, artifact/knowledge discipline, the two
   branch strategies (worker-facing framing, not the planner-facing framing
   in `default-roles.ts`).
2. Shrink `instructions` in `apps/web/src/app/api/mcp/route.ts` to the
   proposed replacement text above.
3. Point the `buildd://workspace/skills` resource handler
   (`route.ts:837–844`) at this file's content instead of the placeholder
   string; resolve the Next.js serverless-file-tracing question from Q3
   before assuming a runtime `readFileSync` works unmodified.
4. Add the action-name drift check described in Q3 (extend
   `scripts/skills-listed.test.ts` or add a sibling script); wire it into the
   same CI job that already runs `specs:lint` / `skills-listed.test.ts`.
5. Manually upload the same content as a published Skill (Track C) once the
   mobile-support open question is resolved — not blocking on steps 1–4.
