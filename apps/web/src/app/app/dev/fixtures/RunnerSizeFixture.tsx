'use client';

/**
 * `?state=runner-size`: the workspace settings' Cloud runner size section in
 * its three sources. The real page needs a workspace with cloud run reports
 * to show a derived size. Top to bottom: derived Large (low disk), an
 * explicit Standard override, the default.
 */
import RunnerSizeSection from '../../(protected)/workspaces/[id]/config/RunnerSizeSection';

export default function RunnerSizeFixture() {
  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-2xl mx-auto">
        <RunnerSizeSection workspaceId="fixture-ws" explicit={null} effective="large" source="derived" reason="low_disk" />
        <RunnerSizeSection workspaceId="fixture-ws" explicit="standard" effective="standard" source="explicit" reason={null} />
        <RunnerSizeSection workspaceId="fixture-ws" explicit={null} effective="standard" source="default" reason={null} />
      </div>
    </main>
  );
}
