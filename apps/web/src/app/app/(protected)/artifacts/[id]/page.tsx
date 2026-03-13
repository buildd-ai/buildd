import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import MarkdownContent from '@/components/MarkdownContent';

export const dynamic = 'force-dynamic';

const TYPE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  content: { bg: 'bg-primary/10', text: 'text-primary', label: 'Content' },
  report: { bg: 'bg-status-info/10', text: 'text-status-info', label: 'Report' },
  data: { bg: 'bg-status-warning/10', text: 'text-status-warning', label: 'Data' },
  link: { bg: 'bg-status-success/10', text: 'text-status-success', label: 'Link' },
  summary: { bg: 'bg-surface-3', text: 'text-text-secondary', label: 'Summary' },
  email_draft: { bg: 'bg-primary/10', text: 'text-primary', label: 'Email Draft' },
  social_post: { bg: 'bg-primary/10', text: 'text-primary', label: 'Social Post' },
  analysis: { bg: 'bg-status-info/10', text: 'text-status-info', label: 'Analysis' },
  recommendation: { bg: 'bg-status-info/10', text: 'text-status-info', label: 'Recommendation' },
  alert: { bg: 'bg-status-warning/10', text: 'text-status-warning', label: 'Alert' },
  calendar_event: { bg: 'bg-status-success/10', text: 'text-status-success', label: 'Calendar Event' },
};

export default async function ArtifactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();

  if (!user) {
    redirect('/app/auth/signin');
  }

  const artifact = await db.query.artifacts.findFirst({
    where: eq(artifacts.id, id),
    with: {
      worker: {
        with: {
          task: {
            columns: { id: true, title: true },
          },
        },
        columns: { id: true, workspaceId: true },
      },
    },
  });

  if (!artifact) {
    notFound();
  }

  // Verify user has access to this artifact's workspace
  const wsIds = await getUserWorkspaceIds(user.id);
  const workspaceId = artifact.worker?.workspaceId || artifact.workspaceId;
  if (!workspaceId || !wsIds.includes(workspaceId)) {
    notFound();
  }

  const metadata = artifact.metadata as Record<string, unknown> | null;
  const artifactUrl = metadata?.url as string | undefined;
  const taskTitle = artifact.worker?.task?.title;
  const taskId = artifact.worker?.task?.id;
  const style = TYPE_STYLES[artifact.type] || { bg: 'bg-surface-3', text: 'text-text-secondary', label: artifact.type };
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';
  const shareUrl = artifact.shareToken ? `${baseUrl}/share/${artifact.shareToken}` : null;

  return (
    <main className="min-h-screen pt-14 px-4 pb-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Breadcrumb */}
        <Link href="/app/artifacts" className="text-sm text-text-muted hover:text-text-secondary mb-4 block">
          &larr; Artifacts
        </Link>

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <span className={`px-2.5 py-0.5 text-[11px] font-mono uppercase tracking-wider rounded ${style.bg} ${style.text}`}>
              {style.label}
            </span>
            <span className="text-sm text-text-muted">
              {new Date(artifact.createdAt).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {artifact.title || 'Untitled'}
          </h1>
          {taskId && taskTitle && (
            <Link
              href={`/app/tasks/${taskId}`}
              className="text-sm text-text-muted hover:text-text-secondary mt-1 inline-block"
            >
              Task: {taskTitle}
            </Link>
          )}
        </div>

        {/* Share link */}
        {shareUrl && (
          <div className="flex items-center gap-2 mb-6 text-sm text-text-muted">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
            <a href={shareUrl} target="_blank" rel="noopener noreferrer" className="hover:text-text-secondary break-all">
              {shareUrl}
            </a>
          </div>
        )}

        {/* Content */}
        <div className="bg-surface-2 border border-border-default rounded-[10px] p-6">
          {artifact.type === 'link' && artifactUrl && (
            <div>
              <a
                href={artifactUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary-400 hover:underline break-all"
              >
                {artifactUrl}
              </a>
              {artifact.content && (
                <p className="text-sm text-text-secondary mt-3">{artifact.content}</p>
              )}
            </div>
          )}

          {(artifact.type === 'content' || artifact.type === 'report' || artifact.type === 'summary' ||
            artifact.type === 'email_draft' || artifact.type === 'social_post' ||
            artifact.type === 'analysis' || artifact.type === 'recommendation' ||
            artifact.type === 'alert' || artifact.type === 'calendar_event') && artifact.content && (
            <MarkdownContent content={artifact.content} />
          )}

          {artifact.type === 'data' && artifact.content && (
            <pre className="overflow-x-auto text-sm font-mono text-text-secondary">
              {(() => {
                try {
                  return JSON.stringify(JSON.parse(artifact.content), null, 2);
                } catch {
                  return artifact.content;
                }
              })()}
            </pre>
          )}

          {!artifact.content && artifact.type !== 'link' && (
            <p className="text-text-muted text-sm">No content</p>
          )}
        </div>
      </div>
    </main>
  );
}
