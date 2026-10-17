'use client';

/**
 * A suggested value offered beside a field.
 *
 * Shown only when there is something to suggest and it differs from what is
 * already in the field, so it disappears the moment it has been taken and
 * never nags somebody who typed the same thing themselves.
 *
 * Deliberately a button rather than a placeholder or an auto-fill: the field
 * keeps whatever was typed until somebody chooses otherwise. Auto-filling as
 * you type looks helpful and then silently rewrites a code somebody meant.
 */
export default function Suggest({
  suggestion, current, onUse,
}: {
  suggestion: string | null | undefined;
  current: string | null | undefined;
  onUse: (value: string) => void;
}) {
  if (!suggestion) return null;
  if (suggestion === (current ?? '').trim()) return null;

  return (
    <button
      type="button"
      onClick={() => onUse(suggestion)}
      className="self-start text-xs font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
    >
      Use &ldquo;{suggestion}&rdquo;
    </button>
  );
}
