import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PUBLIC_API_PATHS = [
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/webauthn/authenticate',
  '/api/auth/webauthn/authenticate-verify',
];

const PROTECTED_API_PREFIXES = [
  '/api/attendance',
  '/api/employees',
  '/api/schedules',
  '/api/locations',
  '/api/reports',
  '/api/leaves',
  '/api/audit-log',
];

const ADMIN_PAGE_PREFIXES = [
  '/overview',
  '/employees',
  '/attendance',
  '/schedules',
  '/leaves',
  '/locations',
  '/reports',
];

const EMPLOYEE_PAGE_PREFIXES = ['/dashboard'];

// ---------------------------------------------------------------------------
// Edge-safe JWT verification using Web Crypto (crypto.subtle)
// ---------------------------------------------------------------------------

function base64urlDecode(str: string): ArrayBuffer {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  const binary = atob(padded);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}

async function verifyJWT(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    const valid = await crypto.subtle.verify(
      'HMAC',
      cryptoKey,
      base64urlDecode(signatureB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(base64urlDecode(payloadB64)),
    ) as Record<string, unknown>;

    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function getToken(request: NextRequest): string | null {
  return (
    request.cookies.get('access_token')?.value ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    null
  );
}

// ---------------------------------------------------------------------------
// Proxy (replaces middleware in Next.js 16)
// ---------------------------------------------------------------------------

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Cron routes use their own secret — skip JWT
  if (pathname.startsWith('/api/cron/')) {
    return NextResponse.next();
  }

  // Public API — always allow
  if (PUBLIC_API_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const isProtectedApi = PROTECTED_API_PREFIXES.some(p => pathname.startsWith(p));
  const isAdminPage = ADMIN_PAGE_PREFIXES.some(
    p => pathname === p || pathname.startsWith(`${p}/`),
  );
  const isEmployeePage = EMPLOYEE_PAGE_PREFIXES.some(
    p => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (!isProtectedApi && !isAdminPage && !isEmployeePage) {
    return NextResponse.next();
  }

  const token = getToken(request);
  const secret = process.env.JWT_ACCESS_SECRET ?? '';
  const payload = token ? await verifyJWT(token, secret) : null;

  // --- Protected API routes ---
  if (isProtectedApi) {
    if (!payload) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 },
      );
    }

    const headers = new Headers(request.headers);
    headers.set('x-employee-id', String(payload.id));
    headers.set('x-employee-role', String(payload.role));
    return NextResponse.next({ request: { headers } });
  }

  // --- Page routes ---
  if (!payload) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Admin pages require manager or super_admin
  if (
    isAdminPage &&
    payload.role !== 'manager' &&
    payload.role !== 'super_admin'
  ) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  const headers = new Headers(request.headers);
  headers.set('x-employee-id', String(payload.id));
  headers.set('x-employee-role', String(payload.role));
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
