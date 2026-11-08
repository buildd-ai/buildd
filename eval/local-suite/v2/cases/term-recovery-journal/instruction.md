`scripts/migrate.ts` migrates `data/accounts.json` to schema 3, but a run was
interrupted (see `NOTES.md`) and the repository is in a half-migrated state.

Finish the migration so that:

1. `data/accounts.json` is fully migrated (schema 3, every account split into
   `firstName`/`lastName` with `balanceCents` in integer cents), with every
   account kept and every balance converted exactly once;
2. `.migrate/journal.json` records each of steps 1, 2 and 3 exactly once;
3. running `bun scripts/migrate.ts` again, once the data is migrated, changes
   nothing and exits 0, so that a repeat of this interruption is harmless;
4. `data/accounts.backup.json` is left exactly as it is.

Do not edit the tests. `bun test` runs the visible checks.
