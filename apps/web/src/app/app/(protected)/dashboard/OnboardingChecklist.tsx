'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface OnboardingChecklistProps {
  hasGithub: boolean;
  hasWorkspaces: boolean;
  hasCompletedTask: boolean;
  hasConnectedAgent: boolean;
  githubConfigured: boolean;
}

const DISMISS_KEY = 'buildd-onboarding-dismissed';

export default function OnboardingChecklist({
  hasGithub,
  hasWorkspaces,
  hasCompletedTask,
  hasConnectedAgent,
  githubConfigured,
}: OnboardingChecklistProps) {
  const [dismissed, setDismissed] = useState(true); // Start hidden to avoid flash

  useEffect(() => {
    const stored = localStorage.getItem(DISMISS_KEY);
    setDismissed(stored === 'true');
  }, []);

  const steps = [
    ...(githubConfigured
      ? [
          {
            id: 'github',
            label: 'Connect GitHub',
            description: 'Link your GitHub org to auto-discover repos',
            done: hasGithub,
            href: '/api/github/install',
            external: true,
          },
        ]
      : []),
    {
      id: 'workspace',
      label: 'Create a workspace',
      description: 'Workspaces map to repositories your agents work on',
      done: hasWorkspaces,
      href: '/app/workspaces/new',
      external: false,
    },
    {
      id: 'cli',
      label: 'Install CLI & login',
      description: 'Connect your local machine to buildd',
      done: hasConnectedAgent,
      href: null,
      external: false,
      code: 'curl https://buildd.dev/install.sh | bash && buildd login',
    },
    {
      id: 'task',
      label: 'Create your first task',
      description: 'Assign work for agents to pick up and execute',
      done: hasCompletedTask,
      href: '/app/tasks/new',
      external: false,
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  const allDone = completedCount === steps.length;

  if (dismissed || allDone) return null;

  function handleDismiss() {
    localStorage.setItem(DISMISS_KEY, 'true');
    setDismissed(true);
  }

  return (
    <div className="mb-8 bg-surface-2 border border-border-default rounded-[10px] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border-default">
        <div className="flex items-center gap-3">
          <div className="font-mono text-[10px] uppercase tracking-[2px] text-text-muted">
            Getting Started
          </div>
          <span className="text-[12px] text-text-muted">
            {completedCount}/{steps.length}
          </span>
        </div>
        <button
          onClick={handleDismiss}
          className="p-1 rounded hover:bg-surface-3 text-text-muted hover:text-text-secondary"
          title="Dismiss"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-[2px] bg-surface-3">
        <div
          className="h-full bg-primary transition-all duration-500"
          style={{ width: `${(completedCount / steps.length) * 100}%` }}
        />
      </div>

      <div className="divide-y divide-border-default/40">
        {steps.map((step, i) => (
          <div
            key={step.id}
            className={`flex items-start gap-4 px-5 py-4 ${step.done ? 'opacity-60' : ''}`}
          >
            {/* Step indicator */}
            <div className="flex-shrink-0 mt-0.5">
              {step.done ? (
                <div className="w-6 h-6 rounded-full bg-status-success/15 flex items-center justify-center">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--status-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              ) : (
                <div className="w-6 h-6 rounded-full border border-border-default flex items-center justify-center">
                  <span className="text-[11px] font-mono text-text-muted">{i + 1}</span>
                </div>
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-text-primary">{step.label}</div>
              <div className="text-[12px] text-text-muted mt-0.5">{step.description}</div>

              {/* Code snippet for CLI step */}
              {step.code && !step.done && (
                <div className="mt-2 px-3 py-2 bg-surface-3 rounded-[6px] font-mono text-[11px] text-text-secondary overflow-x-auto">
                  {step.code}
                </div>
              )}
            </div>

            {/* Action */}
            {!step.done && step.href && (
              step.external ? (
                <a
                  href={step.href}
                  className="flex-shrink-0 px-3 py-[5px] text-xs bg-primary/10 text-primary rounded-[6px] hover:bg-primary/20 whitespace-nowrap"
                >
                  Connect
                </a>
              ) : (
                <Link
                  href={step.href}
                  className="flex-shrink-0 px-3 py-[5px] text-xs bg-primary/10 text-primary rounded-[6px] hover:bg-primary/20 whitespace-nowrap"
                >
                  {step.id === 'workspace' ? 'Create' : 'New Task'}
                </Link>
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
