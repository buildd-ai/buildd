'use client';

/**
 * Health › Queue components in isolation (spec 4bc3e70e R-3, R-5, R-6): the
 * tiles in both layouts (busy, nothing blocked), and one row per reason.
 */
import QueueTiles from '@/components/health/QueueTiles';
import QueueRow from '@/components/health/QueueRow';

const HREFS = { running: '#running', queued: '#queued', blocked: '#blocked', scheduled: '#scheduled' };

const ROWS = [
  { title: 'Lane holder shows queue position', mission: 'Honest queue', reason: 'lane', blockedBy: 'Schema lane · 2nd', age: '38m' },
  { title: 'Nightly export cleanup', mission: null, reason: 'limit', blockedBy: '1/h · lifts 14:00', age: '12m' },
  { title: 'Queue settings page', mission: 'Honest queue', reason: 'dependency', blockedBy: 'Export job', blockedByDot: 'running', age: '1h 4m' },
] as const;

export default function QueueComponentsFixture() {
  return (
    <div data-testid="queue-components-fixture" className="min-h-screen bg-surface-1 p-4 text-text-primary md:p-8">
      <h1 className="mb-4 text-lg font-semibold">Queue tiles and rows</h1>
      <div className="grid gap-8 md:grid-cols-2">
        <section className="max-w-[390px] space-y-4">
          <QueueTiles running={{ used: 4, total: 6 }} queued={2} blocked={{ lane: 3, limit: 2, dependency: 4 }} scheduled={1} hrefs={HREFS} layout="phone" />
          <QueueTiles running={{ used: 0, total: 1 }} queued={0} blocked={{ lane: 0, limit: 0, dependency: 0 }} scheduled={0} hrefs={HREFS} layout="phone" />
          <div>{ROWS.map(r => <QueueRow key={r.title} {...r} href="#row" layout="phone" />)}</div>
        </section>
        <section className="space-y-4">
          <QueueTiles running={{ used: 3, total: 9 }} queued={3} blocked={{ lane: 1, limit: 0, dependency: 5 }} scheduled={2} hrefs={HREFS} layout="desktop" />
          <div>{ROWS.map(r => <QueueRow key={r.title} {...r} href="#row" layout="desktop" />)}</div>
        </section>
      </div>
    </div>
  );
}
