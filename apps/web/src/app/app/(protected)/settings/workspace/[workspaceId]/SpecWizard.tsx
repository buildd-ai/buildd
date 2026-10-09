'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MAX_SPEC_CAPABILITIES, ONBOARDING_INTERVIEW } from '@buildd/shared';
import type { InterviewIssue, InterviewQuestionId } from '@buildd/shared';
import {
    draftToAnswers,
    emptyCapabilityDraft,
    emptySpecDraft,
    missionHref,
    type CapabilityDraft,
    type ExampleDraft,
    type SpecDraft,
} from '@/lib/onboarding-view';

const INPUT = 'w-full px-3 py-2 text-base md:text-sm border border-border-default bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary';

const prompt = (id: InterviewQuestionId) => ONBOARDING_INTERVIEW.find((q) => q.id === id)?.prompt ?? id;

interface Preview {
    path: string;
    markdown: string;
    warnings: string[];
    dropped: unknown[];
    mergePolicy?: unknown;
}

type Phase =
    | { kind: 'edit' }
    | { kind: 'preview'; preview: Preview }
    | { kind: 'created'; preview: Preview; taskId: string };

function ExampleFields({ label, value, onChange, testId }: {
    label: string;
    value: ExampleDraft;
    onChange: (next: ExampleDraft) => void;
    testId: string;
}) {
    return (
        <fieldset className="space-y-1">
            <legend className="text-xs text-text-muted">{label}</legend>
            {(['given', 'when', 'then'] as const).map((k) => (
                <input
                    key={k}
                    data-testid={`${testId}-${k}`}
                    aria-label={`${label}: ${k}`}
                    className={INPUT}
                    placeholder={k.toUpperCase()}
                    value={value[k]}
                    onChange={(e) => onChange({ ...value, [k]: e.target.value })}
                />
            ))}
        </fieldset>
    );
}

/**
 * Q1-Q8 of the shared interview (`ONBOARDING_INTERVIEW`), one form. Nothing
 * here knows the spec format: the route renders, validates and re-asks.
 *
 *   Preview → POST /api/workspaces/[id]/onboarding/spec            (dry run)
 *   Confirm → POST /api/workspaces/[id]/onboarding/spec { confirm } (one PR task)
 */
export function SpecWizard({ workspaceId }: { workspaceId: string }) {
    const [draft, setDraft] = useState<SpecDraft>(emptySpecDraft);
    const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [issues, setIssues] = useState<InterviewIssue[]>([]);

    const setCap = (i: number, next: CapabilityDraft) =>
        setDraft((d) => ({ ...d, capabilities: d.capabilities.map((c, j) => (j === i ? next : c)) }));

    async function post(confirm: boolean) {
        setBusy(true);
        setError(null);
        setIssues([]);
        try {
            const res = await fetch(`/api/workspaces/${workspaceId}/onboarding/spec`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ answers: draftToAnswers(draft), ...(confirm ? { confirm: true } : { dryRun: true }) }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setIssues(Array.isArray(data.issues) ? data.issues : []);
                setError(data.error || 'Could not render the spec');
                if (!confirm) setPhase({ kind: 'edit' });
                return;
            }
            const preview: Preview = {
                path: data.path,
                markdown: data.markdown,
                warnings: data.warnings ?? [],
                dropped: data.dropped ?? [],
                mergePolicy: data.mergePolicy,
            };
            setPhase(confirm ? { kind: 'created', preview, taskId: data.task?.id } : { kind: 'preview', preview });
        } catch {
            setError('Network error. Try again.');
        } finally {
            setBusy(false);
        }
    }

    if (phase.kind === 'created') {
        return (
            <div className="py-4 first:pt-0 last:pb-0" data-testid="spec-wizard">
                <h3 className="text-sm font-medium text-text-primary mb-0.5">Draft spec requested</h3>
                <p className="text-sm text-text-secondary mb-3" data-testid="spec-wizard-created">
                    A builder will open a PR adding <code>{phase.preview.path}</code> as a draft. Review and merge it when ready.
                </p>
                <Link href={missionHref(workspaceId)} data-testid="spec-wizard-mission-link" className="btn btn-primary min-h-11">
                    Plan your first mission
                </Link>
            </div>
        );
    }

    return (
        <div className="py-4 first:pt-0 last:pb-0" data-testid="spec-wizard">
            <h3 className="text-sm font-medium text-text-primary mb-0.5">First spec</h3>
            <p className="text-xs text-text-muted mb-3">
                Answer a few questions. You see the rendered draft before anything is created, and a PR you merge is the only thing that lands.
            </p>

            {phase.kind === 'preview' ? (
                <div data-testid="spec-wizard-preview">
                    <p className="text-xs text-text-muted mb-1">Will add</p>
                    <p className="text-sm font-mono break-all mb-2" data-testid="spec-wizard-preview-path">{phase.preview.path}</p>
                    <pre className="text-xs bg-surface-2 border border-border-default p-3 overflow-x-auto max-h-96 whitespace-pre-wrap break-words">
                        {phase.preview.markdown}
                    </pre>
                    {phase.preview.warnings.length > 0 && (
                        <ul className="text-xs text-status-warning mt-2 list-disc pl-4">
                            {phase.preview.warnings.map((w, i) => <li key={i}>{w}</li>)}
                        </ul>
                    )}
                    <div className="flex flex-wrap gap-2 mt-3">
                        <button type="button" className="btn min-h-11" disabled={busy} onClick={() => setPhase({ kind: 'edit' })}>
                            Edit answers
                        </button>
                        <button
                            type="button"
                            data-testid="spec-wizard-confirm"
                            className="btn btn-primary min-h-11"
                            disabled={busy}
                            onClick={() => post(true)}
                        >
                            {busy ? 'Creating…' : 'Confirm and open PR'}
                        </button>
                    </div>
                </div>
            ) : (
                <form
                    className="space-y-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        post(false);
                    }}
                >
                    <div className="space-y-2">
                        <label className="block text-sm" htmlFor="spec-title">{prompt('Q1')}</label>
                        <input
                            id="spec-title"
                            data-testid="spec-title"
                            className={INPUT}
                            placeholder="Product name"
                            value={draft.title}
                            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                        />
                        <textarea
                            data-testid="spec-description"
                            aria-label="Description"
                            className={INPUT}
                            rows={2}
                            placeholder="What it is and who uses it"
                            value={draft.description}
                            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                        />
                    </div>

                    <p className="text-sm">{prompt('Q2')}</p>
                    {draft.capabilities.map((cap, i) => (
                        <fieldset key={i} className="border border-border-default p-3 space-y-3" data-testid={`spec-capability-${i}`}>
                            <legend className="text-xs text-text-muted px-1">Capability {i + 1}</legend>
                            <input
                                data-testid={`spec-capability-${i}-name`}
                                aria-label={`Capability ${i + 1} name`}
                                className={INPUT}
                                placeholder="e.g. charge a cart exactly once"
                                value={cap.name}
                                onChange={(e) => setCap(i, { ...cap, name: e.target.value })}
                            />
                            <label className="block text-xs text-text-muted">
                                {prompt('Q3')} (one per line)
                                <textarea
                                    data-testid={`spec-capability-${i}-invariants`}
                                    className={`${INPUT} mt-1`}
                                    rows={2}
                                    value={cap.invariants}
                                    onChange={(e) => setCap(i, { ...cap, invariants: e.target.value })}
                                />
                            </label>
                            <p className="text-xs text-text-muted">{prompt('Q4')}</p>
                            <ExampleFields
                                label="Works"
                                testId={`spec-capability-${i}-accepted`}
                                value={cap.accepted}
                                onChange={(accepted) => setCap(i, { ...cap, accepted })}
                            />
                            <ExampleFields
                                label="Must be rejected"
                                testId={`spec-capability-${i}-rejected`}
                                value={cap.rejected}
                                onChange={(rejected) => setCap(i, { ...cap, rejected })}
                            />
                            <label className="block text-xs text-text-muted">
                                {prompt('Q5')} (one path per line, optional)
                                <textarea
                                    className={`${INPUT} mt-1`}
                                    rows={2}
                                    value={cap.codePaths}
                                    onChange={(e) => setCap(i, { ...cap, codePaths: e.target.value })}
                                />
                            </label>
                            {draft.capabilities.length > 1 && (
                                <button
                                    type="button"
                                    className="btn btn-quiet min-h-11"
                                    onClick={() => setDraft((d) => ({ ...d, capabilities: d.capabilities.filter((_, j) => j !== i) }))}
                                >
                                    Remove capability
                                </button>
                            )}
                        </fieldset>
                    ))}
                    {draft.capabilities.length < MAX_SPEC_CAPABILITIES && (
                        <button
                            type="button"
                            data-testid="spec-add-capability"
                            className="btn min-h-11"
                            onClick={() => setDraft((d) => ({ ...d, capabilities: [...d.capabilities, emptyCapabilityDraft()] }))}
                        >
                            Add capability
                        </button>
                    )}

                    {([
                        ['Q6', 'outOfScope'],
                        ['Q7', 'verification'],
                        ['Q8', 'protectedAreas'],
                    ] as const).map(([q, field]) => (
                        <label key={q} className="block text-xs text-text-muted">
                            {prompt(q)} (one per line, optional)
                            <textarea
                                className={`${INPUT} mt-1`}
                                rows={2}
                                value={draft[field]}
                                onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                            />
                        </label>
                    ))}

                    {error && (
                        <div role="alert" data-testid="spec-wizard-error" className="text-xs text-status-error">
                            <p>{error}</p>
                            {issues.length > 0 && (
                                <ul className="list-disc pl-4 mt-1">
                                    {issues.map((iss, i) => <li key={i}>{iss.message}</li>)}
                                </ul>
                            )}
                        </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                        <button type="submit" data-testid="spec-wizard-preview-button" className="btn btn-primary min-h-11" disabled={busy}>
                            {busy ? 'Rendering…' : 'Preview spec'}
                        </button>
                        <Link href={missionHref(workspaceId)} className="btn min-h-11">
                            Skip to first mission
                        </Link>
                    </div>
                </form>
            )}

            {phase.kind === 'preview' && error && (
                <p role="alert" className="text-xs text-status-error mt-3">{error}</p>
            )}
        </div>
    );
}
