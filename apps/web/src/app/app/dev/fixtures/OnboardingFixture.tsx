'use client';

/**
 * `?state=onboarding&view=checklist|no-repo|spec`: the workspace onboarding
 * card with a stubbed readiness report. The real card lives on a page behind a
 * workspace and a GitHub tree fetch, so a route screenshot cannot reach it.
 */
import { useState } from 'react';
import type { WorkspaceReadinessItem, WorkspaceReadinessReport } from '@buildd/shared';
import { ReadinessCard } from '../../(protected)/workspaces/[id]/config/ReadinessCard';

export const ONBOARDING_FIXTURE_VIEWS = ['checklist', 'no-repo', 'spec'] as const;
export type OnboardingFixtureView = (typeof ONBOARDING_FIXTURE_VIEWS)[number];

const item = (over: Partial<WorkspaceReadinessItem>): WorkspaceReadinessItem => ({
  id: 'test-command',
  label: 'Test command',
  status: 'missing',
  importance: 'core',
  evidence: [{ kind: 'absent', note: 'Nothing found.' }],
  fix: null,
  ...over,
});

export function onboardingFixtureReport(view: OnboardingFixtureView): WorkspaceReadinessReport {
  const scaffold = (summary: string, templateId: string) => ({ kind: 'scaffold' as const, summary, templateId });
  const items = [
    item({ id: 'agent-instructions', label: 'Agent instructions', fix: scaffold('Add a CLAUDE.md that names the test and build commands.', 'agent-instructions') }),
    item({ id: 'test-command', label: 'Test command', status: 'detected', value: 'bun run test', evidence: [] }),
    item({ id: 'typecheck-command', label: 'Typecheck command', status: 'unknown', evidence: [{ kind: 'signal', note: 'The manifest could not be read.' }] }),
    item({ id: 'spec-root', label: 'Spec directory', importance: 'recommended', fix: scaffold('Add a specs directory with a format note.', 'spec-root') }),
    item({ id: 'release-path', label: 'Release path', importance: 'recommended', waived: { reason: 'Released by another team', at: '2026-01-01T00:00:00.000Z' } }),
  ];
  if (view === 'no-repo') return { items: [], nextStep: 'link-repo', skill: 'workspace-onboarding', truncated: false };
  if (view === 'spec') {
    return {
      items: items.map((i) => (i.id === 'spec-root' ? { ...i, status: 'detected' as const, fix: null, evidence: [] } : i)).filter((i) => i.id !== 'agent-instructions'),
      nextStep: 'author-spec',
      skill: 'workspace-onboarding',
      truncated: false,
    };
  }
  return { items, nextStep: 'propose-fixes', skill: 'workspace-onboarding', truncated: false };
}

function installStub(view: OnboardingFixtureView) {
  if (typeof window === 'undefined') return;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const real = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    if (url.endsWith('/readiness')) return Promise.resolve(json(onboardingFixtureReport(view)));
    if (url.endsWith('/api/github/installations')) return Promise.resolve(json({ configured: true, installations: [{ id: 'fixture', accountLogin: 'example-org' }] }));
    if (url.includes('/api/github/installations/')) return Promise.resolve(json({ repos: [] }));
    return real(input, init);
  }) as typeof fetch;
}

export default function OnboardingFixture({ view }: { view: OnboardingFixtureView }) {
  // Installed before the card's mount effect fires, which a child effect would otherwise beat.
  useState(() => installStub(view));
  return (
    <main className="min-h-screen p-4 md:p-8 bg-surface-1">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl md:text-3xl font-bold mb-8">Git Workflow Configuration</h1>
        <ReadinessCard workspaceId="fixture-workspace" />
      </div>
    </main>
  );
}
