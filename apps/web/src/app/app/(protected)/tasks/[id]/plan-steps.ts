export interface PlanStep {
  id: number;
  text: string;
  depth: number;
}

/**
 * Parse plan markdown into structured steps.
 * Recognizes:
 * - Numbered lists: `1. Step text`
 * - Markdown checkboxes: `- [ ] Step text` / `- [x] Step text`
 * - Phase/Step headings: `## Phase N` / `### Step N`
 */
export function parsePlanSteps(markdown: string): PlanStep[] {
  const lines = markdown.split('\n');
  const steps: PlanStep[] = [];
  let id = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Numbered list: `1. Step text`
    const numberedMatch = trimmed.match(/^\d+\.\s+(.+)/);
    if (numberedMatch) {
      steps.push({ id: id++, text: numberedMatch[1].trim(), depth: indent >= 4 ? 1 : 0 });
      continue;
    }

    // Checkbox: `- [ ] Step text` or `- [x] Step text`
    const checkboxMatch = trimmed.match(/^-\s+\[[ xX]\]\s+(.+)/);
    if (checkboxMatch) {
      steps.push({ id: id++, text: checkboxMatch[1].trim(), depth: indent >= 4 ? 1 : 0 });
      continue;
    }

    // Heading: `## Phase 1: Setup` or `### Step 2: Implementation`
    const headingMatch = trimmed.match(/^(#{2,4})\s+(.+)/);
    if (headingMatch) {
      const headingLevel = headingMatch[1].length;
      // Only treat as steps if they look like phases/steps
      const text = headingMatch[2].trim();
      if (/^(phase|step|part|stage)\s/i.test(text) || headingLevel >= 3) {
        steps.push({ id: id++, text, depth: headingLevel > 2 ? 1 : 0 });
      }
    }
  }

  return steps;
}

/**
 * Fuzzy-match a milestone label against plan step text.
 * Returns the index of the best matching step, or -1.
 */
export function matchMilestoneToStep(
  milestoneLabel: string,
  steps: PlanStep[]
): number {
  if (!milestoneLabel || steps.length === 0) return -1;

  const normalizedLabel = milestoneLabel.toLowerCase();

  // Extract key nouns (3+ char words, skip common verbs/prepositions)
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'will', 'should', 'into', 'using']);
  const keywords = normalizedLabel
    .split(/\W+/)
    .filter(w => w.length >= 3 && !stopWords.has(w));

  if (keywords.length === 0) return -1;

  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < steps.length; i++) {
    const stepText = steps[i].text.toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
      if (stepText.includes(keyword)) score++;
    }
    // Require at least 1 match
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}
