# Reviewer Evidence and Verification

**Status:** Proposed
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

No patch text is fetched, here or anywhere in the runner. The reviewer role
prompt (`default-roles.ts`, slug `reviewer`) nonetheless opens with "You
receive: The PR diff", and asks the agent to judge scope creep, spec
conformance and "obvious regressions" from that. Three consequences:

1. **Verdicts are guesses about content the model never read.** A judgement of
   "no obvious regressions" over a file list is not a review; it is a review
   *shaped* response. Any finding that requires reading a changed line — a
   stale-snapshot write, a message rendered in a format the receiving tool
   rejects, a turn counter incremented on a bookkeeping request — is
   unreachable by construction.
2. **The declared tool restriction is not enforced.** The role sets
   `allowedTools: ['mcp__buildd__buildd']`, but nothing applies role-level
   `allowedTools` to the primary agent: the runner builds the main agent's
   allowlist purely from skill scoping (`workers.ts`, "Build allowedTools with
   skill scoping"), and `role.allowedTools` is read only when skills run as
   subagents. With no skills attached to a reviewer task, the session gets SDK
   defaults — full shell and file access. So the reviewer *could* fetch the
   diff, is never told to, and simultaneously has more authority than the role
   claims.
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
| Evidence assembly | `reviewer.ts` `buildReviewerContext` | file list + counts, task description, artifact previews, doctrine prose |
| On-demand review | `pr-review-request.ts` | adopts an external PR as task+worker, then same path |
| Verdict handling | `apps/web/src/app/api/workers/[id]/route.ts` | approve → policy decides merge; request-changes → retry iteration; escalate → human |
| Gate resolution | `reviewer-gate.ts` `resolveReviewerGate` | maps reviewer task status to gate state |
| Escalation triggers | role prompt prose + `preflightEscalationCheck` | schema/deny-path preflight is server-side; the rest is asked of the model |
| Confidence | `merge-policy.ts` `maxConfidenceThreshold` | model self-reports `confidence` in the same call that makes the claim |
| Tool access | `apps/runner/src/workers.ts` | role `allowedTools` unenforced for the main agent (see Problem 2) |

Retrieval that already exists and the reviewer never calls: `recall` over the
`spec`, `code`, `pr`, `task`, `artifact` corpora (`packages/core/knowledge-store/types.ts`),
the `spec_compare` action (two-hop spec↔code retrieval, already in the buildd
MCP the role mounts), and the `codebase-memory` MCP graph (`search_graph`,
`trace_path`, `get_code_snippet`).

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
findings matching a hard-exclusion list. Enforce the escalate triggers —
migrations, deny-paths, release PRs — from the file list server-side, **never**
from the model's self-reported `escalationReason`, which is attacker-influenced
text.

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
   `allowedTools` to the primary agent, which is a runner change and therefore
   ships only on a release to `main`; until then the restriction is documentary.
3. **`approve` must not be sufficient for auto-merge on agent-authored PRs.**
   Judgment manipulation has no prompt-level fix, so the merge decision cannot
   rest on model output alone. Anthropic's internal gate on agent-authored PRs
   is two human approvals, fail-closed, invalidated on push. At minimum, keep
   the server-side escalate list authoritative (step 3) and treat model
   `approve` as necessary-not-sufficient where the policy already says human.
4. **Untrusted text is labelled.** Strip HTML comments and invisible characters
   from PR body/diff before they enter the prompt, and mark them as data. Note
   the adjacent lesson from the CodeRabbit RCE
   ([PwnedRabbit](https://research.kudelskisecurity.com/2025/08/19/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories/)):
   the *deterministic linter* was the execution vector, via PR-supplied config.
   Any linter this path runs must not read tool config from PR head.

## Handoff

Nine tasks. Each is one branch, one PR, with a `pathManifest` so the claim
gate serialises overlapping work. T1 is load-bearing; T2–T9 assume it landed.

| ID | Task | pathManifest | Depends | Verification |
|---|---|---|---|---|
| T1 | Patch assembly + PR-Agent-format renderer + token budget | `apps/web/src/lib/reviewer-patch.ts`, `apps/web/src/lib/reviewer-patch.test.ts` | — | unit: hunk format, line numbers only on `+` lines, budget overflow lists filenames |
| T2 | Wire patch into `buildReviewerContext` behind a workspace flag (default off) | `apps/web/src/lib/reviewer.ts`, `apps/web/src/lib/reviewer.test.ts` | T1 | unit: flag off ⇒ byte-identical context to today |
| T3 | Two-phase output: evidence-only findings, then feedback | `apps/web/src/lib/reviewer.ts`, `apps/web/src/app/api/workers/[id]/route.ts` + tests | T2 | unit: old single-shape output still accepted (no-op default) |
| T4 | Structural filters: cited-line anchoring, findings cap, hard exclusions | `apps/web/src/lib/reviewer-findings.ts` + test | T1 | unit: finding citing an unchanged line is dropped |
| T5 | Server-side escalate enforcement from the file list | `apps/web/src/lib/reviewer.ts`, `apps/web/src/lib/workspace-policy.ts` + tests | — | unit: migration path ⇒ escalate even when model says approve |
| T6 | Verification pass for `request-changes` only, fails toward escalate | `apps/web/src/lib/reviewer-verify.ts` + test | T3, T4 | unit: verifier error ⇒ escalate, never request-changes; one pass only |
| T7 | Runtime retrieval: `trace_path` callers, `spec_compare`, `recall` precedents, with caps | `apps/web/src/lib/reviewer-retrieval.ts` + test | T2 | unit: per-call caps respected; skipped below size threshold |
| T8 | `review-precedent` memory convention + `learn` on confirmed false positive | `apps/web/src/lib/reviewer-precedents.ts` + test, `.claude/skills/` doc | T7 | unit: precedent recall injects suppression rules |
| T9 | Security: base-branch doctrine restore, untrusted-text stripping, role `allowedTools` enforcement (runner half is release-gated) | `apps/runner/src/workers.ts`, `apps/web/src/lib/role-config.ts` + tests | — | unit: PR-head `CLAUDE.md` is not read; role allowlist applied to primary agent |

Suggested split for a team: T1 alone first (nothing else is worth doing until
the reviewer can see the diff), then T5+T9 in parallel with T2 (independent,
both security-shaped), then T3→T4→T6 as a chain, with T7+T8 last since they add
cost per review and should be measured against a working baseline.

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
- **Enforce role `allowedTools` on the primary agent?** I lean yes — the current
  state grants more authority than every role declares — but it changes the tool
  surface of every existing role at once and ships only via release, so it wants
  its own PR, its own rollout, and a per-role audit of what breaks.
- **Human approval for agent-authored PRs.** Prior art says model `approve`
  should not be sufficient. That is a policy decision about how autonomous this
  system is, not a technical one, and it belongs to the owner rather than this
  doc.

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
