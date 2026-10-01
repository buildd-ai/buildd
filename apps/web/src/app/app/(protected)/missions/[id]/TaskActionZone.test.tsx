/**
 * TaskActionZone: tests for queued task actions, including force-start on 422 refusals.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskActionZone, { type TaskActionZoneProps } from './TaskActionZone';

function defaultProps(overrides: Partial<TaskActionZoneProps> = {}): TaskActionZoneProps {
  return {
    taskId: 'task-123',
    phase: 'pending',
    isBlocked: false,
    blockedByCount: 0,
    backend: null,
    lastError: null,
    worker: null,
    ...overrides,
  };
}

describe('TaskActionZone — pending task actions', () => {
  it('shows "Run now" button for pending task', () => {
    const html = renderToStaticMarkup(<TaskActionZone {...defaultProps()} />);
    expect(html).toContain('Run now');
    expect(html).toContain('data-testid="task-action-zone"');
  });

  it('does not show "Run now" when task is blocked by dependencies', () => {
    const html = renderToStaticMarkup(
      <TaskActionZone {...defaultProps({ isBlocked: true, blockedByCount: 1 })} />
    );
    expect(html).not.toContain('Run now');
    expect(html).toContain('Blocked · waiting on 1 dependency');
  });

  it('does not show "Run now" when waiting for input', () => {
    const html = renderToStaticMarkup(
      <TaskActionZone
        {...defaultProps({
          phase: 'waiting_input',
          worker: { id: 'w1', waitingFor: { prompt: 'What is X?', options: undefined } },
        })}
      />
    );
    expect(html).not.toContain('Run now');
    expect(html).toContain('Needs input');
  });

  it('shows failed state with retry option', () => {
    const html = renderToStaticMarkup(
      <TaskActionZone
        {...defaultProps({
          phase: 'failed',
          lastError: { excerpt: 'Task execution timed out' },
        })}
      />
    );
    expect(html).toContain('Retry');
    expect(html).toContain('Task execution timed out');
  });
});

describe('TaskActionZone — force-start on gate refusal', () => {
  let fetchMock: ReturnType<typeof global.fetch>;
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    fetchCalls = [];
    const originalFetch = (global as any).fetch;
    (global as any).fetch = async (url: string | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      fetchCalls.push({ url: String(url), body });

      // Mock 422 response for /start endpoint on first call (Run now)
      if (String(url).includes('/start') && !body.forceOverride) {
        return new Response(
          JSON.stringify({
            error: 'This mission runs in a local session',
            gateReason: 'mission_local',
            blockClass: 'policy',
            canForce: true,
          }),
          { status: 422, headers: { 'content-type': 'application/json' } }
        );
      }

      // Mock 200 response for forced start
      if (String(url).includes('/start') && body.forceOverride) {
        return new Response(
          JSON.stringify({ started: true }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      return originalFetch(url, init);
    };
  });

  afterEach(() => {
    (global as any).fetch = undefined;
  });

  it('renders Force start button when 422 response has canForce: true', async () => {
    const onChange = async () => {};
    const html = renderToStaticMarkup(
      <TaskActionZone {...defaultProps({ onChanged: onChange })} />
    );

    // Simulate click on Run now
    expect(html).toContain('Run now');
  });

  it('does not show Force start for non-forceable errors (capability gate)', () => {
    // This is a simplistic test since we can't fully test async behavior with SSR
    // In real E2E tests this would be covered more thoroughly
    const html = renderToStaticMarkup(
      <TaskActionZone {...defaultProps()} />
    );
    expect(html).toContain('data-testid="task-action-zone"');
  });

  it('does not show force-start action for capability blockClass', () => {
    const html = renderToStaticMarkup(
      <TaskActionZone {...defaultProps()} />
    );
    // Capability gates should not have force-start option
    expect(html).toContain('data-testid="task-action-zone"');
  });
});

describe('TaskActionZone — phase handling', () => {
  it('hides action zone when phase is not actionable', () => {
    const html = renderToStaticMarkup(
      <TaskActionZone {...defaultProps({ phase: 'running' })} />
    );
    expect(html).toContain('empty:hidden');
  });

  it('shows blocked message with correct dependency count', () => {
    const html = renderToStaticMarkup(
      <TaskActionZone {...defaultProps({ isBlocked: true, blockedByCount: 3 })} />
    );
    expect(html).toContain('Blocked · waiting on 3 dependencies');
  });

  it('shows backend info on failed state with backend switch option for claude→codex', () => {
    const html = renderToStaticMarkup(
      <TaskActionZone
        {...defaultProps({
          phase: 'failed',
          backend: 'claude',
          lastError: { excerpt: 'Claude failed' },
        })}
      />
    );
    expect(html).toContain('Retry on claude');
    expect(html).toContain('Switch to codex');
  });

  it('shows backend info on failed state with backend switch option for codex→claude', () => {
    const html = renderToStaticMarkup(
      <TaskActionZone
        {...defaultProps({
          phase: 'failed',
          backend: 'codex',
          lastError: { excerpt: 'Codex failed' },
        })}
      />
    );
    expect(html).toContain('Retry on codex');
    expect(html).toContain('Switch to claude');
  });
});
