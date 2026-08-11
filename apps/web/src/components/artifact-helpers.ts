/**
 * Pure helper functions for artifact display logic.
 * Extracted from ArtifactList component for testability.
 */

/**
 * Strips markdown formatting and truncates to 160 chars at a word boundary,
 * for use in collapsed artifact card previews (mobile, 2-line display).
 * Returns null for null/empty input. Never throws.
 */
export function getArtifactCollapsedPreview(content: string | null | undefined): string | null {
  if (!content) return null;
  try {
    let s = content.trim();
    // Remove ATX heading markers (keep heading text)
    s = s.replace(/^#{1,6}\s+/gm, '');
    // Remove setext heading underlines (lines of only = or -)
    s = s.replace(/^[=\-]+\s*$/gm, '');
    // Strip bold/italic markers
    s = s.replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, '$1');
    // Strip code fence delimiter lines
    s = s.replace(/^```[^\n]*$/gm, '').replace(/^~~~[^\n]*$/gm, '');
    // Strip inline code backticks
    s = s.replace(/`([^`]+)`/g, '$1');
    // Strip list markers
    s = s.replace(/^[-*+]\s+/gm, '').replace(/^\d+\.\s+/gm, '');
    // Collapse multiple blank lines
    s = s.replace(/\n{3,}/g, '\n\n');
    // Collapse to single space-separated string of words
    const words = s.split(/\s+/).filter(Boolean);
    s = words.join(' ');
    if (!s) return null;
    if (s.length <= 160) return s;
    const truncated = s.slice(0, 160);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + '…';
  } catch {
    return content.slice(0, 160);
  }
}

function normalizeForDedupeCompare(s: string): string {
  return s.trim().replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Returns true if a summary-type artifact's content is effectively a duplicate
 * of the task result.summary (equal, or one is a substring of the other).
 */
export function isSummaryDuplicate(artifactContent: string | null | undefined, resultSummary: string | null | undefined): boolean {
  if (!artifactContent || !resultSummary) return false;
  const a = normalizeForDedupeCompare(artifactContent);
  const b = normalizeForDedupeCompare(resultSummary);
  return a === b || b.includes(a) || a.includes(b);
}

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
