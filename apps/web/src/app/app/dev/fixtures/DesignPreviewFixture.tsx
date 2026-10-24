'use client';

/**
 * `?state=design-preview`: the artifact page's design preview
 * (components/DesignPreview.tsx) around the sample design served by
 * ./design/route.ts, as the real page frames an uploaded design. Visual QA's
 * prod clone cannot reach file storage, so this is where the chrome is
 * reviewed: label, screen picker, Fit / 100%, download, and the frame scaled
 * to the column at phone and desktop widths, in both themes.
 *
 *   ?state=design-preview                      opens the desktop mission screen
 *   ?state=design-preview&screen=phone-mission  opens that screen (the page's ?screen= deep link)
 *
 * Below it: the same preview when storage cannot serve the file.
 */
import { useEffect, useState } from 'react';
import DesignPreview from '@/components/DesignPreview';
import type { DesignScreen } from '@/lib/design-preview';

export const DESIGN_PREVIEW_FIXTURE_SCREENS: DesignScreen[] = [
  { id: 'phone-mission', name: 'Mission (phone)', viewport: { width: 390, height: 844 } },
  { id: 'phone-task-running', name: 'Task running (phone)', viewport: { width: 390, height: 844 } },
  { id: 'phone-approval', name: 'Approval (phone)', viewport: { width: 390, height: 844 } },
  { id: 'desktop-home', name: 'Home (desktop)', viewport: { width: 1440, height: 900 } },
  { id: 'desktop-mission', name: 'Mission (desktop)', viewport: { width: 1440, height: 900 } },
  { id: 'desktop-task-running', name: 'Task running (desktop)', viewport: { width: 1440, height: 900 } },
  { id: 'coverage', name: 'Coverage', viewport: { width: 1200, height: 700 } },
];

export default function DesignPreviewFixture() {
  const [screen, setScreen] = useState<string>('desktop-mission');
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('screen');
    if (s && DESIGN_PREVIEW_FIXTURE_SCREENS.some((x) => x.id === s)) setScreen(s);
  }, []);

  return (
    <main className="min-h-screen pt-4 px-4 pb-4 md:p-8" data-testid="design-preview-fixture">
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight mb-1">Navigation design (sample)</h1>
          <p className="text-sm text-text-muted mb-4">Fixture: an uploaded HTML design framed as /app/artifacts/[id] frames it.</p>
          <div className="min-w-0 bg-surface-2 border border-border-default p-4 md:p-6">
            <DesignPreview
              key={screen}
              artifactId="fixture-design"
              title="Navigation design (sample)"
              revision={3}
              frameUrl="/app/dev/fixtures/design"
              screens={DESIGN_PREVIEW_FIXTURE_SCREENS}
              initialScreenId={screen}
              downloadUrl="/app/dev/fixtures/design"
              fileName="navigation-design.html"
              sizeLabel="128.8 KB"
            />
          </div>
        </div>
        <div>
          <p className="text-sm text-text-muted mb-4">The same artifact when file storage cannot serve it.</p>
          <div className="min-w-0 bg-surface-2 border border-border-default p-4 md:p-6">
            <DesignPreview
              artifactId="fixture-design-unavailable"
              title="Navigation design (sample)"
              revision={3}
              frameUrl={null}
              screens={DESIGN_PREVIEW_FIXTURE_SCREENS}
              initialScreenId="phone-mission"
              downloadUrl="/app/dev/fixtures/design"
              fileName="navigation-design.html"
              sizeLabel="128.8 KB"
            />
          </div>
        </div>
      </div>
    </main>
  );
}
