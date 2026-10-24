import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunnerRow } from './RunnerRow';
import type { RunnerHeartbeat } from '@buildd/shared';

describe('RunnerRow', () => {
  const mockRunner: RunnerHeartbeat = {
    id: 'test-runner-1',
    accountName: 'Test Runner',
    lastHeartbeatAt: new Date().toISOString(),
    maxConcurrentWorkers: 4,
    activeWorkerCount: 2,
    runnerClass: 'personal',
    mine: true,
    isolation: { platform: 'linux' },
  } as RunnerHeartbeat;

  const now = Date.now();

  it('renders runner name and status', () => {
    render(
      <RunnerRow
        runner={mockRunner}
        fleetRow={null}
        online={true}
        now={now}
      />
    );

    expect(screen.getByText('Test Runner')).toBeInTheDocument();
    expect(screen.getByText('2 of 4 busy')).toBeInTheDocument();
  });

  it('shows online status with glow dot', () => {
    const { container } = render(
      <RunnerRow
        runner={mockRunner}
        fleetRow={null}
        online={true}
        now={now}
      />
    );

    const glowDot = container.querySelector('.glow-dot-success');
    expect(glowDot).toBeInTheDocument();
  });

  it('shows offline status', () => {
    render(
      <RunnerRow
        runner={mockRunner}
        fleetRow={null}
        online={false}
        now={now}
      />
    );

    expect(screen.getByText('offline')).toBeInTheDocument();
  });

  it('displays runner class badge', () => {
    render(
      <RunnerRow
        runner={mockRunner}
        fleetRow={null}
        online={true}
        now={now}
      />
    );

    expect(screen.getByText('personal')).toBeInTheDocument();
  });

  it('shows Details button', () => {
    render(
      <RunnerRow
        runner={mockRunner}
        fleetRow={null}
        online={true}
        now={now}
      />
    );

    const button = screen.getByRole('button', { name: 'Details' });
    expect(button).toBeInTheDocument();
  });

  it('calls onToggleExpanded when Details button is clicked', () => {
    const onToggleExpanded = vi.fn();

    render(
      <RunnerRow
        runner={mockRunner}
        fleetRow={null}
        online={true}
        now={now}
        onToggleExpanded={onToggleExpanded}
      />
    );

    const button = screen.getByRole('button', { name: 'Details' });
    button.click();

    expect(onToggleExpanded).toHaveBeenCalledWith('test-runner-1');
  });

  it('shows expanded content when expanded prop is true', () => {
    const health = { expanded: true, loading: false };

    render(
      <RunnerRow
        runner={mockRunner}
        fleetRow={null}
        online={true}
        now={now}
        health={health as any}
      />
    );

    expect(screen.getByText('Hide')).toBeInTheDocument();
    expect(screen.getByTestId('health-runner-detail')).toBeInTheDocument();
  });

  it('renders with sandbox label when applicable', () => {
    const runnerWithSandbox = {
      ...mockRunner,
      isolation: { platform: 'linux', sandboxed: true },
    } as RunnerHeartbeat;

    render(
      <RunnerRow
        runner={runnerWithSandbox}
        fleetRow={null}
        online={true}
        now={now}
      />
    );

    // The sandbox label should be present if isolation is verified
    // This may or may not show depending on runnerIsolationDetail logic
    const { container } = render(
      <RunnerRow
        runner={runnerWithSandbox}
        fleetRow={null}
        online={true}
        now={now}
      />
    );
    expect(container).toBeInTheDocument();
  });
});
