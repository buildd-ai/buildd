'use client';

import Capacity from '@/components/ui/Capacity';
import IdleAlert from '@/components/ui/IdleAlert';

export const CAPACITY_FIXTURE_STATE = 'capacity-and-idle-alert';

const mockChart = [
  22, 30, 18, 12, 100, 100, 100, 44, 67, 89, 78, 56, 61, 72, 50, 39, 44, 58, 63, 47, 35, 28, 33, 33,
];

export default function CapacityAndIdleAlertFixture() {
  return (
    <div
      style={{
        padding: '16px',
        background: 'var(--surface-1)',
        minHeight: '100vh',
        fontFamily: 'var(--font-sans)',
        color: 'var(--text-primary)',
      }}
    >
      <div style={{ maxWidth: '800px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '32px' }}>
        <section>
          <h2 style={{ marginTop: 0 }}>Capacity Component</h2>
          <div
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '16px',
            }}
          >
            <Capacity
              running={3}
              total={9}
              runnersOnline={2}
              totalRunners={3}
              sessions={2}
              peak={8}
              average={4.6}
              chart={mockChart}
            />
          </div>
        </section>

        <section>
          <h2 style={{ marginTop: 0 }}>Idle Alert - With Issues</h2>
          <div
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '16px',
            }}
          >
            <IdleAlert
              idleSlots={4}
              queuedTasks={3}
              cause="no reviewer runner"
              href="#queue"
            />
          </div>
        </section>

        <section>
          <h2 style={{ marginTop: 0 }}>Idle Alert - Different Cause</h2>
          <div
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '16px',
            }}
          >
            <IdleAlert
              idleSlots={6}
              queuedTasks={5}
              cause="all runners at capacity limit"
              href="#queue"
            />
          </div>
        </section>

        <section>
          <h2 style={{ marginTop: 0 }}>Idle Alert - No Issues (Empty)</h2>
          <div
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '16px',
              minHeight: '40px',
              display: 'flex',
              alignItems: 'center',
              color: 'var(--text-secondary)',
            }}
          >
            <IdleAlert
              idleSlots={0}
              queuedTasks={0}
              cause="healthy"
              href="#queue"
            />
            <span>(No alert shown)</span>
          </div>
        </section>

        <section>
          <h2 style={{ marginTop: 0 }}>Capacity at Different Peak/Avg Values</h2>
          <div
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '16px',
            }}
          >
            <Capacity
              running={12}
              total={15}
              runnersOnline={3}
              totalRunners={5}
              sessions={1}
              peak={15}
              average={9.2}
              chart={mockChart}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
