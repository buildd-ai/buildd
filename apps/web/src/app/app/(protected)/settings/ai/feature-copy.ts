import type { CapabilityDescriptor, InferenceCapability } from '@buildd/core/inference-policy';

/**
 * Wording for Settings → AI → "Features that call a model".
 *
 * The tradeoff (a model call is fast and billed to a provider key; the agent
 * path is slower and runs on a runner's seat) is the same for every row, so the
 * page states it once in FEATURE_TRADEOFF and each row only names its own
 * action. A row used to repeat "No agent fallback. This feature stays off until
 * you enable it." and every button said "Use inference".
 */
export const FEATURE_TRADEOFF =
  'Each feature here calls a model directly. You get an answer in seconds, billed to your provider key. ' +
  'All of them start off, and a stored key spends nothing until you turn one on. ' +
  'With goal grading off, an agent run on your runner grades instead. The other features only run when on.';

const BUTTONS: Record<InferenceCapability, { enable: string; disable: string }> = {
  chat: { enable: 'Turn on chat', disable: 'Turn off chat' },
  criteria_grading: { enable: 'Grade with a model', disable: 'Grade with an agent run' },
  visual_qa: { enable: 'Judge screenshots', disable: 'Stop judging screenshots' },
  task_classification: { enable: 'Classify new tasks', disable: 'Stop classifying' },
  mission_summary: { enable: 'Turn on summaries', disable: 'Turn off summaries' },
  task_category_shadow: { enable: 'Start the shadow check', disable: 'Stop the shadow check' },
};

export interface ToggleCopy {
  button: string;
  meta: string;
  /** Chat does nothing without a provider key, so its row links to the keys. */
  needsKeyHint: boolean;
  turnedOn: string;
  turnedOff: string;
}

export function capabilityToggleCopy(
  d: Pick<CapabilityDescriptor, 'id' | 'label' | 'fallback' | 'costHint'>,
  on: boolean,
): ToggleCopy {
  const b = BUTTONS[d.id] ?? { enable: `Turn on ${d.label.toLowerCase()}`, disable: `Turn off ${d.label.toLowerCase()}` };
  if (d.id === 'chat') {
    return {
      button: on ? b.disable : b.enable,
      meta: on ? `on · ${d.costHint}` : 'off',
      needsKeyHint: true,
      turnedOn: `Chat is on. Each turn bills your provider key (${d.costHint}).`,
      turnedOff: 'Chat is off. Nobody on the team sees it until you turn it back on.',
    };
  }
  return {
    button: on ? b.disable : b.enable,
    meta: on ? `on · ${d.costHint}` : d.fallback === 'agent' ? 'off · an agent run grades instead' : 'off',
    needsKeyHint: false,
    turnedOn: `${d.label} is on. Each call bills your provider key (${d.costHint}).`,
    turnedOff: d.fallback === 'agent'
      ? `${d.label} is off. An agent run does it instead, slower and on your runner's seat.`
      : `${d.label} is off.`,
  };
}
