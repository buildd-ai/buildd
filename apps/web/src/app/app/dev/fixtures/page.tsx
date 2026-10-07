'use client';

import { useEffect, useMemo, useState } from 'react';
import RealTimeWorkerView from '../../(protected)/tasks/[id]/RealTimeWorkerView';
import { KeyHintsProvider, keyHintsFromQuery } from '@/components/KeyHints';
import VisualReviewAsk from '@/components/visual-review/VisualReviewAsk';
import VisualReviewDeck from '@/components/visual-review/VisualReviewDeck';
import VisualReviewLine from '@/components/visual-review/VisualReviewLine';
import VisualReviewTray, { type VisualReviewPhaseActions } from '@/components/visual-review/VisualReviewTray';
import { createFixtureVisualReviewTransport } from '@/components/visual-review/fixture-transport';
import { useVisualReviewDecisions } from '@/components/visual-review/review-transport';
import { mockWorkers, type FixtureState } from './fixtures-data';
import MissionBoardVisualFixture from './MissionBoardVisualFixture';
import MissionListExecutorFixture from './MissionListExecutorFixture';
import MissionTaskStripFixture from './MissionTaskStripFixture';
import MissionCheckInsFixture from './MissionCheckInsFixture';
import GoalCriteriaFixture from './GoalCriteriaFixture';
import OnboardingFixture, { ONBOARDING_FIXTURE_VIEWS, type OnboardingFixtureView } from './OnboardingFixture';
import EvidenceStorageFixture from './EvidenceStorageFixture';
import ModelProvidersFixture from './ModelProvidersFixture';
import TaskEvidenceFilesFixture from './TaskEvidenceFilesFixture';
import { CommitChecksFixture, TaskShippedFixture } from './TaskShippedFixture';
import AnswerStatesFixture from './AnswerStatesFixture';
import FailureKindsFixture from './FailureKindsFixture';
import AgentAccessFixture from './AgentAccessFixture';
import ToolBreakdownFixture from './tool-breakdown-fixture';
import EntitlementBlockedFixture from './EntitlementBlockedFixture';
import RunnerSizeFixture from './RunnerSizeFixture';
import InteractiveSessionsFixture from './InteractiveSessionsFixture';
import {
    EVIDENCE_STORAGE_FIXTURE_STATE,
    RUNNER_SIZE_FIXTURE_STATE,
    INTERACTIVE_SESSIONS_FIXTURE_STATE,
    MODEL_PROVIDERS_FIXTURE_STATE,
    TOOL_BREAKDOWN_FIXTURE_STATE,
    FIXTURE_VIEWS,
    MISSION_BOARD_VISUAL_FIXTURE_STATE,
    MISSION_LIST_EXECUTOR_FIXTURE_STATE,
    MISSION_TASK_STRIP_FIXTURE_STATE,
    MISSION_CHECK_INS_FIXTURE_STATE,
    GOAL_CRITERIA_FIXTURE_STATE,
    ONBOARDING_FIXTURE_STATE,
    TASK_EVIDENCE_FIXTURE_STATE,
    TASK_SHIPPED_FIXTURE_STATE,
    COMMIT_CHECKS_FIXTURE_STATE,
    ANSWER_STATES_FIXTURE_STATE,
    AGENT_ACCESS_FIXTURE_STATE,
    ENTITLEMENT_BLOCKED_FIXTURE_STATE,
    FAILURE_KINDS_FIXTURE_STATE,
    VISUAL_REVIEW_FIXTURE_STATE,
    isFixtureView,
    parseVisualReviewFixtureParams,
    visualReviewFixtureLinks,
    type VisualReviewFixtureParams,
} from './visual-review-fixtures';

export default function DevFixturesPage() {
    // Read the selected state from the URL after mount. Doing this during render
    // (typeof window checks) diverges between the server and client and causes a
    // hydration mismatch, so start from the default and sync on the client.
    const [state, setState] = useState<string>('waiting-input');
    // `?hints=1`: the keyboard-hints preference on (components/KeyHints.tsx).
    const [hints, setHints] = useState(false);

    useEffect(() => {
        const q = new URLSearchParams(window.location.search);
        const param = q.get('state');
        if (isFixtureView(param)) setState(param);
        setHints(keyHintsFromQuery(q));
    }, []);

    const [onboardingView, setOnboardingView] = useState<OnboardingFixtureView>('checklist');
    useEffect(() => {
        const v = new URLSearchParams(window.location.search).get('view');
        if ((ONBOARDING_FIXTURE_VIEWS as readonly string[]).includes(v ?? '')) setOnboardingView(v as OnboardingFixtureView);
    }, []);

    const worker = mockWorkers[state as FixtureState] || mockWorkers['waiting-input'];

    if (state === MISSION_BOARD_VISUAL_FIXTURE_STATE) {
        return (
            <KeyHintsProvider value={hints}>
                <MissionBoardVisualFixture />
            </KeyHintsProvider>
        );
    }

    if (state === MISSION_TASK_STRIP_FIXTURE_STATE) {
        return <MissionTaskStripFixture />;
    }

    if (state === MISSION_LIST_EXECUTOR_FIXTURE_STATE) {
        return <MissionListExecutorFixture />;
    }

    if (state === ONBOARDING_FIXTURE_STATE) {
        return <OnboardingFixture key={onboardingView} view={onboardingView} />;
    }

    if (state === TASK_EVIDENCE_FIXTURE_STATE) {
        return <TaskEvidenceFilesFixture />;
    }

    if (state === TASK_SHIPPED_FIXTURE_STATE) {
        return <TaskShippedFixture />;
    }

    if (state === COMMIT_CHECKS_FIXTURE_STATE) {
        return <CommitChecksFixture />;
    }

    if (state === MISSION_CHECK_INS_FIXTURE_STATE) {
        return <MissionCheckInsFixture />;
    }

    if (state === GOAL_CRITERIA_FIXTURE_STATE) {
        return <GoalCriteriaFixture />;
    }

    if (state === AGENT_ACCESS_FIXTURE_STATE) {
        return <AgentAccessFixture />;
    }

    if (state === FAILURE_KINDS_FIXTURE_STATE) {
        return <FailureKindsFixture />;
    }

    if (state === ANSWER_STATES_FIXTURE_STATE) {
        return <AnswerStatesFixture />;
    }
    if (state === ENTITLEMENT_BLOCKED_FIXTURE_STATE) {
        return <EntitlementBlockedFixture />;
    }

    if (state === TOOL_BREAKDOWN_FIXTURE_STATE) {
        return <ToolBreakdownFixture />;
    }
    if (state === EVIDENCE_STORAGE_FIXTURE_STATE) {
        return <EvidenceStorageFixture />;
    }
    if (state === INTERACTIVE_SESSIONS_FIXTURE_STATE) {
        return <InteractiveSessionsFixture />;
    }

    if (state === RUNNER_SIZE_FIXTURE_STATE) {
        return <RunnerSizeFixture />;
    }
    if (state === MODEL_PROVIDERS_FIXTURE_STATE) {
        return <ModelProvidersFixture />;
    }

    if (state === VISUAL_REVIEW_FIXTURE_STATE) {
        return (
            <KeyHintsProvider value={hints}>
                <VisualReviewFixture />
            </KeyHintsProvider>
        );
    }

    return (
        <KeyHintsProvider value={hints}>
        <div className="min-h-screen bg-surface-1 p-8">
            <div className="max-w-4xl mx-auto">
                <div className="mb-6">
                    <h1 className="text-2xl font-bold mb-2">Dev Fixtures: Worker States</h1>
                    <p className="text-text-secondary mb-4">
                        Use these fixtures to test UI components in isolation without database dependencies.
                    </p>

                    {/* State selector */}
                    <div className="flex gap-2 flex-wrap">
                        {FIXTURE_VIEWS.map((s) => (
                            <a
                                key={s}
                                href={`?state=${s}`}
                                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${state === s
                                    ? 'bg-primary text-white'
                                    : 'bg-surface-3 text-text-secondary hover:bg-surface-4'
                                    }`}
                            >
                                {s}
                            </a>
                        ))}
                    </div>
                </div>

                <>
                        <div className="bg-surface-2 rounded-xl shadow-lg p-6">
                            <h2 className="text-lg font-semibold mb-4">
                                Active Worker: <span className="text-primary">{state}</span>
                            </h2>
                            <RealTimeWorkerView
                                taskId="fixture-task"
                                initialWorker={worker as any}
                                statusColors={{
                                    pending: 'bg-status-warning/10 text-status-warning',
                                    assigned: 'bg-status-info/10 text-status-info',
                                    running: 'bg-status-success/10 text-status-success',
                                    waiting_input: 'bg-status-running/10 text-status-running',
                                    completed: 'bg-surface-3 text-text-secondary',
                                    failed: 'bg-status-error/10 text-status-error',
                                }}
                            />
                        </div>

                        <div className="mt-6 p-4 bg-surface-3 rounded-lg">
                            <h3 className="font-medium mb-2">Raw Worker Data</h3>
                            <pre className="text-xs overflow-auto max-h-64 p-2 bg-surface-1 text-status-success rounded">
                                {JSON.stringify(worker, null, 2)}
                            </pre>
                        </div>
                </>
            </div>
        </div>
        </KeyHintsProvider>
    );
}

// ── ?state=visual-review ────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function VisualReviewFixture() {
    // Read the URL after mount, as above, so server and client render alike.
    const [params, setParams] = useState<VisualReviewFixtureParams | null>(null);
    useEffect(() => {
        setParams(parseVisualReviewFixtureParams(new URLSearchParams(window.location.search)));
    }, []);
    if (!params) return <div className="min-h-screen bg-surface-1" />;
    return <VisualReviewFixtureView params={params} />;
}

function VisualReviewFixtureView({ params }: { params: VisualReviewFixtureParams }) {
    const transport = useMemo(
        () => createFixtureVisualReviewTransport(params.phase, params.options, { latencyMs: 350 }),
        [params],
    );
    const [initial] = useState(() => transport.model());
    const review = useVisualReviewDecisions(initial, transport);
    const model = review.model;
    const opensDeck = params.view === 'deck' || params.view === 'compare' || params.view === 'fix-check' || params.view === 'fix-merged';
    const [deck, setDeck] = useState<{ startKey: string | null; compare: boolean } | null>(
        opensDeck ? { startKey: params.startKey, compare: params.compare } : null,
    );
    const [flash, setFlash] = useState<string | null>(null);
    const fake = (label: string) => async () => { await sleep(300); setFlash(label); };
    const actions: VisualReviewPhaseActions = {
        onTurnOff: fake('Turned off for this mission (fixture, nothing sent).'),
        onSkip: fake('Audit skipped (fixture, nothing sent).'),
        onRetry: fake('Audit queued again (fixture, nothing sent).'),
        onAnswer: async () => { await sleep(300); },
        answerOptions: model.phase === 'boot_failed' ? ['I fixed it, try again', 'Skip the visual audit'] : undefined,
    };
    const openDeck = (startKey: string | null) => setDeck({ startKey, compare: false });
    const deckProps = { model, onDecide: review.decide, onUndo: review.undo, fixTaskHref: () => '#fixture-task' };

    if (params.view === 'deck-phone') {
        return (
            <VisualReviewDeck
                {...deckProps}
                layout="sheet"
                onClose={() => { window.location.search = `?state=${VISUAL_REVIEW_FIXTURE_STATE}&view=board`; }}
            />
        );
    }

    return (
        <div className="min-h-screen bg-surface-1 text-text-primary">
            <header className="border-b-2 border-border-strong px-4 py-4 md:px-8">
                <p className="section-label">Dev fixtures</p>
                <h1 className="mt-1 font-mono text-[18px] font-semibold">Visual review: {params.view === 'tray' ? model.phase : params.view}</h1>
                <nav aria-label="Fixture states" className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
                    {visualReviewFixtureLinks().map(l => (
                        <a key={l.href} href={l.href} className="shrink-0 border border-border-default bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-text-secondary hover:border-border-strong hover:text-text-primary">
                            {l.label}
                        </a>
                    ))}
                </nav>
            </header>

            <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 md:px-8">
                {flash && <p role="status" className="border-l-[3px] border-status-success bg-surface-2 py-2 pl-3 font-mono text-[12px]">{flash}</p>}
                {params.view === 'board' ? (
                    <BoardEmbed model={model} actions={actions} onReview={openDeck} />
                ) : (
                    <>
                        <section className="flex flex-col gap-2">
                            <h2 className="section-label">Line</h2>
                            <div className="border-2 border-border-strong bg-card p-4">
                                <VisualReviewLine model={model} variant="full" />
                            </div>
                        </section>
                        <section className="flex flex-col gap-2">
                            <h2 className="section-label">Ask</h2>
                            <VisualReviewAsk model={model} onReview={openDeck} onAnswer={actions.onAnswer} answerOptions={['Use the demo account']} />
                            {model.phase !== 'needs_you' && <p className="font-mono text-[12px] text-text-muted">No ask in this phase.</p>}
                        </section>
                        <section className="flex flex-col gap-2">
                            <h2 className="section-label">Tray</h2>
                            <div className="border-2 border-border-strong bg-card p-4 shadow-[var(--card-shadow)]">
                                <VisualReviewTray model={model} onReview={openDeck} actions={actions} />
                            </div>
                        </section>
                    </>
                )}
            </main>

            {deck && (
                <VisualReviewDeck
                    {...deckProps}
                    layout="dialog"
                    open
                    startKey={deck.startKey}
                    initialCompare={deck.compare}
                    onClose={() => setDeck(null)}
                />
            )}
        </div>
    );
}

/**
 * The mission board's shape, for the mission-page wiring to match: a band
 * with a Screens cell, the Ask beside the other asks, and the auditor tile
 * whose body is the Tray. Placeholder numbers only.
 */
function BoardEmbed({ model, actions, onReview }: { model: import('@buildd/shared').VisualReviewModel; actions: VisualReviewPhaseActions; onReview: (k: string | null) => void }) {
    const needs = model.summary.awaitingHuman + (model.needsYou?.reason === 'question' || model.phase === 'boot_failed' ? 1 : 0);
    const cell = 'flex min-w-0 flex-col gap-2 border-border-default px-4 pb-4 pt-3.5';
    return (
        <div data-testid="visual-review-board-fixture" className="flex flex-col gap-4">
            <section className="grid grid-cols-2 border-2 border-border-strong bg-card shadow-[var(--card-shadow)] md:grid-cols-[1.2fr_1.6fr_0.8fr]">
                <div className={`${cell} border-b border-r md:border-b-0`}>
                    <span className="section-label">Landed</span>
                    <span className="font-mono text-[28px] font-semibold leading-none">5 <span className="text-[13px] font-normal text-text-muted">of 6</span></span>
                </div>
                <div className={`${cell} order-last col-span-2 border-t md:order-none md:col-span-1 md:border-r md:border-t-0`}>
                    <VisualReviewLine model={model} variant="full" />
                </div>
                <div className={`${cell} border-b md:border-b-0 ${needs ? 'bg-accent-soft' : ''}`}>
                    <span className={`section-label ${needs ? '!text-accent-text' : ''}`}>Needs you</span>
                    <span className={`font-mono text-[28px] font-semibold leading-none ${needs ? 'text-accent-text' : 'text-text-muted'}`}>{needs}</span>
                </div>
            </section>

            <VisualReviewAsk model={model} onReview={onReview} onAnswer={actions.onAnswer} answerOptions={['Use the demo account']} />

            <section className="flex flex-col gap-2.5">
                <span className="section-label">Verify</span>
                <div className="relative border-[1.5px] border-border-strong bg-card px-3 py-3 pl-4">
                    <span aria-hidden="true" className="absolute -bottom-[1.5px] -left-[1.5px] -top-[1.5px] w-1 bg-text-muted" />
                    <p className="mb-3 flex items-center gap-2 font-mono text-[13px] font-semibold">
                        <span className="border border-border-strong px-1.5 py-px text-[11px] uppercase tracking-[1px] text-text-secondary">Visual auditor</span>
                        <span className="min-w-0 truncate">{model.audit?.title ?? 'Visual audit'}</span>
                    </p>
                    <VisualReviewTray model={model} onReview={onReview} actions={actions} hideLine />
                </div>
            </section>
        </div>
    );
}
