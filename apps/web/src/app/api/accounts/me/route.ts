import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import {
  learnOauthCapacity,
  oauthBudgetPressure,
  readPacingConfig,
  windowEndsAt,
} from '@buildd/core/oauth-budget';
import { loadOauthEpisodes, measureOauthWindow, resolveSeatIdPeers } from '@/lib/oauth-budget-window';

// GET /api/accounts/me - Get current account info from API key
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  // OAuth budget pacing readout. This is the only human-facing surface for the
  // learned session ceiling — deliberately hung off an endpoint that already
  // exists rather than a new settings page: `curl /api/accounts/me` answers
  // "what does buildd think my window holds, and how full is it right now?".
  // Absent for API-billed accounts (they have a real cost signal instead).
  let budgetPacing: Record<string, unknown> | undefined;
  if (account.authType === 'oauth') {
    const config = readPacingConfig(process.env);
    try {
      const accountIds = await resolveSeatIdPeers({
        id: account.id,
        teamId: account.teamId ?? '',
        seatId: account.seatId ?? null,
      });
      const episodes = await loadOauthEpisodes(accountIds);
      const capacity = learnOauthCapacity(episodes, { quantile: config.quantile });
      const now = new Date();
      const { windowStartedAt, usage } = await measureOauthWindow({
        accountIds,
        now,
        lastResetsAt: episodes[0]?.resetsAt ?? null,
      });
      const pressure = oauthBudgetPressure({ usage, capacity });

      budgetPacing = {
        enabled: config.enabled,
        quantile: config.quantile,
        // 'learning' until there are enough episodes; 'inert' when switched off.
        state: !config.enabled ? 'inert' : capacity.confidence === 'none' ? 'learning' : 'active',
        pressurePct: Math.round(pressure.pct * 100),
        limiter: pressure.limiter,
        confidence: capacity.confidence,
        episodes: capacity.samples,
        // Units are sonnet-equivalents where weighted values were learned
        // (opus counts ~5x, haiku ~0.27x — see MODEL_WEIGHTS).
        learnedCapacity: {
          workers: capacity.workerCount,
          turns: capacity.turns,
          weightedTurns: capacity.weightedTurns,
          tokens: capacity.tokens,
          weightedTokens: capacity.weightedTokens,
        },
        window: {
          // Inferred by sessionizing worker history, not a rolling 5h clock.
          startedAt: windowStartedAt.toISOString(),
          endsAt: windowEndsAt(windowStartedAt).toISOString(),
          ...usage,
        },
        lastExhaustedAt: episodes[0]?.exhaustedAt?.toISOString() ?? null,
      };
    } catch (err) {
      console.warn(`[accounts/me] OAuth budget pacing readout failed for ${account.id}:`, err);
      budgetPacing = { enabled: config.enabled, state: 'unavailable' };
    }
  }

  // Return relevant account info (not the full account with sensitive data)
  return NextResponse.json({
    id: account.id,
    name: account.name,
    type: account.type,
    level: account.level,
    authType: account.authType,
    maxConcurrentWorkers: account.maxConcurrentWorkers,
    ...(budgetPacing ? { budgetPacing } : {}),
  });
}
