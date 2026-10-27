'use client';

/**
 * `?state=delivery-bar`: DeliveryBar in each outcome and duration (spec
 * 9430a28f r2 R-16, AC-15), in colour and under `filter: grayscale(1)` so the
 * marks can be checked without hue.
 */
import DeliveryBar, { type DeliveryOutcome } from '@/components/ui/DeliveryBar';

const CASES: { name: string; start: number; end: number; verifyStart?: number; fixRounds: number[]; outcome: DeliveryOutcome }[] = [
  { name: 'done, two fixes', start: 0.15, end: 0.6, verifyStart: 0.35, fixRounds: [0.28, 0.45], outcome: 'delivered' },
  { name: 'not done', start: 0.3, end: 0.7, verifyStart: 0.5, fixRounds: [0.55], outcome: 'not-delivered' },
  { name: 'came to you', start: 0.1, end: 0.5, verifyStart: 0.3, fixRounds: [0.2, 0.4, 0.45], outcome: 'came-to-you' },
  { name: 'very short', start: 0.5, end: 0.502, fixRounds: [], outcome: 'delivered' },
  { name: 'very long', start: 0, end: 1, verifyStart: 0.6, fixRounds: [0.2, 0.5, 0.8], outcome: 'delivered' },
  { name: 'zero fixes', start: 0.25, end: 0.55, fixRounds: [], outcome: 'delivered' },
];

function Rows({ grey }: { grey?: boolean }) {
  return (
    <div
      className="card p-4 space-y-3"
      style={grey ? { filter: 'grayscale(1)' } : undefined}
      data-testid={grey ? 'delivery-bar-greyscale' : 'delivery-bar-colour'}
    >
      <p className="font-mono text-chip text-text-muted">{grey ? 'Greyscale' : 'Colour'}</p>
      {CASES.map(c => (
        <div key={c.name} className="space-y-1">
          <span className="font-mono text-chip text-text-primary">{c.name}</span>
          <DeliveryBar start={c.start} end={c.end} verifyStart={c.verifyStart} fixRounds={c.fixRounds} outcome={c.outcome} />
        </div>
      ))}
    </div>
  );
}

export default function DeliveryBarFixture() {
  return (
    <div className="min-h-screen bg-surface-1 p-4 space-y-4 max-w-xl">
      <h1 className="font-mono text-chip text-text-primary">DeliveryBar · {CASES.length} cases</h1>
      <Rows />
      <Rows grey />
    </div>
  );
}
