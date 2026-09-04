import { archiveStaleDoneMissions } from '@/lib/mission-archive';

/**
 * Best-effort: archive done missions quiet for >24h (the "Awaiting
 * review" group's TTL — see lib/mission-archive.ts).
 *
 * Failures are swallowed (logged only) and surfaced in the cron response body
 * as `{ error }` instead of throwing, so the tick still returns 200 with the
 * scheduling counters it already accumulated.
 *
 * Returns the archived mission ids, or `{ error }` when the archive failed.
 */
export async function runMissionArchive(now: Date): Promise<string[] | { error: string }> {
  try {
    return await archiveStaleDoneMissions(now);
  } catch (archiveErr) {
    const message = archiveErr instanceof Error ? archiveErr.message : String(archiveErr);
    console.warn('[Cron] mission archive failed:', message);
    return { error: message };
  }
}
