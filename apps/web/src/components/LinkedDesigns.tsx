import { db } from '@buildd/core/db';
import DesignsSection from '@/components/DesignsSection';
import { artifactsLinkedTo } from '@/lib/artifact-links';
import { isDesignArtifact } from '@/lib/design-preview';
import { designView } from '@/lib/design-view';

/**
 * Server component: the designs linked to a mission, task or spec for this
 * viewer. A pinned link shows its revision; a link that follows shows the
 * current one. Renders nothing when there are none or the lookup fails (a page
 * must not break because its designs cannot be read).
 */
export default async function LinkedDesigns({ subjectKind, subjectId, userId }: {
  subjectKind: 'mission' | 'task' | 'spec';
  subjectId: string;
  userId: string;
}) {
  try {
    const linked = await artifactsLinkedTo(subjectKind, subjectId, { caller: { kind: 'user', userId }, relations: ['design_reference'] });
    if (!Array.isArray(linked) || linked.length === 0) return null;
    const rows = await db.query.artifacts.findMany({ where: { id: { in: linked.map((l) => l.artifactId) } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const designs = [];
    for (const l of linked) {
      const a = byId.get(l.artifactId);
      if (!a) continue;
      const metadata = (a.metadata ?? null) as Record<string, unknown> | null;
      if (!isDesignArtifact({ storageKey: a.storageKey, metadata })) continue;
      const view = await designView(
        { id: a.id, storageKey: a.storageKey, currentRevision: a.currentRevision, uploadState: a.uploadState, metadata },
        l.pinnedRevision != null ? String(l.pinnedRevision) : undefined,
      );
      designs.push({
        id: a.id,
        title: a.title || 'Design',
        view,
        downloadUrl: view.frameUrl ? `/api/artifacts/${a.id}/download` : null,
      });
    }
    return <DesignsSection designs={designs} />;
  } catch {
    return null;
  }
}
