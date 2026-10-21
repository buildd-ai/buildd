/** Representative local fixture, never imported by production UI. */
import { renderToStaticMarkup } from 'react-dom/server';
import * as missionHelpers from '../../packages/core/mission-helpers';
import { projectMissionDelivery, type MissionTaskRow } from '../../apps/web/src/lib/delivery-projection';
import { buildMissionSections, type MissionSectionKey } from '../../apps/web/src/lib/mission-sections';
import type { PortfolioRow } from '../../apps/web/src/lib/mission-portfolio';
import { TERMS } from '../../packages/shared/src/terms';

export const SCHEDULED_AT = '2026-10-21T14:00:00.000Z';
/** The sort captions the Missions list printed before #5359; the unrepaired fixture still shows them. */
export const PRINTED_ORDER: Record<MissionSectionKey, string> = {
  needs: 'oldest first', motion: 'slipping first', waiting: 'next to start first', landed: 'oldest first',
};
const task = (id: string, status?: string): MissionTaskRow => ({
  id, title: id, taskClass: 'work', status: status ? 'completed' : 'pending',
  workers: status ? [{ status: 'completed', prUrl: 'https://github.com/example/project/pull/1', prLifecycleStatus: status }] : [],
});

function row(id: string, tasks: MissionTaskRow[], lastAdvancedAt: number, isHeld = false): PortfolioRow {
  return {
    delivery: projectMissionDelivery({
      id, title: id, status: 'active', href: `/fixture/missions/${id}`, isHeld, tasks,
    }, missionHelpers),
    status: 'active', workspaceId: null, workspaceName: null, priority: 0, liveAgents: 0,
    lastAdvancedAt, completedAt: null, nextScanMins: null,
  };
}

/** Same projection and comparator used by the Missions list; intentionally unsorted input. */
export function fixtureRows(): PortfolioRow[] {
  return [
    row('held', [task('held-task')], 1000, true),
    row('fresh', [task('fresh-task', 'ci_pending')], 9000),
    row('scheduled', [], 1000),
    row('quiet', [task('quiet-task', 'ci_pending')], 1000),
    row('queued', [task('queued-task')], 1000),
    row('fix', [task('fix-task', 'ci_failed')], 8000),
  ];
}

/** The fixture supplies authoritative scheduling facts; text is never used to infer state. */
export function MissionCopyFixture({ repaired }: { repaired: boolean }) {
  const sections = buildMissionSections(fixtureRows());
  return <main>
    {sections.map(section => <section key={section.key}>
      <h2>{section.label}</h2>
      {!repaired && <span data-testid="mission-section-order">{PRINTED_ORDER[section.key]}</span>}
      <ul>{section.rows.map(item => <li key={item.delivery.id} data-mission-id={item.delivery.id}>
        {item.delivery.title}
        {item.delivery.id === 'scheduled' && <>
          <span role="status">{repaired ? TERMS['wait.scheduled'].word : 'Planning'}</span>
          <time dateTime={SCHEDULED_AT}>21 Oct 2026, 14:00 UTC</time>
        </>}
      </li>)}</ul>
    </section>)}
    <form method="post" action="/fixture/approve"><button type="submit">Approve changes</button></form>
  </main>;
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) throw new Error('Supply an output HTML path');
  const html = '<!doctype html><meta charset="utf-8"><title>Project policy representative fixture</title>'
    + '<style>body{font:16px system-ui;margin:2rem;max-width:50rem}article{border:1px solid #aaa;padding:1rem;margin:1rem 0}li{margin:.6rem 0}li span,time{margin-left:1rem}</style>'
    + renderToStaticMarkup(<><h1>Representative mission copy fixture</h1>
      <article><h2>Before repair</h2><MissionCopyFixture repaired={false} /></article>
      <article><h2>After repair</h2><MissionCopyFixture repaired /></article></>);
  await Bun.write(target, html);
  console.log(target);
}
