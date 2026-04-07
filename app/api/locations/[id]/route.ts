import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, insertAuditLog } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { ApiResponse, Location } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

const UpdateLocationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  address: z.string().max(500).nullable().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  radius_meters: z.number().int().min(10).max(10000).optional(),
  is_active: z.boolean().optional(),
});

// GET /api/locations/[id]
export async function GET(request: NextRequest, context: Params) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const locationId = parseInt(id, 10);
  if (isNaN(locationId)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  const location = await queryOne<Location>(
    'SELECT * FROM locations WHERE id = ?',
    [locationId],
  );
  if (!location) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Location not found' }, { status: 404 });
  }

  return NextResponse.json<ApiResponse<Location>>({ success: true, data: location });
}

// PUT /api/locations/[id]
export async function PUT(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const locationId = parseInt(id, 10);
  if (isNaN(locationId)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  const existing = await queryOne<Location>('SELECT * FROM locations WHERE id = ?', [locationId]);
  if (!existing) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Location not found' }, { status: 404 });
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const parsed = UpdateLocationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Validation error' },
      { status: 400 },
    );
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];
  const apply = (col: string, val: unknown) => { setClauses.push(`${col} = ?`); params.push(val); };

  const d = parsed.data;
  if (d.name !== undefined) apply('name', d.name);
  if (d.address !== undefined) apply('address', d.address);
  if (d.latitude !== undefined) apply('latitude', d.latitude);
  if (d.longitude !== undefined) apply('longitude', d.longitude);
  if (d.radius_meters !== undefined) apply('radius_meters', d.radius_meters);
  if (d.is_active !== undefined) apply('is_active', d.is_active ? 1 : 0);

  if (setClauses.length === 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'No fields to update' }, { status: 400 });
  }

  params.push(locationId);
  await query(`UPDATE locations SET ${setClauses.join(', ')} WHERE id = ?`, params);

  await insertAuditLog({
    action: 'location_updated',
    entity: 'location',
    entity_id: locationId,
    performed_by: auth.id,
    details: { changed_fields: Object.keys(parsed.data) },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  const updated = await queryOne<Location>('SELECT * FROM locations WHERE id = ?', [locationId]);
  return NextResponse.json<ApiResponse<Location>>({ success: true, data: updated! });
}

// DELETE /api/locations/[id] — soft delete
export async function DELETE(request: NextRequest, context: Params) {
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const locationId = parseInt(id, 10);
  if (isNaN(locationId)) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Invalid ID' }, { status: 400 });
  }

  const existing = await queryOne<{ id: number; name: string }>(
    'SELECT id, name FROM locations WHERE id = ? AND is_active = TRUE',
    [locationId],
  );
  if (!existing) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Location not found or already inactive' },
      { status: 404 },
    );
  }

  await query('UPDATE locations SET is_active = FALSE WHERE id = ?', [locationId]);

  await insertAuditLog({
    action: 'location_deactivated',
    entity: 'location',
    entity_id: locationId,
    performed_by: auth.id,
    details: { name: existing.name },
    ip_address: request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  });

  return NextResponse.json<ApiResponse>({ success: true, message: 'Location deactivated' });
}
