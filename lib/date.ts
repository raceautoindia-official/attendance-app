export function formatDateOnly(value: string | Date | null | undefined): string {
  if (!value) return '-';

  if (typeof value === 'string') {
    const ymd = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (ymd) return `${ymd[3]}-${ymd[2]}-${ymd[1]}`;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';

  return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
}
