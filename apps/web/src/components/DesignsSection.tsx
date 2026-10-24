/**
 * The designs attached to a mission, task or spec, each in the sandboxed
 * viewer (DesignPreview): screen picker, true size, fit toggle. Presentational:
 * LinkedDesigns.tsx loads the views. Every frame is the signed storage URL in
 * an iframe whose sandbox omits allow-same-origin; the host page's CSP
 * (next.config.mjs, designFramingCsp) allows frames from the storage origin only.
 */
import DesignDisclosure from '@/components/DesignDisclosure';
import DesignPreview from '@/components/DesignPreview';
import type { DesignView } from '@/lib/design-view';

export interface DesignSectionItem {
  id: string;
  title: string;
  view: DesignView;
  downloadUrl: string | null;
}

export default function DesignsSection({ designs, collapsed = false }: { designs: DesignSectionItem[]; collapsed?: boolean }) {
  if (designs.length === 0) return null;
  const body = (
    <section data-testid="designs-section" aria-label="Designs" className={`min-w-0 ${collapsed ? '' : 'mt-6'}`}>
      {!collapsed && <h2 className="text-label text-text-muted mb-3">{designs.length === 1 ? 'Design' : 'Designs'}</h2>}
      <div className="flex flex-col gap-6">
        {designs.map((d) => (
          <div key={d.id} data-testid="design-item" className="min-w-0 bg-surface-2 border border-border-default p-3 md:p-4">
            {d.view.revisionNote && <p className="text-meta text-status-warning mb-3">{d.view.revisionNote}</p>}
            <DesignPreview
              artifactId={d.id}
              title={d.title}
              revision={d.view.revision}
              frameUrl={d.view.frameUrl}
              screens={d.view.screens}
              downloadUrl={d.downloadUrl}
            />
          </div>
        ))}
      </div>
    </section>
  );
  return collapsed ? <DesignDisclosure count={designs.length}>{body}</DesignDisclosure> : body;
}
