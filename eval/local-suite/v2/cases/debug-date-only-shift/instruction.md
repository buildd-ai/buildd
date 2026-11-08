A user reported that exported payloads still contain real calendar dates.
The failing test in `test/sanitize.spec.ts` ("date-only values do not
survive") is the repro: `bun test` fails on it.

Find the cause and fix it so that no absolute date leaks through
`sanitizePayload`, whichever form the date takes (date only, date and time
with no zone, or with a zone). Keep the existing behaviour of full
timestamps. A shifted date must keep its distance in whole days from the
day the delivery started, and the delivery's own day must always map to
2000-01-01, whatever time of day it was created.

Do not edit the tests to make them pass; do not rename exported functions.
