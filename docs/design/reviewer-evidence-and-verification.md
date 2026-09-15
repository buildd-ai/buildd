---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "reviewer-patch"
    type: "symbol"
    name: "renderReviewerPatch"
    path: "apps/web/src/lib/reviewer-patch.ts"
  - id: "reviewer-patch-tests"
    type: "test_file"
    path: "apps/web/src/lib/reviewer-patch.test.ts"
  - id: "request-changes-verifier"
    type: "config_key"
    key: "request-changes"
    file: "apps/web/src/lib/reviewer-verify.ts"
---
# Reviewer Evidence and Verification

**Status:** Partially shipped — T1, T2, T5, T9b and T10 of the Handoff table
landed (#2107, #2108, #2113, #2111, #2112); T3, T4, T6, T7, T8, T9a and T9c
have not. See "Current state" and "Handoff" below for what each piece actually
does today.
**Related:** `apps/web/src/lib/reviewer.ts`, `apps/web/src/lib/default-roles.ts`,
`apps/web/src/lib/reviewer-gate.ts`, `apps/web/src/lib/reviewer-evidence.ts`,
`apps/web/src/lib/merge-policy.ts`, `apps/web/src/lib/pr-review-request.ts`,
`apps/web/src/app/api/workers/[id]/route.ts` (BT-7/8/9 verdict handling),
`apps/runner/src/workers.ts` (tool gating), `packages/core/mcp-tools.ts`
(`spec_compare`, `recall`, `learn`), `docs/specs/scheduled-task-merge-policy.md`,
`docs/design/merge-policy.md`

---

## Problem

The reviewer agent decides whether a PR merges, and it cannot see the PR.

`buildReviewerContext` (`reviewer.ts:333`) assembles the reviewer task's
description from the GitHub *files* endpoint and renders one line per file:

```
## PR Files Changed (+120/-14)

  - apps/web/src/lib/foo.ts (+80/-4) [modified]
  - apps/web/src/lib/foo.test.ts (+40/-10) [modified]
```

No patch text was fetched, here or anywhere in the runner — T1/T2 below have
since shipped a renderer and wired it into `buildReviewerContext`, but behind
`policyConfig.reviewerPatchEvidence`, defaulting off. For any workspace that
has not opted in, the description below is still exactly what the reviewer
sees. The reviewer role prompt (`default-roles.ts`, slug `reviewer`)
nonetheless opens with "You receive: The PR diff", and asks the agent to judge
scope creep, spec conformance and "obvious regressions" from that. Three
consequences:

1. **Verdicts are guesses about content the model never read.** A judgement of
   "no obvious regressions" over a file list is not a review; it is a review
   *shaped* response. Any finding that requires reading a changed line — a
   stale-snapshot write, a message rendered in a format the receiving tool
   rejects, a turn counter incremented on a bookkeeping request — is
   unreachable by construction.
2. **The declared tool restriction is still not enforced for the primary
   agent.** The three UI surfaces that used to claim otherwise have since been
   corrected (T9b, #2111) to say what the control actually governs. See "The
   allowedTools gap" below — enforcement itself (T9c) is what's left.
3. **The output shape maximises false rejections.** `REVIEWER_TASK_OUTPUT_SCHEMA`
   (`reviewer.ts`) asks for verdict + confidence + summary + actionable feedback
   in one pass. Published measurements put wrong-rejection of *correct* code at
   26% → 73% once a prompt demands explanations and proposed corrections
   ([arXiv 2603.00539](https://arxiv.org/abs/2603.00539)). A wrong
   `request-changes` costs a full retry iteration of the authoring agent
   (`context.iteration` / `maxIterations`, default 3), so this is the expensive
   error, not the cosmetic one.

Nothing is broken in the sense of throwing. The failure mode is a gate that
appears to work: it emits verdicts, it feeds auto-merge, and its evidence base
is a filename list.

## Current state

| Piece | Where | Behaviour today |
|---|---|---|
| Reviewer task creation | `reviewer.ts` `createReviewerTask` | inserts task with `roleSlug: reviewerRole`, `outputSchema: REVIEWER_TASK_OUTPUT_SCHEMA`, no `skillSlugs` |
| Evidence assembly | `reviewer.ts` `buildReviewerContext` | file list + counts, task description, artifact previews, doctrine prose; renders the patch (`renderReviewerPatch`) when `policyConfig.reviewerPatchEvidence` is set — default off (T1/T2, #2107/#2108) |
| On-demand review | `pr-review-request.ts` | adopts an external PR as task+worker, then same path |
| Verdict handling | `apps/web/src/app/api/workers/[id]/route.ts` | approve → policy decides merge; request-changes → retry iteration; escalate → human |
| Gate resolution | `reviewer-gate.ts` `resolveReviewerGate` | maps reviewer task status to gate state |
| Escalation triggers | role prompt prose + `preflightEscalationCheck` + `enforceServerSideEscalation` | schema/deny-path preflight runs before dispatch, and is re-derived from the file list again at verdict time (T5, #2113) — overriding a model `approve` when the current files demand a human; the rest is asked of the model |
| Confidence | `merge-policy.ts` `maxConfidenceThreshold` | model self-reports `confidence` in the same call that makes the claim |
| Tool access | `apps/runner/src/workers.ts` | role `allowedTools` still unenforced for the main agent (see Problem 2; the UI that used to misstate this was fixed, T9b) |
| Untrusted text | `untrusted-text.ts` `sanitizeUntrustedText` | strips HTML comments, invisible/bidi characters, and structure-impersonating markdown from PR title/body/summary/feedback before they reach the prompt (#2110) — not yet applied to the rendered patch text itself |
| Auto-merge bound on a model `approve` | `auto-merge-bound.ts` `evaluateModelApproveBound` | base-ref-keyed: refuses unless the PR's base is the mission's own integration branch (never a protected trunk), and requires a check run that actually reached `success` for the head SHA (T10, #2112) |

Retrieval that already exists and the reviewer never calls: `recall` over the
`spec`, `code`, `pr`, `task`, `artifact` corpora (`packages/core/knowledge-store/types.ts`),
the `spec_compare` action (two-hop spec↔code retrieval, already in the buildd
MCP the role mounts), and the `codebase-memory` MCP graph (`search_graph`,
`trace_path`, `get_code_snippet`).

## The allowedTools gap

The `reviewer` role declares `allowedTools: ['mcp__buildd__buildd']` — read-only
task context, no shell, no file access. Nothing applies that to the agent.

`apps/runner/src/workers.ts` builds the primary agent's allowlist purely from
skill scoping: with skills assigned it pushes `Skill(<slug>)` entries, and with
none it passes no `allowedTools` at all, so the SDK defaults apply. The role's
`allowedTools` array is read in exactly one place — the branch that turns skill
bundles into subagents (`useSkillAgents`), where it becomes each subagent's
`tools`, falling back to `['Read','Grep','Glob','Bash','Edit','Write']` when
empty. Reviewer tasks attach no skills. So a reviewer session runs with full
default tools: shell, file writes, network, `gh`.

**This has been fixed on the UI side (T9b, #2111).** The three surfaces below
used to disagree with the runtime; they now import a shared
`apps/web/src/lib/role-tool-scope.ts`, which relabels the control "Subagent
Tools", states in-place that it "applies when this role runs as a skill
subagent — it does not narrow the main agent on a task", and summarises the
selection as "Subagent defaults" / "N subagent tools" instead of the old
"All allowed" / "N restricted" phrasing that implied a restriction on the
primary agent:

| Surface | Before (T9b) | Now |
|---|---|---|
| `workspaces/[id]/skills/[skillId]/RoleEditor.tsx` | an "Allowed Tools" panel whose summary read **"All allowed"** / **"N restricted"** | "Subagent Tools", `subagentToolsSummary()` |
| `team/[slug]/settings/TeamRoleEditor.tsx` | `allowedTools` as an overridable field implying an override changed agent authority | same shared label and note |
| `workspaces/[id]/skills/SkillList.tsx` | a per-role tool count read as a restriction | `subagentToolsSummary()` |

What was true before the fix, and remains true today, is the runtime half:
the count still governs nothing for the primary agent. A user restricting a
role's subagent tools gets a saved value, a correctly-scoped label, and a
primary agent whose authority is unchanged — that's now stated up front
instead of silently implied otherwise.

**The runtime fix (T9c) has not shipped.** Applying role `allowedTools` to the
primary agent is a runner change, so it only takes effect on a release to
`main`, and it flips the tool surface of every role at once. Most roles in a
mature workspace do declare an allowlist, and a few declare MCP-only lists
that omit `Read`/`Edit`/`Bash` entirely — those agents would lose file and
shell access the moment enforcement lands. So it needs a per-role audit and a
rollout, not a one-line change. Its dependency (T1, patch pre-injection) has
since landed, so T9c is now unblocked — see "Handoff".

**Enforcement has a dependency on this design.** Today the reviewer needs shell
to have any hope of seeing a diff. Restricting it to `mcp__buildd__buildd`
before the patch is pre-injected would guarantee the evidence vacuum instead of
merely permitting it. So: T1 (patch in the prompt) must land before the
allowlist is enforced for this role — after which read-only git plus the buildd
MCP is genuinely sufficient, and the restriction becomes real security rather
than a self-inflicted blindfold.

## Proposal

Five changes, in dependency order. Each ships behind a per-workspace flag
defaulting to current behaviour, so merging alters nothing until a workspace
opts in.

**1. Give the reviewer the patch, deterministically.** A new
`apps/web/src/lib/reviewer-patch.ts` fetches per-file `patch` text and renders
it in the format published by Qodo PR-Agent
([`prompt_fragments.toml`](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/settings/prompt_fragments.toml)):
a per-file header, `@@ ... @@ <enclosing symbol>` from git's own hunk header,
then `__new hunk__` **with line numbers** and `__old hunk__` **without** —
omitted entirely when nothing was removed. Line numbers appear only on lines
the reviewer is permitted to cite. Budget: pack to a fixed token ceiling,
additions before deletions, deletion-only hunks stripped, deleted files
collapsed to a name list, overflow listed **by filename only** under an
explicit "not reviewed — token budget" heading so the model cannot mistake
absence for cleanliness. Pre-inject it; do not rely on the agent choosing to
shell out to `gh`.

Shipped in #2107 (renderer) and #2108 (wiring, behind
`policyConfig.reviewerPatchEvidence`, default off). Two contracts came out of
building it that T4 depends on. First, **only added lines carry a line
number** — a deliberate deviation from PR-Agent, which numbers every line — so
a cited line number is provably a line the PR introduced. Second, that
guarantee lives in the returned `citableLines` map and **not** in the rendered
text: context lines render as `<width spaces>  <content>`, `width` is per-file
and never emitted, so a context line whose content begins with digits and a
`+` is byte-identical to a numbered added line, and that content is
PR-authored. A T4 filter that re-parses the prompt is therefore defeatable by
any PR that documents a diff — including this module's own tests.

**2. Split the verdict from the feedback.** Call one returns findings as
evidence only: `{file, lineStart, lineEnd, claim, failureScenario}` — no prose
fix. Call two writes `feedback` for findings that survive filtering. This
attacks the 26%→73% shape directly and is what PR-Agent reports as the reason
for splitting generation from ranking ("models struggle to simultaneously
generate high-quality suggestions and rank them well").

**3. Filter before spending another token.** Deterministic, in the coordination
server, not the prompt: (a) reject any finding whose cited file+line is not a
`+` line in the patch (PR-Agent anchors the model's cited line back into the
patch with difflib at cutoff 0.93); (b) cap findings per review; (c) drop
findings matching a hard-exclusion list. **(a)–(c) have not shipped** — there
is no findings-cap or cited-line filter yet (T4). The last sentence of this
item has: enforcing the escalate triggers — migrations and deny-paths — from
the file list server-side, never from the model's self-reported
`escalationReason`, shipped as `preflightEscalationCheck` (pre-dispatch) and
`enforceServerSideEscalation` (re-derived again at verdict time, T5, #2113).
Release PRs are covered by a different mechanism (`evaluateModelApproveBound`,
T10) rather than this escalate path — see Safety property 3.

**4. Verify only `request-changes`, and only with new evidence.** Verification
that adds no evidence is noise: Greptile measured a model's self-rated severity
as "nearly random" ([How to Make LLMs Shut Up](https://www.greptile.com/blog/make-llms-shut-up)),
and the one published ablation of naive adversarial review scored *worse* than a
single reviewer (F1 0.457 vs 0.495), recovering only when the critic had to cite
contradicting code or drop the flag ([arXiv 2608.18167](https://arxiv.org/html/2608.18167)).
So the verifier gets what the first pass did not have: the **whole file** for
each cited location (Anthropic's security review does exactly this), the
`trace_path` inbound callers of each changed symbol, and `recall` hits for the
same paths. It fails toward `escalate`, never toward `request-changes`. Bound:
one verification pass, at most N findings verified, never re-entrant.

**5. Precedents in the knowledge store, not a confidence threshold.** Anthropic
publishes 17 numbered "PRECEDENTS" of settled false positives in its security
filter; that is more useful than any numeric bar. Ours belong in the knowledge
store rather than a static file, because `learn`/`recall` already dedupe,
supersede and index: write each confirmed false positive as a memory
(`type: gotcha`, a `review-precedent` marker in the title) and have the reviewer
`recall` them for the paths it is reviewing. Seed from settled disputes already
in this repo's history — neon-http has no interactive `db.transaction()`; mocked
`db` makes WHERE predicates unobservable; `bun run test`, never `bun test`.

**Crux: the evidence, not the orchestration.** This design turns on the claim
that a single careful reviewer *with the diff, the callers of what changed, and
the relevant precedents* beats any arrangement of reviewers without them. If
that is wrong — if the bottleneck is reasoning rather than evidence — then step 1
buys little and the effort should go into fan-out instead. Two things make the
evidence reading the better bet: the reviewer currently has no diff at all, and
the only published ablation of per-dimension fan-out found it net negative.
Everything else here (2–5) is precision work on top; if step 1 lands and quality
does not move, stop and re-examine before building step 4.

## Leverage: CBM and the knowledge store

Two distinct uses. Keep them apart.

**For the agents implementing this design** — use `codebase-memory` for
structural discovery instead of grep, per CLAUDE.md: `search_graph` to find the
reviewer symbols, `trace_path` for callers of `createReviewerTask` /
`resolveReviewerGate` before changing their signatures, `get_code_snippet` for
exact source. `recall` with `scope=["memory","task"]` before starting — the
reviewer path has prior outcomes recorded, and this doc is not the only source
of truth about it.

**For the reviewer at runtime** — this is the new capability, and it is the part
worth measuring:

| Evidence | Call | Bound |
|---|---|---|
| Contract breaks the diff can't show | `trace_path` inbound on each changed exported symbol | top N symbols by churn, depth ≤ 2 |
| Was this built as specced | existing `spec_compare` action, plus `recall scope=["spec","code"]` | one call per review |
| Prior findings on these paths | `recall scope=["pr","task"] files=[...]` | top N, used for dedupe + precedent |
| Settled false positives | `recall` for `review-precedent` memories touching these paths | injected as suppression rules |
| After the review | `learn` a `review-precedent` when a finding is confirmed wrong | one per confirmed false positive |

The `pr` and `task` corpora already exist; nothing new needs indexing for the
dedupe path. Cost control matters here: every one of these is a retrieval call
inside a review, so each gets an explicit cap and the whole set is skipped for
PRs below a size threshold.

## Safety properties

The reviewer reads an untrusted contributor diff. It currently also has shell
access, network egress and `gh` — `gh pr comment` is an exfiltration channel no
egress rule blocks. Four bounds, all non-optional:

1. **Doctrine comes from the base branch.** If `CLAUDE.md`, `.claude/`,
   `.mcp.json` or role config are read from PR head, a contributor rewrites the
   reviewer's rubric. This is demonstrated, not theoretical: GitInject
   ([arXiv 2606.09935](https://arxiv.org/html/2606.09935v1)) used a PR-branch
   `CLAUDE.md` "scope restrictions" section to make a reviewer wave through a
   CSRF flaw it had caught in baseline runs. Anthropic's action restores those
   paths from base and keeps PR copies in a reference-only directory; PR-Agent
   has `repo_context_from_default_branch`. There is no prompt-level mitigation.
2. **Tool allowlist, actually enforced.** The reviewer needs read-only git
   (`git diff`, `status`, `log`, `show`) and the buildd MCP — not `Bash`,
   not `Write`, not network. Enforcing this requires the runner to apply role
   `allowedTools` to the primary agent (T9c), which is a runner change and
   therefore ships only on a release to `main`; **not shipped** — the
   restriction is still documentary. The UI that used to claim otherwise has
   been corrected (T9b, #2111; see "The allowedTools gap").
3. **Shipped (T10, #2112). Auto-merge on model `approve` is permitted — bounded
   by the branch it merges into.** Prior art argues against letting a model
   approve its way into a production branch, because judgment manipulation has
   no prompt-level fix (Anthropic's internal gate on agent-authored PRs is two
   human approvals, fail-closed, invalidated on push). The topology this system
   is moving to answers that differently: a task PR targets the **mission
   integration branch**, not `dev`, so an approved-and-merged task PR lands in a
   quarantined branch and the human gate sits once at the integration → `dev`
   PR (see `docs/design/mission-delivery-arc.md`, option A′). An injected
   `approve` then costs a bad commit on a branch that is itself reviewed before
   it can reach `dev`, which is a blast radius worth trading for unattended
   task merges. `evaluateModelApproveBound` (`auto-merge-bound.ts`) implements
   exactly this: it fails closed on an unreadable base ref, refuses outright
   against an explicit trunk deny-list (`protectedBaseBranches` — `main`
   unconditionally, plus the workspace's configured target/default/prod
   branches, checked *before* the positive mission test so a mission whose
   `workingBranch` was pointed at trunk can't launder it), and only then checks
   `isMissionIntegrationBase` against the mission row. Schema/migration and
   deny-path files are not re-checked here — `enforceServerSideEscalation` (T5)
   and the migration operation-class inspector already gate this exact path,
   twice. If the integration-branch topology is not in force for a workspace,
   task PRs target `dev` directly and the same trade does not hold — so this
   bound reads the base ref, not a global flag.

   **The trade also assumed CI ran, and that gap is closed.** `build.yml` used
   to declare `pull_request: branches: [main, dev, 'mission/**']`, so a PR
   based on any other ref got no Build & Test run at all — and since
   `ci-fix.yml` triggers on `workflow_run` of that workflow, the CI-retry chain
   went silent with it. A PR with zero runs is indistinguishable from a green
   one to anything that only looks for failures; observed on PR #2108, where
   the three passing checks were a secrets scan and two Vercel no-ops. The
   trigger list now has the needed catch-all —
   `pull_request: branches: ['**', main, dev, 'mission/**']` — and
   `hasBuildProof` (`auto-merge-bound.ts`) requires a named build/test/typecheck
   check run to have actually reached `status: completed, conclusion: success`
   for the head SHA before a model `approve` may merge; absence, `skipped` and
   `neutral` all refuse.
4. **Mostly shipped. Untrusted text is labelled.** `sanitizeUntrustedText`
   (`untrusted-text.ts`, #2110) strips HTML comments, invisible/bidi
   characters, and markdown structure that impersonates a prompt section from
   PR title/body/summary/feedback before they reach the prompt, and reports
   which carriers it found so the prompt can say the text was tampered with
   rather than present laundered text as clean. **Not yet applied to the
   rendered patch/diff text itself** (`reviewer-patch.ts` does not call it) —
   the same carriers can appear inside diff content. Note the adjacent lesson
   from the CodeRabbit RCE
   ([PwnedRabbit](https://research.kudelskisecurity.com/2025/08/19/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories/)):
   the *deterministic linter* was the execution vector, via PR-supplied config.
   Any linter this path runs must not read tool config from PR head.

## Handoff

Nine tasks. Each is one branch, one PR, with a `pathManifest` so the claim
gate serialises overlapping work. T1 is load-bearing; T2–T9 assume it landed.

Five have shipped since this table was written (T1, T2, T5, T9b, T10); two of
those (T9b, T10) brought an open question below to a close (see "Open
questions"). T9a shipped half of its scope. T3, T4, T6, T7, T8, the rest of
T9a, and T9c remain.

| ID | Task | pathManifest | Depends | Verification | Status |
|---|---|---|---|---|---|
| T1 | Patch assembly + PR-Agent-format renderer + token budget | `apps/web/src/lib/reviewer-patch.ts`, `apps/web/src/lib/reviewer-patch.test.ts` | — | unit: hunk format, line numbers only on `+` lines, budget overflow lists filenames | **Shipped** (#2107) |
| T2 | Wire patch into `buildReviewerContext` behind a workspace flag (default off) | `apps/web/src/lib/reviewer.ts`, `apps/web/src/lib/reviewer.test.ts` | T1 | unit: flag off ⇒ byte-identical context to today | **Shipped** (#2108), flag `policyConfig.reviewerPatchEvidence`, default off |
| T3 | Two-phase output: evidence-only findings, then feedback | `apps/web/src/lib/reviewer.ts`, `apps/web/src/app/api/workers/[id]/route.ts` + tests | T2 | unit: old single-shape output still accepted (no-op default) | Not shipped — `REVIEWER_TASK_OUTPUT_SCHEMA` is still one call |
| T4 | Structural filters: cited-line anchoring, findings cap, hard exclusions | `apps/web/src/lib/reviewer-findings.ts` + test | T1 | unit: finding citing an unchanged line is dropped | Not shipped — `reviewer-findings.ts` does not exist |
| T5 | Server-side escalate enforcement from the file list | `apps/web/src/lib/reviewer.ts`, `apps/web/src/lib/workspace-policy.ts` + tests | — | unit: migration path ⇒ escalate even when model says approve | **Shipped** (#2113) as `preflightEscalationCheck` (pre-dispatch) + `enforceServerSideEscalation` (re-derived at verdict time) |
| T6 | Verification pass for `request-changes` only, fails toward escalate | `apps/web/src/lib/reviewer-verify.ts` + test | T3, T4 | unit: verifier error ⇒ escalate, never request-changes; one pass only | Not shipped — `reviewer-verify.ts` does not exist |
| T7 | Runtime retrieval: `trace_path` callers, `spec_compare`, `recall` precedents, with caps | `apps/web/src/lib/reviewer-retrieval.ts` + test | T2 | unit: per-call caps respected; skipped below size threshold | Not shipped — `reviewer-retrieval.ts` does not exist |
| T8 | `review-precedent` memory convention + `learn` on confirmed false positive | `apps/web/src/lib/reviewer-precedents.ts` + test, `.claude/skills/` doc | T7 | unit: precedent recall injects suppression rules | Not shipped — `reviewer-precedents.ts` does not exist |
| T9a | Security: base-branch doctrine restore + untrusted-text stripping | `apps/web/src/lib/role-config.ts`, `apps/runner/src/roles.ts` + tests | — | unit: PR-head `CLAUDE.md`/`.claude/` is not read | **Split.** Untrusted-text stripping shipped separately as `untrusted-text.ts` (#2110), applied to PR title/body/summary/feedback but not yet the rendered patch. Base-branch doctrine restore has **not** shipped — `roles.ts`/`workers.ts` still resolve `CLAUDE.md` from the checked-out (PR-head) working directory; the GitInject risk this item names is still live |
| T9b | UI truth: label the Allowed Tools panel as subagent-scoped (or hide it for skill-less roles) | `apps/web/src/app/app/(protected)/workspaces/[id]/skills/[skillId]/RoleEditor.tsx`, `apps/web/src/app/app/(protected)/team/[slug]/settings/TeamRoleEditor.tsx` | — | visual: no surface claims "N restricted" for a control that does not apply | **Shipped** (#2111) as `apps/web/src/lib/role-tool-scope.ts`, also applied to `SkillList.tsx` |
| T9c | Enforce role `allowedTools` on the primary agent, reviewer role first | `apps/runner/src/workers.ts` + tests | T1, T9b | unit: role allowlist applied to primary agent; per-role audit recorded in the PR | Not shipped — `workers.ts` still only scopes `allowedTools` from skill assignment (`Skill(<slug>)`), never from role config. Both dependencies (T1, T9b) are now satisfied, so this is unblocked |
| T10 | Base-ref-keyed auto-merge bound: approve may merge a task PR into an integration branch, never into `dev`/`prodBranch`/a release PR — **and only when Build & Test actually reported success for the head SHA** | `apps/web/src/lib/auto-merge.ts`, `apps/web/src/lib/merge-policy.ts`, `.github/workflows/build.yml` + tests | T5 | unit: same verdict auto-merges on integration base, escalates on `dev` base; a PR whose build workflow never ran does not auto-merge | **Shipped** (#2112) as `apps/web/src/lib/auto-merge-bound.ts`; `build.yml`'s `pull_request` trigger now includes the `'**'` catch-all |

Suggested split for a team, updated for what's left: T3→T4→T6 as a chain (T4
before T6, since the verifier needs findings to verify), then T7+T8 last since
they add cost per review and should be measured against a working baseline.
T9a's remaining half (base-branch doctrine restore) and T9c (allowlist
enforcement) are both independent security-shaped work with no code
dependency on T3/T4/T6/T7/T8 — T9c's own dependencies (T1, T9b) are already
satisfied, so it no longer needs to wait on anything in this table.

Every task: tests before code, `bun run test` (never `bun test`), and a
regression test confirmed to fail before the fix.

## Open questions

- **Does `confidence` stay in the schema?** I lean yes, but only for logging and
  escalate routing — never as a precision gate, because it is self-reported in
  the same call that makes the claim, and that has been measured as near-random.
  Alternative: drop it and let the structural filters carry precision.
- **Two calls or one?** I lean two (evidence, then prose), per the measured
  false-rejection shape. The cost is a second round trip per review; if latency
  matters more than precision for some workspaces, this could be flag-gated.
- **Resolved: the UI half of the `allowedTools` gap shipped first** (T9b,
  #2111) — as leaned here, ahead of any release-gated runtime change. What's
  still open is the runtime half: enforcement for the reviewer role first
  (T9c), then every other role as its own PR with a per-role audit — because a
  few roles declare MCP-only lists and would lose file and shell access the
  moment enforcement lands.
- **Resolved: auto-merge on `approve` is allowed** for task PRs into a mission
  integration branch, since the human gate moves to the integration → `dev` PR.
  The open part is narrower: the bound has to key off the PR's base ref, so a
  workspace still merging task PRs straight into `dev` does not inherit the
  permission by accident.

## Non-goals

- **Parallel per-dimension reviewers** (bug/security/style/history). The only
  published ablation found naive fan-out worse than a single pass, and
  Anthropic's own multi-agent guidance excludes shared-context tasks like this
  one. Not before steps 1–4 are measured.
- **Embedding-based suppression from up/downvote history** (Greptile's approach
  that worked). It needs a corpus of human votes on review comments that this
  system does not collect yet. T8's precedents are the cheap approximation.
- **Replacing linters or the type checker.** Formatting, imports, type errors,
  lockfile drift and coverage stay with CI. Feeding raw static-analysis output
  into the review prompt is explicitly avoided — one benchmark measured that
  variant as the worst of those tested.
- **Reviewing PRs in repos buildd does not have an installation for.**
- **Changing `reviewer-gate.ts` semantics.** The gate mapping is orthogonal;
  this design changes what the reviewer knows, not how its verdict is applied.
