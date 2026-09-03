interface AgentRecommendationProps {
  recommendation?: string | null;
  /** Show an explicit gap notice when the handoff was expected but absent. */
  expected?: boolean;
  tone?: 'error' | 'muted';
}

/**
 * The last agent's advice on what to do next, shown on cards where a human is
 * being asked to decide something an agent already tried and failed at.
 */
export function AgentRecommendation({ recommendation, expected = false, tone = 'muted' }: AgentRecommendationProps) {
  if (recommendation) {
    const border = tone === 'error' ? 'border-status-error/30' : 'border-border-default';
    return (
      <p className={`text-[12px] text-text-primary mt-1.5 border-l-2 ${border} pl-2`}>
        <span className="text-text-muted">Agent recommends: </span>
        {recommendation}
      </p>
    );
  }
  if (!expected) return null;
  return (
    <p className="text-[11px] text-text-muted mt-1.5 italic">
      No handoff recommendation recorded by the last attempt.
    </p>
  );
}
