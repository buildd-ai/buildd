An incident was opened for failures that have nothing in common except that
none of them carried an error message. The failing test "unrelated
messageless failures are not one incident" in `test/patterns.spec.ts` is the
repro: `bun test` fails on it.

Find the cause and fix it so that failures with no error text are not
treated as "the same failure" merely because the text is missing, without
breaking what the other tests and the rest of the module already do. Messageless
failures that do share something real must still be able to form an incident.

Do not edit the tests to make them pass.
