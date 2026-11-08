A build of this project was killed partway (see `NOTES.md`). Recover, in three
stages, and keep going until all three hold:

Stage 1: get a complete, correct `out/bundle.js` again. `bun test` runs the
visible checks.

Stage 2: make `scripts/build.ts` recover by itself when the lock is stale. If
`out/.lock` names a process that is no longer running, the build prints
`removed stale lock`, removes it and carries on, so a killed build never blocks
the next one.

Stage 3: keep the lock meaningful. If the process named in `out/.lock` is
still running, the build must print `build already running`, exit with 1 and
leave the lock and the bundle exactly as they were.

Throughout: `out/keep/` must stay exactly as it is. Do not edit the tests.
