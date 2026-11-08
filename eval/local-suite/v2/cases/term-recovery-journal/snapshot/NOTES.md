# Migration log

The migration was running on a laptop that lost power. The run that was
interrupted was an earlier revision of `scripts/migrate.ts` that saved the data
file after every account instead of once per step; it died partway through
step 2. `data/accounts.backup.json` is the untouched copy taken before the
migration started. It is kept for audit and must stay exactly as it is.
