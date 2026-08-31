import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import MarkdownContent from '@/components/MarkdownContent';
import AiFeedback from '@/components/AiFeedback';
import { buildCreateTaskUrl } from '@/components/artifact-helpers';
import ArtifactShareControl from '@/components/ArtifactShareControl';
import { ARTIFACT_TYPE_LABELS, isArtifactType, type ArtifactTypeValue } from '@buildd/shared';

export const dynamic = 'force-dynamic';

/**
 * Colour tokens only. Labels come from ARTIFACT_TYPE_LABELS in @buildd/shared so
 * this file cannot drift into a second vocabulary — it used to render labels for
 * four types no writer accepted, and none for the five it never listed.
 */
const TYPE_COLORS: Partial<Record<ArtifactTypeValue, { bg: string; text: string }>> = {
  content: { bg: 'bg-primary/10', text: 'text-primary' },
  report: { bg: 'bg-status-info/10', text: 'text-status-info' },
  data: { bg: 'bg-status-warning/10', text: 'text-status-warning' },
  link: { bg: 'bg-status-success/10', text: 'text-status-success' },
  summary: { bg: 'bg-surface-3', text: 'text-text-secondary' },
  email_draft: { bg: 'bg-primary/10', text: 'text-primary' },
  social_post: { bg: 'bg-primary/10', text: 'text-primary' },
  analysis: { bg: 'bg-status-info/10', text: 'text-status-info' },
  recommendation: { bg: 'bg-status-info/10', text: 'text-status-info' },
  alert: { bg: 'bg-status-warning/10', text: 'text-status-warning' },
  calendar_event: { bg: 'bg-status-success/10', text: 'text-status-success' },
  file: { bg: 'bg-surface-3', text: 'text-text-secondary' },
};

const DEFAULT_TYPE_COLOR = { bg: 'bg-surface-3', text: 'text-text-secondary' };

/**
 * Types whose `content` is NOT markdown prose. Expressed as the exclusion set so
 * a type added to the vocabulary renders its content by default instead of
 * silently showing nothing — the failure mode of the old inclusion list, which
 * omitted impl_plan / walkthrough / diff / screenshot / recording.
 */
const NON_PROSE_TYPES = new Set<string>(['data', 'diff', 'link', 'file', 'screenshot', 'recording']);

const isProse = (type: string) => !NON_PROSE_TYPES.has(type);

function typeStyle(type: string): { bg: string; text: string; label: string } {
  const color = TYPE_COLORS[type as ArtifactTypeValue] ?? DEFAULT_TYPE_COLOR;
  const label = isArtifactType(type) ? ARTIFACT_TYPE_LABELS[type] : type;
  return { ...color, label };
}

export default async function ArtifactDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; taskId?: string; missionId?: string }>;
}) {
  const { id } = await params;
  const { from, taskId: fromTaskId, missionId: fromMissionId } = await searchParams;
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
  const fileMimeType = metadata?.mimeType as string | undefined;
  const fileName = metadata?.filename as string | undefined;
  const fileSizeBytes = metadata?.sizeBytes as number | undefined;
  const isImage = artifact.storageKey && fileMimeType?.startsWith('image/');
  const isFile = artifact.storageKey && !isImage;
  const downloadUrl = artifact.storageKey
    ? `/api/artifacts/${artifact.id}/download`
    : undefined;
  const taskTitle = artifact.worker?.task?.title;
  const taskId = artifact.worker?.task?.id;
  const style = typeStyle(artifact.type);
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';

  return (
    <main className="min-h-screen pt-14 px-4 pb-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Breadcrumb */}
        {from === 'task' && fromTaskId ? (
          <Link href={`/app/tasks/${fromTaskId}`} className="text-sm text-text-muted hover:text-text-secondary mb-4 block">
            &larr; Back
          </Link>
        ) : from === 'mission' && fromMissionId ? (
          <Link href={`/app/missions/${fromMissionId}`} className="text-sm text-text-muted hover:text-text-secondary mb-4 block">
            &larr; Back
          </Link>
        ) : (
          <Link href="/app/artifacts" className="text-sm text-text-muted hover:text-text-secondary mb-4 block">
            &larr; Artifacts
          </Link>
        )}

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-3">
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
            <Link
              href={buildCreateTaskUrl({ id: artifact.id, title: artifact.title, content: artifact.content })}
              data-testid="create-task-from-artifact"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-3 border border-border-default rounded hover:bg-surface-4 text-text-secondary transition-colors whitespace-nowrap"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create Task
            </Link>
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

        {/* Share control (gated: private → Share, public → copy/unshare) */}
        <ArtifactShareControl
          artifactId={artifact.id}
          baseUrl={baseUrl}
          initialVisibility={(artifact.visibility as 'private' | 'public') ?? 'private'}
          initialShareToken={artifact.shareToken}
        />

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

          {isProse(artifact.type) && artifact.content && (
            <MarkdownContent content={artifact.content} />
          )}

          {(artifact.type === 'data' || artifact.type === 'diff') && artifact.content && (
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

          {isImage && downloadUrl && (
            <div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={downloadUrl}
                alt={artifact.title || fileName || 'Image'}
                className="max-w-full rounded-lg"
              />
              {artifact.content && (
                <div className="mt-4">
                  <MarkdownContent content={artifact.content} />
                </div>
              )}
            </div>
          )}

          {isFile && downloadUrl && (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{fileName || 'File'}</p>
                {fileSizeBytes && (
                  <p className="text-xs text-text-muted mt-1">
                    {fileSizeBytes < 1024 * 1024
                      ? `${(fileSizeBytes / 1024).toFixed(1)} KB`
                      : `${(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB`}
                  </p>
                )}
              </div>
              <a
                href={downloadUrl}
                className="px-4 py-2 bg-surface-3 hover:bg-surface-4 text-sm rounded-md transition-colors"
              >
                Download
              </a>
            </div>
          )}

          {!artifact.content && !artifact.storageKey && artifact.type !== 'link' && (
            <p className="text-text-muted text-sm">No content</p>
          )}

          {/* Feedback */}
          <div className="mt-4 pt-3 border-t border-border-default/50 flex justify-end">
            <AiFeedback entityType="artifact" entityId={artifact.id} />
          </div>
        </div>
      </div>
    </main>
  );
}
