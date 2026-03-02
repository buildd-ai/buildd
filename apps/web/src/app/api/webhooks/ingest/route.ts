import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { dispatchNewTask } from '@/lib/task-dispatch';

interface WebhookSourceConfig {
  webhookSecret: string;
  labelFilter: string[];
  planLabel?: string;
  callbackUrl?: string;
  callbackToken?: string;
}

interface WebhookPayload {
  issue: {
    id: string;
    title: string;
    body: string;
    state: 'open' | 'closed';
    url: string;
    labels: string[];
  };
  project: {
    id: string;
    name: string;
    repo: string | null;
  };
}

type WebhookEvent = 'issue.created' | 'issue.updated' | 'issue.closed' | 'issue.reopened';

/**
 * Verify HMAC-SHA256 signature of incoming webhook payload.
 */
async function verifySignature(payload: string, signature: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  const expected = `sha256=${hex}`;

  return signature === expected;
}

/**
 * POST /api/webhooks/ingest
 *
 * Generic webhook handler that accepts the shared issue webhook contract.
 * Mirrors the GitHub handler pattern: authenticate, resolve workspace, create/update tasks.
 *
 * Headers:
 *   x-webhook-event: issue.created | issue.updated | issue.closed | issue.reopened
 *   x-webhook-signature: sha256={hmac}
 *   authorization: Bearer bld_xxx (to identify the source/workspace)
 */
export async function POST(req: NextRequest) {
  // 1. Authenticate via Bearer token → resolve account
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const event = req.headers.get('x-webhook-event') as WebhookEvent | null;
  const signature = req.headers.get('x-webhook-signature') || '';

  if (!event) {
    return NextResponse.json({ error: 'Missing x-webhook-event header' }, { status: 400 });
  }

  const rawBody = await req.text();
  let data: WebhookPayload;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // 2. Look up workspace by project.repo
  if (!data.project?.repo) {
    return NextResponse.json({ error: 'project.repo is required' }, { status: 400 });
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.repo, data.project.repo),
  });

  if (!workspace) {
    return NextResponse.json({ error: `No workspace found for repo: ${data.project.repo}` }, { status: 404 });
  }

  // 3. Resolve webhook config from workspace
  const webhookConfig = (workspace as any).webhookConfig as WebhookSourceConfig | null;
  const config = webhookConfig || {} as WebhookSourceConfig;

  // 4. Verify HMAC signature if source has a webhook secret
  if (config.webhookSecret) {
    const isValid = await verifySignature(rawBody, signature, config.webhookSecret);
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
    }
  }

  const externalId = `webhook-${data.issue.id}`;

  try {
    switch (event) {
      case 'issue.created': {
        // Check label filter
        const labelFilter = config.labelFilter || [];
        if (labelFilter.length > 0) {
          const hasMatchingLabel = data.issue.labels.some(
            label => labelFilter.some(f => label.toLowerCase() === f.toLowerCase())
          );
          if (!hasMatchingLabel) {
            return NextResponse.json({ ok: true, skipped: 'no matching label' });
          }
        }

        const [newTask] = await db
          .insert(tasks)
          .values({
            workspaceId: workspace.id,
            title: data.issue.title,
            description: data.issue.body || '',
            externalId,
            externalUrl: data.issue.url,
            status: 'pending',
            context: {
              webhook: {
                issueId: data.issue.id,
                projectId: data.project.id,
                projectName: data.project.name,
                repo: data.project.repo,
              },
            },
            creationSource: 'webhook',
            createdByAccountId: null,
            createdByWorkerId: null,
            parentTaskId: null,
          })
          .onConflictDoNothing()
          .returning();

        if (newTask) {
          await dispatchNewTask(newTask, workspace);
        }

        return NextResponse.json({ ok: true, taskId: newTask?.id || null });
      }

      case 'issue.closed': {
        await db
          .update(tasks)
          .set({ status: 'completed', updatedAt: new Date() })
          .where(eq(tasks.externalId, externalId));

        return NextResponse.json({ ok: true });
      }

      case 'issue.reopened': {
        await db
          .update(tasks)
          .set({ status: 'pending', updatedAt: new Date() })
          .where(eq(tasks.externalId, externalId));

        return NextResponse.json({ ok: true });
      }

      case 'issue.updated': {
        // Update title/description if changed
        await db
          .update(tasks)
          .set({
            title: data.issue.title,
            description: data.issue.body || '',
            updatedAt: new Date(),
          })
          .where(eq(tasks.externalId, externalId));

        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ ok: true, skipped: `unhandled event: ${event}` });
    }
  } catch (error) {
    console.error(`Webhook ingest error (${event}):`, error);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
