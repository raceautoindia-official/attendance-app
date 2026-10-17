'use client';

/**
 * A number you can actually type.
 *
 * THE BUG THIS EXISTS TO FIX
 * --------------------------
 * The obvious way to write a numeric field is wrong in a way that only shows
 * up when somebody uses it:
 *
 *   value={String(x ?? '')}
 *   onChange={e => setX(Number(e.target.value))}
 *
 * Type "12.5" into that and you get 125. The keystrokes arrive one at a time,
 * so the field is asked to hold "12." - and `Number("12.")` is 12, which
 * renders as "12", which deletes the dot you just typed. Clearing the field is
 * worse: `Number("")` is 0, so the field snaps back to "0" and cannot be
 * emptied. Fourteen fields on the statutory screen behaved like this.
 *
 * HOW IT WORKS
 * ------------
 * The TEXT is the state while somebody is typing; the number is derived from
 * it. A partial entry - "12.", "-", "" - is left alone on screen and simply
 * does not produce a new number, so the parent keeps the last good value.
 *
 * An empty field reports `null`, not 0. "Not set" and "zero" are different
 * answers, and most of these fields mean the first one.
 *
 * The parent can still change the value from outside - loading a record,
 * resetting a form - and the text follows. It only follows when the incoming
 * number differs from what the text already means, so a parent echoing back
 * the number you just typed cannot wipe a half-typed decimal.
 */

import { useState, type InputHTMLAttributes } from 'react';
import Input from './Input';

type Passthrough = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type'
>;

export interface NumberFieldProps extends Passthrough {
  label?: string;
  helper?: string;
  error?: string;
  value: number | null | undefined;
  /** Null when the field is empty. */
  onChange: (value: number | null) => void;
  /** Passed through to the input, e.g. "0.001" for a rate. */
  step?: string | number;
}

/** The number a string means, or null when it does not mean one yet. */
function parse(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export default function NumberField({
  value, onChange, label, helper, error, step, ...rest
}: NumberFieldProps) {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  const [lastValue, setLastValue] = useState<number | null | undefined>(value);

  // Adjusting state during render, which React supports for exactly this: a
  // controlled value changing underneath a local draft. Guarded twice - on the
  // prop having changed, and on the text no longer meaning it - so it settles
  // in one extra pass and never fights the keyboard.
  if (value !== lastValue) {
    setLastValue(value);
    const meant = parse(text);
    const incoming = value === undefined ? null : value;
    if (meant !== incoming) {
      setText(incoming === null ? '' : String(incoming));
    }
  }

  return (
    <Input
      {...rest}
      type="number"
      step={step}
      label={label}
      helper={helper}
      error={error}
      value={text}
      onChange={e => {
        const raw = e.target.value;
        setText(raw);
        const parsed = parse(raw);
        // An empty field is a real answer - "not set" - and is reported.
        // A partial one ("12.", "-", "1e") is not, so the parent keeps the
        // last good number until there is a new one.
        if (raw.trim() === '' || parsed !== null) onChange(parsed);
      }}
    />
  );
}
