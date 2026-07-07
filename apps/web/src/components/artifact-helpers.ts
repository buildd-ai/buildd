/**
 * Pure helper functions for artifact display logic.
 * Extracted from ArtifactList component for testability.
 */

export interface ArtifactPreviewInput {
  type: string;
  content: string | null;
  storageKey?: string | null;
  metadata: Record<string, unknown>;
}

export interface ArtifactTaskUrlInput {
  id: string;
  title: string | null;
  content: string | null;
}

/**
 * Build the URL for creating a task pre-filled from an artifact.
 * Links to /app/tasks/new with title, description, artifactId, and artifactTitle params.
 */
export function buildCreateTaskUrl(artifact: ArtifactTaskUrlInput): string {
  const title = encodeURIComponent(`Implement: ${artifact.title || 'Untitled'}`);
  const artifactTitle = encodeURIComponent(artifact.title || 'Untitled');
  const preview = artifact.content
    ? artifact.content.slice(0, 500) + (artifact.content.length > 500 ? '...' : '')
    : '';
  const description = encodeURIComponent(
    `Based on artifact "${artifact.title || 'Untitled'}":\n\n${preview}`
  );
  return `/app/tasks/new?title=${title}&artifactId=${artifact.id}&artifactTitle=${artifactTitle}&description=${description}`;
}

/**
 * Generate a preview string for an artifact.
 * - Link artifacts: return URL from metadata
 * - Data artifacts: pretty-print JSON, truncated to 300 chars
 * - Content/report/summary: return raw content truncated to 500 chars
 */
export function getArtifactPreview(artifact: ArtifactPreviewInput): string | null {
  if (artifact.type === 'link') {
    return (artifact.metadata?.url as string) || null;
  }
  if (artifact.storageKey) {
    const filename = artifact.metadata?.filename as string | undefined;
    const sizeBytes = artifact.metadata?.sizeBytes as number | undefined;
    const size = sizeBytes
      ? sizeBytes < 1024 * 1024
        ? `${(sizeBytes / 1024).toFixed(1)} KB`
        : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
      : null;
    return [filename, size].filter(Boolean).join(' — ') || 'File';
  }
  if (!artifact.content) return null;
  if (artifact.type === 'data') {
    try {
      return JSON.stringify(JSON.parse(artifact.content), null, 2).slice(0, 300);
    } catch {
      return artifact.content.slice(0, 300);
    }
  }
  return artifact.content.slice(0, 500);
}
