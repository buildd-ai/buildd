import { db as _db } from '@buildd/core/db';
import { releases, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';

type DB = typeof _db;

const MAX_ATTEMPTS = 5;
const PROBE_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 15_000;

// Injectable for tests — do not use in production code.
let sleeper = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export function _setSleeper(fn: (ms: number) => Promise<void>): void {
  sleeper = fn;
}

export async function verifyReleaseDeployment(releaseId: string, db: DB): Promise<void> {
  const [release] = await db
    .select({
      id: releases.id,
      state: releases.state,
      verificationStrategy: releases.verificationStrategy,
      workspaceId: releases.workspaceId,
    })
    .from(releases)
    .where(eq(releases.id, releaseId))
    .limit(1);

  if (!release || release.state !== 'deploying') return;
  if (release.verificationStrategy !== 'http') return;

  const [ws] = await db
    .select({ releaseConfig: workspaces.releaseConfig })
    .from(workspaces)
    .where(eq(workspaces.id, release.workspaceId))
    .limit(1);

  const verificationUrl = ws?.releaseConfig?.verificationUrl;
  if (!verificationUrl) return;

  let success = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleeper(RETRY_DELAY_MS);
    }
    try {
      const res = await fetch(verificationUrl, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.ok) {
        success = true;
        break;
      }
    } catch {
      // Network error or timeout — retry
    }
  }

  if (success) {
    await db
      .update(releases)
      .set({ state: 'healthy', healthyAt: new Date() })
      .where(eq(releases.id, releaseId));
    await triggerEvent(channels.workspace(release.workspaceId), events.RELEASE_UPDATED, {
      releaseId,
      state: 'healthy',
    });
  } else {
    await db
      .update(releases)
      .set({ state: 'failed', failureReason: 'verificationUrl did not respond 2xx after 5 attempts' })
      .where(eq(releases.id, releaseId));
    await triggerEvent(channels.workspace(release.workspaceId), events.RELEASE_UPDATED, {
      releaseId,
      state: 'failed',
    });
  }
}
