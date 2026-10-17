/**
 * Sensible defaults for fields a person would otherwise invent.
 *
 * Every value in here is a SUGGESTION offered beside the field, never a value
 * written behind somebody's back. The distinction matters: a plant with four
 * night shifts needs its own names, and software that overwrites what was
 * typed teaches people to fight the form.
 *
 * What these exist to prevent is the lazy path producing something arbitrary.
 * This database already holds a shift called 'regular morning 10' and a
 * department called '7305408577', and neither was anybody's fault - they are
 * what a blank text box gets at four in the afternoon.
 */

/**
 * A short handle derived from a name.
 *
 *   'Plant Operations'          -> 'PLANT-OPERATIONS'
 *   'Quality Assurance & Test'  -> 'QAT'
 *   'Ops'                       -> 'OPS'
 *
 * Shaped to pass the code validation every one of these tables shares -
 * letters, numbers, dot, dash or underscore, at least two characters - so a
 * suggestion is never something the server then refuses. Returns null when the
 * name has nothing to build from yet, which is the case while somebody types.
 */
export function codeFromName(name: string | undefined, maxLength = 16): string | null {
  const words = (name ?? '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (words.length === 0) return null;

  const joined = words.join('-');
  if (joined.length <= maxLength) {
    return joined.length >= 2 ? joined : null;
  }

  // Too long to read in a column heading: initials, which is what people
  // shorten a long department to anyway.
  const initials = words.map(w => w[0]).join('');
  if (initials.length >= 2) return initials.slice(0, maxLength);

  const first = words[0].slice(0, maxLength);
  return first.length >= 2 ? first : null;
}

/**
 * A name derived from what the shift actually is.
 *
 *   ('fixed', '10:00:00', '19:00:00') -> 'Morning 10:00-19:00'
 *   ('flexible', '09:00', '18:00')    -> 'Flexible 09:00-18:00'
 *
 * Left to free text, shift names drift into things nobody can read later: this
 * database holds 'regular day shift', 'Flexible Time' and 'regular morning
 * 10', which between them say almost nothing about when anybody works. A name
 * carrying the hours answers the only question a reader has when they meet it
 * in a dropdown three pages away.
 */
export function suggestShiftName(
  type: string | undefined,
  start: string | undefined,
  end: string | undefined,
): string | null {
  if (!start || !end) return null;
  const hhmm = (t: string) => t.slice(0, 5);
  const startHour = Number(start.slice(0, 2));
  if (!Number.isFinite(startHour)) return null;

  // Named for when it begins, because that is what somebody checks when
  // deciding which shift a person is on.
  const partOfDay =
    startHour < 5 ? 'Night'
    : startHour < 12 ? 'Morning'
    : startHour < 17 ? 'Afternoon'
    : startHour < 21 ? 'Evening'
    : 'Night';

  const prefix = type === 'flexible' ? 'Flexible' : partOfDay;
  return `${prefix} ${hhmm(start)}-${hhmm(end)}`;
}

/**
 * The next employee id, in the pattern the existing ones already follow.
 *
 * This company numbers people RACE001..RACE026 with one ADMIN001 beside
 * them, so the next id is RACE027 - obvious to a human reading the list and
 * invisible to somebody adding their first employee, who types EMP1, Race27
 * or a phone number. The id is what people SIGN IN with, so a one-off
 * spelling is not a tidiness problem: it is the thing they get wrong at the
 * gate on their first morning.
 *
 * The dominant prefix wins, keeping its zero padding. Returns null when
 * nothing stored has a numeric tail to count from - a first employee, or ids
 * that are genuinely free-form.
 */
export function suggestEmpId(existing: Array<string | null | undefined>): string | null {
  const taken = new Set(existing.filter((e): e is string => Boolean(e)).map(e => e.toUpperCase()));

  const seen = new Map<string, { count: number; max: number; width: number }>();
  for (const id of taken) {
    const m = /^([A-Z][A-Z._-]*)?(\d+)$/.exec(id);
    if (!m) continue;
    const prefix = m[1] ?? '';
    const digits = m[2];
    const entry = seen.get(prefix) ?? { count: 0, max: 0, width: digits.length };
    entry.count += 1;
    entry.max = Math.max(entry.max, Number(digits));
    entry.width = Math.max(entry.width, digits.length);
    seen.set(prefix, entry);
  }
  if (seen.size === 0) return null;

  // Most-used prefix, so one ADMIN001 among twenty-six RACE ids does not
  // decide the house style. Ties break on the name, to stay deterministic.
  const [prefix, entry] = Array.from(seen.entries())
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))[0];

  // Walk past anything already taken: numbering is rarely gapless, and a
  // suggestion the server then rejects as a duplicate is worse than none.
  for (let n = entry.max + 1; n <= entry.max + 1000; n++) {
    const candidate = `${prefix}${String(n).padStart(entry.width, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

// 1234, 0000, 1111, 4321... - the PINs that get guessed first. A generated
// PIN that lands on one of these is worse than useless, because it arrives
// with the authority of having been generated.
const WEAK_PINS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '2345', '3456', '4567', '5678', '6789', '0123',
  '4321', '5432', '6543', '7654', '8765', '9876', '3210',
  '1122', '1212', '2020', '2580', '0852',
]);

/**
 * A four-digit starting PIN worth handing to somebody.
 *
 * Left to an admin creating twenty accounts, every PIN is 1234 - and this is
 * the credential that signs in at the gate before a passkey exists. Uses the
 * platform CSPRNG where there is one; Math.random is the fallback rather than
 * the plan, and this is a value the employee replaces, not a long-term
 * secret.
 */
export function randomPin(): string {
  const draw = (): string => {
    const crypto = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
    if (crypto?.getRandomValues) {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      // Rejection-free enough: 2^32 is not a multiple of 10000, so the bias is
      // about one part in 400,000 - immaterial for a PIN that gets replaced.
      return String(buf[0] % 10000).padStart(4, '0');
    }
    return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  };

  for (let attempt = 0; attempt < 50; attempt++) {
    const pin = draw();
    if (!WEAK_PINS.has(pin)) return pin;
  }
  return '7391';  // Unreachable in practice; still not a weak PIN.
}
