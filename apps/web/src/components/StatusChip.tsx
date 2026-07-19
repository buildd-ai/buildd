import type { MergePolicyTier } from '@buildd/shared';

const TIER_CONFIG: Record<MergePolicyTier, { label: string; className: string }> = {
  'auto-threshold': {
    label: 'Auto',
    className: 'bg-status-success/10 text-status-success border-status-success/20',
  },
  'agent-review': {
    label: 'Agent Review',
    className: 'bg-status-warning/10 text-status-warning border-status-warning/20',
  },
  'human': {
    label: 'Human Gate',
    className: 'bg-status-error/10 text-status-error border-status-error/20',
  },
};

interface Props {
  policyTier: MergePolicyTier;
  waitingMinutes?: number;
  className?: string;
}

export function StatusChip({ policyTier, waitingMinutes, className = '' }: Props) {
  const cfg = TIER_CONFIG[policyTier];

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded border whitespace-nowrap ${cfg.className} ${className}`}
    >
      {cfg.label}
      {waitingMinutes != null && waitingMinutes > 0 && (
        <span className="opacity-70 font-normal">
          · {waitingMinutes < 60
            ? `${waitingMinutes}m`
            : `${Math.floor(waitingMinutes / 60)}h${waitingMinutes % 60 > 0 ? `${waitingMinutes % 60}m` : ''}`}
        </span>
      )}
    </span>
  );
}
