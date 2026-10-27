'use client';

/**
 * `?state=you-strip-pipeline`: YouStrip and Pipeline (spec 9430a28f r2 R-12,
 * R-13, AC-11, AC-12). Each case draws the strip, the Pipeline and the rows
 * under it from one delivery list through `groupByStage`, so the count, the
 * dots and the rows of every stage are the same array.
 */
import Pipeline, { PIPELINE_STAGES, groupByStage, type PipelineDelivery } from '@/components/ui/Pipeline';
import StageMeter from '@/components/ui/StageMeter';
import YouStrip, { type YouStripItem } from '@/components/ui/YouStrip';

export interface FixtureDelivery extends PipelineDelivery {
  title: string;
  tag: string;
  fixRounds?: number;
}

const ONE_WAITING: FixtureDelivery[] = [
  { id: 'd1', title: 'Stable attempt order', tag: 'activity', state: 'waiting-on-you', stage: 'verify' },
  { id: 'd2', title: 'Runner image digest', tag: 'release', state: 'build' },
];

export const MANY_DELIVERIES: FixtureDelivery[] = [
  { id: 'm1', title: 'Spec import review', tag: 'specs', state: 'queued' },
  { id: 'm2', title: 'Mission branch refresh', tag: 'git', state: 'queued' },
  { id: 'm3', title: 'Delivery bar ticks', tag: 'activity', state: 'build' },
  { id: 'm4', title: 'Runner keys page', tag: 'settings', state: 'build' },
  { id: 'm5', title: 'Hosted runner sizes', tag: 'unit tests', state: 'fixing-in-build', fixRounds: 2 },
  { id: 'm6', title: 'Stage meter states', tag: 'activity', state: 'verify' },
  { id: 'm7', title: 'Answer recorded line', tag: 'tasks', state: 'verify' },
  { id: 'm8', title: 'Closed PR reasons', tag: 'prs', state: 'verify' },
  { id: 'm9', title: 'Model providers', tag: 'type check', state: 'fixing-in-verify', fixRounds: 3 },
  { id: 'm10', title: 'Evidence storage', tag: 'visual qa', state: 'check-cant-run', stage: 'verify' },
  { id: 'm11', title: 'Stable attempt order', tag: 'activity', state: 'waiting-on-you', stage: 'verify' },
  { id: 'm12', title: 'Service status banner', tag: 'home', state: 'deliver' },
];

/** The YouStrip items are the deliveries whose meter reads waiting on you. */
function waitingOf(list: FixtureDelivery[]): YouStripItem[] {
  return list.filter(d => d.state === 'waiting-on-you').map(d => ({ id: d.id, title: d.title, reason: `Review · ${d.tag}`, href: '#' }));
}

/** Closest to done first (R-14). */
const ROW_ORDER = ['deliver', 'verify', 'build', 'queued'] as const;

export function NowPreview({ deliveries, extraWaiting = [], layout = 'stack' }: { deliveries: FixtureDelivery[]; extraWaiting?: YouStripItem[]; layout?: 'stack' | 'row' }) {
  const groups = groupByStage(deliveries);
  return (
    <div className="space-y-4">
      <YouStrip waiting={[...waitingOf(deliveries), ...extraWaiting]} />
      <Pipeline deliveries={deliveries} layout={layout} hrefFor={s => (groups[s].length ? `#group-${s}` : undefined)} />
      {ROW_ORDER.filter(s => groups[s].length > 0).map(s => (
        <div key={s} id={`group-${s}`} data-group={s} className="space-y-1">
          <p className="font-mono text-chip text-text-muted">{s}</p>
          {groups[s].map(d => (
            <div key={d.id} data-row={d.id} className="flex items-center gap-3 border-b border-border-default py-2">
              <StageMeter state={d.state} stage={d.stage} fixRounds={d.fixRounds} />
              <span className="min-w-0 flex-1 truncate text-title text-text-primary">{d.title}</span>
              <span className="font-mono text-meta text-text-muted">{d.tag}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const CASES: { key: string; label: string; deliveries: FixtureDelivery[]; extraWaiting?: YouStripItem[]; layout?: 'stack' | 'row' }[] = [
  { key: 'empty', label: 'Empty: nothing waiting, counts of 0', deliveries: [] },
  { key: 'one-waiting', label: 'One waiting', deliveries: ONE_WAITING },
  {
    key: 'many', label: 'Many deliveries, three waiting (1/3)', deliveries: MANY_DELIVERIES,
    extraWaiting: [{ id: 'x1', title: 'Docker Hub credentials', reason: 'Decision', href: '#' }, { id: 'x2', title: 'Release candidate', reason: 'Approval', href: '#' }],
  },
  { key: 'zero-stages', label: 'Some stages at 0', deliveries: MANY_DELIVERIES.filter(d => d.state === 'build' || d.state === 'queued') },
  { key: 'desktop-row', label: 'Desktop row layout', deliveries: MANY_DELIVERIES, layout: 'row' },
];

export default function YouStripPipelineFixture() {
  return (
    <div className="min-h-screen space-y-6 bg-surface-1 p-4">
      <h1 className="font-mono text-chip text-text-primary">YouStrip · Pipeline · {PIPELINE_STAGES.length} groups</h1>
      {CASES.map(c => (
        <section key={c.key} data-testid={`you-strip-pipeline-${c.key}`} className={`card space-y-3 p-4 ${c.layout === 'row' ? 'max-w-5xl' : 'max-w-[390px]'}`}>
          <p className="font-mono text-chip text-text-muted">{c.label}</p>
          <NowPreview deliveries={c.deliveries} extraWaiting={c.extraWaiting} layout={c.layout} />
        </section>
      ))}
    </div>
  );
}
