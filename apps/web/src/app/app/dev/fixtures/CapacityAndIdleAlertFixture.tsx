'use client';

import UiCapacity from '@/components/delivery/UiCapacity';
import UiIdleAlert from '@/components/delivery/UiIdleAlert';

export const CAPACITY_FIXTURE_STATE = 'capacity-and-idle-alert';

const mockChart = [
  22, 30, 18, 12, 100, 100, 100, 44, 67, 89, 78, 56, 61, 72, 50, 39, 44, 58, 63, 47, 35, 28, 33, 33,
];

export default function CapacityAndIdleAlertFixture() {
  return (
    <div
      style={{
        padding: '16px',
        background: '#F7F5F0',
        minHeight: '100vh',
        fontFamily: "'Schibsted Grotesk', system-ui, sans-serif",
        color: '#26231F',
      }}
    >
      <div style={{ maxWidth: '800px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '32px' }}>
        <section>
          <h2 style={{ marginTop: 0 }}>Capacity Component</h2>
          <div
            style={{
              background: '#FDFCF9',
              border: '1px solid #E3DED5',
              borderRadius: '6px',
              padding: '16px',
            }}
          >
            <UiCapacity
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
              background: '#FDFCF9',
              border: '1px solid #E3DED5',
              borderRadius: '6px',
              padding: '16px',
            }}
          >
            <UiIdleAlert
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
              background: '#FDFCF9',
              border: '1px solid #E3DED5',
              borderRadius: '6px',
              padding: '16px',
            }}
          >
            <UiIdleAlert
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
              background: '#FDFCF9',
              border: '1px solid #E3DED5',
              borderRadius: '6px',
              padding: '16px',
              minHeight: '40px',
              display: 'flex',
              alignItems: 'center',
              color: '#6B655C',
            }}
          >
            <UiIdleAlert
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
              background: '#FDFCF9',
              border: '1px solid #E3DED5',
              borderRadius: '6px',
              padding: '16px',
            }}
          >
            <UiCapacity
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
