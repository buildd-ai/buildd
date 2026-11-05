import type { ChipTone } from '@/components/ui/Chip';
import type { RiskTier } from '@buildd/spec-contract/risk-tier';

/** How a tier reads and which chip tone carries it (Living Spec b7fc9316 R-32, R-33). */
export const TIER_WORD: Record<RiskTier, string> = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' };
export const TIER_CHIP: Record<RiskTier, ChipTone> = { high: 'error', medium: 'warning', low: 'muted' };
