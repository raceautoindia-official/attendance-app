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
  // Which company this site belongs to. Nullable: six sites exist and no
  // company does, and attendance reads these rows on every clock-in - so
  // nothing here may become mandatory.
  company_id: z.number().int().positive().nullable().optional(),
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
    `SELECT l.id, l.name, l.company_id, c.legal_name AS company_name,
            l.address, l.latitude, l.longitude, l.radius_meters, l.is_active, l.created_at
     FROM locations l
     -- The company's name, so a site can be offered as "Plant A - Acme Ltd"
     -- wherever one is chosen. LEFT, because a site with no company still
     -- works: attendance reads these rows on every clock-in.
     LEFT JOIN companies c ON c.id = l.company_id
     WHERE l.is_active = TRUE
     ORDER BY l.name ASC`,
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

  const { name, address, latitude, longitude, radius_meters, company_id } = parsed.data;

  const result = await query(
    `INSERT INTO locations (name, company_id, address, latitude, longitude, radius_meters)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, company_id ?? null, address ?? null, latitude, longitude, radius_meters],
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
