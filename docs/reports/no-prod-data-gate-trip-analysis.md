# No Production Data gate — trip analysis

Generated audit output. Rebuildable, may be stale — never a source of truth.
Source: the GitHub Actions API for the `No Production Data` workflow
(`.github/workflows/no-prod-data.yml`), every run from 2026-08-31 (its first
run ever) through 2026-09-22. 1,139 runs, 80 failures. Findings are read off
each failed job's `##[error]` lines — the check masks the matched value on
purpose (see the workflow's own comments), so this report never reproduces
one; only category, location and, for a handful of samples, the still-public
PR body they came from.

## Why this matters more than it looks

This gate is this repo's single most common source of CI red — more common
than the entire unit test suite failing. That headline number (previously
measured at ~10% of PRs) is real, but it blends two very different periods
and, within the second one, one recognizable authoring habit dominates
everything else. Both are actionable; neither is a reason to loosen
detection.

## The headline rate is mostly a four-day bring-up window, not steady state

| period | days | branches (proxy for PRs) | branches w/ ≥1 trip | branch-level rate |
|---|---|---|---|---|
| bring-up: 2026-08-31 → 09-03 | 4 | 73 | 21 | **28.8%** |
| steady state: 2026-09-04 → 09-22 | 19 | 462 | 34 | **7.4%** |
| whole window | 23 | 534 | 55 | 10.3% |

(Branch name, not PR number, is the join key — GitHub drops the
run→PR association once a PR's head branch is deleted, which is true of
almost every merged PR here. Branch-level and the platform's own PR-level
measurement agree to within 0.2 points, so this is a sound proxy.)

The bring-up window is explained by the workflow's own file header: the
identifier half of the check shipped reading a repo **variable** that was
never set, so it silently scanned nothing from day one — fixed by making an
absent `NO_PROD_DATA_IDENTIFIERS` **fail** instead of warn. For two days after
that fix landed, the secret itself hadn't been created yet, so *every* PR
failed regardless of content — 15 of the 80 failures in the whole window are
exactly this, clustered on 2026-09-01 through 09-03. The same days carried a
handful of the check's own early false positives (its regex was still being
tuned against real history — see `scripts/__tests__/check_no_prod_data_test.py`'s
docstring). Re-running today's checker against the bodies of the PRs that
tripped it back then, the population-count cases no longer reproduce: the
rule has already been narrowed since.

None of that is ongoing. It is a one-time cost of bringing the gate up,
already paid. The number to plan around is the steady-state 7.4%.

## Steady-state category distribution (branch-deduplicated, n=35 tripped)

| location | branches | share |
|---|---|---|
| PR body | 28 | 80% |
| commit message | 9 | 26% |
| added code / added source line | 7 | 20% |

(Shares don't sum to 100 — several branches tripped more than one location.)
Split the other way, the one the task asked for:

| shape | branches | share |
|---|---|---|
| prose only (PR body and/or commit message) | 28 | 80% |
| added-code only | 4 | 11% |
| both | 3 | 9% |

**Prose beats code roughly 4:1.** That's the opposite of the failure mode this
gate was originally built to catch — the script's own history notes a real
workspace id that sat in committed *code* for months before anyone scanned
added source lines for UUIDs at all. Code UUID trips still happen (7 of 35),
they're just not the dominant mode any more.

By kind, prose trips split further:

| kind | branches |
|---|---|
| UUID | ~31 |
| population count | ~7 |
| personal handle / private repo name | ~4 |

## The dominant shape: agents citing their own task by full UUID

Reading the (still-public) PR bodies behind the UUID trips, they are almost
entirely one pattern: an agent citing the buildd task, worker, mission, or
artifact id that produced the PR, as attribution or cross-reference —
`` retry task `<uuid>` ``, `` fulfills task `<uuid>` ``, `` fixes friction
task `<uuid>` ``, `` WORKSPACE_ID: <uuid> ``, `` artifact `<name>:<uuid>` ``.
This is dogfood traceability, not a customer-data leak — but a task/worker id
is a real row identifier in a production table regardless of whose task it
is, so the rule is right to catch it, and there is no safe way to special-case
"my own task" in the pattern: a citation of someone else's task id, which
*would* be a real disclosure, is textually identical.

Traced to its source (`create_pr`'s body construction in
`apps/web/src/app/api/github/pr/route.ts`, the MCP tool descriptions in
`packages/core/mcp-tools.ts`, and both workflow skills): **nothing in the
platform ever asks for this, in either the full or short form.** It is
agent-authored free text, every time. Meanwhile a short-id convention already
exists and is used everywhere else a task needs citing — branch names
(`packages/core/branch-names.ts:68`, `taskId.substring(0, 8)`), docs, log
lines, entity extraction. Branches like
`buildd/8237cfa9-investigate-5-releases-stuck-i` use exactly this form
throughout this repo's own history and have never once tripped the gate,
because an 8-hex-character prefix doesn't match the UUID pattern.

**Conclusion: this is not a rule to narrow.** The regex is doing its job —
distinguishing "a UUID that identifies a real row" from "an 8-character
prefix that doesn't" is precisely the line CLAUDE.md already draws elsewhere
(a hardcoded row count is the disclosure; a qualitative description isn't).
The fix is the authoring habit, not the pattern, and CLAUDE.md's "This Repo
Is Public" section now says so directly: cite the short id.

## Confirmed: the reported line number was wrong for code findings

Item 3 asked to confirm a previously-noted defect: the line number on an
`added source line` / `added code` finding indexed the filtered list of `+`
diff lines, not the file. Confirmed and reproduced — a UUID inserted at real
file line 50, behind 49 unchanged lines, was reported as line 1. Two hunks in
one diff compounded it further: the second hunk's first added line reported
as if it were the first added line in the whole diff.

This did not affect PR body / PR title / commit message findings — those
already enumerate the isolated text's own lines directly.

Fixed in `scripts/check_no_prod_data.py`: `diff_added_lines()` replaces
`added_source_lines()`, tracking real position from each hunk's `@@ -a,b
+c,d @@` header (`c`) and advancing it on every context or added line (a
removed line only exists on the old side and doesn't move it). The identifier
scan, which previously reported no file at all — just an index into every
added line across the whole diff — now carries the same real path and line
number the UUID scan does. Both are pinned by new tests in
`scripts/__tests__/check_no_prod_data_test.py`
(`line_number_accuracy_failures`, plus the existing `added_source_uuid_
failures` updated for the new 3-tuple shape).

## What was NOT done, and why

- **No rule was narrowed.** The one clear over-matching candidate — UUID
  citations of the PR's own task — has no safe narrower pattern (see above).
  Every other category (population count, personal handle) is rare enough in
  steady state, and mostly resolves to genuine catches on inspection (e.g. a
  PR body citing a real measured production figure, subsequently reworded to
  qualitative language after the check fired — the intended workflow), that
  there's no over-matching case to make.
- **The identifier/handle half still cannot be verified locally.** That's by
  design — `NO_PROD_DATA_IDENTIFIERS` is a secret specifically so it never
  sits in a workstation env or a log. The local runner (below) says so
  explicitly rather than reporting a false green.

## What was done: a local path that reproduces the CI verdict

`scripts/check-no-prod-data-local.sh` (wired to `bun run no-prod-data:check`,
and into `.githooks/pre-commit` for the code/commit-message half of whatever
is already committed on the branch) runs the exact same
`scripts/check_no_prod_data.py` CI uses, against `origin/dev`. It:

- Runs the count/UUID rules exactly as CI does — no secret needed.
- Explicitly warns and skips the identifier/handle scan when
  `NO_PROD_DATA_IDENTIFIERS` isn't set (the normal case locally), instead of
  either faking a pass or failing every run over something a workstation can
  never have. CI sets neither this behavior nor the `NO_PROD_DATA_LOCAL` flag
  that enables it, so CI's fail-closed guarantee on a missing secret is
  unchanged.
- Fails open (skips, doesn't block) if `origin/dev` can't be resolved or
  fetched — an offline or partial checkout must not turn into a blocked
  commit.

It does not check the PR title/body, since those don't exist yet at commit
time on most commits. Run it explicitly with `--body`/`--title` right before
opening the PR to cover that half too.
