import Link from 'next/link';
import Chip from '@/components/ui/Chip';
import Eyebrow from '@/components/ui/Eyebrow';
import RunnerInstallSteps from '@/components/RunnerInstallSteps';
import { NewWorkLink } from '@/components/chat/ChatEntry';
import type { FirstTaskState, GettingStartedChecklist as Checklist, GettingStartedStepId } from '@/lib/getting-started';
import { AGENT_CREDENTIAL_HREF } from '@/lib/provider-auth-failure';

/** Settings → Model providers → Agent model endpoint (OpenRouter, LiteLLM). */
export const AGENT_ENDPOINT_HREF = '/app/settings/providers#agent-endpoint-h';

const TITLES: Record<GettingStartedStepId, string> = {
  runner: 'Connect a runner',
  credential: 'Add an agent key',
  task: 'Run a first task',
};

/** Shell lines, one per row, in one inset block. */
function StepBody({ id, taskState }: { id: GettingStartedStepId; taskState?: FirstTaskState }) {
  if (id === 'runner') {
    return (
      <>
        <p className="text-body text-text-secondary">Install the CLI on any machine, reload your shell, log in, then start it.</p>
        <RunnerInstallSteps className="mt-2" />
      </>
    );
  }
  if (id === 'credential') {
    return (
      <>
        <p className="text-body text-text-secondary">
          Agents run on your own key: Anthropic, OpenRouter or a LiteLLM gateway.
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-4">
          <Link href={AGENT_CREDENTIAL_HREF} data-testid="getting-started-credential-link" className="inline-flex min-h-11 md:min-h-0 items-center text-body text-accent-text hover:underline">
            Add an Anthropic key
          </Link>
          <Link href={AGENT_ENDPOINT_HREF} className="inline-flex min-h-11 md:min-h-0 items-center text-body text-accent-text hover:underline">
            Use OpenRouter or LiteLLM
          </Link>
        </div>
      </>
    );
  }
  if (taskState === 'failed') {
    return (
      <p className="text-body text-text-secondary">
        Your first task failed. Needs you, below, says why and how to fix it; then retry it.
      </p>
    );
  }
  if (taskState === 'open') {
    return (
      <p className="text-body text-text-secondary">
        Your first task is queued or running. This step is done when it finishes.
      </p>
    );
  }
  return (
    <p className="text-body text-text-secondary">
      <NewWorkLink kind="task" className="text-accent-text hover:underline">New task</NewWorkLink>
      {'. '}A runner picks it up and the result shows here.
    </p>
  );
}

/**
 * Home's one getting-started list (lib/getting-started.ts): runner, agent key,
 * a first task that succeeded, in order. A done step folds to its title and a Done chip; the
 * current step shows how. The host renders nothing once `visible` is false.
 */
export default function GettingStartedChecklist({ checklist, chatSetupHref, headingId = 'getting-started-h' }: {
  checklist: Checklist; chatSetupHref?: string | null;
  /** Unique per instance: Home renders a phone and a desktop copy in one document. */
  headingId?: string;
}) {
  const total = checklist.steps.length;
  return (
    <section className="card mb-8 p-0" data-testid="getting-started" aria-labelledby={headingId}>
      <div className="px-4 pt-4 pb-3 md:px-5">
        <Eyebrow as="h2" id={headingId} tone="accent">
          Get started · {checklist.doneCount} of {total}
        </Eyebrow>
      </div>
      <ol className="divide-y divide-border-default border-t border-border-default">
        {checklist.steps.map((step, i) => (
          <li
            key={step.id}
            data-testid={`getting-started-${step.id}`}
            data-done={step.done ? 'true' : 'false'}
            aria-current={step.current ? 'step' : undefined}
            className="flex items-start gap-3 px-4 py-3 md:px-5"
          >
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-meta ${
                step.done
                  ? 'border-status-success text-status-success'
                  : step.current
                    ? 'border-primary text-accent-text'
                    : 'border-border-default text-text-muted'
              }`}
            >
              {step.done ? '✓' : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-title ${step.done ? 'text-text-secondary' : 'text-text-primary'}`}>{TITLES[step.id]}</span>
                {step.done && <Chip tone="success" variant="soft">Done</Chip>}
              </div>
              {!step.done && (
                <div className="mt-1">
                  <StepBody id={step.id} taskState={step.taskState} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {chatSetupHref && (
        <p className="border-t border-border-default px-4 py-3 md:px-5 text-meta text-text-muted">
          Chat with your agent uses a model key too.{' '}
          <Link href={chatSetupHref} className="text-accent-text hover:underline">Model providers</Link>
        </p>
      )}
    </section>
  );
}
