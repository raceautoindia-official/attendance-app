/**
 * scripts/verify-input-contracts.ts — the two ways a form stops accepting typing.
 *
 *   npx tsx scripts/verify-input-contracts.ts
 *
 * This is a STATIC check over the source. There is no browser in this test
 * setup, and both bugs it guards against were invisible to every other test in
 * the suite while being obvious to anybody using the app for ten seconds.
 *
 * ONE: A FOCUS EFFECT THAT DEPENDS ON A HANDLER.
 * `Drawer` traps focus in an effect. Every one of its call sites passes
 * `onClose={() => ...}`, a new function each render, so listing it as a
 * dependency made the effect tear down and re-run on every render - which for
 * a controlled input is every keystroke. The cleanup handed focus back to the
 * button that opened the drawer and the effect then moved it to the drawer's
 * first field, so the character went somewhere else. Every form in this app is
 * a drawer, so typing was broken everywhere at once.
 *
 * TWO: A NUMBER FIELD THAT PARSES ON EVERY KEYSTROKE.
 *
 *   value={String(x ?? '')}  onChange={e => setX(Number(e.target.value))}
 *
 * Typing "12.5" gives 125, because the field is briefly asked to hold "12."
 * and Number("12.") is 12. Clearing it gives 0, because Number("") is 0, so
 * the field cannot be emptied. Fourteen fields on one screen behaved this way.
 * `components/ui/NumberField.tsx` exists so there is one right answer.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
};

/** Every .tsx under the app and component trees. */
function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const files = [
  ...sources(join(process.cwd(), 'app')),
  ...sources(join(process.cwd(), 'components')),
];
check('the source tree was found', files.length > 30, `${files.length} components`);

// ---------------------------------------------------------------------------
console.log('\n— the focus trap —');
const drawer = readFileSync(join(process.cwd(), 'components/ui/Drawer.tsx'), 'utf8');

// The effect that focuses and traps must depend on `open` and nothing else.
const depArrays = Array.from(drawer.matchAll(/\}, \[([^\]]*)\]\);/g)).map(m => m[1].trim());
check('Drawer has its dependency arrays', depArrays.length > 0, depArrays.join(' | '));
const focusEffectDeps = depArrays.filter(d => d.includes('open'));
check('the focus effect depends on `open` alone',
  focusEffectDeps.length > 0 && focusEffectDeps.every(d => d === 'open'),
  focusEffectDeps.join(' | ') || 'none found');
check('and onClose is read through a ref instead',
  drawer.includes('onCloseRef') && drawer.includes('onCloseRef.current()'));

// Modal was always right; it is checked so a future edit cannot break it
// quietly in the same way.
const modal = readFileSync(join(process.cwd(), 'components/ui/Modal.tsx'), 'utf8');
const modalDeps = Array.from(modal.matchAll(/\}, \[([^\]]*)\]\);/g))
  .map(m => m[1].trim()).filter(d => d.includes('open'));
check('Modal does the same', modalDeps.every(d => d === 'open'), modalDeps.join(' | '));

// The same trap, anywhere else.
//
// Matched per EFFECT rather than per file: a component may legitimately have
// an effect that depends on a handler - keeping that handler in a ref is
// exactly such an effect - and the rule is only about effects that MOVE
// FOCUS. The first version of this check flagged Drawer's own ref-sync
// effect, which is the fix rather than the bug.
const movesFocusOnHandler: string[] = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const effect = /useEffect\(\(\) => \{([\s\S]*?)\}, \[([^\]]*)\]\);/g;
  for (const match of src.matchAll(effect)) {
    const body = match[1];
    const deps = match[2].trim();
    if (!body.includes('.focus()')) continue;
    if (!/\bon[A-Z]\w*/.test(deps)) continue;
    const line = src.slice(0, match.index).split('\n').length;
    movesFocusOnHandler.push(
      `${file.split(/[\\\/]/).slice(-2).join('/')}:${line} depends on ${deps}`);
  }
}
check('no effect that moves focus depends on a handler',
  movesFocusOnHandler.length === 0, movesFocusOnHandler.join(', ') || 'none');
// ---------------------------------------------------------------------------
console.log('\n— number fields —');
const offenders: string[] = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  // NumberField itself documents the bad pattern in its own comment.
  if (file.endsWith('NumberField.tsx')) continue;

  // Each JSX element, roughly: from a tag opening to its self-closing end.
  for (const match of src.matchAll(/<(Input|input)\b[\s\S]*?\/>/g)) {
    const el = match[0];
    if (!el.includes('type="number"')) continue;
    const coerces = /onChange=\{[^}]*Number\(e\.target\.value\)/.test(el)
      || /onChange=\{[^}]*parseInt\(e\.target\.value/.test(el);
    if (coerces) {
      const line = src.slice(0, match.index).split('\n').length;
      offenders.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${line}`);
    }
  }
}
check('no numeric field parses on every keystroke', offenders.length === 0,
  offenders.join(', ') || 'none');

// A number field whose value is rebuilt from a number each render has the same
// problem even without the Number() call, because String(12) can never show
// "12." - unless it goes through NumberField, which keeps the text.
const restringified: string[] = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (file.endsWith('NumberField.tsx')) continue;
  for (const match of src.matchAll(/<(Input|input)\b[\s\S]*?\/>/g)) {
    const el = match[0];
    if (!el.includes('type="number"')) continue;
    if (!/value=\{String\(/.test(el)) continue;
    // Storing the raw string is fine - the giveaway is a cast on the way in
    // AND a cast on the way out.
    const setsString = /onChange=\{[^}]*e\.target\.value\s*\)?\s*\}/.test(el)
      && !/Number\(|parseInt\(/.test(el);
    if (!setsString) {
      const line = src.slice(0, match.index).split('\n').length;
      restringified.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${line}`);
    }
  }
}
check('no numeric field is rebuilt from a number on every render',
  restringified.length === 0, restringified.join(', ') || 'none');

check('and there is one component that does it properly',
  existsSync(join(process.cwd(), 'components/ui/NumberField.tsx')));

// ---------------------------------------------------------------------------
console.log('\n— controlled text fields —');
// A text input with a value and no onChange is read-only by accident: React
// simply refuses the keystrokes, which looks exactly like a broken keyboard.
const frozen: string[] = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const match of src.matchAll(/<(Input|input|textarea|NumberField)\b[\s\S]*?\/>/g)) {
    const el = match[0];
    if (!/\bvalue=\{/.test(el)) continue;
    if (/onChange=/.test(el) || /readOnly/.test(el) || /disabled/.test(el)) continue;
    // react-hook-form supplies both through a spread.
    if (/\{\.\.\./.test(el)) continue;
    const line = src.slice(0, match.index).split('\n').length;
    frozen.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${line}`);
  }
}
check('every controlled field has an onChange', frozen.length === 0,
  frozen.join(', ') || 'none');

// A <select value=...> with no onChange refuses every choice, which looks
// exactly like a broken dropdown. It is not self-closing, so it needs its own
// pass rather than the element matcher above.
const frozenSelects: string[] = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const match of src.matchAll(/<select\b([\s\S]*?)>/g)) {
    const attrs = match[1];
    if (!/\bvalue=\{/.test(attrs)) continue;
    if (/onChange=/.test(attrs) || /disabled/.test(attrs)
      || /\{\.\.\./.test(attrs)) continue;
    const line = src.slice(0, match.index).split('\n').length;
    frozenSelects.push(`${file.split(/[\\\/]/).slice(-2).join('/')}:${line}`);
  }
}
check('every controlled dropdown has an onChange', frozenSelects.length === 0,
  frozenSelects.join(', ') || 'none');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
