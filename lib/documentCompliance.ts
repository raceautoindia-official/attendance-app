import { query } from '@/lib/db';
import { toYmd } from '@/lib/date';
import { resolvePoliciesFor, type Policy } from '@/lib/policy';
import type { DocumentType } from '@/lib/types';

/**
 * lib/documentCompliance.ts — who is missing which papers, and why they are expected.
 *
 * WHY THIS EXISTS
 * ---------------
 * Document upload has been built and working for months and production holds
 * ZERO documents. The feature was never the problem: it sits inside an expanded
 * row on the Employees page, one employee at a time, and nothing anywhere says
 * who is missing what. There was no way to see the gap, so nobody closed it.
 *
 * This answers the question an administrator actually has — "whose papers are
 * we missing" — rather than the one the old screen answered, which was "what
 * has this one person filed".
 *
 * WHERE THE REQUIREMENTS COME FROM
 * --------------------------------
 * They are DERIVED from the statutory flags on the employee's policy, not
 * configured separately. If PF is applicable you need a PAN and a bank proof;
 * that follows from the flag, and making somebody tick it twice invites the two
 * disagreeing.
 *
 * Every requirement carries the reason it applies, so nobody has to guess why
 * the app is asking — and when an employee has no policy, only the baseline
 * identity proof is expected. The app does not invent obligations for somebody
 * whose terms nobody has recorded.
 *
 * These are reasonable defaults for Indian statutory registration, not legal
 * advice, and the reason string says which flag produced each one so a wrong
 * expectation is traceable to the policy rather than to this file.
 */

export interface Requirement {
  key: string;
  label: string;
  /** Why this is being asked for. */
  reason: string;
  /** Any ONE of these satisfies it. */
  satisfiedBy: DocumentType[];
  /** False when it is a recommendation rather than a statutory consequence. */
  required: boolean;
}

export interface EmployeeCompliance {
  employee: { id: number; name: string; emp_id: string; department: string | null };
  policy: { id: number; name: string; code: string } | null;
  onFile: Array<{
    id: number; doc_type: DocumentType; title: string;
    uploaded_on: string; storage: 'db' | 's3';
  }>;
  satisfied: Requirement[];
  missing: Requirement[];
  complete: boolean;
}

export interface ComplianceReport {
  employees: EmployeeCompliance[];
  totals: {
    employees: number;
    complete: number;
    /** Employees missing at least one REQUIRED document. */
    incomplete: number;
    documents_on_file: number;
  };
  notes: string[];
}

/** Anything that proves who somebody is. */
const IDENTITY: DocumentType[] = [
  'aadhaar_card', 'government_id', 'passport', 'driving_licence', 'voter_id',
];

/**
 * What a policy's statutory flags imply.
 *
 * A null policy yields the baseline only: identity. Expecting tax papers from
 * somebody whose terms nobody has recorded would be the app making up an
 * obligation.
 */
export function requirementsFor(policy: Policy | null): Requirement[] {
  const out: Requirement[] = [
    {
      key: 'identity',
      label: 'Proof of identity',
      reason: 'Required for every employee on record',
      satisfiedBy: IDENTITY,
      required: true,
    },
  ];
  if (!policy) return out;

  const statutory: string[] = [];
  if (policy.pf_applicable) statutory.push('PF');
  if (policy.esi_applicable) statutory.push('ESI');
  if (policy.income_tax_tds_applicable) statutory.push('TDS');
  if (policy.professional_tax_applicable) statutory.push('Professional Tax');

  if (policy.pf_applicable || policy.income_tax_tds_applicable) {
    out.push({
      key: 'pan',
      label: 'PAN card',
      reason: `${[policy.pf_applicable && 'PF', policy.income_tax_tds_applicable && 'TDS']
        .filter(Boolean).join(' and ')} is applicable under "${policy.name}"`,
      satisfiedBy: ['pan_card'],
      required: true,
    });
  }

  if (policy.pf_applicable || policy.esi_applicable) {
    out.push({
      key: 'aadhaar',
      label: 'Aadhaar card',
      reason: `${[policy.pf_applicable && 'PF', policy.esi_applicable && 'ESI']
        .filter(Boolean).join(' and ')} registration uses Aadhaar`,
      satisfiedBy: ['aadhaar_card'],
      required: true,
    });
  }

  if (statutory.length > 0) {
    out.push({
      key: 'bank',
      label: 'Bank proof',
      reason: `${statutory.join(', ')} applicable — needed to pay and remit`,
      satisfiedBy: ['bank_proof'],
      required: true,
    });
  }

  // Recommended rather than required: useful to hold, but nothing statutory
  // turns on it, and flagging it red would bury the ones that matter.
  out.push({
    key: 'offer',
    label: 'Offer letter',
    reason: 'Recommended — the record of agreed terms',
    satisfiedBy: ['offer_letter'],
    required: false,
  });

  return out;
}

/** Who is missing what, across everybody. */
export async function buildComplianceReport(params: {
  managerId?: number | null;
  onDate?: string;
} = {}): Promise<ComplianceReport> {
  const { managerId = null } = params;
  const onDate = params.onDate ?? new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  const employees = await query<{
    id: number; name: string; emp_id: string; department: string | null;
  }>(
    `SELECT id, name, emp_id, department
       FROM employees
      WHERE is_active = TRUE AND role <> 'super_admin'
        ${managerId != null ? 'AND manager_id = ?' : ''}
      ORDER BY name`,
    managerId != null ? [managerId] : [],
  );

  if (employees.length === 0) {
    return {
      employees: [],
      totals: { employees: 0, complete: 0, incomplete: 0, documents_on_file: 0 },
      notes: ['No employees to check.'],
    };
  }

  const ids = employees.map(e => e.id);
  const docs = await query<{
    id: number; employee_id: number; doc_type: DocumentType; title: string;
    created_at: Date | string; storage: 'db' | 's3' | null;
  }>(
    `SELECT id, employee_id, doc_type, title, created_at, storage
       FROM employee_documents
      WHERE employee_id IN (${ids.map(() => '?').join(',')})
      ORDER BY created_at DESC`,
    ids,
  );

  const policies = await resolvePoliciesFor(ids, onDate);

  const byEmployee = new Map<number, typeof docs>();
  for (const d of docs) {
    const list = byEmployee.get(d.employee_id) ?? [];
    list.push(d);
    byEmployee.set(d.employee_id, list);
  }

  const out: EmployeeCompliance[] = employees.map(e => {
    const mine = byEmployee.get(e.id) ?? [];
    const held = new Set(mine.map(d => d.doc_type));
    const policy = policies.get(e.id) ?? null;
    const reqs = requirementsFor(policy);

    const satisfied = reqs.filter(r => r.satisfiedBy.some(t => held.has(t)));
    const missing = reqs.filter(r => !r.satisfiedBy.some(t => held.has(t)));

    return {
      employee: { id: e.id, name: e.name, emp_id: e.emp_id, department: e.department },
      policy: policy ? { id: policy.id, name: policy.name, code: policy.code } : null,
      onFile: mine.map(d => ({
        id: d.id,
        doc_type: d.doc_type,
        title: d.title,
        uploaded_on: toYmd(d.created_at),
        storage: (d.storage ?? 'db') as 'db' | 's3',
      })),
      satisfied,
      missing,
      // Only the REQUIRED ones decide completeness. A missing offer letter
      // should not make somebody look non-compliant beside somebody with no
      // identity document at all.
      complete: missing.every(r => !r.required),
    };
  });

  const notes: string[] = [];
  const withoutPolicy = out.filter(c => c.policy === null).length;
  if (withoutPolicy > 0) {
    notes.push(
      `${withoutPolicy} employee(s) are on no policy, so only proof of identity is expected of `
      + 'them. Assign a policy and its statutory flags decide what else is needed.',
    );
  }
  if (docs.length === 0) {
    notes.push('No documents have been uploaded for anybody yet.');
  }

  return {
    employees: out,
    totals: {
      employees: out.length,
      complete: out.filter(c => c.complete).length,
      incomplete: out.filter(c => !c.complete).length,
      documents_on_file: docs.length,
    },
    notes,
  };
}
