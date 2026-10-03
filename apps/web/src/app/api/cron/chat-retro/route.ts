/**
 * GET /api/cron/chat-retro
 *
 * Daily chat session retro pass (experiment; knowledge-base: buildd/design/chat-session-retro.md,
 * code in apps/web/src/lib/chat-retro/, removal in its REMOVAL.md).
 *
 * For teams that opted in (teams.chat_retro.lessons), each conversation window
 * that has gone quiet gets a deterministic pre-filter and at most one decision
 * call, and leaves a content-free lesson row. For teams that also turned on
 * proposals, the recurring patterns are filed as tasks in the team's own
 * workspace, capped per day and deduped by signature. Every team is off by
 * default; CHAT_RETRO_ENABLED=0 turns the pass off everywhere.
 *
 * Daily at the top of an hour, inside the wake window the hourly schedules
 * tick already opens. No opted-in team: one cheap query.
 *
 * `changed` = lessons written plus proposals filed or appended.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cron-run';
import { runChatRetroPass } from '@/lib/chat-retro/run';
import { productionDeps } from '@/lib/chat-retro/deps';

export const maxDuration = 120;

const CHAT_RETRO_JOB = 'chat-retro';

export async function GET(req: NextRequest) {
  return withCronRun(CHAT_RETRO_JOB, req, async report => {
    const counts = await runChatRetroPass(productionDeps(Date.now() + maxDuration * 1000));
    console.log(JSON.stringify({ event: 'chat_retro', ...counts }));
    report({
      processed: counts.windows,
      changed: counts.judged + counts.skipped + counts.failed + counts.filed + counts.appended,
      errors: counts.errors,
      result: { ...counts },
    });
    return NextResponse.json({ ok: true, ...counts });
  });
}
