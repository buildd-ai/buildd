import { randomBytes } from 'crypto';
import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';

export function generateShareToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Public origin for share links. NEXT_PUBLIC_APP_URL wins; VERCEL_URL is the
 * per-deploy fallback. Written as a function because the naive
 * `A || B ? \`https://${B}\` : default` form yields `https://undefined` whenever
 * A is set and B is not.
 */
export function shareBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://buildd.dev';
}

export function formatStructuredOutput(
  structuredOutput?: Record<string, unknown>,
  summary?: string
): string {
  if (structuredOutput) {
    // Heartbeat format detection
    if ('status' in structuredOutput && 'checksPerformed' in structuredOutput && 'actionsPerformed' in structuredOutput) {
      const lines: string[] = [];
      lines.push(`## Status: ${structuredOutput.status}`);
      if (structuredOutput.summary) {
        lines.push('');
        lines.push(String(structuredOutput.summary));
      }
      const checks = structuredOutput.checksPerformed as string[];
      if (checks && checks.length > 0) {
        lines.push('');
        lines.push('### Checks Performed');
        for (const check of checks) {
          lines.push(`- ${check}`);
        }
      }
      const actions = structuredOutput.actionsPerformed as string[];
      if (actions && actions.length > 0) {
        lines.push('');
        lines.push('### Actions Performed');
        for (const action of actions) {
          lines.push(`- ${action}`);
        }
      }
      return lines.join('\n');
    }

    // Generic structured output: key-value sections
    const lines: string[] = [];
    for (const [key, value] of Object.entries(structuredOutput)) {
      lines.push(`### ${key}`);
      lines.push('');
      lines.push(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      lines.push('');
    }
    return lines.join('\n').trim();
  }

  if (summary) {
    return summary;
  }

  return '';
}

interface UpsertAutoArtifactParams {
  workerId: string;
  workspaceId: string;
  key: string;
  type: string;
  title: string;
  content: string | null;
  metadata: Record<string, unknown>;
}

export async function upsertAutoArtifact(params: UpsertAutoArtifactParams): Promise<void> {
  const { workerId, workspaceId, key, type, title, content, metadata } = params;

  if (!workspaceId) return;

  try {
    const existing = await db.query.artifacts.findFirst({
      where: and(
        eq(artifacts.workspaceId, workspaceId),
        eq(artifacts.key, key),
      ),
    });

    let result: any;

    if (existing) {
      // Update existing artifact, preserve shareToken
      const [updated] = await db
        .update(artifacts)
        .set({
          title,
          content: content || null,
          metadata,
          workerId,
          type,
          updatedAt: new Date(),
        })
        .where(eq(artifacts.id, existing.id))
        .returning();
      result = updated;
    } else {
      // Insert new artifact — PRIVATE, with no share token. A token is a bearer
      // credential; only an explicit Share (POST /api/artifacts/[id]/share)
      // mints one.
      const [inserted] = await db
        .insert(artifacts)
        .values({
          workerId,
          workspaceId,
          key,
          type,
          title,
          content: content || null,
          shareToken: null,
          visibility: 'private',
          metadata,
        })
        .returning();
      result = inserted;
    }

    // Fire Pusher events — never over the wire with the share credential on it.
    const { shareToken: _shareToken, ...broadcastArtifact } = (result || {}) as Record<string, unknown>;

    await triggerEvent(
      channels.worker(workerId),
      events.WORKER_PROGRESS,
      { artifact: broadcastArtifact }
    );

    await triggerEvent(
      channels.workspace(workspaceId),
      'worker:artifact',
      { artifact: broadcastArtifact }
    );
  } catch (err) {
    console.error(`[Auto-artifact] Failed to upsert artifact for worker ${workerId}:`, err);
  }
}
