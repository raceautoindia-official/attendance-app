'use client';

import { useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Table from '@/components/ui/Table';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Badge from '@/components/ui/Badge';
import Spinner from '@/components/ui/Spinner';
import type { Location, ApiResponse } from '@/lib/types';

const locationSchema = z.object({
  name: z.string().min(1, 'Required'),
  address: z.string().optional(),
  latitude: z.coerce.number().min(-90).max(90, 'Must be between -90 and 90'),
  longitude: z.coerce.number().min(-180).max(180, 'Must be between -180 and 180'),
  radius_meters: z.coerce.number().int().min(10, 'Min 10m').max(10000, 'Max 10km').default(200),
});

type LocationForm = z.infer<typeof locationSchema>;

export default function LocationsPage() {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Location | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['locations'],
    queryFn: async () => {
      const res = await fetch('/api/locations');
      return res.json() as Promise<ApiResponse<{ locations: Location[] }>>;
    },
  });

  const locations = data?.data?.locations ?? [];

  const addForm = useForm<LocationForm>({
    resolver: zodResolver(locationSchema) as unknown as Resolver<LocationForm>,
    defaultValues: { radius_meters: 200 },
  });

  const editForm = useForm<LocationForm>({ resolver: zodResolver(locationSchema) as unknown as Resolver<LocationForm> });

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
      <div className="flex justify-end">
        <Button onClick={() => setAddOpen(true)}>
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
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Location">
        <form onSubmit={addForm.handleSubmit((v: LocationForm) => createMutation.mutate(v))} className="space-y-4">
          <Input label="Name" {...addForm.register('name')} error={addForm.formState.errors.name?.message} />
          <Input label="Address" {...addForm.register('address')} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Latitude" type="number" step="any" {...addForm.register('latitude')}
              error={addForm.formState.errors.latitude?.message} />
            <Input label="Longitude" type="number" step="any" {...addForm.register('longitude')}
              error={addForm.formState.errors.longitude?.message} />
          </div>
          <Input label="Radius (meters)" type="number" {...addForm.register('radius_meters')}
            error={addForm.formState.errors.radius_meters?.message}
            helper="Employees must be within this radius to clock in" />

          {createMutation.isError && (
            <p className="text-sm text-red-500">{(createMutation.error as Error).message}</p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="submit" loading={createMutation.isPending}>Add Location</Button>
          </div>
        </form>
      </Modal>

      {/* Edit modal */}
      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Location">
        {editTarget && (
          <form onSubmit={editForm.handleSubmit((v: LocationForm) => editMutation.mutate({ id: editTarget.id, values: v }))} className="space-y-4">
            <Input label="Name" {...editForm.register('name')} error={editForm.formState.errors.name?.message} />
            <Input label="Address" {...editForm.register('address')} />
            <div className="grid grid-cols-2 gap-4">
              <Input label="Latitude" type="number" step="any" {...editForm.register('latitude')}
                error={editForm.formState.errors.latitude?.message} />
              <Input label="Longitude" type="number" step="any" {...editForm.register('longitude')}
                error={editForm.formState.errors.longitude?.message} />
            </div>
            <Input label="Radius (meters)" type="number" {...editForm.register('radius_meters')} />

            {editMutation.isError && (
              <p className="text-sm text-red-500">{(editMutation.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={() => setEditTarget(null)}>Cancel</Button>
              <Button type="submit" loading={editMutation.isPending}>Save Changes</Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
