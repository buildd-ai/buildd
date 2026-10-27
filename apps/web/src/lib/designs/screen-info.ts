import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { isDesignScreenKind, isRepoPath, type DesignScreenInfo } from '@buildd/shared';

/**
 * A design artifact's screens with their kind and code (R-14), from its
 * metadata. Recorded for the current file only, so an older pinned revision
 * reads none here and design-capture falls back to the file's `data-kind`.
 */
export async function loadDesignScreenInfo(design: { artifactId: string; revision?: number }): Promise<DesignScreenInfo[]> {
  const [row] = await db.select({ metadata: artifacts.metadata, currentRevision: artifacts.currentRevision })
    .from(artifacts).where(eq(artifacts.id, design.artifactId)).limit(1);
  if (!row || (design.revision && design.revision !== row.currentRevision)) return [];
  const screens = (row.metadata as { screens?: unknown } | null)?.screens;
  if (!Array.isArray(screens)) return [];
  return screens.flatMap((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.viewport !== 'string') return [];
    return [{
      id: o.id, name: o.name, viewport: o.viewport,
      ...(isDesignScreenKind(o.kind) ? { kind: o.kind } : {}), ...(isRepoPath(o.code) ? { code: o.code } : {}),
    }];
  });
}
