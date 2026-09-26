/**
 * The task page's artifact rows, as the client section and the viewer read
 * them. `storageKey` is carried from its own column: upload-url stores the
 * object key there, and without it an uploaded screenshot has nothing to show.
 */
export interface TaskArtifactItem {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  storageKey: string | null;
  shareToken: string | null;
  visibility: 'private' | 'public';
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface ArtifactRow {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  storageKey?: string | null;
  shareToken: string | null;
  visibility?: string | null;
  metadata?: unknown;
  createdAt: Date | string;
}

export function toTaskArtifactItem(a: ArtifactRow): TaskArtifactItem {
  const metadata =
    a.metadata && typeof a.metadata === 'object' && !Array.isArray(a.metadata)
      ? (a.metadata as Record<string, unknown>)
      : {};
  return {
    id: a.id,
    type: a.type,
    title: a.title,
    content: a.content,
    storageKey: a.storageKey ?? null,
    shareToken: a.shareToken,
    visibility: a.visibility === 'public' ? 'public' : 'private',
    metadata,
    createdAt: typeof a.createdAt === 'string' ? a.createdAt : a.createdAt.toISOString(),
  };
}
