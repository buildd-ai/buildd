import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RunnerSlotDetail from './RunnerSlotDetail';
import type { RunnerHeartbeat } from '@buildd/shared';

describe('RunnerSlotDetail', () => {
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

  it('renders runner dimensions', () => {
    render(
      <RunnerSlotDetail
        fleetRow={null}
        runner={mockRunner}
        online={true}
        lastHeartbeatAt={mockRunner.lastHeartbeatAt}
        now={now}
        seesTeamWork={true}
        ownerLabel="personal"
        route={{ claude: 'api', codex: 'api' }}
      />
    );

    expect(screen.getByText('Runner')).toBeInTheDocument();
    expect(screen.getByText('personal')).toBeInTheDocument();
    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.getByText('Route')).toBeInTheDocument();
  });

  it('displays connectivity status', () => {
    render(
      <RunnerSlotDetail
        fleetRow={null}
        runner={mockRunner}
        online={true}
        lastHeartbeatAt={mockRunner.lastHeartbeatAt}
        now={now}
        seesTeamWork={true}
        ownerLabel="personal"
        route={{ claude: 'api', codex: 'api' }}
      />
    );

    expect(screen.getByText(/Connected/)).toBeInTheDocument();
  });

  it('shows offline status', () => {
    render(
      <RunnerSlotDetail
        fleetRow={null}
        runner={mockRunner}
        online={false}
        lastHeartbeatAt={mockRunner.lastHeartbeatAt}
        now={now}
        seesTeamWork={true}
        ownerLabel="personal"
        route={{ claude: 'api', codex: 'api' }}
      />
    );

    expect(screen.getByText(/Offline/)).toBeInTheDocument();
  });

  it('shows message when no slots reported', () => {
    render(
      <RunnerSlotDetail
        fleetRow={null}
        runner={mockRunner}
        online={true}
        lastHeartbeatAt={mockRunner.lastHeartbeatAt}
        now={now}
        seesTeamWork={true}
        ownerLabel="personal"
        route={{ claude: 'api', codex: 'api' }}
      />
    );

    expect(screen.getByText('No slot detail reported for this runner.')).toBeInTheDocument();
  });

  it('shows failure status', () => {
    render(
      <RunnerSlotDetail
        fleetRow={null}
        runner={mockRunner}
        online={true}
        lastHeartbeatAt={mockRunner.lastHeartbeatAt}
        now={now}
        seesTeamWork={true}
        ownerLabel="personal"
        route={{ claude: 'api', codex: 'api' }}
      />
    );

    expect(screen.getByText('No failed last runs on these slots')).toBeInTheDocument();
  });
});
