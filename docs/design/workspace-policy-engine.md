# Workspace Policy Engine

**Status:** Proposed
**Related:**
`packages/core/db/schema.ts` (missionNotes, workspaces, workers tables),
`packages/shared/src/types.ts` (MergePolicy, MissionNote),
`apps/web/src/lib/merge-policy.ts` (resolvePolicy),
`apps/runner/src/worker-runner.ts` (question detection, inputAsRetry),
`apps/web/src/app/api/tasks/[id]/notes/route.ts`,
`apps/web/src/app/api/missions/[id]/notes/route.ts`,
`docs/design/mission-goal-criteria.md`,
`docs/specs/mission-task-lifecycle.md`

---

## Problem

On 2026-08-24 an agent asked a question, the reply UI didn't exist (task a86c0460), answering via MCP crashed the worker (task d6678b3e), and the same question will be asked again on the next retry because nothing was learned. Three separate failures that share a root cause: **the question lifecycle has no memory and no governance layer**.

Concretely:

1. `post_note type=question` stores a string title and optional `defaultChoice`. The agent's reasoning (why this default, what the blast radius is, whether the work is salvageable on human override) is thrown away. The reply UI gets a text title and option chips but no signal for rendering policy citations or tiering badges.

2. There is no reversibility classification. Low-stakes clarifications ("which variable name?") park the worker for the same duration as irreversible actions ("merge to main?"). The agent has no triage axis and the platform has no automatic gates.

3. Every answer is ad-hoc. A human confirms the same question 8 times across 8 retries. Nothing is promoted to policy. Nothing gets faster. The workspace never learns.

The merge policy primitive (`resolvePolicy`, PR #1162) already solved governance for one specific question ("should this PR merge automatically?"). This design generalises that pattern to all agent questions.

---

## Proposal

**Crux:** the classification authority. Every agent question must carry a reversibility class determined by the agent *before* parking, not inferred after the fact by a human reviewer. If the class is wrong (reversible mis-classified as irreversible) the agent parks unnecessarily. If wrong the other way (irreversible classified as reversible) the agent self-authorises a destructive action. The classification must be explicit, auditable, and overridable by policy.

### Part 1 — Structured decision records on questions

Add a `decisionRecord` JSONB column to `mission_notes`. It is only populated when `type = 'question'`. Existing rows are unaffected (column is nullable).

```ts
// packages/shared/src/types.ts

export type ReversibilityClass =
  | 'reversible'    // free undo: revert a file, rename a variable
  | 'recoverable'   // medium cost: schema rollback, revert PR, restore backup
  | 'irreversible'; // no undo or very high cost: merge to main, delete branch,
                    // prod deploy, external payment, force-push, destructive SQL

export type BlastRadius =
  | 'local'       // single file or test
  | 'workspace'   // multiple files, migration, PR
  | 'production'; // external system, deployed surface, billing

export interface QuestionDecisionRecord {
  // The normalized question text (may differ from missionNote.title which is UI-facing)
  question: string;
  // Options the agent considered, in preference order
  options: string[];
  // The agent's chosen default (same value as missionNote.defaultChoice — duplicated
  // here for cohesion with rationale and reversibility)
  defaultChoice: string;
  // Agent's stated reasoning for choosing this default
  rationale: string;
  // Reversibility of the action that resolves this question
  reversibilityClass: ReversibilityClass;
  // Scope of impact if the default choice is acted on
  blastRadius: BlastRadius;
  // True if work done under defaultChoice can be undone when a human later overrides.
  // When false, the agent must NOT self-answer — it must park.
  // Example: "which variable name?" → salvageable=true.
  // Example: "merge feature to main?" → salvageable=false.
  isSalvageable: boolean;
  // If a workspace_policy matched and answered this question, its ID
  policyMatchId?: string;
  // Provenance of the matched policy, if any
  policyProvenance?: 'harvested' | 'interviewed' | 'manual';
  // Free-form evidence the agent used to classify reversibility
  // (e.g. "touches packages/core/drizzle/ — migration path")
  classificationEvidence?: string;
}
```

**Schema addition to `mission_notes`:**

| Column | Type | Default | Notes |
|---|---|---|---|
| `decision_record` | `jsonb` | `null` | Populated only on `type='question'` |

Three consumers of this record:
1. **Continuation-task `failureContext`** — when `inputAsRetry` fires, the runner serialises the full `QuestionDecisionRecord` into the retry task's `failureContext`. The retry task prompt sees all context.
2. **Reply UI option chips** (task a86c0460) — renders `options`, `defaultChoice` badge, reversibility tier label, and a "matched policy" citation when `policyMatchId` is set.
3. **Policy learning loop** — harvester reads `reversibilityClass`, `isSalvageable`, `question`, and `defaultChoice` when a human answers a parked question, to determine whether the answer is a policy candidate.

### Part 2 — Question tiering by reversibility

The runner evaluates three tiers in order, immediately after `post_note type=question`:

```
Tier 1 — Self-answer (reversible + salvageable)
  reversibilityClass === 'reversible' AND isSalvageable === true
  → continue under defaultChoice; log to milestones; no park
  
Tier 2 — Policy-answer (covered by workspace_policies)
  A matching active policy exists AND policy.scope covers this workspace
  AND reversibilityClass !== 'irreversible' (hard gate — policies never bypass irreversible)
  → answer from policy; post note citing policyMatchId; continue
  
Tier 3 — Park (irreversible + uncovered, or unsalvageable)
  All others
  → inputAsRetry: set status=waiting_input, sync decisionRecord, abort session
```

**Hard constraint on Tier 2:** Orchestrator answers from policy only, never from its own judgment. If the policy table has no match, the agent parks even if it "knows" the answer. This is intentional — the policy table is the single accountable authority for autonomous decisions above reversible threshold.

**Salvageability gate:** If `isSalvageable === false` the agent parks regardless of reversibility class. A question that would fork work irreversibly was mis-classified as reversible — the salvageability field catches this.

Example reclassifications that this gate handles:
- "Should I use `bun` or `npm`?" → appears reversible but if it generates a lockfile committed to a PR, it's not salvageable — park.
- "Which function signature?" → reversible AND salvageable → self-answer.
- "Delete the old migration file?" → irreversible, park.
- "Force-push this branch?" → irreversible, park.

### Part 3 — Unified rule shape (workspace_policies table)

All policies — regardless of origin (harvested, interviewed, manual) — share one DB row shape.

**New table: `workspace_policies`**

```ts
// packages/core/db/schema.ts

export const workspacePolicies = pgTable('workspace_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  // Scope at which this rule applies
  scope: text('scope').notNull().$type<'workspace' | 'global'>(),
  // Structured condition that must match for this rule to fire
  condition: jsonb('condition').notNull().$type<PolicyCondition>(),
  // The answer this policy provides when condition matches
  answer: text('answer').notNull(),
  // If the question had options, which index (0-based) this corresponds to
  answerOptionIndex: integer('answer_option_index'),
  // How this rule was created
  provenance: text('provenance').notNull().$type<'harvested' | 'interviewed' | 'manual'>(),
  // Source note/task for audit trail
  provenanceRef: text('provenance_ref'),    // format: 'note:<noteId>' | 'task:<taskId>'
  // Confidence score 0.0–1.0; below threshold = demoted to 'pending'
  confidence: doublePrecision('confidence').notNull().default(0.5),
  // Times this answer was chosen by humans (reinforcement count)
  confirmationCount: integer('confirmation_count').notNull().default(0),
  // Times the opposite answer was chosen (decay signal)
  contradictionCount: integer('contradiction_count').notNull().default(0),
  // Last time a matching question was answered in line with this policy
  lastReinforcedAt: timestamp('last_reinforced_at', { withTimezone: true }),
  // Null = no expiry; set for time-limited overrides
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  // Lifecycle: pending (awaiting confirmation) → active → rejected | expired | superseded
  status: text('status').notNull().default('pending').$type<'pending' | 'active' | 'rejected' | 'expired' | 'superseded'>(),
  supersededById: uuid('superseded_by_id'),   // FK to workspace_policies (self-reference)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index('workspace_policies_workspace_idx').on(t.workspaceId),
  statusIdx: index('workspace_policies_status_idx').on(t.status),
  scopeIdx: index('workspace_policies_scope_idx').on(t.scope),
}));
```

**PolicyCondition type:**

```ts
// packages/shared/src/types.ts

export type PolicyCondition =
  | {
      type: 'keyword';
      // Question text contains ALL of these keywords (case-insensitive)
      keywords: string[];
    }
  | {
      type: 'reversibility_class';
      // Question's reversibility class matches exactly
      class: ReversibilityClass;
    }
  | {
      type: 'path_pattern';
      // Question concerns files matching these glob patterns
      // (derived from the worker's current pathManifest or question context)
      patterns: string[];
    }
  | {
      type: 'question_hash';
      // Normalized question text hash — exact (fuzzy-canonical) match
      // Computed by normalising whitespace and lowercasing the question string
      hash: string;
      // Original question text, stored for display (the hash is the matching key)
      questionText: string;
    }
  | {
      type: 'compound';
      // ALL of the nested conditions must match
      all: PolicyCondition[];
    };
```

**Matching algorithm (runner-side, stateless):**
1. Normalize the question (lowercase, collapse whitespace).
2. Try `question_hash` conditions first (O(1) hash lookup).
3. Then `keyword` conditions (substring scan).
4. Then `path_pattern` conditions (if pathManifest is available).
5. Then `reversibility_class` catch-alls (broadest, lowest specificity).
6. Compound conditions require all sub-conditions to match.
7. If multiple rules match, the highest-confidence active rule wins.
8. Rules with `status !== 'active'` are never applied.

**Why `workspace_policies` table, not skill/role content:**

| Concern | skill/role content | workspace_policies table |
|---|---|---|
| Machine-queryable conditions | No — text blob requires regex | Yes — indexed JSONB |
| Per-rule lifecycle (pending/active/rejected) | No | Yes |
| Confidence + decay (numeric) | No — parsed from text | Yes — native columns |
| Harvest pipeline (write new rows) | Requires text surgery | Append new row |
| Revocation by policy ID | No — requires text edit | DELETE/UPDATE by PK |
| Provenance audit trail | Not reliable | FK to source note/task |
| UI confirmation flow | No natural hook | Query by status='pending' |

Skill content is the right home for *how the agent works*. Policy rules govern *what decisions it makes*. These are distinct concerns that deserve distinct storage.

The policy table may optionally generate a rendered text view for the agent's prompt context (e.g. injected as a short section in CLAUDE.md before each run), but the source of truth is the relational table.

### Part 4 — Three policy definition channels

#### 4a. Harvest (primary, warm workspaces)

Every time a parked question is answered by a human, the harvest pipeline runs:

```
Human answers note → POST /api/tasks/[id]/notes (type='reply') or UI answer tap
  → harvest.evaluateCandidate(note, answer)
    → check: does an active policy already exist for this condition? (skip if yes)
    → check: is reversibilityClass === 'irreversible'? → never auto-promote
    → check: does isSalvageable === false? → never auto-promote
    → create workspace_policies row with status='pending', confidence=0.3, confirmationCount=1
    → check: is confirmationCount for this question_hash ≥ PROMOTION_THRESHOLD (default: 3)?
      AND confidence ≥ CONFIDENCE_THRESHOLD (default: 0.75)?
      AND reversibilityClass === 'reversible'?
        → upgrade to SUGGESTED: post a mission/workspace note with action chips
          "Approve policy" / "Reject"
        → status remains 'pending' until explicit human confirm
```

**NO silent promotion.** Repeated 'yes' taps must never become auto-policy without an explicit confirmation step. Even at 100 confirmations and 1.0 confidence, status stays `pending` until a human clicks "Approve policy." Auto-apply is only valid for `reversible` class rules and only after the confirmation step.

The suggestion UI (mirroring moa-ops classification-suggestion pattern):
- Shows the question text, the chosen answer, the confidence score, and confirmationCount
- Two actions: "Approve" (→ `status='active'`) and "Reject" (→ `status='rejected'`)
- Approved reversible policies take effect immediately on next matching question
- Rejected candidates are archived (cannot be re-promoted from the same question_hash for 30 days)

**Reinforcement loop (existing active policies):**
When a question matches an active policy and the human later overrides the policy answer:
- `contradictionCount += 1`
- Confidence recomputed: `confidence = confirmationCount / (confirmationCount + contradictionCount)`
- If `confidence < 0.5` → policy demoted back to `pending` (visible in policy audit UI)

#### 4b. Interview (cold start, existing repo)

Triggered once at workspace onboarding (and incrementally on graduation events, see §5).

```
POST /api/workspaces/[id]/policies/interview
  → dispatch a one-shot worker task (role: 'policy-interviewer' or workspace organizer)
  → worker inspects the repo for high-signal artifacts:
      .github/workflows/*.yml      → CI/CD patterns → "should I merge if CI is yellow?"
      .github/CODEOWNERS           → ownership → "who reviews [path] changes?"
      packages/core/drizzle/*.sql  → migration dir → "should I run migrations automatically?"
      protected branches (GitHub API) → "is main protected? should I force-push?"
      deploy configs               → "should I trigger deploy after merge?"
      package.json scripts         → "should I run tests before committing?"
  → generates ≤5 interview questions, each with:
      - questionText: string
      - anchor: { artifact: string, excerpt: string }  // real file/line that motivated it
      - options: string[]
      - suggestedAnswer: string  // agent's read of the repo
  → posts questions to the user as a batch workspace note
  → user answers → each answer becomes an interviewed-provenance policy row (status='active')
```

Interviewed rules start `active` immediately (no confirmation queue) because:
1. They were explicitly asked of the human at onboarding (not inferred from behaviour)
2. The anchor artifact makes the rationale transparent
3. They answer questions the repo structure already implies

Interview is idempotent: re-running it with the same repo state produces the same question set. If an active policy already covers the condition, the question is skipped.

#### 4c. Menu (thin)

Settings UI exposes only universal, context-free knobs:
- Retry cap (max retries per task)
- Model tier preference
- Notification urgency threshold
- Parking threshold for recoverable class (override: park or continue-with-log)

No behavioral policies in settings forms. "What should the agent do when X?" must go through harvest or interview, not a dropdown. This prevents a combinatorial settings explosion and keeps behavioral rules auditable through the same provenance chain.

### Part 5 — Greenfield workspaces (no repo to inspect)

A greenfield workspace has an empty or scaffold-only repo — the interview has no protected branches, no workflow files, no migration dirs to anchor on. Without anchors the interview cannot generate meaningful questions.

**Posture: strict-by-default.**
No history + no artifacts = everything above `reversible` parks. The policy set starts near-empty. This is the correct conservative posture: the workspace hasn't proven anything yet, so the human stays in the loop.

**Spec-anchored interview (spec-before-code applied to governance):**
During `manage_workspaces action=init` or first mission creation, if the repo is empty:
1. Prompt the user for a brief project description / initiative statement (or inherit from the mission description).
2. NLP-extract declared intents: deploy target, data stores, external services, auth model.
3. Generate interview questions from declared intents rather than repo artifacts:
   - "Your project declares Postgres — should I auto-run migrations before merging?"
   - "Your project deploys to Vercel — should I verify the preview URL before merging?"
   - "You mentioned Stripe integration — should I park any task that touches billing paths?"
4. Answers become `interviewed`-provenance rules with `anchor: { source: 'mission_description', excerpt: '...' }`.

These rules are provisional and should carry lower confidence (0.6) than artifact-anchored rules (0.9). They are the first layer; harvest reinforces or contradicts them as work accrues.

**Policy questions folded into scaffolding, not a separate ceremony:**
These questions are asked once during `manage_workspaces action=init` or the first `manage_missions action=create`. They are not a separate "policy wizard" that can be deferred. A project that skips them operates strict-by-default.

**Inheritance — team-level baseline policies:**
Some rules are doctrine, not per-workspace preferences:
- "Never report success on red CI"
- "Never commit secrets"
- "Never force-push main without explicit human instruction"

These live in a `global`-scoped `workspace_policies` rows (workspaceId = null, scope = 'global'). All workspaces inherit them. Workspace-level rules override global rules by precedence:

```
task-level policy (future) → mission-level policy (future) → workspace-level policy → global policy
```

The matching algorithm tries the narrowest scope first.

**Graduation — incremental interview on first real artifacts:**
When a greenfield workspace transitions from empty to having real infrastructure:
- First protected branch created → emit `protected_branch_added` event → trigger interview questions for that branch
- First `.github/workflows/*.yml` committed → trigger CI/CD policy questions
- First migration file in `drizzle/` → trigger migration policy question

Graduation events are idempotent: if an active policy already covers the condition, no question is asked.

### Part 6 — Decay + scope hygiene

Harvested rules are workspace-scoped (never global). "Yes, force-push in moa-ops" is not doctrine for buildd.

**Decay model:**

```
confidence = confirmationCount / (confirmationCount + contradictionCount)

Decay trigger: STALE_DAYS without reinforcement (default: 90 days)
  → confidence *= 0.5 (halved once)
  → if confidence < DEMOTION_THRESHOLD (default: 0.4):
      status → 'pending' (rule visible in audit UI as "needs review")
  → if STALE_DAYS × 2 without reinforcement and still pending:
      status → 'expired' (rule no longer applied; preserved for audit)
```

Decay runs as a cron sweep (not per-request), similar to the PR merge-state reconciliation pattern. Expired rules are never deleted — they remain in the table with `status='expired'` for audit and potential resurrection.

**Scope guard (workspace_policies row has workspaceId FK):**
- Global rules (scope='global', workspaceId=null) require admin confirmation to create.
- Workspace rules (scope='workspace') are the default.
- Mission-scoped rules are not proposed in this spec (flagged in Open questions).

---

## Schema additions summary

| Table | Column | Type | Default | Notes |
|---|---|---|---|---|
| `mission_notes` | `decision_record` | `jsonb` | `null` | Only on `type='question'` |
| `workspace_policies` | — | new table | — | Full table above |

Migration count: 2 (one for each table change).

No existing table rows are affected. All new columns/tables are additive.

---

## Rollout order

Each phase is independently shippable and can be reviewed before the next is cut.

### Phase 1 — Decision records (unblocks reply UI + retry context)
**Scope:** Add `decision_record` JSONB to `mission_notes`. Update runner to populate it when `post_note type=question` is called. Update continuation-task `failureContext` serialization to include the full record. Update reply UI to read and render it (option chips, reversibility badge).
**Ships independently of policy engine** — value is immediate (better retry context, richer UI) even if no policies exist yet.
**Verification:** A question note has `decision_record` populated; retry task's `failureContext` contains it; reply UI shows the badge.

### Phase 2 — Question tiering + park gate
**Scope:** Runner evaluates reversibility tiers (§2) before parking or continuing. Add `isSalvageable` check to `inputAsRetry` path. Add logging to milestones when Tier 1 self-answer fires. Tier 2 stub (no policies yet → always falls through to Tier 3).
**Ships independently** — makes the park gate stricter by reversibility without requiring the policy table.
**Verification:** A reversible+salvageable question does not park. An irreversible question parks regardless of any other signals.

### Phase 3 — workspace_policies table + Tier 2 matching
**Scope:** Add `workspace_policies` table + migration. Add policy-matching logic to runner (§3 matching algorithm). Add MCP actions: `manage_workspace_policies` (list/create/update/delete). Add basic policy audit UI (list active policies, their confidence, last reinforced). Manual policy creation only at this stage.
**Ships independently** — humans can manually define policies via MCP. No harvest yet.
**Verification:** A manually-created active policy answers a matching question; the answer is logged with `policyMatchId`.

### Phase 4 — Harvest pipeline
**Scope:** Add harvest trigger to the reply/answer path. Implement `SUGGESTED` promotion flow (pending → human confirms → active). Add harvest queue UI showing pending policy suggestions. Implement reinforcement loop (contradictionCount, confidence recomputation).
**Ships independently** — workspace begins learning from answered questions.
**Verification:** After 3 identical answers, a SUGGESTED policy appears; human confirms; subsequent matching question is answered automatically (Tier 2).

### Phase 5 — Interview (existing repos)
**Scope:** Implement `POST /api/workspaces/[id]/policies/interview`. Dispatch policy-interviewer worker task. Implement anchor-extraction from repo artifacts. Add to workspace onboarding flow.
**Ships independently** — warm workspaces get cold-start policy seeding.
**Verification:** Interview is triggered at onboarding; ≤5 questions are asked; answers create `interviewed` policies.

### Phase 6 — Greenfield + team-level baseline + graduation
**Scope:** Spec-anchored interview from mission description. Global-scoped policies. `manage_workspaces action=init` policy questions. Graduation event hooks (`protected_branch_added`, etc.). Decay cron sweep.
**Ships independently** — completes the policy surface.
**Verification:** Greenfield workspace starts strict-by-default; confirms a team-level global rule is inherited; graduation event triggers incremental interview.

---

## Open questions

**Q1: Mission-scoped policies?**
The current proposal has only `workspace` and `global` scope. A mission-scoped policy ("for this data-migration mission, always park before running destructive SQL") would be useful. Leaning **yes** — add `missionId` FK to `workspace_policies` with a 3-level precedence chain (mission → workspace → global). Deferring to Phase 3+ to keep the initial table simple.

**Q2: Reversibility classification authority — agent or runner?**
Currently proposed: the agent declares `reversibilityClass` in its `post_note` call. Alternative: the runner infers it from the question text / path context without trusting the agent. Leaning **agent-declared** because the agent has full context about what it's about to do; but the runner adds a hard-floor: questions mentioning known irreversible keywords (`merge`, `force-push`, `delete`, `deploy`, `drop table`, `rm -rf`) are always at least `recoverable` regardless of agent claim. This prevents a confused agent from self-classifying a destructive action as reversible.

**Q3: Policy condition `path_pattern` — how does the runner know which paths are in scope?**
The runner knows the worker's `pathManifest` and current working files. Path-pattern conditions match against these. If no pathManifest is set, path-pattern conditions cannot match (they are skipped, not defaulted). Implication: path-pattern policies only work when the task declares a `pathManifest`. Flagging this as a usability gap — should the runner infer paths from recent file edits in the session?

**Q4: Interview frequency and freshness.**
The interview runs once at onboarding and incrementally on graduation events. Should there be a "re-interview" trigger (e.g., after a major infra change)? Leaning **yes** — expose `POST /api/workspaces/[id]/policies/interview` as a user-callable action (not just onboarding). Rate-limited to 1/day to prevent thrashing.

**Q5: Policy answer is always a text string — what about structured answers?**
Some questions have numeric answers (retry cap: 3). `policy.answer` is `text` and `answerOptionIndex` handles multi-choice. For numeric answers the agent must parse the text. Leaning: acceptable for now; a `answerPayload: jsonb` column can be added later if parsing becomes error-prone.

**Q6: Who can create global-scoped policies?**
Proposed: admin token only (same as `create_schedule`, `manage_model_tiers`). Global policies are team doctrine and warrant an elevated permission gate. Workspace-scoped policies are accessible to any workspace member via API key.

**Q7: Confidence threshold tuning.**
`PROMOTION_THRESHOLD = 3`, `CONFIDENCE_THRESHOLD = 0.75`, `STALE_DAYS = 90`, `DEMOTION_THRESHOLD = 0.4` are proposed defaults. These are tuneable. Should they be exposed as workspace settings (Menu channel, §4c)? Leaning **yes** for `PROMOTION_THRESHOLD` (teams vary in how much reinforcement they want before suggesting a policy) but **no** for the decay parameters (too esoteric for a settings form).

---

## Non-goals

- **Replacing `resolvePolicy` / `MergePolicy`**: the existing merge policy engine is not replaced or merged into `workspace_policies`. Merge policy is a specialised, well-tested primitive. The workspace policy engine operates at the question level, upstream of PR merge decisions. A future spec may unify them; not this one.
- **Auto-creating tasks from policy failures**: when a policy is contradicted (human overrides it), no task is created. The contradiction increments `contradictionCount` and may demote the rule — the human stays in control of remediation.
- **Cross-workspace policy sharing**: policies are workspace-scoped (or global). Sharing a policy between two arbitrary workspaces is not in scope.
- **Policy versioning/history**: only the current row is live. The audit trail comes from the notes feed and the provenance trail (`provenanceRef`). Full version history is deferred.
- **LLM-generated conditions**: this spec does not propose using an LLM to generate `PolicyCondition` values from free-text descriptions. Conditions are structured types created by harvest (from seen questions) or interview (from anchor inspection). Menu-created conditions are typed form fields.
- **Policy enforcement outside the runner**: policies are checked by the runner before a question parks. Server-side enforcement (blocking an API call that matches a policy condition) is not in scope.
