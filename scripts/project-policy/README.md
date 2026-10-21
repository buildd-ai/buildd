# Local Product Language experiment

Reuse/gap inventory, written before implementation:

| Capability | Existing | Missing / choice |
| --- | --- | --- |
| Terminology | `packages/shared/src/terms.ts`, totality tests, generated `docs/design/terms.md` | Read the catalog; never copy its state mapping. |
| Copy lint | `packages/core/copy-rules.ts`, `scripts/copy-check.ts` AST and ratchet | Add conservative changed-subject extraction; current flattening of expressions to N cannot prove state. |
| Delivery review | `apps/web/src/lib/copy-review.ts`, `reviewer.ts`, `gitConfig.copyReview` | Preserve the independent PR gate. No hook installation. |
| Decisions | `packages/ai-kit/src/decide`, core decision kinds/policy/client, ledger, measurements | Optional local Jev exploration now uses the existing typed shadow adapter and scoped resolver. Default checks remain offline; production kind/ledger integration is separate. |
| Evidence | `packages/core/verification-check.ts`, Quality Scout adapters | Adapt findings to existing check results; no persistence or lifecycle. |
| Missions | `mission-sections.ts` SECTION_META, MissionGrid SectionView, delivery/start projections | Fixtures only. PR #5359 owns production caption/Next removal; do not duplicate its changes. Scheduled context is absent from the list projection and must be supplied. |

Authority: approved Product voice revision 6 (hash
`6edfd5f059cc452f9470d5157b545a422868bfb987c17d678a757161d153b980`),
R-14/R-16/R-21/R-22/R-23, and `docs/design/design-system.md` section 5.
Living Specs checking-work revision 1 requires independent evidence; tests are
not a builder's final spec verdict. Decision Kinds keeps spend, routing,
measurement and recording in the existing platform. No spec amendments here.

Plan: first failing extractor/policy/command tests, then source-located TSX
adapter + versioned policy data + local CLI, then independent rendered fixtures
using actual section sorting, focused regressions and repository checks.

The PoC deliberately does not claim complete AST data flow, universal copy
quality, automatic state understanding or production enforcement.

## Run locally

From the repository root (Bun and locked workspace dependencies required):

```sh
bun run scripts/project-policy/cli.ts --input=scripts/project-policy/negative.json
# exit 1: deterministic state mismatch and custom action rule; caption advice
bun run scripts/project-policy/cli.ts --input=scripts/project-policy/positive.json
# exit 0: deterministic recheck passed; semantic evaluation remains unsupported
bun run scripts/project-policy/cli.ts --staged --stage=commit
bun run scripts/project-policy/cli.ts --input=scripts/project-policy/negative.json --stage=agent
# advisory authoring invocation: exit 0, same structured findings
# Explicit opt-in, using OPENROUTER_API_KEY injected by your secret manager:
bun run scripts/project-policy/explore.ts --output=/absolute/path/to/jev-report.json
bun run scripts/project-policy/cli.ts --input=scripts/project-policy/negative.json --jev
# Or pass --team=<team-id> --workspace=<workspace-id> with the scoped resolver's
# existing database/encryption configuration supplied by your secret manager.
bun run scripts/run-unit-tests.ts scripts/project-policy/project-policy.test.ts scripts/project-policy/cli.test.ts scripts/project-policy/rendered.test.tsx scripts/project-policy/semantic.test.ts scripts/project-policy/explore.test.ts
bunx tsc --project scripts/project-policy/tsconfig.json --noEmit
bun run scripts/project-policy/fixtures.tsx /absolute/path/to/fixture.html
```

The CLI emits JSON with file/line/offsets, before/after, role/provenance,
policy version, reason, repair, evaluator, fingerprint, and the existing
`VerificationResult`. Exit 1 means a deterministic violation; 2 means malformed
input or execution failure. Exit 0 does **not** certify semantic quality. Nothing
installs hooks. `--stage` records an invocation mode; it does not prove a hook or
CI ran. Agent hook, pre-commit hook and CI integration remain **not integrated**.
The existing PR copyReview gate is unchanged.

Supplied JSON contains `changes: [{file, before, after, patch?, contexts?}]` and
optional `customRules`. `patch` is a per-file unified diff matching the full
new-side TSX snapshot. `--staged` reads HEAD/index blobs, never unstaged contents,
and handles renamed files as delete/add. Deletions introduce no new strings.
Context is keyed by new-side line and includes a provenance `source`; supply
`prop`, `component` or `start` to disambiguate multiple subjects on one line.
Context is a caller assertion, not automatic state discovery. Each supplied
state uses the catalog's `InternalRef`. No context means no state inference.

Policy data lives in `product-language.json`; it references the shared catalogs
instead of copying their rules. The supplied examples demonstrate a configurable
action-only workspace rule. The sort-caption heuristic is deliberately advisory,
restricted to a known section-subtitle purpose. It generalizes beyond the two
reported strings, but cannot establish semantic user value or interpret an
approved exception. `gold.json` includes redundant, useful and unclear controls;
these are development labels, not a held-out calibration or a measured threshold.

The default command makes no model calls. Explicit `--jev` and `explore.ts` use
the existing `defineDecision` adapter in **shadow** mode, pinned to the kit's
Jev model, with existing transport, retry/deadline handling and metadata receipts.
The local evaluator defaults to 20 decisions. The surface command can explicitly
raise that budget with `--max-new` (maximum 5000); retries remain bounded separately.
A supplied env API key
uses the existing offline-eval convention; otherwise explicit team/workspace args
use the shared scoped credential resolver, with platform billing fallback disabled
and database writes disabled. Credentials never enter files or reports. No alternate
provider is selected. Missing keys/provider failure remain unsupported.

Only bounded changed text, syntactic role/component/prop, relevant purpose and
resolved catalog/date/action facts reach the model. Paths, before text, diffs,
arbitrary provenance and unrelated context are excluded; unresolved, oversized and
recognizably sensitive copy abstains. Reports include actual returned model version,
confidence, latency/cost, request and prompt fingerprints, and shared-adapter receipts.
Local receipts are not database ledger rows. A production adapter still needs its own
opt-in capability and `runBuilddDecision` integration. The platform's implicit Jev
measurement behavior is insufficient calibration for a new copy question. No model
judgment, even at confidence 1, can overrule a deterministic violation or block commit.
Gold-set accuracy is development evidence; it selects no enforcement threshold.

The same development set can be explored explicitly with Cloudflare's existing
team-scoped route (no settings writes, token minting or provider fallback):

```powershell
bun scripts/project-policy/explore.ts --model=clef --team=<authorized-team-id> --workspace=<authorized-workspace-id> --output=<local-report.json>
bun scripts/project-policy/explore.ts --model=clef-flash --team=<authorized-team-id> --workspace=<authorized-workspace-id> --output=<local-report.json>
```

`--model=jev` remains the default for `explore.ts`; the copy CLI's `--jev` stays
Jev-only. Clef uses the shared Workers AI transport, including existing gateway
headers. Missing credentials abstain. Reports retain raw confidence and chosen-label
`topProbability` separately; neither has a threshold calibrated for this policy.
Clef model names are service aliases, not immutable model-version pins. Workers AI
does not return billed cost through the current adapter, so cost remains null.

## Limits and smallest next slices

### Prompt routing and shortlist experiment

`run-pattern-experiment.ts` compares the broad WWVD decision with per-string
pattern routing and batch candidate selection followed by targeted review.
`pattern-prompts.json` versions the router, candidate picker and narrow questions.
The separate 32-case corpus has provisional agent-reviewed labels; validation
examples are withheld from prompt construction for the run, but some adapt earlier
controls. It is not human gold or independent production calibration.

```powershell
bun scripts/project-policy/run-pattern-experiment.ts --team=<team-id> --workspace=<workspace-id> --output=<absolute-report.json> --surface=<absolute-surface-final.json>
```

Use `--variant=1|2|3` and `--order=source|shuffle-17|reverse` to reproduce prompt
tuning and position-sensitivity runs. V1 is the frozen first prompt; V2 tunes
mixed fact/filler routing using development failures; V3 adds data selectors so
vague-action prompts only apply to actions or known result/toast purposes. Native
component/prop context is retained for surface inputs. Pattern agreement and final
verdict precision/recall are reported separately. These variants remain experiments;
the staged CLI still uses its existing broad policy and cache.
An additional `multi` arm asks all applicable narrow pattern questions in one typed
request per string, exposing routing skips versus the cost of simultaneous checks.

The optional surface pass lets the model inspect all eligible strings in bounded
batches of32, selecting at most one per batch, then choosing a pattern and checking
the selected string. This is batch-local prioritization, not a single global rank.
Only bounded text/role/purpose/static context is sent; labels, rationale, source
paths and previous model verdicts are withheld. All calls use the existing typed
shadow adapter, current scoped credentials and local receipts. Nothing is enforced,
learned automatically or written to production. Each experiment engine caps requests
at400 with the existing timeout/retry handling; bulk work uses four workers.

### Cached surface scans and changed context

```powershell
# Full tracked web TSX inventory and deterministic checks, offline:
bun scripts/project-policy/surface.ts --policy=wwvd --output=<absolute-local-report.json>
# Initial semantic baseline, using the authorized existing route; default budget is 20:
bun scripts/project-policy/surface.ts --policy=wwvd --jev --team=<team-id> --workspace=<workspace-id> --max-new=3000 --output=<absolute-local-report.json>
# Replay cached advice with no new model decisions:
bun scripts/project-policy/surface.ts --policy=wwvd --jev --team=<team-id> --workspace=<workspace-id> --max-new=0 --output=<absolute-local-report.json>
```

The surface scan and staged CLI share a local `.git/project-policy-cache` by
default; `--cache=<directory>` overrides it. Current credential authorization is
resolved before cache use. Entries expire after 24 hours. Keys cover exact bounded
model input, full policy, prompt/engine/model identity, context schema and scoped
namespace. No credential values, source paths, whole source or copy text are stored
in cache records; local reports separately contain attributable source findings.
Only successful answers are persisted, including uncertain answers; transport and
unsupported results retry next time. Corrupt/expired records miss. Writes replace
individual content-addressed records atomically; concurrent identical requests in
one process coalesce. Historical receipts remain marked as such, while current
attempts/latency/cost are zero on replay. This is memoization, not a new evidence ledger.

Static context includes a nearest native container, preceding local heading and
up to two complete static neighboring texts. It excludes code snippets, hidden,
custom and dynamic neighbors and oversized sentences, and is always marked partial.
The complete outbound context is secret-screened. Changes to neighboring context
recheck affected unchanged strings and invalidate their cached advice. Moving a
string without changing model input does not invalidate it. Static syntax cannot
prove runtime visibility, state, route reachability or duplication across components.

The inventory separately reports unknown/dynamic subjects, parse errors and `.ts`
catalog candidates from the existing copy-check extractor. Descriptions with local
headings are prioritized. Deterministic checks run before model/cache advice. When
budget is exhausted, deferred rows remain explicit; repeat to advance through cache
hits, or use `--offset` if persistent provider failures would starve later rows.
The command does not modify production copy, install hooks or change CI policy.

`--policy=wwvd` selects the user's local enterprise-copy restraint preset in
`wwvd.json`: direct outcome/fact, a next action when needed, no dispensable
explanation or reassurance, and preserved necessary consequences/recovery steps.
It is a user instruction, not an official Vercel standard or an amended Living Spec.
Use `explore.ts --policy=wwvd --model=jev` for its separate 12-example development
set, or `cli.ts --staged --policy=wwvd --jev` for changed copy. Both support the
same scoped credential arguments as before. Default policy/gold remain unchanged.
Jev advice cannot enforce this preset yet. Existing deterministic rules still
apply, including the >30-word rule: direct exploration may find a long warning
useful while the CLI rejects it before calling the model. An approved rule change
would be needed to reconcile that conflict; this experiment does not bypass it.

- TSX only; no Vue, Svelte, MDX, translations or cross-file constant/data flow.
  The actual SECTION_META-to-MissionGrid flow is demonstrated by a render fixture,
  not resolved statically. Supplied snapshots must represent the actual edit.
- Native JSX and common visible props are extracted. Custom component contracts,
  hidden elements, rich inline sentence joining, spread props, runtime templates
  and conditional visibility need further work. Unknown dynamics/roles abstain.
  Before values pair by component/prop occurrence; reordering can make that pairing
  approximate. Locations and new-side filtering remain source based.
- Deterministic checks use current shared rules; their existing false positives
  remain possible. This is an experiment, not approved production enforcement.
- Render tests assert actual React HTML, state/date and unchanged real sort order.
  They do not certify a full browser layout or implement the production scheduled
  projection missing from the current Missions list.
- Extend existing components: retain this small adapter under scripts, then
  share strict AST subjects with copy-review/copy-check, register the production
  semantic kind/ledger path, collect independent gold labels and held-out measurements,
  and only then add explicit agent/pre-commit/CI adapters under measured policy.
  No new package, evidence store, or lifecycle is warranted yet.

Architectural references inspected: [Chock](https://github.com/open-coder-ai/chock)
(policy entry-point coverage), [Abide](https://github.com/coldteadotai/abide)
(semantic edit feedback), [Reflex](https://github.com/ursuciprian/reflex)
(rules first, model fallback/escalation). None is installed as a dependency.

The local label experiment compares the previous multi-pattern wording with
`edit / leave` and `edit / leave / need_context`, using either one question or
three narrow questions. Binary `leave` includes insufficient evidence; it is not
a quality certification. The fresh validation examples are agent-provisional,
not human gold. Prompts and cases are frozen before live calls.

```sh
bun scripts/project-policy/run-label-experiment.ts --team=<team-id> --workspace=<workspace-id> --order=shuffle-17 --output=<absolute-local-report.json>
```

Repeat with `--order=reverse` to check order sensitivity. Batch selection compares
Jev with `deepseek/deepseek-v4.1-flash` through the existing typed chat adapter.
Pools contain 16 strings to respect that adapter's option limit. DeepSeek only
selects candidates; Jev checks them. An unavailable route is reported without
provider fallback. Reports retain actual receipts, selection recall and final
findings separately. This runner does not change production defaults.

Add `--experiment=tree` to compare the existing narrow baselines with sequential
single-string trees. One stops at the first edit; the other independently checks
each suspected defect before accepting it, continuing after a rejected suspicion.
Unknown evidence is retained, and transport failures abstain immediately. Trace
nodes and receipts expose the path and call cost. These examples are now exposed;
tree results are exploratory rather than fresh validation.
