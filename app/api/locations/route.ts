import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse, Location } from '@/lib/types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const CreateLocationSchema = z.object({
  name: z.string().min(1).max(100),
  address: z.string().max(500).nullable().optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radius_meters: z.number().int().min(10).max(10000).default(100),
});

// ---------------------------------------------------------------------------
// GET /api/locations — any authenticated user (needed for clock-in)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const locations = await query<Location>(
    `SELECT id, name, address, latitude, longitude, radius_meters, is_active, created_at
     FROM locations
     WHERE is_active = TRUE
     ORDER BY name ASC`,
  );

  return NextResponse.json<ApiResponse<{ locations: Location[] }>>({ success: true, data: { locations } });
}

// ---------------------------------------------------------------------------
// POST /api/locations — super_admin only
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = CreateLocationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const { name, address, latitude, longitude, radius_meters } = parsed.data;

  const result = await query(
    `INSERT INTO locations (name, address, latitude, longitude, radius_meters)
     VALUES (?, ?, ?, ?, ?)`,
    [name, address ?? null, latitude, longitude, radius_meters],
  );
  const insertId = (result as unknown as { insertId: number }).insertId;

  await insertAuditLog({
    action: 'location_created',
    entity: 'location',
    entity_id: insertId,
    performed_by: auth.id,
    details: { name, latitude, longitude, radius_meters },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  const location = await queryOne<Location>(
    'SELECT * FROM locations WHERE id = ?',
    [insertId],
  );

  return NextResponse.json<ApiResponse<Location>>(
    { success: true, data: location! },
    { status: 201 },
  );
}
