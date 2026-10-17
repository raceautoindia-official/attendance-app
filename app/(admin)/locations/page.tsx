'use client';

import { useState } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Table from '@/components/ui/Table';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Drawer from '@/components/ui/Drawer';
import Badge from '@/components/ui/Badge';
import Spinner from '@/components/ui/Spinner';
import FilterBar from '@/components/ui/FilterBar';
import type { Location, ApiResponse } from '@/lib/types';

const locationSchema = z.object({
  name: z.string().min(1, 'Required'),
  // Which company this site belongs to. A site with none still works - the
  // geofence does not care - but the company profile cannot point at it as
  // its registered office until somebody says whose it is.
  company_id: z.coerce.number().int().positive().nullable().optional(),
  address: z.string().optional(),
  latitude: z.coerce.number().min(-90).max(90, 'Must be between -90 and 90'),
  longitude: z.coerce.number().min(-180).max(180, 'Must be between -180 and 180'),
  radius_meters: z.coerce.number().int().min(10, 'Min 10m').max(10000, 'Max 10km').default(200),
});

type LocationForm = z.infer<typeof locationSchema>;


// Below roughly this, a phone's own position error is comparable to the fence
// itself. The radius is still enforced exactly as entered — this only decides
// when to mention the trade-off.
const TIGHT_RADIUS_M = 50;

/**
 * The radius is used exactly as typed: a 10 m site means 10 m. That is worth a
 * word of caution rather than a silent override — a fence smaller than the GPS
 * error will occasionally place a stationary employee outside their own office.
 */
function RadiusNote({ value }: { value: number }) {
  if (!Number.isFinite(value) || value <= 0 || value >= TIGHT_RADIUS_M) return null;
  return (
    <p className="-mt-2 text-xs text-amber-600 dark:text-amber-400">
      <strong>{value} m will be enforced exactly.</strong> A phone fix is usually accurate to
      5–20 m outdoors and worse indoors, so a fence this tight may sometimes read
      as “outside” while the employee is at their desk. They are only clocked out
      after being continuously unconfirmed for the grace period, not on one stray
      reading.
    </p>
  );
}

/**
 * Fills the coordinates from the device the admin is holding.
 *
 * Nobody knows their own latitude. The honest alternatives are looking it up
 * in another tab and typing eight decimal places by hand, or standing at the
 * gate and pressing this - and a mistyped coordinate does not look wrong, it
 * just puts the fence in a different district and nobody can clock in.
 *
 * Accuracy is reported rather than hidden: a fix taken indoors can be a
 * hundred metres out, which matters when the next field is a radius.
 */
function UseMyLocation({ onFix }: { onFix: (lat: number, lon: number) => void }) {
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; accuracy: number } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  function locate() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({ kind: 'error', message: 'This browser cannot report a position. Enter the coordinates by hand.' });
      return;
    }
    setState({ kind: 'busy' });
    navigator.geolocation.getCurrentPosition(
      pos => {
        // Six decimal places is about 0.1 m - past that the digits are noise,
        // and a column of them is unreadable.
        onFix(Number(pos.coords.latitude.toFixed(6)), Number(pos.coords.longitude.toFixed(6)));
        setState({ kind: 'done', accuracy: Math.round(pos.coords.accuracy) });
      },
      err => setState({
        kind: 'error',
        message: err.code === err.PERMISSION_DENIED
          ? 'Location permission was refused, so the coordinates have to be entered by hand.'
          : 'Could not get a position just now. Try again, or enter the coordinates by hand.',
      }),
      // A stale cached fix is worse than a slow one here, because it may be
      // from the last place this laptop was opened.
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={locate}
        disabled={state.kind === 'busy'}
        className="self-start text-xs font-medium text-blue-600 underline decoration-dotted hover:decoration-solid disabled:opacity-60 dark:text-blue-400"
      >
        {state.kind === 'busy' ? 'Finding this device...' : 'Use my current location'}
      </button>
      {state.kind === 'done' && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Filled from this device, accurate to about {state.accuracy} m. Check it before saving
          {state.accuracy > 50 ? ' - that is a weak fix, which is normal indoors.' : '.'}
        </p>
      )}
      {state.kind === 'error' && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{state.message}</p>
      )}
    </div>
  );
}
export default function LocationsPage() {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Location | null>(null);

  const { data: companyData } = useQuery({
    queryKey: ['org', 'companies', 'for-locations'],
    queryFn: async () => {
      const res = await fetch('/api/org/companies');
      const json = await res.json() as ApiResponse<{
        companies: Array<{ id: number; legal_name: string }>;
      }>;
      // A manager may not read companies, and that is not an error here - it
      // only means the picker has nothing to offer.
      return json.success ? json.data?.companies ?? [] : [];
    },
    retry: false,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['locations'],
    queryFn: async () => {
      const res = await fetch('/api/locations');
      return res.json() as Promise<ApiResponse<{ locations: Location[] }>>;
    },
  });

  const allLocations = data?.data?.locations ?? [];

  // Filtered in the browser because the whole list is already here. On a
  // server-paginated page this would be wrong - a box that searches only the
  // page you are on says 'no results' when the match is on page two.
  const [search, setSearch] = useState('');
  const locations = search.trim()
    ? allLocations.filter(l => {
        const q = search.trim().toLowerCase();
        return l.name.toLowerCase().includes(q)
          || (l.address ?? '').toLowerCase().includes(q);
      })
    : allLocations;

  const addForm = useForm<LocationForm>({
    resolver: zodResolver(locationSchema) as unknown as Resolver<LocationForm>,
    defaultValues: { radius_meters: 200 },
  });

  const editForm = useForm<LocationForm>({ resolver: zodResolver(locationSchema) as unknown as Resolver<LocationForm> });

  // Watched by field rather than through form.watch(), which hands back a
  // fresh function on every render and makes this page unmemoisable.
  const addRadius = useWatch({ control: addForm.control, name: 'radius_meters' });
  const editRadius = useWatch({ control: editForm.control, name: 'radius_meters' });

  const createMutation = useMutation({
    mutationFn: async (values: LocationForm) => {
      const res = await fetch('/api/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['locations'] }); setAddOpen(false); addForm.reset(); },
  });

  const editMutation = useMutation({
    mutationFn: async ({ id, values }: { id: number; values: LocationForm }) => {
      const res = await fetch(`/api/locations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['locations'] }); setEditTarget(null); },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/locations/${id}`, { method: 'DELETE' });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }),
  });

  function openEdit(loc: Location) {
    setEditTarget(loc);
    editForm.reset({
      name: loc.name,
      address: loc.address ?? '',
      latitude: loc.latitude,
      longitude: loc.longitude,
      radius_meters: loc.radius_meters,
    });
  }

  function mapsLink(lat: number, lng: number) {
    return `https://www.google.com/maps?q=${lat},${lng}`;
  }

  return (
    <div className="space-y-4">
      <FilterBar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Name or address…"
        onClear={() => setSearch('')}
        showing={{ shown: locations.length, total: allLocations.length, noun: 'sites' }}
      />

      <div className="flex justify-end">
        <Button data-tour="location-new" onClick={() => setAddOpen(true)}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Location
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <Table
          columns={[
            { key: 'name', header: 'Name', render: r => <span className="font-medium">{(r as Location).name}</span> },
            { key: 'address', header: 'Address', render: r => (r as Location).address ?? '—' },
            {
              key: 'coordinates',
              header: 'Coordinates',
              render: r => {
                const l = r as Location;
                return (
                  <a href={mapsLink(Number(l.latitude), Number(l.longitude))} target="_blank" rel="noopener noreferrer"
                    className="text-blue-600 dark:text-blue-400 hover:underline text-xs">
                    {Number(l.latitude).toFixed(5)}, {Number(l.longitude).toFixed(5)} ↗
                  </a>
                );
              },
            },
            {
              key: 'radius_meters',
              header: 'Radius',
              render: r => `${(r as Location).radius_meters}m`,
            },
            {
              key: 'is_active',
              header: 'Status',
              render: r => (
                <Badge variant={(r as Location).is_active ? 'success' : 'neutral'}>
                  {(r as Location).is_active ? 'Active' : 'Inactive'}
                </Badge>
              ),
            },
            {
              key: 'actions',
              header: '',
              render: r => (
                <div className="flex items-center gap-1 justify-end">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(r as Location)}>Edit</Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => { if (confirm('Deactivate this location?')) deleteMutation.mutate((r as Location).id); }}
                  >
                    Delete
                  </Button>
                </div>
              ),
              headerClassName: 'text-right',
            },
          ]}
          data={locations as object[]}
          emptyMessage="No locations defined yet."
        />
      )}

      {/* Add modal */}
      <Drawer open={addOpen} onClose={() => setAddOpen(false)} title="Add Location">
        <form onSubmit={addForm.handleSubmit((v: LocationForm) => createMutation.mutate(v))} className="space-y-4">
          <Input label="Name" {...addForm.register('name')} error={addForm.formState.errors.name?.message} />
          <Input label="Address" {...addForm.register('address')} />
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Company
            </span>
            <select {...addForm.register('company_id')}
              className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100">
              <option value="">Not set</option>
              {(companyData ?? []).map(c => (
                <option key={c.id} value={c.id}>{c.legal_name}</option>
              ))}
            </select>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {(companyData ?? []).length === 0
                ? 'No company profile yet - add one under People, Organisation.'
                : 'Whose site this is. The company profile can then point at it as its registered office.'}
            </span>
          </label>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Latitude" type="number" step="any" {...addForm.register('latitude')}
              error={addForm.formState.errors.latitude?.message} />
            <Input label="Longitude" type="number" step="any" {...addForm.register('longitude')}
              error={addForm.formState.errors.longitude?.message} />
          </div>
          <UseMyLocation onFix={(lat, lon) => {
            addForm.setValue('latitude', lat, { shouldDirty: true, shouldValidate: true });
            addForm.setValue('longitude', lon, { shouldDirty: true, shouldValidate: true });
          }} />
          <Input label="Radius (meters)" type="number" {...addForm.register('radius_meters')}
            error={addForm.formState.errors.radius_meters?.message}
            helper="Employees must be within this radius to clock in" />
          <RadiusNote value={Number(addRadius)} />

          {createMutation.isError && (
            <p className="text-sm text-red-500">{(createMutation.error as Error).message}</p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="submit" loading={createMutation.isPending}>Add Location</Button>
          </div>
        </form>
      </Drawer>

      {/* Edit modal */}
      <Drawer open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Location">
        {editTarget && (
          <form onSubmit={editForm.handleSubmit((v: LocationForm) => editMutation.mutate({ id: editTarget.id, values: v }))} className="space-y-4">
            <Input label="Name" {...editForm.register('name')} error={editForm.formState.errors.name?.message} />
            <Input label="Address" {...editForm.register('address')} />
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Company
            </span>
            <select {...editForm.register('company_id')}
              className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100">
              <option value="">Not set</option>
              {(companyData ?? []).map(c => (
                <option key={c.id} value={c.id}>{c.legal_name}</option>
              ))}
            </select>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {(companyData ?? []).length === 0
                ? 'No company profile yet - add one under People, Organisation.'
                : 'Whose site this is. The company profile can then point at it as its registered office.'}
            </span>
          </label>
            <div className="grid grid-cols-2 gap-4">
              <Input label="Latitude" type="number" step="any" {...editForm.register('latitude')}
                error={editForm.formState.errors.latitude?.message} />
              <Input label="Longitude" type="number" step="any" {...editForm.register('longitude')}
                error={editForm.formState.errors.longitude?.message} />
            </div>
            <UseMyLocation onFix={(lat, lon) => {
              editForm.setValue('latitude', lat, { shouldDirty: true, shouldValidate: true });
              editForm.setValue('longitude', lon, { shouldDirty: true, shouldValidate: true });
            }} />
            <Input label="Radius (meters)" type="number" {...editForm.register('radius_meters')} />
            <RadiusNote value={Number(editRadius)} />

            {editMutation.isError && (
              <p className="text-sm text-red-500">{(editMutation.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={() => setEditTarget(null)}>Cancel</Button>
              <Button type="submit" loading={editMutation.isPending}>Save Changes</Button>
            </div>
          </form>
        )}
      </Drawer>
    </div>
  );
}
