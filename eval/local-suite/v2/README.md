# Local suite v2: cases

`cases/<id>/` is one case (layout and rules: `docs/specs/coding-eval-playground.md`).
`splits.json` says which cases are `dev` (open here) and which are `sealedHoldout`
(descriptor and hash only; the content is not in this repository).

Cases here: find-by-behaviour, causal-debugging and multi-file-change, three open
cases each (a fourth per category is sealed). Nothing here has been run against a model.

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
