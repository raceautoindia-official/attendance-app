/**
 * lib/charts/types.ts — the chart SPEC.
 *
 * A spec is data plus a declared form. It is never markup, never HTML, and
 * never a colour: the assistant produces one of these from figures it has
 * already read out of the database, and the client decides how to draw it.
 *
 * That separation is the point. If the model returned SVG or HTML we would be
 * rendering model output into the page, and a chart could then assert any
 * number it liked. A spec can only say "these labels have these values", and
 * every value in it has to have come from a tool result.
 *
 * Shared by the server (lib/chat/tools/charts.ts) and the client
 * (components/charts/Chart.tsx) so the two cannot drift.
 */

export const CHART_TYPES = ['bar', 'column', 'line', 'pie', 'stacked_bar'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const CHART_UNITS = ['minutes', 'hours', 'days', 'count', 'percent'] as const;
export type ChartUnit = (typeof CHART_UNITS)[number];

export interface ChartPoint {
  label: string;
  value: number;
}

export interface ChartSeries {
  label: string;
  points: ChartPoint[];
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  subtitle?: string;
  /** Drives value formatting — `minutes` renders as "8h 30m". */
  unit: ChartUnit;
  series: ChartSeries[];
  /** Shown under the chart: the period, the source, any caveat. */
  note?: string;
}

/** Past this many slices a pie stops being readable; the rest fold into "Other". */
export const MAX_PIE_SLICES = 6;
/** The categorical palette has eight slots and they are never cycled. */
export const MAX_SERIES = 8;

/**
 * Validate a spec that came from the model.
 *
 * Returns the cleaned spec, or an error naming what is wrong so the model can
 * fix it rather than silently rendering something misleading. Everything here
 * is a shape check — truthfulness comes from the values having been read out of
 * a tool result in the first place.
 */
export function validateChartSpec(input: unknown): { spec: ChartSpec } | { error: string } {
  const s = input as Partial<ChartSpec>;

  if (!s || typeof s !== 'object') return { error: 'Chart spec must be an object.' };
  if (!CHART_TYPES.includes(s.type as ChartType)) {
    return { error: `Unknown chart type. Use one of: ${CHART_TYPES.join(', ')}.` };
  }
  if (typeof s.title !== 'string' || !s.title.trim()) {
    return { error: 'A chart needs a title saying what it shows.' };
  }
  if (!CHART_UNITS.includes(s.unit as ChartUnit)) {
    return { error: `Unknown unit. Use one of: ${CHART_UNITS.join(', ')}.` };
  }
  if (!Array.isArray(s.series) || s.series.length === 0) {
    return { error: 'A chart needs at least one series.' };
  }
  if (s.series.length > MAX_SERIES) {
    return {
      error: `${s.series.length} series is more than the palette can tell apart. `
        + `Use at most ${MAX_SERIES}, or group the rest together.`,
    };
  }

  const series: ChartSeries[] = [];
  for (const raw of s.series) {
    if (!raw || typeof raw.label !== 'string' || !Array.isArray(raw.points)) {
      return { error: 'Each series needs a label and a list of points.' };
    }
    const points: ChartPoint[] = [];
    for (const p of raw.points) {
      if (!p || typeof p.label !== 'string') {
        return { error: 'Each point needs a label.' };
      }
      const value = Number(p.value);
      if (!Number.isFinite(value)) {
        return { error: `Point "${p.label}" has no usable value.` };
      }
      // A negative slice has no meaning in a part-to-whole chart, and silently
      // dropping or flipping it would misstate the data.
      if (value < 0 && (s.type === 'pie' || s.type === 'stacked_bar')) {
        return { error: `"${p.label}" is negative, which a ${s.type} cannot show. Use a column or bar chart.` };
      }
      points.push({ label: p.label, value });
    }
    if (points.length === 0) return { error: `Series "${raw.label}" has no points.` };
    series.push({ label: raw.label, points });
  }

  if ((s.type === 'pie' || s.type === 'stacked_bar') && series.length > 1) {
    return { error: `A ${s.type} shows one set of parts — pass a single series.` };
  }
  if (s.type === 'pie' && series[0].points.length < 2) {
    return { error: 'A pie of one slice is not a chart. State the number instead.' };
  }
  if (s.type === 'pie' && series[0].points.every(p => p.value === 0)) {
    return { error: 'Every slice is zero, so there is nothing to show as a share.' };
  }

  return {
    spec: {
      type: s.type as ChartType,
      title: s.title.trim(),
      subtitle: typeof s.subtitle === 'string' && s.subtitle.trim() ? s.subtitle.trim() : undefined,
      unit: s.unit as ChartUnit,
      series,
      note: typeof s.note === 'string' && s.note.trim() ? s.note.trim() : undefined,
    },
  };
}

/** Fold a long tail into "Other" so a pie stays readable. */
export function foldForPie(points: ChartPoint[]): ChartPoint[] {
  if (points.length <= MAX_PIE_SLICES) return points;
  const sorted = [...points].sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, MAX_PIE_SLICES - 1);
  const tail = sorted.slice(MAX_PIE_SLICES - 1);
  return [
    ...head,
    { label: `Other (${tail.length})`, value: tail.reduce((sum, p) => sum + p.value, 0) },
  ];
}

/** Format a value for display. Minutes become "8h 30m", never a decimal. */
export function formatValue(value: number, unit: ChartUnit): string {
  switch (unit) {
    case 'minutes': {
      const sign = value < 0 ? '-' : '';
      const v = Math.abs(Math.round(value));
      const h = Math.floor(v / 60);
      const m = v % 60;
      if (h === 0) return `${sign}${m}m`;
      if (m === 0) return `${sign}${h}h`;
      return `${sign}${h}h ${m}m`;
    }
    case 'hours':
      return `${Math.round(value * 10) / 10}h`;
    case 'days':
      return `${Math.round(value * 10) / 10}`;
    case 'percent':
      return `${Math.round(value)}%`;
    default:
      return value.toLocaleString('en-IN');
  }
}
