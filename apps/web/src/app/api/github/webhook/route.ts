import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos, tasks, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { verifyWebhookSignature, type GitHubInstallationEvent, type GitHubIssuesEvent } from '@/lib/github';
import { dispatchNewTask } from '@/lib/task-dispatch';

export async function POST(req: NextRequest) {
  const signature = req.headers.get('x-hub-signature-256') || '';
  const event = req.headers.get('x-github-event') || '';
  const deliveryId = req.headers.get('x-github-delivery') || '';

  const payload = await req.text();

  // Verify webhook signature
  const isValid = await verifyWebhookSignature(payload, signature);
  if (!isValid) {
    console.error('Invalid webhook signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const data = JSON.parse(payload);

  console.log(`GitHub webhook: ${event} (${deliveryId})`);

  try {
    switch (event) {
      case 'installation':
        await handleInstallationEvent(data as GitHubInstallationEvent);
        break;

      case 'installation_repositories':
        await handleInstallationReposEvent(data);
        break;

      case 'issues':
        await handleIssuesEvent(data as GitHubIssuesEvent);
        break;

      case 'ping':
        console.log('GitHub webhook ping received');
        break;

      default:
        console.log(`Unhandled event: ${event}`);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`Webhook error (${event}):`, error);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

async function handleInstallationEvent(event: GitHubInstallationEvent) {
  const { action, installation } = event;

  switch (action) {
    case 'created': {
      // New installation - save to database (repos are fetched on-demand)
      await db
        .insert(githubInstallations)
        .values({
          installationId: installation.id,
          accountType: installation.account.type,
          accountLogin: installation.account.login,
          accountId: installation.account.id,
          accountAvatarUrl: installation.account.avatar_url,
          permissions: installation.permissions,
          repositorySelection: installation.repository_selection,
        })
        .onConflictDoUpdate({
          target: githubInstallations.installationId,
          set: {
            accountLogin: installation.account.login,
            accountAvatarUrl: installation.account.avatar_url,
            permissions: installation.permissions,
            repositorySelection: installation.repository_selection,
            suspendedAt: null,
            updatedAt: new Date(),
          },
        });
      break;
    }

    case 'deleted': {
      // Installation removed - delete from database (cascade will delete repos)
      await db
        .delete(githubInstallations)
        .where(eq(githubInstallations.installationId, installation.id));
      break;
    }

    case 'suspend': {
      await db
        .update(githubInstallations)
        .set({ suspendedAt: new Date(), updatedAt: new Date() })
        .where(eq(githubInstallations.installationId, installation.id));
      break;
    }

    case 'unsuspend': {
      await db
        .update(githubInstallations)
        .set({ suspendedAt: null, updatedAt: new Date() })
        .where(eq(githubInstallations.installationId, installation.id));
      break;
    }
  }
}

async function handleInstallationReposEvent(event: {
  action: 'added' | 'removed';
  installation: { id: number };
  repositories_removed?: Array<{ id: number }>;
}) {
  // Only handle removals - clean up repos that were persisted when linked to a workspace
  if (event.action === 'removed' && event.repositories_removed) {
    for (const repo of event.repositories_removed) {
      await db
        .delete(githubRepos)
        .where(eq(githubRepos.repoId, repo.id));
    }
  }
}

async function handleIssuesEvent(event: GitHubIssuesEvent) {
  if (!event.installation) {
    return; // Ignore events without installation context
  }

  const { action, issue, repository } = event;

  // Find the workspace linked to this repo by full name
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.repo, repository.full_name),
  });

  if (!workspace) {
    // No workspace linked to this repo
    return;
  }

  switch (action) {
    case 'opened': {
      // Create a new task from the issue
      const hasBuilddLabel = issue.labels.some(
        (l) => l.name.toLowerCase() === 'buildd' || l.name.toLowerCase() === 'ai'
      );

      // Only auto-create tasks for issues with 'buildd' or 'ai' label
      if (!hasBuilddLabel) {
        return;
      }

      // Check for planning mode label
      const hasPlanLabel = issue.labels.some(
        (l) => l.name.toLowerCase() === 'buildd:plan'
      );

      const mode = hasPlanLabel ? 'planning' : 'execution';

      const [newTask] = await db
        .insert(tasks)
        .values({
          workspaceId: workspace.id,
          title: issue.title,
          description: issue.body || '',
          externalId: `issue-${issue.id}`,
          externalUrl: issue.html_url,
          status: 'pending',
          mode,
          context: {
            github: {
              issueNumber: issue.number,
              issueId: issue.id,
              repoFullName: repository.full_name,
            },
          },
          // Creator tracking - GitHub webhook creates tasks without a user account
          creationSource: 'github',
          createdByAccountId: null,
          createdByWorkerId: null,
          parentTaskId: null,
        })
        .onConflictDoNothing() // Don't create duplicate tasks
        .returning();

      // Dispatch to connected workers and GitHub Actions
      if (newTask) {
        await dispatchNewTask(newTask, workspace);
      }
      break;
    }

    case 'closed': {
      // Mark task as completed if it exists
      await db
        .update(tasks)
        .set({
          status: 'completed',
          updatedAt: new Date(),
        })
        .where(eq(tasks.externalId, `issue-${issue.id}`));
      break;
    }

    case 'reopened': {
      // Re-open the task
      await db
        .update(tasks)
        .set({
          status: 'pending',
          updatedAt: new Date(),
        })
        .where(eq(tasks.externalId, `issue-${issue.id}`));
      break;
    }
  }
}
