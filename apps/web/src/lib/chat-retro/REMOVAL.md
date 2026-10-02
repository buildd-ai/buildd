# Removing the chat retro experiment

Chat session retros (knowledge-base: buildd/design/chat-session-retro.md) are an experiment. This
is everything it adds. Nothing else in the codebase depends on it.

## To turn it off without removing code

- One team: `PATCH /api/teams/<teamId>/chat-retro` with `{ "lessons": false }`.
  That turns proposals off too and deletes the team's lessons.
- Everyone: set `CHAT_RETRO_ENABLED=0` in the deployment's environment. The
  cron then returns before any query, whatever teams opted into.

## Files (delete them)

- `apps/web/src/lib/chat-retro/`: the whole directory (settings, vocab,
  skeleton, lesson, proposals, store, run, deps, the settings UI section, their
  tests, and this file)
- `apps/web/src/app/api/cron/chat-retro/`: the cron route and its test
- `apps/web/src/app/api/teams/[id]/chat-retro/`: the settings and lessons API
  and its test

## Touch points (edit them)

- `apps/web/src/app/app/(protected)/settings/ai/page.tsx`: the
  `ChatRetroSection` import and its one JSX line.
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
- `packages/core/db/schema.ts`: the `chatRetros` table and the `teams.chatRetro`
  column.
- `knowledge-base: buildd/design/chat-session-retro.md`: set its status to withdrawn.
- Environment: `CHAT_RETRO_ENABLED`, if it was set.

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
```

## What stays behind, on purpose

- Proposal tasks already filed stay as ordinary tasks in each team's
  workspace (`context.origin = 'chat-retro'`). Close them by hand if wanted.
- `ai_usage` receipts with `kind = 'chat_retro'` stay: they are spend history.
