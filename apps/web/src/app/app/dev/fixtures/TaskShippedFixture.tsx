'use client';

/**
 * `?state=task-shipped` and `?state=commit-checks`: the completed task page's
 * "What shipped" header over the PR card, and the "Checks by commit" list,
 * laid out like the task page's main column. Illustrative data only
 * (task-shipped-fixtures.ts); shots are SVG sketches.
 */
import { useEffect, useState } from 'react';
import PrCard, { CommitChecksList } from '@/components/task/PrCard';
import { visualReviewSketch } from '@/lib/visual-review-model.fixtures';
import { TaskShippedBody, TaskShippedDetails, TaskShippedTitle } from '../../(protected)/tasks/[id]/TaskShippedHeader';
import TaskVerdictBlock from '../../(protected)/tasks/[id]/TaskVerdictBlock';
import {
  COMMIT_CHECKS_VARIANTS,
  FIXTURE_HERO_SHOTS,
  FIXTURE_RUN_DETAILS,
  FIXTURE_TASK_TITLE,
  TASK_SHIPPED_VARIANTS,
  fixtureCommits,
  fixtureOutcome,
  parseCommitChecksVariant,
  parseTaskShippedVariant,
  taskShippedFixtureVerdict,
  taskShippedFixtureView,
  type CommitChecksVariant,
  type TaskShippedVariant,
} from './task-shipped-fixtures';

const shotSrc = (id: string) =>
  visualReviewSketch(FIXTURE_HERO_SHOTS.find(s => s.artifactId === id)?.viewport ?? 'mobile');

function VariantLinks({ state, variants, current }: { state: string; variants: readonly string[]; current: string | null }) {
  return (
    <nav aria-label="Fixture variants" className="mb-6 flex flex-wrap gap-2 font-mono text-meta">
      {variants.map(v => (
        <a key={v} href={`?state=${state}&variant=${v}`} className={`flex min-h-11 items-center border px-3 md:min-h-8 ${current === v ? 'border-accent text-accent-text' : 'border-border-default text-text-secondary'}`}>
          {v}
        </a>
      ))}
    </nav>
  );
}

export function TaskShippedFixture() {
  const [variant, setVariant] = useState<TaskShippedVariant | null>(null);
  useEffect(() => {
    setVariant(parseTaskShippedVariant(new URLSearchParams(window.location.search).get('variant')));
  }, []);
  if (!variant) return <div className="min-h-screen bg-surface-1" />;
  const view = taskShippedFixtureView(variant);
  const merged = variant === 'merged-shots';
  const verdict = taskShippedFixtureVerdict(variant);
  return (
    <div className="min-h-screen bg-surface-1 p-4 md:p-8" data-testid="task-shipped-fixture" data-variant={variant}>
      <div className="max-w-[1000px]">
        <VariantLinks state="task-shipped" variants={TASK_SHIPPED_VARIANTS} current={variant} />
        <div className="mb-5 md:mb-6">
          <TaskShippedTitle view={view} title={FIXTURE_TASK_TITLE} />
        </div>
        <TaskVerdictBlock verdict={verdict} decision={null} displayStatus="completed" />
        <TaskShippedBody view={view} artifactHref={() => '#'} shotSrc={shotSrc} />
        <div className="mb-8">
          <PrCard
            prUrl="https://github.com/example/app/pull/1234"
            prNumber={1234}
            prLifecycleStatus={merged ? 'merged' : variant === 'blocked' ? 'ci_failed' : 'ci_green'}
            outcome={fixtureOutcome(variant)}
            hideAction
          />
        </div>
        <TaskShippedDetails view={view} runDetails={FIXTURE_RUN_DETAILS} />
      </div>
    </div>
  );
}

export function CommitChecksFixture() {
  const [variant, setVariant] = useState<CommitChecksVariant | null | undefined>(undefined);
  useEffect(() => {
    setVariant(parseCommitChecksVariant(new URLSearchParams(window.location.search).get('variant')));
  }, []);
  if (variant === undefined) return <div className="min-h-screen bg-surface-1" />;
  const shown = variant ? [variant] : COMMIT_CHECKS_VARIANTS;
  return (
    <div className="min-h-screen bg-surface-1 p-4 md:p-8" data-testid="commit-checks-fixture">
      <div className="max-w-[1000px]">
        <VariantLinks state="commit-checks" variants={COMMIT_CHECKS_VARIANTS} current={variant} />
        {shown.map(v => (
          <section key={v} data-variant={v} className="mb-10">
            <div className="section-label border-b border-border-default pb-2 mb-1">Checks by commit · {v}</div>
            <CommitChecksList commits={fixtureCommits(v)} />
          </section>
        ))}
      </div>
    </div>
  );
}
