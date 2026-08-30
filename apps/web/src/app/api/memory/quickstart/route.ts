import { NextRequest, NextResponse } from 'next/server';

const CORS_ORIGINS = ['https://buildd.dev', 'https://www.buildd.dev'];

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (origin && CORS_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
  }
  return h;
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

export async function POST(req: NextRequest) {
  return NextResponse.json(
    { error: 'The standalone memory service has been absorbed into buildd. This endpoint is no longer available.' },
    { status: 410, headers: corsHeaders(req.headers.get('origin')) },
  );
}
