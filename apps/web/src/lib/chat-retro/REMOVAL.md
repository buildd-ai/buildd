# Removing the chat retro experiment

Chat session retros (knowledge-base: buildd/design/chat-session-retro.md) are an experiment. This
is everything it adds. Nothing else in the codebase depends on it.

The model policy reads retro verdicts for chat cells, but the dependency runs
one way: `packages/core/tier-dial-chat.ts` defines `ChatQualitySource` and
works without one, and `policy-signal.ts` here implements it. With the retro
gone (or just turned off), chat dial cells read "no quality signal": a fixed
split keeps working, the dial never shifts chat traffic, and a cell already
shifted goes back to its primary with a recorded reason on the next hourly
step. Thumbs keep reverting a shifted cell either way.

## To turn it off without removing code

- One team: `PATCH /api/teams/<teamId>/chat-retro` with `{ "lessons": false }`.
  That turns proposals off too and deletes the team's lessons. While an owner
  of the team has account dogfood on, this is refused (409) instead.
- Account dogfood, one person: set `users.chat_retro_dogfood_at` back to NULL
  for them, and remove any team they own from `CHAT_RETRO_DOGFOOD_TEAM_IDS`
  (the daily pass turns it back on for owners of those teams). Their teams keep
  lessons + proposals stored; each can then be turned off per team as above.
- Everyone: set `CHAT_RETRO_ENABLED=0` in the deployment's environment. The
  cron then returns before any query, whatever teams opted into.

## Files (delete them)

- `apps/web/src/lib/chat-retro/`: the whole directory (settings, vocab,
  skeleton, lesson, proposals, store, run, deps, policy-signal, the settings
  UI section, their tests, and this file)
- `apps/web/src/app/api/cron/chat-retro/`: the cron route and its test
- `apps/web/src/app/api/teams/[id]/chat-retro/`: the settings and lessons API
  and its test
- The visible-answer turn signal, whose only reader is the retro:
  `apps/web/src/lib/chat/turn-signal.ts`, `turn-signal-store.ts` (and tests),
  `apps/web/src/app/api/chat/[id]/turn-signal/`,
  `apps/web/src/components/chat/turn-signal-tracker.ts`, `use-turn-signal.ts`
  (and test), and `apps/web/scripts/chat-retro-visible-fixture.ts`

## Account dogfood

A person with `users.chat_retro_dogfood_at` set keeps lessons + proposals on
for every team they own, read at query time (`store.ts` `dogfoodOwnerExists`),
so a team they create later is covered with no write. It is set by:

- the owner themselves, once: `POST /api/teams/<teamId>/chat-retro` with
  `{ "accountDogfood": true }` (the "Keep on for every team I own" control in
  Settings → AI features), signed in as a team owner; or
- the daily pass, for every owner of a team in `CHAT_RETRO_DOGFOOD_TEAM_IDS`
  (`reconcileAccountDogfood`), which also writes lessons + proposals onto every
  team with such an owner so the stored value matches.

## Touch points (edit them)

- `apps/web/src/app/api/cron/tier-pools/route.ts`: the
  `chatRetroQualitySource` import and the `chatQuality` argument to
  `runDialStep` (and the matching mock + test in `route.test.ts`).
- `apps/web/src/app/api/model-tiers/cells/route.ts`: the
  `chatRetroQualitySource` import and the `{ chatQuality }` argument to
  `buildModelPolicyCells` (and the matching mock + assertion in
  `route.test.ts`). Nothing in `packages/core` changes.

- `apps/web/src/app/app/(protected)/settings/ai/page.tsx`: the
  `ChatRetroSection` import and its one JSX line.
- `apps/web/src/components/chat/ChatConversation.tsx`: the `useTurnSignal`
  call and `turnSignal.onStop()` in `onStop`.
- `apps/web/src/lib/chat/turn.ts`: `withTurnRef(...)` around the user
  message's usage (keep `userTurnUsageRouted(...)`). Rows already saved keep
  a harmless `usage.turn` object: ids, offsets and flags, no text.
- `apps/web/package.json`: the `chat-retro:visible-fixture` script.
- `cron-manifest.json`: the `"Buildd: Chat Retro"` job
  (`/api/cron/chat-retro`). Run `bun run cron:sync` after removing it, so the
  external scheduler stops calling the route.
- `packages/core/gate-slugs.ts`: `CHAT_RETRO_PROPOSAL`. Past `gate_events`
  rows keep the `chat_retro_proposal` slug; that is harmless history.
- `docs/reports/gate-audit.md`: the "Chat retro proposals" section (rows 65
  and 66). `packages/core/__tests__/gate-slug-coverage.test.ts` fails until
  the slug and its rows go together.
- `scripts/qa/scrub-pii.test.ts`: the `chat_retros` entry and `chat_retro` in
  the `teams` entry of `SAFE` (remove in the same release as the schema).
- `packages/core/db/schema.ts`: the `chatRetros` table, the `teams.chatRetro`
  column and the `users.chatRetroDogfoodAt` column.
- `knowledge-base: buildd/design/chat-session-retro.md`: set its status to withdrawn.
- Environment: `CHAT_RETRO_ENABLED` and `CHAT_RETRO_DOGFOOD_TEAM_IDS`, if set.

## The schema, in two releases

Follow `.claude/skills/schema-change/SKILL.md`. `db:migrate` runs before the
new build serves, so the old build is still reading these for the length of
the deploy:

1. Release 1: delete the files and touch points above, except `schema.ts`
   and the scrub-pii `SAFE` entries.
2. Release 2: delete `chatRetros` and `chatRetro` from `schema.ts` (and the
   `SAFE` entries), run
   `cd packages/core && bun db:generate`, and check the generated SQL is only:

```sql
DROP TABLE IF EXISTS "chat_retros" CASCADE;
ALTER TABLE "teams" DROP COLUMN IF EXISTS "chat_retro";
ALTER TABLE "users" DROP COLUMN IF EXISTS "chat_retro_dogfood_at";
```

## What stays behind, on purpose

- Proposal tasks already filed stay as ordinary tasks in each team's
  workspace (`context.origin = 'chat-retro'`). Close them by hand if wanted.
- `ai_usage` receipts with `kind = 'chat_retro'` stay: they are spend history.
