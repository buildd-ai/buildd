'use client';

/**
 * `?state=stage-meter`: every StageMeter state (spec 9430a28f r2 R-9, AC-7),
 * once in colour and once in a greyscale-checkable layout (the whole block
 * under `filter: grayscale(1)`), so a reviewer can confirm each state still
 * differs from every other without hue.
 */
import StageMeter, { STAGE_METER_STATES, type StageMeterStage, type StageMeterState } from '@/components/ui/StageMeter';

const CASES: { state: StageMeterState; stage?: StageMeterStage; fixRounds?: number; note: string }[] = [
  { state: 'queued', note: 'dashed outline, nothing started' },
  { state: 'build', note: 'Build filled' },
  { state: 'fixing-in-build', fixRounds: 2, note: 'Build hatched, ↻2' },
  { state: 'verify', note: 'Build grey, Verify filled' },
  { state: 'fixing-in-verify', fixRounds: 3, note: 'Verify hatched, ↻3' },
  { state: 'check-cant-run', stage: 'verify', note: 'Verify outlined, ?' },
  { state: 'waiting-on-you', stage: 'verify', note: 'filled alert, !' },
  { state: 'deliver', note: 'Deliver filled' },
];

function Rows({ grey }: { grey?: boolean }) {
  return (
    <div
      className="card p-4 space-y-2"
      style={grey ? { filter: 'grayscale(1)' } : undefined}
      data-testid={grey ? 'stage-meter-greyscale' : 'stage-meter-colour'}
    >
      <p className="font-mono text-chip text-text-muted">{grey ? 'Greyscale' : 'Colour'}</p>
      {CASES.map(c => (
        <div key={c.state} className="flex items-center gap-3">
          <StageMeter state={c.state} stage={c.stage} fixRounds={c.fixRounds} />
          <span className="font-mono text-chip text-text-primary w-40">{c.state}</span>
          <span className="text-text-muted text-sm">{c.note}</span>
        </div>
      ))}
    </div>
  );
}

export default function StageMeterFixture() {
  return (
    <div className="min-h-screen bg-surface-1 p-4 space-y-4 max-w-xl">
      <h1 className="font-mono text-chip text-text-primary">StageMeter · {STAGE_METER_STATES.length} states</h1>
      <Rows />
      <Rows grey />
    </div>
  );
}
