# Local suite v2: cases

`cases/<id>/` is one case (layout and rules: `docs/specs/coding-eval-playground.md`).
`splits.json` says which cases are `dev` (open here) and which are `sealedHoldout`
(descriptor and hash only; the content is not in this repository).

Cases here: find-by-behaviour, causal-debugging and multi-file-change, three open
cases each (a fourth per category is sealed), and code-review, long-context-requirements
and terminal-recovery-compaction, four open cases each. Nothing here has been run
against a model.

How the newer categories are laid out:

- **code-review** (`review-*`): `snapshot/change.diff` plus the post-change tree. The
  agent writes `review.json`. Seeded defects have a file, line range and word groups
  naming the cause; `review-clean-extract-helper` is a clean control where any finding is
  a false positive. `review-calibration/calibration.json` holds known-answer probes that
  pin the deterministic grader; model-grader and person agreement is not recorded yet.
- **long-context-requirements** (`ctx-*`): `snapshot/evidence/needles.json` is the
  numbered requirements and `filler.md` the surrounding notes. The harness builds the
  8K, 16K and 32K evidence with `buildEvidence` (same filler at every size, needles at a
  recorded start, middle, end or dispersed position) and either puts it in the prompt
  or writes `evidence/context-<size>.md` for the tool-retrieval track. The agent writes
  `answer.json`.
- **terminal-recovery-compaction** (`term-*`): standing rules and stages in the
  instruction. The hidden verifier checks the rules and the stage tests; `STAGE=<n>`
  checks one stage (a harness calls it after each stage, including after compaction)
  and a JSON vector is printed for `gradeCompaction`.

Case directories under a fixture are named so that no `.gitignore` rule hides them
(for example `out/`, not `dist/`).

Editing a case changes its hash. After an edit:

```
bun scripts/local-eval/v2-seal.ts          # re-pin hashes and suite.json
bun scripts/local-eval/cli.ts validate --suite v2
bun scripts/local-eval/cli.ts admit --suite v2 --write   # rewrites evidence in admission/
```

Bump `version` in `case.json` when the edit is meant to supersede an admitted case.
Never edit a sealed-holdout case after hashing; rotate it into dev under a new version instead.

Case fixtures keep their own tests as `*.spec.ts`, so the repository unit-test collector
does not pick them up as repository tests.
