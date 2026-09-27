'use client';

/**
 * "Steer" — opens the chat canvas rescoped to one running worker (SteerConversation.tsx),
 * from a running task's card or row: the tasks list, mission Board tiles, home's
 * fleet slot. Null with no chat canvas in context (chat unavailable, or outside
 * the protected layout) rather than a dead button.
 */
import { useChatCanvas } from './canvas-context';

export default function SteerButton({ taskId, className }: { taskId: string; className?: string }) {
  const canvas = useChatCanvas();
  if (!canvas) return null;
  return (
    <button
      type="button"
      data-testid="steer-trigger"
      aria-label="Steer this agent"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); canvas.openSteer(taskId); }}
      className={className ?? 'relative z-10 shrink-0 font-mono text-[11px] font-semibold text-accent-text hover:underline'}
    >
      Steer
    </button>
  );
}
