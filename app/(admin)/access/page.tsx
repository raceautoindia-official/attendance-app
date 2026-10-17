'use client';

/**
 * /access — who may do what, and over whom.
 *
 * Two tabs: the roles themselves, and who holds them.
 *
 * The editor is a drawer showing every permission with a scope beside it,
 * because a permission list without scopes answers half the question and the
 * missing half is the dangerous one. "May view attendance" sounds harmless
 * until it turns out to mean everybody's.
 *
 * Two things the UI is deliberate about:
 *
 *   - A company-wide permission offers no scope picker at all. Showing a
 *     disabled dropdown invites somebody to try; showing the words "whole
 *     company" explains why there is nothing to choose.
 *   - People with no explicit role are listed first and labelled, because
 *     that is everybody today. Their access comes from the legacy role, and
 *     the page says so rather than showing an empty row that reads as "no
 *     access".
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Badge from '@/components/ui/Badge';
import Spinner from '@/components/ui/Spinner';
import Drawer from '@/components/ui/Drawer';
import FilterBar from '@/components/ui/FilterBar';
import type { ApiResponse } from '@/lib/types';
import { codeFromName } from '@/lib/suggest';
import Suggest from '@/components/ui/Suggest';

type Scope = 'self' | 'team' | 'department' | 'all';

interface Permission {
  id: number; perm_key: string; label: string; description: string | null;
  category: string; scopable: boolean; sort_order: number;
}
interface Role {
  id: number; code: string; name: string; description: string | null;
  is_system: boolean; is_active: boolean; holder_count: number;
  grants: Array<{ permission_id: number; perm_key: string; scope: Scope }>;
}
interface Holder {
  employee_id: number; name: string; emp_id: string; legacy_role: string;
  roles: Array<{ id: number; code: string; name: string }>;
}

const SCOPES: Array<{ value: Scope; label: string; hint: string }> = [
  { value: 'self', label: 'Themselves', hint: 'Their own records only' },
  { value: 'team', label: 'Their team', hint: 'The team they lead' },
  { value: 'department', label: 'Their department', hint: 'And everything below it' },
  { value: 'all', label: 'Everyone', hint: 'The whole company' },
];

const CATEGORY_LABEL: Record<string, string> = {
  attendance: 'Attendance', people: 'People', time: 'Time off',
  insight: 'Reports and insight', setup: 'Setup and configuration', general: 'General',
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error ?? 'Could not load');
  return json.data as T;
}
async function send(url: string, body: unknown, method = 'POST'): Promise<void> {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: ApiResponse = await res.json();
  if (!json.success) throw new Error(json.error ?? 'Could not save');
}

interface Draft {
  id?: number; code: string; name: string; description: string | null;
  is_active: boolean; grants: Map<number, Scope>;
}

export default function AccessPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'roles' | 'people'>('roles');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['access', 'roles'],
    queryFn: () => getJson<{ roles: Role[]; permissions: Permission[] }>('/api/access/roles'),
  });
  const { data: holderData } = useQuery({
    queryKey: ['access', 'holders'],
    queryFn: () => getJson<{ holders: Holder[] }>('/api/access/assignments'),
  });

  const roles = data?.roles ?? [];
  const permissions = data?.permissions ?? [];
  const allHolders = holderData?.holders ?? [];
  const [holderSearch, setHolderSearch] = useState('');
  const [holderFilter, setHolderFilter] = useState('');
  const holders = allHolders.filter(h => {
    // 'Nobody' is the useful filter here, not a nicety: everybody is on
    // the legacy fallback today, and finding who has actually been given
    // a role is the question this tab exists to answer.
    if (holderFilter === 'none' && h.roles.length > 0) return false;
    if (holderFilter === 'some' && h.roles.length === 0) return false;
    const q = holderSearch.trim().toLowerCase();
    if (!q) return true;
    return h.name.toLowerCase().includes(q) || h.emp_id.toLowerCase().includes(q);
  });

  const after = (m: string) => { setError(null); setNotice(m); qc.invalidateQueries({ queryKey: ['access'] }); };

  const save = useMutation({
    mutationFn: (d: Draft) => send('/api/access/roles', {
      id: d.id, code: d.code, name: d.name, description: d.description, is_active: d.is_active,
      grants: [...d.grants.entries()].map(([permission_id, scope]) => ({ permission_id, scope })),
    }),
    onSuccess: () => { setDraft(null); after('Role saved.'); },
    onError: (e: Error) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => send(`/api/access/roles?id=${id}`, undefined, 'DELETE'),
    onSuccess: () => { setDraft(null); after('Role deleted.'); },
    onError: (e: Error) => setError(e.message),
  });
  const assign = useMutation({
    mutationFn: (b: { employee_id: number; role_id: number; action: 'grant' | 'revoke' }) =>
      send('/api/access/assignments', b),
    onSuccess: () => after('Access updated.'),
    onError: (e: Error) => setError(e.message),
  });

  function openRole(r?: Role) {
    setError(null);
    setDraft(r
      ? {
          id: r.id, code: r.code, name: r.name, description: r.description,
          is_active: r.is_active, grants: new Map(r.grants.map(g => [g.permission_id, g.scope])),
        }
      : { code: '', name: '', description: null, is_active: true, grants: new Map() });
  }

  const byCategory = permissions.reduce<Record<string, Permission[]>>((acc, p) => {
    (acc[p.category] ??= []).push(p);
    return acc;
  }, {});

  if (loadError) {
    return (
      <Card>
        <p className="text-sm text-red-600 dark:text-red-400">{(loadError as Error).message}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Roles &amp; Access</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Every permission carries a reach as well as a yes. &ldquo;May view attendance&rdquo;
          is not a useful rule until it says whose.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
          {notice}
          <button onClick={() => setNotice(null)} className="text-xs underline">Dismiss</button>
        </div>
      )}

      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800 w-fit">
        {([['roles', 'Roles'], ['people', 'Who holds what']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === k
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'roles' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Built-in roles describe what the existing Super Admin, Manager and Employee
              already do. Nobody holds an explicit role yet, so nothing has changed.
            </p>
            <Button data-tour="role-new" onClick={() => openRole()}>New role</Button>
          </div>

          {isLoading ? (
            <Card><div className="flex justify-center py-10"><Spinner /></div></Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {roles.map(r => (
                <Card key={r.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate font-semibold text-slate-900 dark:text-slate-100">{r.name}</h3>
                        {r.is_system && <Badge variant="neutral">built-in</Badge>}
                        {!r.is_active && <Badge variant="warning">inactive</Badge>}
                      </div>
                      <p className="text-xs text-slate-400">{r.code}</p>
                      {r.description && (
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{r.description}</p>
                      )}
                    </div>
                    <button
                      onClick={() => openRole(r)}
                      className="shrink-0 text-xs font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
                    >
                      Edit
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-slate-500 dark:text-slate-400">
                      {r.grants.length} permission{r.grants.length === 1 ? '' : 's'}
                    </span>
                    {[...new Set(r.grants.map(g => g.scope))].map(s => (
                      <Badge key={s} variant="info">
                        {SCOPES.find(x => x.value === s)?.label ?? s}
                      </Badge>
                    ))}
                    <span className="ml-auto text-slate-400">
                      {r.holder_count} {r.holder_count === 1 ? 'holder' : 'holders'}
                    </span>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'people' && (
        <div className="space-y-3">
        <FilterBar
          search={holderSearch}
          onSearchChange={setHolderSearch}
          searchPlaceholder="Name or employee ID…"
          filters={[{ key: 'has', label: 'Roles', allLabel: 'Everyone', options: [
            { value: 'some', label: 'Has an explicit role' },
            { value: 'none', label: 'Still on the built-in rules' },
          ] }]}
          values={{ has: holderFilter }}
          onChange={(_k, v) => setHolderFilter(v)}
          onClear={() => { setHolderSearch(''); setHolderFilter(''); }}
          showing={{ shown: holders.length, total: allHolders.length, noun: 'people' }}
        />
        <Card padding={false}>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {holders.map(h => (
              <div key={h.employee_id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="font-medium text-slate-800 dark:text-slate-200">{h.name}</p>
                  <p className="text-xs text-slate-400">{h.emp_id}</p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {h.roles.length === 0 ? (
                    // Everybody, today. Saying where their access comes from is
                    // the difference between "no access" and "the old rules".
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      No explicit role &mdash; still using the built-in{' '}
                      <strong>{h.legacy_role.replace('_', ' ')}</strong> rules
                    </span>
                  ) : h.roles.map(r => (
                    <button
                      key={r.id}
                      onClick={() => assign.mutate({ employee_id: h.employee_id, role_id: r.id, action: 'revoke' })}
                      className="group flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 transition-colors hover:bg-red-50 hover:text-red-700 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                      title="Remove this role"
                    >
                      {r.name}
                      <span className="opacity-0 transition-opacity group-hover:opacity-100">&times;</span>
                    </button>
                  ))}
                </div>

                <select
                  className="ml-auto h-8 rounded-lg border border-slate-300 bg-white px-2 text-xs text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  value=""
                  onChange={e => {
                    if (!e.target.value) return;
                    assign.mutate({
                      employee_id: h.employee_id, role_id: Number(e.target.value), action: 'grant',
                    });
                    e.target.value = '';
                  }}
                >
                  <option value="">Give a role&hellip;</option>
                  {roles
                    .filter(r => r.is_active && !h.roles.some(x => x.id === r.id))
                    .map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            ))}
            {holders.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                {allHolders.length > 0 ? 'Nobody matches those filters.' : 'No active employees.'}
              </p>
            )}
          </div>
        </Card>
        </div>
      )}

      <Drawer
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? `Edit ${draft.name || 'role'}` : 'New role'}
        description="Tick what the role may do, and set how far each one reaches."
        size="xl"
        footer={
          <div className="flex items-center justify-between gap-2">
            <div>
              {draft?.id && !roles.find(r => r.id === draft.id)?.is_system && (
                <Button
                  variant="secondary"
                  loading={remove.isPending}
                  onClick={() => remove.mutate(draft.id!)}
                >
                  Delete role
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setDraft(null)}>Cancel</Button>
              <Button loading={save.isPending} onClick={() => save.mutate(draft!)}>Save</Button>
            </div>
          </div>
        }
      >
        {draft && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Name" required value={draft.name}
                onChange={e => setDraft({ ...draft, name: e.target.value })} />
              <div className="flex flex-col gap-1">
                <Input label="Code" required value={draft.code}
                  onChange={e => setDraft({ ...draft, code: e.target.value })}
                  helper="Short unique handle, e.g. SHIFT-LEAD." />
                <Suggest suggestion={codeFromName(draft.name)} current={draft.code}
                  onUse={v => setDraft({ ...draft, code: v })} />
              </div>
              <Input label="Description" className="sm:col-span-2" value={draft.description ?? ''}
                onChange={e => setDraft({ ...draft, description: e.target.value })}
                helper="What this role is for, so the next administrator does not have to infer it." />
            </div>

            {Object.entries(byCategory).map(([cat, perms]) => (
              <div key={cat}>
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {CATEGORY_LABEL[cat] ?? cat}
                </h4>
                <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                  {perms.map(p => {
                    const scope = draft.grants.get(p.id);
                    const granted = scope !== undefined;
                    return (
                      <div key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                        <label className="flex min-w-0 flex-1 items-start gap-2.5">
                          <input
                            type="checkbox"
                            checked={granted}
                            onChange={e => {
                              const next = new Map(draft.grants);
                              // A company-wide permission can only ever be
                              // 'all', so it is granted at 'all' without
                              // offering a choice that does not exist.
                              if (e.target.checked) next.set(p.id, p.scopable ? 'department' : 'all');
                              else next.delete(p.id);
                              setDraft({ ...draft, grants: next });
                            }}
                            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300"
                          />
                          <span className="min-w-0">
                            <span className="block text-sm text-slate-800 dark:text-slate-200">{p.label}</span>
                            {p.description && (
                              <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                                {p.description}
                              </span>
                            )}
                          </span>
                        </label>

                        {granted && (
                          p.scopable ? (
                            <select
                              value={scope}
                              onChange={e => {
                                const next = new Map(draft.grants);
                                next.set(p.id, e.target.value as Scope);
                                setDraft({ ...draft, grants: next });
                              }}
                              className="h-8 shrink-0 rounded-lg border border-slate-300 bg-white px-2 text-xs text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                              aria-label={`How far ${p.label} reaches`}
                            >
                              {SCOPES.map(s => (
                                <option key={s.value} value={s.value}>{s.label}</option>
                              ))}
                            </select>
                          ) : (
                            <span className="shrink-0 text-xs text-slate-400">whole company</span>
                          )
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Drawer>
    </div>
  );
}
