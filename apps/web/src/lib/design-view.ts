import { getArtifactRevision } from '@/lib/artifact-revisions';
import { resolveDesignScreens, type DesignScreen } from '@/lib/design-preview';
import { generateDownloadUrl, isStorageConfigured, readObject } from '@/lib/storage';

/** A design file larger than this is framed without reading it for its screens' viewports. */
const DESIGN_SCAN_MAX_BYTES = 4 * 1024 * 1024;

export interface DesignView {
  revision: number;
  /** The signed, per-viewer storage URL for this render; null when storage cannot serve the file. */
  frameUrl: string | null;
  screens: DesignScreen[];
  /** Set when `?revision=` named a revision the artifact does not have. */
  revisionNote: string | null;
}

/**
 * What the design preview frames: the requested (or current) revision's file,
 * signed for this viewer now, plus the screens and their sizes. The file is
 * read here only as text, to find `data-viewport` on its sections, and only
 * when metadata does not state them; it never reaches the page's HTML.
 */
export async function designView(
  artifact: { id: string; storageKey: string | null; currentRevision: number; uploadState: string | null; metadata: Record<string, unknown> | null },
  requestedRevision: string | undefined,
): Promise<DesignView> {
  const current = artifact.currentRevision > 0 ? artifact.currentRevision : 1;
  let revision = current;
  let storageKey = artifact.storageKey;
  let revisionNote: string | null = null;
  if (requestedRevision !== undefined) {
    const n = Number(requestedRevision);
    if (!Number.isInteger(n) || n < 1) {
      revisionNote = `"${requestedRevision}" is not a revision; showing revision ${current}.`;
    } else if (n !== current || artifact.currentRevision > 0) {
      const row = n === current && artifact.currentRevision === 0 ? null : await getArtifactRevision(artifact.id, n);
      if (row?.storageKey) {
        revision = n;
        storageKey = row.storageKey;
      } else if (n !== current) {
        revisionNote = `This design has no revision ${n}; showing revision ${current}.`;
      }
    }
  }

  const servable = !!storageKey && isStorageConfigured() && (!artifact.uploadState || artifact.uploadState === 'ready');
  let frameUrl: string | null = null;
  let html: string | null = null;
  if (servable && storageKey) {
    try {
      frameUrl = await generateDownloadUrl(storageKey);
    } catch {
      frameUrl = null;
    }
    const stated = resolveDesignScreens(artifact.metadata, null);
    if (!stated.length || stated.some((s) => !s.viewport)) {
      try {
        html = (await readObject(storageKey, DESIGN_SCAN_MAX_BYTES))?.toString('utf8') ?? null;
      } catch {
        html = null;
      }
    }
  }
  return { revision, frameUrl, screens: resolveDesignScreens(artifact.metadata, html), revisionNote };
}
