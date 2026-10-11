'use client';

/**
 * `?state=refined-components`: the shared refined-UI components on one page,
 * the gallery the prototype's COMPONENTS section shows. Invented data.
 */
import { useState } from 'react';
import Criteria from '@/components/ui/Criteria';
import FocusCard from '@/components/ui/FocusCard';
import Lifecycle from '@/components/ui/Lifecycle';
import MissionRow from '@/components/ui/MissionRow';
import Segmented from '@/components/ui/Segmented';
import StatePill from '@/components/ui/StatePill';
import TaskStrip, { type TaskStripCell } from '@/components/ui/TaskStrip';
import { STATE_KEYS, type StateKey } from '@/components/ui/states';
import { reasonLine } from '@/components/ui/task-strip';
import { ActionQueueCard } from '../../(protected)/home/ActionQueueCard';
import type { ActionQueueItem } from '@/lib/action-queue';

const TASKS: Array<TaskStripCell & { downstream: string[]; upstream: string[] }> = [
  { id: '01', state: 'landed', title: 'Delivery spec', upstream: [], downstream: [] },
  { id: '02', state: 'landed', title: 'Prototype + feasibility', upstream: [], downstream: [] },
  { id: '03', state: 'review', title: 'Shared delivery projection', upstream: [], downstream: ['05', '06', '07'] },
  { id: '04', state: 'running', title: 'Missions portfolio list', upstream: [], downstream: ['06', '07'] },
  { id: '05', state: 'blocked', title: 'Activity Now / History', upstream: ['03'], downstream: [] },
  { id: '06', state: 'blocked', title: 'Mission detail: gates + repair', upstream: ['03', '04'], downstream: [] },
  { id: '07', state: 'queued', title: 'Final audit', upstream: ['05', '06', '03', '04'], downstream: [] },
];
const DIRECT: Record<string, string[]> = { '03': ['05', '06'], '04': ['06'], '05': ['03'], '06': ['03', '04'], '07': ['05', '06'] };

const LONG: StateKey[] = [...Array(14).fill('landed'), 'review', 'running', 'running', 'fixing', ...Array(4).fill('blocked'), ...Array(6).fill('queued')];

const REVIEW_ITEM = {
  subjectKey: 'fixture-review',
  chip: 'REVIEW',
  prNumber: 42,
  workspaceId: 'ws-fixture',
  taskTitle: 'Add an incident table',
  prUrl: 'https://github.com/example/repo/pull/42',
  machineStatus: 'CI running',
  humanReview: {
    label: 'Review on GitHub',
    reason: 'The change adds a table and a migration, and workspace policy asks a person to approve both.',
    decision: 'Approve the additive migration after the branch refresh lands.',
    blockers: [{ kind: 'migration', text: 'Adds one table' }],
  },
  refreshFirst: { taskId: null, prNumber: 41, prUrl: 'https://github.com/example/repo/pull/41' },
} as unknown as ActionQueueItem;

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border-default pt-4">
      <h2 className="section-label">{title}</h2>
      {children}
    </section>
  );
}

export default function RefinedComponentsFixture() {
  const [sel, setSel] = useState('03');
  const [view, setView] = useState<'state' | 'effort'>('state');
  const task = TASKS.find(t => t.id === sel)!;
  const held = task.state === 'blocked' || task.state === 'queued';
  const relation = held ? task.upstream : task.downstream;
  const direct = DIRECT[sel] ?? [];
  const marks = Object.fromEntries(relation.map(id => [id, direct.includes(id) ? 'direct' : 'transitive'] as const));
  const named = held
    ? direct.map(id => `${id} ${TASKS.find(t => t.id === id)!.title}`)
    : direct;
  const reason = reasonLine(held ? 'upstream' : 'downstream', named, relation.length);

  return (
    <main className="min-h-screen p-4 md:p-8" data-testid="refined-components-fixture">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <h1 className="text-heading font-semibold">Refined components</h1>

        <Block title="StatePill">
          <div className="flex flex-wrap gap-2">{STATE_KEYS.map(k => <StatePill key={k} state={k} />)}</div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">{STATE_KEYS.map(k => <StatePill key={k} state={k} variant="plain" />)}</div>
        </Block>

        <Block title="Lifecycle">
          {(['running', 'review', 'fixing', 'recovering', 'needs_you', 'landing', 'landed'] as StateKey[]).map(s => (
            <Lifecycle key={s} state={s} repairs={s === 'fixing' ? 2 : undefined} />
          ))}
        </Block>

        <Block title="TaskStrip lg + FocusCard">
          <TaskStrip cells={TASKS} selectedId={sel} onSelect={setSel} marks={marks} label="Mission tasks" />
          <FocusCard
            meta={`${task.id} · builder`}
            title={task.title ?? ''}
            state={task.state}
            next={held ? 'Starts by itself when its dependencies land' : 'Review starts automatically when CI passes'}
            reason={reason}
            estimate={task.state === 'running' ? { p50: 60, p80: 100, actual: 18 } : task.state === 'review' ? { p50: 40, p80: 70, actual: 48 } : null}
            needs="Nothing"
            note="Buildd freed this task's agent while CI runs. It comes back if CI fails."
          />
        </Block>

        <Block title="TaskStrip sm">
          <TaskStrip size="sm" cells={TASKS} />
          <TaskStrip size="sm" cells={LONG.map((state, i) => ({ id: String(i), state }))} label="A long mission" />
        </Block>

        <Block title="MissionRow">
          <div>
            <MissionRow href="#" title="Delivery UX: portfolio Missions, actionable Activity, quiet Home" strip={TASKS.map(t => t.state)} state="review" stat="2 of 7 merged" eta="est. 5:35 PM" slip="90m later than first estimated" next="03 lands when CI passes" />
            <MissionRow href="#" title="Staging verification" strip={['landed', 'needs_you', 'queued']} state="needs_you" stat="1 of 3 merged" decide="Decide: add the staging credential" />
          </div>
        </Block>

        <Block title="Segmented + Criteria">
          <Segmented label="Strip view" value={view} onChange={setView} items={[{ value: 'state', label: 'State' }, { value: 'effort', label: 'Effort' }]} />
          <Criteria
            items={[
              { ok: true, text: 'Design spec attached', value: 'found' },
              { ok: true, text: 'Interactive prototype attached', value: 'found' },
              { ok: false, text: 'All PRs merged', value: '2/7' },
              { ok: false, text: 'No open tasks', value: '5 open' },
            ]}
            evaluated="Evaluated 40m ago"
          />
        </Block>

        <Block title="Decision (L3)">
          <div className="max-w-md"><ActionQueueCard item={REVIEW_ITEM} /></div>
        </Block>
      </div>
    </main>
  );
}
