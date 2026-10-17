/**
 * verify-suggest.ts — the suggested defaults.
 *
 *   npx tsx scripts/verify-suggest.ts
 *
 * No database and no network: these are pure functions, which is the point of
 * having them in lib rather than inside a page. They decide what an admin sees
 * offered for a code, an employee id, a shift name or a PIN, and a suggestion
 * the server then refuses is worse than no suggestion at all - so the shapes
 * asserted here are the shapes the API schemas accept.
 */

import { codeFromName, suggestShiftName, suggestEmpId, randomPin } from '../lib/suggest';

let passed = 0;
let failed = 0;

function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }
}

function assert(label: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ': ' + detail : ''}`); }
}

console.log('codeFromName');
check('a single word', codeFromName('Operations'), 'OPERATIONS');
check('two words join with a dash', codeFromName('Plant Ops'), 'PLANT-OPS');
// 'QUALITY-ASSURANCE' is 17 characters, one past the default limit, so this
// falls through to initials - which is what people call it anyway.
check('punctuation is dropped, and a long pair initialises', codeFromName('Quality & Assurance'), 'QA');
check('punctuation is dropped when it fits', codeFromName('Sales & Ops'), 'SALES-OPS');
check('too long becomes initials', codeFromName('Quality Assurance And Testing'), 'QAAT');
check('a long single word is truncated', codeFromName('Administration', 8), 'ADMINIST');
check('nothing to build from', codeFromName(''), null);
check('undefined is handled', codeFromName(undefined), null);
check('one character is not a code', codeFromName('A'), null);
check('digits survive', codeFromName('Plant 2'), 'PLANT-2');

// Every code the org, policy and role APIs accept must match this.
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;
for (const name of ['Operations', 'Plant Ops', 'Quality & Assurance',
  'Quality Assurance And Testing', 'Plant 2', 'R&D', '  spaced  out  ']) {
  const code = codeFromName(name);
  assert(`'${name}' yields a code the API accepts`,
    code === null || CODE_RE.test(code), String(code));
}

console.log('suggestShiftName');
check('morning', suggestShiftName('fixed', '10:00:00', '19:00:00'), 'Morning 10:00-19:00');
check('night before dawn', suggestShiftName('fixed', '02:00', '10:00'), 'Night 02:00-10:00');
check('night after dusk', suggestShiftName('fixed', '22:00', '06:00'), 'Night 22:00-06:00');
check('afternoon', suggestShiftName('fixed', '13:30', '22:00'), 'Afternoon 13:30-22:00');
check('evening', suggestShiftName('fixed', '18:00', '02:00'), 'Evening 18:00-02:00');
check('flexible is named for being flexible',
  suggestShiftName('flexible', '09:00', '18:00'), 'Flexible 09:00-18:00');
check('no times, no suggestion', suggestShiftName('fixed', '', '18:00'), null);
check('missing end', suggestShiftName('fixed', '09:00', undefined), null);
check('unparseable time', suggestShiftName('fixed', 'ab:00', '18:00'), null);

console.log('suggestEmpId');
check('this company, as it stands',
  suggestEmpId(['ADMIN001', 'RACE001', 'RACE026', 'RACE017']), 'RACE027');
check('the dominant prefix wins over the odd one out',
  suggestEmpId(['ADMIN001', 'ADMIN002', 'RACE001']), 'ADMIN003');
check('padding is kept', suggestEmpId(['EMP0007']), 'EMP0008');
check('no padding to keep', suggestEmpId(['E7']), 'E8');
check('a taken number is stepped over',
  suggestEmpId(['RACE001', 'RACE002', 'RACE003']), 'RACE004');
check('nothing numeric to count from', suggestEmpId(['arun', 'admin']), null);
check('an empty company', suggestEmpId([]), null);
check('nulls are ignored', suggestEmpId([null, undefined, 'RACE009']), 'RACE010');
check('case is normalised', suggestEmpId(['race009']), 'RACE010');
check('widening past the padding', suggestEmpId(['RACE099']), 'RACE100');

// The suggestion must never collide with something already taken.
const taken = ['RACE001', 'RACE002', 'RACE004', 'ADMIN001'];
const next = suggestEmpId(taken);
assert('the suggested id is free', next !== null && !taken.includes(next), String(next));

console.log('randomPin');
const pins = Array.from({ length: 500 }, () => randomPin());
assert('always four digits', pins.every(p => /^\d{4}$/.test(p)));
const WEAK = ['0000', '1111', '1234', '4321', '9999', '2580'];
assert('never one of the obvious ones', pins.every(p => !WEAK.includes(p)));
assert('actually varies', new Set(pins).size > 100, `${new Set(pins).size} distinct in 500`);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
