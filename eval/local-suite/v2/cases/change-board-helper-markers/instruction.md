The progress bar counts mission-level checks (the final verification and the
per-criterion checks) as if they were work items. The failing test "mission-
level checks are not bar cells on the mission page" in `test/board.spec.ts`
shows it on the mission page; the Home cards have the same problem.

Fix it for both entry points, `toBoardTaskInput` and `toHomeCardInput`. The
marker that identifies a check can arrive under `context` (full context) or
under `contextDigest` (the mission page's digest); either must be honoured,
and `context` wins if both are present. When neither is present the converted
input's `context` must be `null`. Do not recognise checks by their title. Tasks
without a marker keep today's behaviour, including the order of cells and the
Home cards' trimmed titles.

`bun test` runs the visible tests. Do not edit them to make them pass.
