import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import MarkdownContent from '@/components/MarkdownContent';

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const artifact = await db.query.artifacts.findFirst({
    where: eq(artifacts.shareToken, token),
    with: {
      worker: {
        with: {
          task: {
            columns: { id: true, title: true, status: true, createdAt: true },
          },
        },
        columns: { id: true, name: true },
      },
    },
  });

  if (!artifact) {
    notFound();
  }

  const taskTitle = artifact.worker?.task?.title;
  const metadata = artifact.metadata as Record<string, unknown> | null;
  const artifactUrl = metadata?.url as string | undefined;

  const TYPE_LABELS: Record<string, string> = {
    content: 'Content',
    report: 'Report',
    data: 'Data',
    link: 'Link',
    summary: 'Summary',
    file: 'File',
  };

  const fileMimeType = metadata?.mimeType as string | undefined;
  const fileName = metadata?.filename as string | undefined;
  const fileSizeBytes = metadata?.sizeBytes as number | undefined;
  const isImage = artifact.storageKey && fileMimeType?.startsWith('image/');
  const isFile = artifact.storageKey && !isImage;
  const downloadUrl = artifact.storageKey
    ? `/api/artifacts/${artifact.id}/download?token=${artifact.shareToken}`
    : undefined;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5]">
      {/* Header */}
      <header className="border-b border-[#222] px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <a href="https://buildd.dev" className="text-sm font-semibold tracking-tight text-[#888] hover:text-white">
            buildd
          </a>
          <span className="text-xs text-[#555]">
            {TYPE_LABELS[artifact.type] || artifact.type}
          </span>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-6 py-10">
        {/* Title */}
        <h1 className="text-2xl font-semibold tracking-tight mb-2">
          {artifact.title}
        </h1>
        {taskTitle && (
          <p className="text-sm text-[#888] mb-8">
            Task: {taskTitle}
          </p>
        )}

        {/* Artifact body */}
        {artifact.type === 'link' && artifactUrl && (
          <div className="p-6 bg-[#111] border border-[#222] rounded-lg mb-8">
            <a
              href={artifactUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-400 hover:underline break-all"
            >
              {artifactUrl}
            </a>
            {artifact.content && (
              <p className="text-sm text-[#888] mt-3">{artifact.content}</p>
            )}
          </div>
        )}

        {(artifact.type === 'content' || artifact.type === 'report' || artifact.type === 'summary') && artifact.content && (
          <div className="p-6 bg-[#111] border border-[#222] rounded-lg mb-8">
            <MarkdownContent content={artifact.content} />
          </div>
        )}

        {artifact.type === 'data' && artifact.content && (
          <div className="mb-8">
            <pre className="p-6 bg-[#111] border border-[#222] rounded-lg overflow-x-auto text-sm font-mono text-[#ccc]">
              {(() => {
                try {
                  return JSON.stringify(JSON.parse(artifact.content), null, 2);
                } catch {
                  return artifact.content;
                }
              })()}
            </pre>
          </div>
        )}

        {isImage && downloadUrl && (
          <div className="mb-8">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={downloadUrl}
              alt={artifact.title || fileName || 'Image'}
              className="max-w-full rounded-lg border border-[#222]"
            />
            {artifact.content && (
              <div className="mt-4 p-6 bg-[#111] border border-[#222] rounded-lg">
                <MarkdownContent content={artifact.content} />
              </div>
            )}
          </div>
        )}

        {isFile && downloadUrl && (
          <div className="p-6 bg-[#111] border border-[#222] rounded-lg mb-8 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{fileName || 'File'}</p>
              {fileSizeBytes && (
                <p className="text-xs text-[#888] mt-1">
                  {fileSizeBytes < 1024 * 1024
                    ? `${(fileSizeBytes / 1024).toFixed(1)} KB`
                    : `${(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB`}
                </p>
              )}
            </div>
            <a
              href={downloadUrl}
              className="px-4 py-2 bg-[#222] hover:bg-[#333] text-sm rounded-md transition-colors"
            >
              Download
            </a>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-[#222] px-6 py-6 mt-12">
        <div className="max-w-4xl mx-auto flex items-center justify-between text-xs text-[#555]">
          <span>
            Created {new Date(artifact.createdAt).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </span>
          <a href="https://buildd.dev" className="hover:text-[#888]">
            Created via buildd.dev
          </a>
        </div>
      </footer>
    </div>
  );
}
