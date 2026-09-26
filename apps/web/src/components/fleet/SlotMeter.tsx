/**
 * One square per concurrent-worker slot, filled for each slot in use.
 * Past `MAX_SQUARES` the meter stops drawing squares and the number carries it.
 */
const MAX_SQUARES = 16;

export function SlotMeter({ live, max, size = 'sm', className = '' }: { live: number; max: number; size?: 'sm' | 'lg'; className?: string }) {
  const n = Math.min(Math.max(max, 0), MAX_SQUARES);
  const box = size === 'lg' ? 'h-[14px] w-[14px]' : 'h-2.5 w-2.5';
  return (
    <span
      data-testid="slot-meter"
      role="img"
      aria-label={`${live} of ${max} slots in use`}
      className={`flex ${size === 'lg' ? 'gap-1' : 'gap-[3px]'} ${className}`}
    >
      {Array.from({ length: n }, (_, i) => (
        <i
          key={i}
          className={`inline-block ${box} border ${i < live ? 'border-accent bg-accent' : 'border-border-strong'}`}
        />
      ))}
    </span>
  );
}
