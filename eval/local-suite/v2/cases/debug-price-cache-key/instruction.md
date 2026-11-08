A EUR customer was shown a USD amount. The failing test "currency is
honoured after a cached lookup" in `test/price.spec.ts` reproduces it:
`bun test` fails on it.

Find the cause and fix it at its source. Keep `price` and `stats.loads`
(from `src/catalog.ts`) working as they do now, and keep the memoization:
repeated calls must not hit the catalog again every time.

Do not edit the tests to make them pass.
