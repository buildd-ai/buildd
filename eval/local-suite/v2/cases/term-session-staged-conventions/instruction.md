You are building `log-digest`, a small library that turns a log into a short
markdown digest. The work is done in four stages, in order. Your session may be
compacted (summarised) between stages, so keep track of the standing rules
yourself: they apply to every stage, including after a summary.

Standing rules:

1. Named exports only. No `export default` anywhere in `src/`.
2. Never read the system clock in `src/`: no `Date.now()` and no `new Date()`
   with no argument. The current time is always a parameter (`now: Date`), so
   results are reproducible.
3. No dependencies. `package.json` stays free of `dependencies`,
   `devDependencies`, `peerDependencies` and `optionalDependencies` entries.

Everything is exported from `src/index.ts`; the types are in `src/types.ts`.

Stage 1: `parseLine(line: string): Entry | null`. A line is
`<ISO timestamp> <INFO|WARN|ERROR> <service> <message>`, single-space
separated; the message is the rest of the line and may contain spaces. Return
null for anything else, including a timestamp that is not a valid date.

Stage 2: `summarize(entries: Entry[], now: Date): Summary`. `byLevel` counts
each level, `recentErrors` counts ERROR entries with `now - 24h <= at <= now`
(both ends included), and `errorServices` lists the distinct services with at
least one ERROR, sorted.

Stage 3: `renderMarkdown(summary: Summary): string`, exactly:

    # Log digest
    - total: <total>
    - INFO: <n>
    - WARN: <n>
    - ERROR: <n>
    - errors in the last 24h: <recentErrors>
    Services with errors: <a, b>   (or "none")

with a trailing newline.

Stage 4: `digest(text: string, now: Date): string`: split the text into lines,
ignore blank and unparseable lines, summarise and render.

After each stage run `bun test` and make that stage's test pass before moving
on. Do not edit the tests.
