import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';

interface AnthropicModel {
  id: string;
  display_name?: string;
}

interface CachedModels {
  models: { id: string; displayName: string; provider: 'anthropic' }[];
  fetchedAt: number;
}

// 24-hour in-memory cache
let modelsCache: CachedModels | null = null;
const CACHE_TTL = 24 * 60 * 60 * 1000;

async function fetchModels(): Promise<{ id: string; displayName: string; provider: 'anthropic' }[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!res.ok) return [];

    const data = (await res.json()) as { data?: AnthropicModel[] };
    return (data.data ?? [])
      .filter(
        (m) =>
          m.id.startsWith('claude-') &&
          !m.id.includes('claude-2') &&
          !m.id.includes('claude-3')
      )
      .sort((a, b) => b.id.localeCompare(a.id))
      .map((m) => ({
        id: m.id,
        displayName: m.display_name ?? m.id,
        provider: 'anthropic' as const,
      }));
  } catch {
    return [];
  }
}

async function getCachedModels() {
  if (modelsCache && Date.now() - modelsCache.fetchedAt < CACHE_TTL) {
    return modelsCache.models;
  }
  const models = await fetchModels();
  modelsCache = { models, fetchedAt: Date.now() };
  return models;
}

/** Exposed for tests only — resets the in-memory cache. */
export function _resetCache() {
  modelsCache = null;
}

export async function GET(_req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const models = await getCachedModels();
  return NextResponse.json({ models });
}
