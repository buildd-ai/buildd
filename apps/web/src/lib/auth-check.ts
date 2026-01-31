import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';

const isDevelopment = process.env.NODE_ENV === 'development';

/**
 * Check if request is authenticated via session or API key
 */
export async function isAuthenticated(request: NextRequest): Promise<boolean> {
  // Dev mode bypass
  if (isDevelopment) return true;

  // Check session (cookie-based)
  const session = await auth();
  if (session?.user) return true;

  // Check API key (header-based) - for agents/services
  const apiKey = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (apiKey) {
    // Validate against accounts table
    // This is handled by the route itself for more flexibility
    return false; // Let route handle API key validation
  }

  return false;
}

/**
 * Return 401 response
 */
export function unauthorized(message = 'Unauthorized') {
  return NextResponse.json({ error: message }, { status: 401 });
}

/**
 * Require authentication for API routes
 * Use in API routes: if (!(await requireAuth(req))) return unauthorized();
 */
export async function requireAuth(request: NextRequest): Promise<boolean> {
  return isAuthenticated(request);
}
