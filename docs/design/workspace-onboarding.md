# Workspace Onboarding: make any repo buildd-ready

**Status:** Implemented. The contract now lives in `docs/specs/workspace-onboarding.md`; this document keeps the rationale and the rejected alternatives.
**Related:** `apps/web/src/app/api/workspaces/[id]/policy-init/route.ts`, `apps/web/src/lib/workspace-policy.ts`, `packages/core/spec-conformance-detect.ts`, `packages/core/spec-conformance.ts`, `apps/runner/src/env-verify.ts`, `.buildd/env.yaml`, `docs/specs/SPEC-FORMAT.md`, `docs/design/DESIGN-FORMAT.md`, `docs/design/spec-conformance.md`, `docs/design/merge-policy.md`, `docs/design/release-handoff-workflow.md`, `docs/design/buildd-mcp-consumer-skill.md`, `docs/design/visual-qa-auditor.md`, `docs/specs/team-workspace-mission-onboarding.md`, `.claude/skills/buildd-mcp-consumer/SKILL.md`, `.claude/skills/visual-review/SKILL.md`

---

## Problem

A new workspace pointed at an arbitrary repo gets workers that can claim tasks
and little else. Everything that makes buildd's own delivery loop reliable is
something this repo has and the new repo does not: an agent instructions file
that names the real test/typecheck/build commands, a spec root with a format
the conformance checks can read, a merge policy derived from the repo's own
risky paths, a release path, an env contract, and a way to look at UI changes.
Today a worker in a fresh repo guesses the test command, opens a PR nobody
classified, and finishes with no spec to be checked against.

What exists is one slice of this. `manage_workspaces action=init` scans the
repo tree and proposes a merge policy plus spec-conformance roots; nothing else
is detected, nothing is scaffolded, and there is no path from "I have an idea
for a product" to "a first spec exists in the format buildd reads". The steps
are scattered across the dashboard (repo picker, create-repo, mission form) and
the MCP (`create`, `create_repo`, `init`) with no single documented order and
no place that says what is still missing.

Two shortcuts are tempting and both fail the mission: copying buildd's own
`CLAUDE.md`, `docs/specs/SPEC-FORMAT.md` and scripts into the user's repo
(they name `apps/web`, `bun run test`, Neon, `proxy.ts`, buildd's ten spec
domains), and requiring Vercel for visual review. A workspace that is a Python
service on a plain VPS must onboard as cleanly as a Next.js app.

## Current state

| Step | Dashboard | MCP | Status |
|---|---|---|---|
| 1. Create workspace | `/app/workspaces/new` with `RepoPicker.tsx` | `manage_workspaces action=create` | Exists |
| 2. Link or create repo | `create-repo` route exists; the workspace page has no link/create affordance when `repo` is null | `action=update` (link), `action=create_repo` | Partial (dashboard) |
| 3. Init | Policy sheet reachable from `WorkspaceHealthCard` ("review-policy") | `action=init` returns a policy + spec-root + Tier-3 schedule proposal; applied by `action=update gitConfig.policyConfig` | Partial: policy and spec roots only |
| 4. Readiness report | none | none | Missing |
| 5. Guided fixes (scaffold PR) | none | none | Missing |
| 6. First spec | none | none | Missing |
| 7. First mission | `/app/missions/new` (workspace picker is buried inside the form) | `manage_missions` | Exists |

What `init` does and does not do (`policy-init/route.ts`): it fetches the repo
tree once, runs `detectAllRiskClasses(files)` (`workspace-policy.ts`,
regex/dir/file matchers over a flat `string[]`), `detectSpecConformanceRoots(files)`
and `buildTier3ScheduleParams`, and returns a proposal; it writes nothing and
the owner applies it with `PATCH /api/workspaces/[id]/config`, which sets
`configStatus = 'admin_confirmed'`. It does not detect a migrations directory
(`resolveConformanceConfig` silently defaults `migrationsDir` to buildd's own
path), test/typecheck/build commands, instruction files, the release path, or a
visual-QA source. Two neighbouring things are named to avoid confusion:
`release-readiness.ts` is the release widget's readiness, unrelated to this
report, and the `.buildd/env.yaml` contract with the `env-verify.ts` planner
already does lockfile-based ecosystem detection (bun/pnpm/yarn/npm/uv/poetry/
cargo/go) but in `apps/runner`, where a web route cannot import it.

## Proposal

One documented path, eight steps, every step reachable from both surfaces:

```
create workspace -> link/create repo -> init (policy) -> readiness report
  -> guided fixes (owner-approved scaffold PR) -> first spec (interview -> draft PR)
  -> first mission
```

**The crux: detection is a pure function over observable repo facts, and every
change that reaches the repo is a proposal an owner approves.** If detection
bakes in buildd's layout (it looks for `bun`, `docs/specs`, `apps/web`), the
report lies about every other repo and the scaffold writes wrong files. If any
step writes without approval, onboarding becomes the thing that commits to a
stranger's default branch. So the design splits cleanly: a pure
`computeReadiness(input)` that never does IO and never writes; an IO shell that
feeds it; a scaffold step that only ever opens a PR from a non-default branch;
and two explicit approval points (select what to propose, merge the PR).

### 1. Creation flow

The flow is the list above. What is new per step:

1. **Create workspace** - unchanged.
2. **Link or create repo** - add the missing dashboard affordance on the
   workspace page when `repo` is null (link an existing installation repo via
   the same `RepoPicker`, or call the existing `create-repo` route). No new
   API.
3. **Init** - unchanged action; it becomes *one item* of the readiness report
   (merge-policy classes) rather than a separate ritual. `init` keeps working
   standalone for existing callers.
4. **Readiness report** - new (section 2). Dashboard: a card beside
   `WorkspaceHealthCard` using the same `HealthItem`-style rows. MCP:
   `manage_workspaces action=readiness`.
5. **Guided fixes** - new (section 3). Dashboard: select items, "Propose
   changes". MCP: `action=scaffold` with explicit item ids.
6. **First spec** - new (section 4). Dashboard: a short wizard. MCP:
   `action=author_spec`, driven by the onboarding skill's interview.
7. **First mission** - existing; the dashboard wizard ends by deep-linking
   `/app/missions/new?workspace=<id>` with the workspace preselected (today the
   picker is buried), and the MCP flow ends by naming `manage_missions`.

The report's `nextStep` field is what ties the path together: it is the first
unmet step, so both surfaces answer "what do I do next" from the same source.

*Rejected:* a separate "onboarding wizard" page with its own state machine.
It duplicates step state that the report already derives from the repo, and a
wizard that remembers "step 4 done" goes stale the moment someone edits a file.

### 2. Readiness report

**Decision: a sibling action, `manage_workspaces action=readiness`, not an
extension of `init`.** `init` returns a *config proposal* keyed to one apply
call (`gitConfig.policyConfig`); the readiness report is a *checklist* whose
items have heterogeneous fixes (scaffold a file, apply a config, ask the
owner). Stretching `init`'s response to carry both makes every existing
`init` caller parse a larger shape and overloads "init" with "check". The
sibling is read-only and idempotent, so it can run on every dashboard load;
`init` is a write-adjacent ritual. `readiness` calls the same detectors `init`
uses, so there is one detection implementation, not two.

#### Item schema

```ts
type ItemStatus = 'detected' | 'missing' | 'unknown';
type FixKind =
  | 'scaffold'         // a file the agent can author in a PR from a template
  | 'apply-config'     // a detected value the owner applies via the existing config PATCH
  | 'owner-decision'   // cannot be inferred; needs a choice (no automated fix)
  | 'none';            // nothing to fix (status detected)

interface ReadinessItem {
  id: ReadinessItemId;              // stable slug, see list below
  label: string;
  status: ItemStatus;               // `unknown` = could not tell (truncated tree, no GitHub access, sibling detector absent)
  importance: 'core' | 'recommended';
  evidence: Array<{ kind: 'path' | 'manifest' | 'signal' | 'absent'; paths?: string[]; note: string }>;
  fix: { kind: FixKind; summary: string; templateId?: string; configPatch?: object } | null;
  waived?: { reason: string; at: string };   // owner said "not for this repo"
}

interface ReadinessReport {
  items: ReadinessItem[];
  nextStep: 'link-repo' | 'review-policy' | 'propose-fixes' | 'author-spec' | 'first-mission' | 'done';
  skill: 'workspace-onboarding';   // what to load to drive the fixes (section 5)
  truncated: boolean;               // the git tree response was truncated
}
```

`unknown` is load-bearing: a detector that cannot see (tree truncated, repo
not reachable, optional sibling detector not yet built) must say so rather
than report `missing`, or the scaffold would propose overwriting real files.

#### Items (minimum set, ids are stable)

| id | importance | Detection (generic) | Fix when not detected |
|---|---|---|---|
| `agent-instructions` | core | any of `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursor/rules/**`, `.cursorrules` | `scaffold` (template `instructions`) |
| `spec-root` | core | `detectSpecConformanceRoots(files)` (existing candidate list) | `scaffold` (template `spec-root`: directory + `README`-style format doc) |
| `spec-format` | core | spec root exists *and* a format doc or consistent frontmatter in the existing specs | `scaffold` (template `spec-format`), else `owner-decision` when specs exist in a format we should mirror instead |
| `test-command` | core | ecosystem manifests (below) and CI `run:` lines as evidence | `owner-decision` (recorded into the instructions file in the scaffold PR) |
| `typecheck-command` | recommended | same; `n/a` ecosystems (e.g. untyped Python) report `missing` with a waivable fix, not an error | `owner-decision` |
| `build-command` | recommended | same | `owner-decision` |
| `env-manifest` | recommended | `.buildd/env.yaml` present; else a lockfile is detectable | `scaffold` (template `env-manifest`, generated from detected ecosystem) |
| `migrations-dir` | recommended | path-shaped candidates (`migrations/`, `db/migrate/`, `drizzle/`, `prisma/migrations/`, `alembic/`); absent is fine | `apply-config` (`gitConfig.specConformance.migrationsDir`), closing the gap where `resolveConformanceConfig` defaults to buildd's path |
| `merge-policy` | core | `detectAllRiskClasses(files)` yields at least one class with paths *or* `configStatus = 'admin_confirmed'` | `apply-config` (the existing `init` apply call); the **preset** is an `owner-decision`, default `balanced` |
| `release-path` | recommended | a workflow with a `workflow_dispatch` trigger whose name/file suggests release/deploy/publish (-> `workflow_dispatch`); a `release`-shaped script in a manifest (-> `script`); long-lived dev+prod branches (-> `branch_merge`); else `unknown` | `apply-config` (`releaseConfig`, per `release-handoff-workflow.md` section 5) or `scaffold` the release workflow (separate PR, section 3) |
| `visual-qa-source` | recommended | see below | `owner-decision` (which source), optionally `scaffold` the sandbox boot recipe |

`recommended` items never block the first spec or mission; `core` items drive
`nextStep`. Release is `recommended` because `releaseConfig` is off by default
and a workspace with no release path is legitimate.

**Generic detection rules.** The detectors take a bounded `manifests` map (see
purity below) and recognise ecosystems by files, never by a repo name:
`package.json` scripts (`test`, `typecheck`/`check-types`/`tsc`, `build`),
`Makefile` targets, `pyproject.toml` (pytest/ruff/mypy tool tables) and
lockfile (uv/poetry), `Cargo.toml` (`cargo test`/`cargo check`), `go.mod`
(`go test ./...`/`go vet`). The package manager comes from the lockfile table
that `env-verify.ts` already holds. A command found in both a manifest and a CI
`run:` line is reported with both as evidence; a manifest-only command is
reported as `detected` with lower confidence noted in `evidence.note`. The
detectors must not mention `bun`, Next.js, `docs/specs` or any buildd file name
except as members of a generic candidate list; a unit test (section 6) fails if
a fixture repo with none of those gets a buildd-shaped answer.

**Visual-QA source.** The report decides *which* source a workspace should
use; it does not require any. Two sources exist:

- **`sandbox`**: boot the app in the runner sandbox with a dev-auth bypass
  (`visual-qa.yml`, `scripts/qa/*`, the `visual-review` skill, the
  `visual-auditor` role gated on a browser-capable runner). Available when the
  env manifest or a manifest script yields a start command; the dev-auth
  bypass is something the *app* must provide, so its absence is an
  `owner-decision`, never a scaffold.
- **`vercel-preview`**: read the preview URL from GitHub deployment statuses
  (environment `Preview`, state `success`, `environment_url`). This is owned
  by the sibling in-flight task on Vercel previews (bb2ca69e), whose contract
  is a pure exported function from repo + GitHub signals to
  `{ previewsDetected, protectionBypassConfigured, appAuthStrategy, recommendation }`
  and a page-source setting `sandbox | vercel-preview | auto`.

The readiness item calls that function when it exists and maps
`recommendation` into the item (`vercel-preview` only when previews are
detected *and* both auth walls are addressed; otherwise `sandbox`; otherwise
`missing`). Until that function is merged the item reports `unknown` with
evidence "preview detection not available", and the build plan orders the
detector after it (soft dependency, section 6). Vercel is never required: a
workspace with no deployments, or no GitHub App deployment permission, falls
back to `sandbox` or `missing`, both valid.

**Purity and testability.** Detection is `computeReadiness(input: ReadinessInput): ReadinessReport`
in `packages/core` with no fetch, no db, no clock. `ReadinessInput` is
`{ files: string[]; manifests: Record<string, string>; deployments: DeploymentSignal[] | null; gitConfig; configStatus }`.
The IO shell (a web lib used by the route) fetches the git tree (the same call
`policy-init` makes), a **bounded** allow-list of small manifests (fixed list of
names, at most 12 files, at most 64 KB each, anything larger is skipped and the
item goes `unknown`), and the GitHub deployments list when the installation
allows it; it passes them in. Tests are fixtures: a file list plus manifest
strings in, a report out. No network mock is needed for ~all of the logic.

**Persistence: recompute, persist only owner decisions.** The report is
derived from the repo and is cheap (one tree fetch, a handful of small reads),
so it is recomputed per request and never stored; a stored report would be a
second source of truth that drifts from the repo. The only thing persisted is
what the repo cannot tell us: waivers and the scaffold PR link, in
`workspaces.gitConfig.onboarding` (`{ waived?: Record<itemId, {reason, at}>, scaffoldPr?: {number, branch}, lastSeenPolicyInitAt? }`).
`gitConfig` is jsonb, so this is a TypeScript type change in
`packages/core/db/schema.ts` with **no migration**; absent means current
behaviour.

*Rejected:* (a) extend `init` with `include: [...]` - mixes a write-adjacent
ritual with a read-only check, enlarges a shape existing callers parse;
(b) persist the report in a table - stale-by-default, needs a migration and a
refresh trigger for something recomputable; (c) run detection in the runner
(where `env-verify.ts` lives) - a web route and an interactive MCP session
have no runner, and the report must work before any worker exists.

### 3. Making the repo buildd-friendly

**An agent-authored PR from a non-default branch, scaffolded from templates,
approved by the owner twice.** Templates are real files in buildd's repo under
`packages/core/onboarding-templates/` (new), rendered by a pure
`renderOnboardingTemplate(templateId, params)` (new) using plain
`{{placeholder}}` substitution and `<!-- keep-if: <flag> -->` section markers.
They are **derived from** buildd's own files but are separate files with
explicit parameters, so a change to buildd's `CLAUDE.md` never silently changes
what a stranger's repo receives.

| Template | Derived from | Parameterised | Dropped |
|---|---|---|---|
| `instructions` (-> `CLAUDE.md`; or a one-line importing stub if only `AGENTS.md` exists) | `CLAUDE.md` | default branch, test/typecheck/build commands, spec root, design root, migrations dir (section kept only if detected), PR target, the "Issues & Friction" and "TDD / where tests live" skeleton, pointer to the consumer skill | Quick Reference, Architecture, Auth Model, Database, Missions, Roles & Teams, Credentials, Preview URLs, Related Repos, every `bun`/Turborepo/Neon/`proxy.ts` line, CI workflow names, buildd's skills index, the "this repo is public" section (kept only if the repo is public) |
| `spec-format` (-> `<specsRoot>/SPEC-FORMAT.md`) | `docs/specs/SPEC-FORMAT.md` | domain vocabulary (seeded from the workspace's top-level dirs or left to the owner), spec root path | rules 7 and 8 (symbol and route liveness) and the `check-specs.ts` references unless the owner opts into a checker (open question); the domain vocabulary of ten buildd domains |
| `design-format` (-> `<designRoot>/DESIGN-FORMAT.md`) | `docs/design/DESIGN-FORMAT.md` | design root, public-repo rule conditional | none material |
| `env-manifest` (-> `.buildd/env.yaml`) | `.buildd/env.yaml` | **generated from the detected ecosystem**, not copied: install/verify commands from the lockfile table | buildd's own entries |
| `consumer-skill` (-> `.claude/skills/buildd-mcp-consumer/SKILL.md`) | the same file | none - it is already workspace-agnostic by design | none (copied verbatim, the one template that is) |
| `visual-review` (-> `.claude/skills/visual-review/SKILL.md`, optional) | `.claude/skills/visual-review/SKILL.md` | start command, dev-auth env var name, viewports | `scripts/qa/shoot.sh` and the prod-data scrub scripts (need buildd's DB) |
| `release-workflow` (-> `.github/workflows/release.yml`, optional, own PR) | `release-handoff-workflow.md` section 5 scaffold | branch names, tag format | everything buildd-specific in `release.yml` |

Not scaffolded, deliberately: CI itself, `check-specs.ts`, the
`no-prod-data` workflow and `.githooks/pre-commit` (buildd's own gates), any
Vercel configuration. Where a command is an `owner-decision` (no detectable
test command), the template renders a clearly marked `TODO(owner)` line rather
than a guess.

**Anti-blind-copy gate.** A test renders every template against a fixture
repo that has none of buildd's layout and fails on any residue from a
denylist (`apps/web`, `bun run`, `Neon`, `proxy.ts`, `turbo`, `packages/core`,
`buildd-ai`, buildd's domain names) outside explicitly passed parameter values.

**PR granularity: at most two PRs per onboarding run.**

- **One "docs and instructions" PR** containing every selected non-CI item,
  one commit per item (`docs: add agent instructions`, `docs: add spec format`,
  `chore: add env manifest`, ...). Not one PR per item: the items reference
  each other (the instructions file names the spec root scaffolded alongside
  it), a half-merged set leaves dangling references, and six one-file PRs is
  six reviews for one decision.
- **A separate "release workflow" PR**, only if selected. It changes CI and
  deploy config, which is a different risk class (`ci_deploy_config`) and
  deserves its own review.

**Approval, twice, on both surfaces.**

1. *Select*: the owner chooses which items to propose. Dashboard: checkboxes on
   the readiness card, then "Propose changes". MCP: `action=scaffold` with
   `itemIds: [...]`; it defaults to `dryRun: true`, returning the rendered
   files and target paths without creating anything, and only `confirm: true`
   creates the task. A scaffold call that does not name item ids does nothing
   (defaults are no-ops).
2. *Merge*: the agent opens a PR; the owner reviews and merges it. Nothing is
   committed to the default branch; the task runs like any other builder task
   (`outputRequirement: pr_required`, branch from `packages/core/branch-names.ts`,
   `baseBranch` the workspace default branch under the direct strategy). The
   PR is **never auto-merged regardless of preset**: a workspace that has
   already applied the `autonomous` preset must still get a human merge for
   this PR. Implementation picks the lowest-blast-radius mechanism (see build
   task B5); the acceptance criterion is behavioural and testable.

The agent is handed the *rendered* templates as a starting point and is
instructed to verify each against the repo (the commands actually run, paths
actually exist) before committing; it adjusts, it does not paste.

*Rejected:* (a) server-side direct commit via the GitHub API - bypasses review
and is exactly the "commit to a stranger's default branch" failure; (b) a PR
per item - see above; (c) copying buildd files with find/replace - the
mission's explicit non-goal, and the denylist test exists to keep it dead;
(d) a `register_skill` or `workspaceSkills` route for instructions - those are
for role/skill delivery, not repo files, and `docs/design/buildd-mcp-consumer-skill.md`
already rejected that track for the same reason.

### 4. Guided spec authoring

**An interview that produces a draft spec in the workspace's own format, as a
PR the owner approves.** Input is the owner's product description; output is one
flat markdown file in the detected spec root.

**Format resolution.** (1) If `spec-root` is detected and contains existing
specs, the authoring agent reads one or two and mirrors their frontmatter and
headings. (2) Otherwise it uses the default from `docs/specs/SPEC-FORMAT.md`
(frontmatter `title/status/owner/last_verified/summary/domain`, then capability
statement / invariants / acceptance criteria / code surface / out of scope),
with the spec-root scaffold from section 3 landing the format doc in the same
run. The file is **flat** (`<specsRoot>/<slug>.md`) because `discoverDocs`
reads flat `*.md` only. `status: draft`, always: the derived conformance state
for a draft with no assertions is `unverified`, which does not fail CI, and
promotion to `active` needs `verified_by` tests that do not exist yet
(`SPEC-FORMAT.md` rule 9).

**Questions** (one shared list, defined once in `packages/shared`, so the
dashboard wizard and the skill cannot diverge):

| # | Question | Maps to |
|---|---|---|
| Q1 | In one or two sentences, what is this product and who uses it? | `title`, `summary` (one sentence, present tense, states what MUST hold) |
| Q2 | List the 3-7 things it must do (verbs, not features). | One spec **block** (capability) per item; first becomes the file's primary capability, the rest become additional `##` blocks |
| Q3 | For each: what must always be true, whatever the input? | **Invariants** (each a falsifiable predicate; vague answers are re-asked, "should/may" rewritten to MUST) |
| Q4 | For each: give one example that works and one that must be rejected. | **Acceptance criteria** `AC-N: GIVEN ... WHEN ... THEN ...`; the rejected example guarantees the error-path AC required by rule 3; at least 3 ACs per block |
| Q5 | Where in the repo does this live? (agent pre-fills from a scan; owner confirms) | **Code surface**; only paths that exist are kept |
| Q6 | What is explicitly not part of this? | **Out of scope** |
| Q7 | How would you know it works today? (tests, a command, a manual check) | `verified_by` when a real test path exists; otherwise left empty and the status stays `draft` |
| Q8 | Anything that must never change without you? | Feeds the `merge-policy` owner-decision (risk classes), not the spec |

**Assertions.** The conformance `assertions` frontmatter (six types, see
`docs/design/spec-conformance.md` section 1) is not asked for. The authoring
agent proposes an assertion only when an answer names something checkable that
verifiably exists (a path, a route, a test file); everything else stays prose.
A spec with no assertions is valid and reads as `unverified`; it is still
retrievable by `spec_compare` and, once merged, discoverable by `discoverDocs`.

**Approval gate.** The interview shows a rendered preview before anything is
created (MCP: `action=author_spec` with `dryRun: true` default returning the
markdown; dashboard: preview pane). `confirm: true` creates a builder task that
opens a PR with the one file. The owner reviews and merges. The spec is
`draft` until the owner promotes it. Nothing writes to the default branch.

*Rejected:* (a) generating the spec from a scan of the code (it describes what
the code does, not what the owner wants, which is the whole point of
spec-first); (b) a free-form "describe your product" box with the agent
deciding structure - that loses the falsifiable-invariant and error-path
discipline the format depends on; (c) emitting `status: active` - no guard, no
`active` (rule 9).

### 5. Packaged skill

**Decision: one new skill, `workspace-onboarding`, separate from
`buildd-mcp-consumer`.** The consumer skill is loaded by every worker on every
task and is size-constrained (about 11 KB today) by the MCP `instructions`
budget; onboarding is a one-time, owner-facing, interactive flow. Folding it
in taxes every task forever for something used once per workspace, and mixes
two audiences (a worker executing a task vs an agent guiding an owner).

- **Audience:** an agent in an interactive MCP session with an owner, or an
  agent running an onboarding task. Not every worker.
- **Size:** at most 8 KB, enforced by a test, so it stays cheap to load.
- **Load timing:** never always-on. The consumer skill gains one line pointing
  at it; `manage_workspaces action=readiness` returns `skill: 'workspace-onboarding'`
  as the thing to load; onboarding tasks created by `scaffold`/`author_spec`
  carry it in their context.
- **Contents:** the step order, the readiness item list and fix kinds, the
  two approval points, the interview questions with the mapping table, and
  the "never commit to the default branch, never require Vercel" rules.

**Distribution**, mirroring the consumer skill's tracks from
`docs/design/buildd-mcp-consumer-skill.md`:

- **Repo-committed**: `.claude/skills/workspace-onboarding/SKILL.md` in
  buildd's repo (needs `git add -f`, since `.claude/` is gitignored, and an
  index line in `CLAUDE.md`, both enforced by `scripts/skills-listed.test.ts`).
  It is *not* scaffolded into user repos: it describes setting a repo up, not
  working in one, and the user's repo gets the consumer skill instead.
- **MCP resource**: a new `buildd://workspace/onboarding` beside
  `buildd://workspace/skills` in `apps/web/src/app/api/mcp/route.ts`, read
  from the same file at request time (same reader pattern as
  `readConsumerSkillBody()`), with an `outputFileTracingIncludes` entry in
  `apps/web/next.config.mjs`. One source file, no copy.
- **Published skill (Track C)**: published under the same name by the same
  manual upload as the consumer skill; tracked as an owner action, not a build
  task.

**Drift gate.** `scripts/mcp-consumer-skill-action-drift.test.ts` (added with
PR #2142) resolves every backticked action identifier in the consumer skill
against `allActions` plus group tool names. Generalise it to loop over a list
of skill files (consumer and onboarding), so `readiness`, `scaffold` and
`author_spec` named in the onboarding skill must exist or the test fails. Add
the resource-sync assertion (resource body equals the file) that
`scripts/mcp-consumer-skill-instructions.test.ts` does for the consumer skill,
for the new resource.

*Rejected:* extending `buildd-mcp-consumer` (audience and budget, above);
registering it through `register_skill`/`workspaceSkills` (Track A, already
rejected: no repo-committed source of truth, nothing for the drift gate to
read).

### 6. Build plan

Each task is one PR. Conventional commit prefix in brackets. `pathManifest`
lists the files the task owns; tasks whose manifests overlap **must serialize**.
`packages/core/mcp-tools.ts` is the hot file: every task that adds an action to
`manage_workspaces` edits it (and the MCP tools token-budget test), so B3, B5
and B6 form a strict chain.

| Task | Depends on | pathManifest | Tests |
|---|---|---|---|
| **B1** `refactor:` extract ecosystem/lockfile detection into core | none | `packages/core/ecosystem-detect.ts` (new), `apps/runner/src/env-verify.ts`, `apps/runner/__tests__/unit/env-verify*.test.ts`, `packages/core/__tests__/ecosystem-detect.test.ts` (new) | Existing `env-verify` tests pass unchanged (behaviour-preserving); new unit tests for the table |
| **B4** `feat:` onboarding templates and pure renderer | none | `packages/core/onboarding-templates/**` (new), `packages/core/onboarding-render.ts` (new), `packages/core/__tests__/onboarding-render.test.ts` (new) | Render each template against fixtures; the denylist test (section 3); `keep-if` sections drop cleanly; unknown placeholder throws |
| **B2** `feat:` pure readiness detectors | B1 (soft: Vercel-preview task bb2ca69e) | `packages/core/workspace-readiness.ts` (new), `packages/core/readiness/**` (new), `packages/core/spec-conformance-detect.ts` (migrations-dir candidates only), `packages/core/__tests__/workspace-readiness*.test.ts` (new) | Fixture repos: node/pnpm, python/uv, rust, go, an empty repo, a buildd-shaped repo, a truncated tree -> `unknown`. Asserts no buildd-shaped output for non-buildd fixtures |
| **B3** `feat:` readiness route and `action=readiness` | B2 | `apps/web/src/app/api/workspaces/[id]/readiness/route.ts` (+ `route.test.ts`) (new), `apps/web/src/lib/workspace-readiness-io.ts` (new), `packages/core/mcp-tools.ts`, `packages/core/db/schema.ts` (`gitConfig.onboarding` type only, no migration), `packages/shared/src/types.ts` | Route tests co-located (session auth, API-key auth, 404 cross-team, truncated tree, no repo -> `nextStep: 'link-repo'`); MCP tools token-budget test |
| **B5** `feat:` `action=scaffold` (dry-run then confirm) | B3, B4 | `apps/web/src/app/api/workspaces/[id]/onboarding/scaffold/route.ts` (+ test) (new), `packages/core/mcp-tools.ts`, the merge-gate file(s) the chosen human-merge mechanism touches | Route tests: no item ids -> no-op; `dryRun` default creates nothing; `confirm` creates exactly one task with `pr_required`; with preset `autonomous` the scaffold PR is still not auto-merged |
| **B6** `feat:` interview definition and `action=author_spec` | B3, B4 | `packages/shared/src/onboarding-interview.ts` (new), `apps/web/src/app/api/workspaces/[id]/onboarding/spec/route.ts` (+ test) (new), `packages/core/mcp-tools.ts` | Mapping tests (answers -> blocks, >= 3 ACs per block, error-path AC present, no "should/may"); `dryRun` default; confirm creates one task; output file is flat under the detected spec root |
| **B7** `feat:` dashboard: readiness card, repo link affordance, spec wizard | B3, B5, B6 | `apps/web/src/app/app/(protected)/workspaces/[id]/config/ReadinessCard.tsx` (+ dom test) (new), `apps/web/src/app/app/(protected)/workspaces/[id]/page.tsx` or the config page that hosts it, `apps/web/src/app/app/(protected)/missions/new/**` (workspace preselect only) | DOM tests: rows per status, select-and-propose posts item ids, no-repo shows link affordance; visual check at phone and desktop width via the `visual-review` skill |
| **B8** `docs:` skill, MCP resource, drift gate | B3, B5, B6 (action names must exist) | `.claude/skills/workspace-onboarding/SKILL.md` (new, `git add -f`), `apps/web/src/app/api/mcp/route.ts`, `apps/web/next.config.mjs`, `CLAUDE.md` (index line), `.claude/skills/buildd-mcp-consumer/SKILL.md` (one pointer line), `scripts/mcp-consumer-skill-action-drift.test.ts`, `scripts/mcp-consumer-skill-instructions.test.ts` | Drift gate over both skills; resource body equals the file; size <= 8 KB; `skills-listed` passes |
| **B9** `docs:` promote to a spec; mark this design Implemented | B1-B8 | `docs/specs/workspace-onboarding.md` (new, `draft` until guarded), `docs/design/workspace-onboarding.md`, `docs/specs/INDEX.md` (regenerated) | `bun run specs:check` |

**Parallelism.** B1 and B4 run in parallel (disjoint files) and need nothing
else. B2 follows B1. B3 follows B2. B5 and B6 both follow B3 and B4, but both
edit `mcp-tools.ts`, so they serialize (B5 then B6, or either order, never
concurrently). B7 and B8 run in parallel after B6 (disjoint files: web UI vs
skill/resource/scripts). B9 is last. The critical path is B1 -> B2 -> B3 -> B5
-> B6 -> B7/B8 -> B9; B4 hangs off the side and must land before B5.

**Sequencing caveat.** B2's `visual-qa-source` item soft-depends on the pure
function from the Vercel-preview task (bb2ca69e). If it has not merged when B2
starts, B2 ships the item returning `unknown` ("preview detection not
available") and a follow-up one-line wire-up lands after; this does not block
the chain.

#### Acceptance criteria (checkable by an agent)

- **AC-1** `computeReadiness` given a file list and manifests with no `bun`, no `apps/`, no `docs/specs` returns no item whose evidence or fix names a buildd-specific path.
- **AC-2** A fixture Python/uv repo yields `test-command` and `build-command` answers derived from `pyproject.toml`/lockfile, not `bun run test`.
- **AC-3** A truncated git tree yields `unknown` (never `missing`) for every item that depends on absent files, and `truncated: true`.
- **AC-4** `action=readiness` on a workspace with no repo returns `nextStep: 'link-repo'` and writes nothing.
- **AC-5** `action=readiness` called twice returns the same report and performs no writes (idempotent, read-only).
- **AC-6** `action=init` output and behaviour are unchanged by this work (existing `init` tests pass unmodified).
- **AC-7** `action=scaffold` with no `itemIds` creates no task; with `itemIds` and no `confirm` creates no task and returns the rendered files.
- **AC-8** `action=scaffold confirm: true` creates exactly one builder task with `outputRequirement: pr_required`; no commit lands on the workspace's default branch.
- **AC-9** With the `autonomous` preset applied, a scaffold PR is not auto-merged.
- **AC-10** Rendering every template against a non-buildd fixture produces no denylisted string outside passed parameters.
- **AC-11** `author_spec` output is one flat file under the detected spec root (or the default when none), `status: draft`, each block has >= 3 ACs including one rejection case, and contains no "should" or "may".
- **AC-12** A generated spec passes `specs:check`-style frontmatter validation for required fields in the default format and is returned by `spec_compare` after the PR merges.
- **AC-13** The drift gate fails when `workspace-onboarding` names a backticked action that is not in `allActions`.
- **AC-14** `buildd://workspace/onboarding` returns exactly the contents of `.claude/skills/workspace-onboarding/SKILL.md`.
- **AC-15** With no Vercel deployments and no GitHub deployment permission, `visual-qa-source` resolves to `sandbox` or `missing`, never an error, and the rest of the report is unaffected.
- **AC-16** No flag, field or schema column added by this work changes behaviour for a workspace that never calls `readiness`, `scaffold` or `author_spec`.

## Open questions

1. **Scaffold a spec checker?** Rules 7/8 of the spec format (symbol and route
   liveness) depend on buildd's `scripts/check-specs.ts`, which is bun/TS and
   buildd-specific. *Lean:* no - ship the format without the liveness rules,
   and let Tier-1/2 CI scripts be a later, separately designed, per-ecosystem
   item. Shipping a bun script into a Python repo is the failure this design
   exists to avoid.
2. **`AGENTS.md` or `CLAUDE.md` as the canonical instructions file?** *Lean:*
   scaffold `CLAUDE.md` when neither exists; when only `AGENTS.md` exists,
   scaffold a one-line `CLAUDE.md` that imports it rather than duplicating
   content. Workers run Claude and Codex backends; one source avoids drift.
3. **Default merge preset for a freshly onboarded workspace.** *Lean:*
   `balanced`, but only ever proposed, never applied without the owner's
   `update`; until then auto-merge stays off.
4. **Should the first spec be required before the first mission?** *Lean:* no,
   `nextStep` recommends it but a mission can start without one; a hard gate
   would block owners who want to try a task first.
5. **Where does the human-merge guarantee for the scaffold PR live?** Options:
   tag the scaffold task/PR so the gate treats it as human-tier, or rely on
   the fact that it always touches instructions/CI files already in a
   human-tier risk class. *Lean:* the explicit tag, because depending on
   path classification is fragile for a docs-only subset. B5 confirms against
   the gate code and keeps the AC-9 behaviour either way.
6. **Does `gitConfig.onboarding` belong in `gitConfig` or a dedicated column?**
   *Lean:* `gitConfig` - small, per-workspace, no migration. Revisit only if a
   cross-workspace query needs it.
7. **Sibling contract drift.** The Vercel-preview task's function name and
   field names may change before it merges. *Lean:* B2 binds to whatever lands
   and does not guess; the `unknown` fallback makes the ordering safe.

## Non-goals

- **No buildd hardcoding.** Detectors and templates never assume bun, Next.js,
  Turborepo, Neon, `docs/specs`, or any buildd file name other than as a member
  of a generic candidate list; templates are derived, parameterised, and
  denylist-tested, not copied.
- **No automatic commit to the owner's default branch.** Every change is a PR
  from a non-default branch that an owner merges.
- **No Vercel requirement.** Vercel preview is one optional visual-QA source;
  in-sandbox boot is the fallback and "missing" is an acceptable answer.
- Not building a CI system, a spec checker, or a release pipeline for the
  user's repo; release scaffolding is an optional, separate, owner-approved PR.
- Not changing `init`, the merge-policy model, the spec-conformance assertion
  vocabulary, or the consumer skill beyond one pointer line.
- Not back-filling specs for existing code (spec-first is about what the owner
  wants built; back-filling is a different, conformance-flavoured task).
- Not migrating existing workspaces or bulk-running the report; it is on
  demand per workspace.
- Not a new agent role: onboarding work is done by the existing builder role
  (and organizer for mission planning), consistent with `spec-conformance.md`
  section 15.
