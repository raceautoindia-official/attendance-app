// Dark palette mirrored from the web app's dark mode (Tailwind slate scale) so
// the native app matches the website exactly.
export const colors = {
  bg: '#0f172a',          // slate-900 — page background
  card: '#1e293b',        // slate-800 — cards
  border: '#334155',      // slate-700 — card borders
  borderInput: '#475569', // slate-600 — input borders / outlined buttons

  brand: '#2563eb',       // blue-600  — logo / primary button
  accent: '#3b82f6',      // blue-500  — live clock / highlights

  text: '#f1f5f9',        // slate-100 — primary text
  textLabel: '#cbd5e1',   // slate-300 — labels
  textMuted: '#94a3b8',   // slate-400 — subtitles
  textFaint: '#64748b',   // slate-500 — placeholders / footnotes

  avatar: '#db2777',      // pink-600  — avatar circle

  greenBg: '#14532d',     // green-900 — "present" badge bg
  greenText: '#86efac',   // green-300 — "present" badge text

  red: '#ef4444',         // red-500   — sign out / clock out accent
  redBg: 'rgba(239,68,68,0.12)',
  redBorder: 'rgba(239,68,68,0.4)',
  redText: '#fca5a5',     // red-300
};
