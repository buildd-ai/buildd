import { NextRequest, NextResponse } from 'next/server';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0.1';

// GET /api/mcp/registry?search=github&limit=20&cursor=...
export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const search = url.searchParams.get('search') || '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
    const cursor = url.searchParams.get('cursor') || '';

    const params = new URLSearchParams();
    if (search) params.set('search', search);
    params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);

    try {
        const res = await fetch(`${REGISTRY_BASE}/servers?${params}`, {
            headers: { 'Accept': 'application/json' },
            next: { revalidate: 300 }, // cache 5 min
        });

        if (!res.ok) {
            return NextResponse.json(
                { error: 'Registry unavailable' },
                { status: 502 }
            );
        }

        const data = await res.json();
        return NextResponse.json(data);
    } catch {
        return NextResponse.json(
            { error: 'Failed to fetch registry' },
            { status: 502 }
        );
    }
}
