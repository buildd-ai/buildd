'use client';

/**
 * `?state=answer-states`: a question's answer in each state it passes through,
 * on the mission task sheet and on the chat / respond-page question card:
 * the tapped option pending, answered after one tap, a second tap (already
 * answered, the same answer and a different one) and a real failure. The live
 * states need a tap and a server reply, so a route screenshot never reaches
 * them.
 */
import type { ReactNode } from 'react';
import WorkerRespondInput from '@/components/WorkerRespondInput';
import AnswerRecorded, { AnswerOutcomeText } from '@/components/AnswerRecorded';
import QuestionHero from '../../(protected)/tasks/[id]/QuestionHero';
import type { AnswerOutcome } from '../../(protected)/tasks/[id]/respond/submit-answer';
import type { AnswerSubmitState } from '../../(protected)/tasks/[id]/respond/use-answer-submit';

const QUESTION = 'The settings audit found two more screens. Park this task until they land, or ship what is done?';
const OPTIONS = ['Park and wait (recommended)', 'Ship what is done'];

const noop = async () => {};
const state = (over: Partial<AnswerSubmitState>): AnswerSubmitState => ({ submit: noop, sending: null, outcome: null, error: null, ...over });

const SENT: AnswerOutcome = { kind: 'sent', answer: OPTIONS[0], taskId: null, path: 'resume', message: null };
const DUPLICATE: AnswerOutcome = { kind: 'already_answered', answer: OPTIONS[0], recordedAnswer: OPTIONS[0], differs: false, taskId: null, path: null, message: null };
const DIFFERS: AnswerOutcome = { kind: 'already_answered', answer: OPTIONS[1], recordedAnswer: OPTIONS[0], differs: true, taskId: null, path: null, message: null };

const heroQuestion = {
  headline: 'Park this task, or ship what is done?',
  body: 'The settings audit found two more screens.',
  options: [
    { label: OPTIONS[0], description: 'Wait for the two screens, then finish in one PR.', recommended: true },
    { label: OPTIONS[1], description: 'Open a PR now and file the rest as a follow-up.', recommended: false },
  ],
  noteId: null,
};

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section data-testid="answer-state" data-state-label={label} className="space-y-2">
      <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted">{label}</h2>
      {children}
    </section>
  );
}

function SheetBox({ children }: { children: ReactNode }) {
  return (
    <div className="border-2 border-status-warning p-4">
      <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-status-warning">Needs input</span>
      {children}
    </div>
  );
}

export default function AnswerStatesFixture() {
  return (
    <div className="min-h-screen bg-surface-1 px-4 py-6 md:p-8">
      <div className="mx-auto grid max-w-5xl gap-8 md:grid-cols-2">
        <div className="space-y-6">
          <h1 className="text-lg font-bold">Mission task sheet</h1>
          <Panel label="Tapped, sending">
            <SheetBox>
              <WorkerRespondInput workerId="w1" question={QUESTION} options={OPTIONS} answer={state({ sending: OPTIONS[0] })} />
            </SheetBox>
          </Panel>
          <Panel label="Answered after one tap">
            <AnswerRecorded outcome={SENT} />
          </Panel>
          <Panel label="Second tap: already answered, same answer">
            <AnswerRecorded outcome={DUPLICATE} />
          </Panel>
          <Panel label="Already answered, a different answer">
            <AnswerRecorded outcome={DIFFERS} />
          </Panel>
          <Panel label="Real failure: retry">
            <SheetBox>
              <WorkerRespondInput
                workerId="w1"
                question={QUESTION}
                options={OPTIONS}
                answer={state({ error: { message: 'The answer did not send. Check your connection and try again.', credentialRevoked: false } })}
              />
            </SheetBox>
          </Panel>
        </div>
        <div className="space-y-6">
          <h1 className="text-lg font-bold">Chat card and respond page</h1>
          <Panel label="Tapped, sending">
            <QuestionHero density="feed" question={heroQuestion} askerLabel="The builder asks" onAnswer={() => {}} sending={OPTIONS[0]} testId="fixture-hero-sending" />
          </Panel>
          <Panel label="Answered after one tap">
            <QuestionHero density="feed" question={heroQuestion} askerLabel="The builder asks" onAnswer={() => {}} sending={null} sent={<AnswerOutcomeText outcome={SENT} waitingFor="the Builder" tail="It picks up where it stopped." />} testId="fixture-hero-sent" />
          </Panel>
          <Panel label="Already answered, a different answer">
            <QuestionHero density="feed" question={heroQuestion} askerLabel="The builder asks" onAnswer={() => {}} sending={null} sent={<AnswerOutcomeText outcome={DIFFERS} />} testId="fixture-hero-differs" />
          </Panel>
        </div>
      </div>
    </div>
  );
}
