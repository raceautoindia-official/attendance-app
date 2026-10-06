'use client';

import { useId, useMemo, useState } from 'react';
import {
  foldForPie,
  formatValue,
  type ChartSpec,
} from '@/lib/charts/types';

/**
 * components/charts/Chart.tsx — every chart in the app, drawn as plain SVG.
 *
 * No charting dependency. The requirement is five forms with exact mark specs
 * and a palette that has been validated for colour-vision deficiency; a general
 * library would have to be fought on all three, and this also keeps the chat
 * panel's bundle small, since the same component renders charts there.
 *
 * The rules it is built to, which are not negotiable:
 *
 * - Categorical hues are assigned BY SLOT in a fixed order and never cycled.
 *   The ordering is what makes the palette colour-vision-safe. A ninth series
 *   does not get a generated colour; it is refused upstream.
 * - One axis. Never two scales on one chart.
 * - Magnitude of a single measure uses the sequential blue ramp, not eight hues.
 * - A legend whenever there are two or more series; a single series needs none,
 *   because the title already says what is plotted.
 * - Every chart has a table view. Three of the light-mode hues sit under 3:1
 *   contrast on a light surface, which is permitted only if no value is
 *   reachable by colour alone — so the table is a requirement, not a nicety.
 * - Marks are thin, gridlines hairline and solid, and touching marks are
 *   separated by a 2px gap in the surface colour rather than a border.
 */

const SLOT = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)',
  'var(--viz-5)', 'var(--viz-6)', 'var(--viz-7)', 'var(--viz-8)'] as const;

/** Sequential blue, light → dark, for a single measure's magnitude. */
const SEQ = ['var(--viz-seq-2)', 'var(--viz-seq-3)', 'var(--viz-seq-4)',
  'var(--viz-seq-5)', 'var(--viz-seq-6)'] as const;

const GAP = 2;          // surface gap between touching marks
const BAR_MAX = 24;     // bars never fill their slot — the leftover is air
const TICKS = 4;

/**
 * Running total BEFORE each entry — `[1,2,3]` → `[0,1,3]`.
 *
 * Quadratic, which is irrelevant at eight slices and keeps it free of a running
 * variable — the React compiler rejects mutation that outlives a render pass.
 */
function cumulative(values: number[]): number[] {
  return values.map((_, i) => values.slice(0, i).reduce((sum, v) => sum + v, 0));
}

/** Round a maximum up to something a human would choose for an axis. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (value <= step * mag) return step * mag;
  }
  return 10 * mag;
}

export default function Chart({ spec, className }: { spec: ChartSpec; className?: string }) {
  const [showTable, setShowTable] = useState(false);
  const multi = spec.series.length > 1;

  return (
    <figure className={`not-prose my-2 w-full ${className ?? ''}`}>
      <figcaption className="mb-1.5">
        <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{spec.title}</p>
        {spec.subtitle && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{spec.subtitle}</p>
        )}
      </figcaption>

      {/* A legend is the dependable identity channel; direct labels supplement
          it. One series needs none — the title already names it. */}
      {multi && (
        <ul className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
          {spec.series.map((s, i) => (
            <li key={s.label} className="flex items-center gap-1.5 text-[10.5px] text-slate-600 dark:text-slate-300">
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: SLOT[i % SLOT.length] }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}

      {showTable ? <TableView spec={spec} /> : <Plot spec={spec} />}

      <div className="mt-1.5 flex items-start justify-between gap-3">
        {spec.note
          ? <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500">{spec.note}</p>
          : <span />}
        <button
          type="button"
          onClick={() => setShowTable(v => !v)}
          className="shrink-0 rounded px-1 text-[10px] text-slate-400 underline decoration-dotted underline-offset-2 transition-colors hover:text-slate-600 dark:hover:text-slate-200"
        >
          {showTable ? 'Show chart' : 'Show numbers'}
        </button>
      </div>
    </figure>
  );
}

function Plot({ spec }: { spec: ChartSpec }) {
  switch (spec.type) {
    case 'pie': return <Pie spec={spec} />;
    case 'line': return <Line spec={spec} />;
    case 'column': return <Columns spec={spec} />;
    case 'stacked_bar': return <StackedBar spec={spec} />;
    default: return <Bars spec={spec} />;
  }
}

/** The numbers behind the picture. Required, not optional — see the header. */
function TableView({ spec }: { spec: ChartSpec }) {
  const labels = [...new Set(spec.series.flatMap(s => s.points.map(p => p.label)))];
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full border-collapse text-[11px]">
        <thead className="bg-slate-50 dark:bg-slate-800/60">
          <tr>
            <th className="px-2.5 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-200">Item</th>
            {spec.series.map(s => (
              <th key={s.label} className="px-2.5 py-1.5 text-right font-semibold text-slate-700 dark:text-slate-200">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map(label => (
            <tr key={label} className="border-t border-slate-100 dark:border-slate-700/60">
              <td className="px-2.5 py-1 text-slate-600 dark:text-slate-300">{label}</td>
              {spec.series.map(s => {
                const p = s.points.find(x => x.label === label);
                return (
                  <td key={s.label} className="px-2.5 py-1 text-right tabular-nums text-slate-700 dark:text-slate-200">
                    {p ? formatValue(p.value, spec.unit) : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars — magnitude of ONE measure, so sequential blue, not hues.
// ---------------------------------------------------------------------------

function Bars({ spec }: { spec: ChartSpec }) {
  const series = spec.series[0];
  const points = series.points;
  const max = niceMax(Math.max(...points.map(p => Math.abs(p.value)), 0));
  const rowH = Math.min(34, Math.max(22, 260 / Math.max(points.length, 1)));
  const barH = Math.min(BAR_MAX, rowH - 8);
  const labelW = 104;
  const valueW = 62;
  const height = points.length * rowH + 4;

  return (
    <svg
      viewBox={`0 0 460 ${height}`}
      className="w-full"
      style={{ height: Math.min(height, 420) }}
      role="img"
      aria-label={spec.title}
    >
      {points.map((p, i) => {
        const y = i * rowH + (rowH - barH) / 2;
        const w = max === 0 ? 0 : (Math.abs(p.value) / max) * (460 - labelW - valueW);
        // Darker for bigger: magnitude reads from the ramp, not from eight hues.
        const shade = SEQ[Math.min(SEQ.length - 1, Math.floor((Math.abs(p.value) / (max || 1)) * SEQ.length))];
        return (
          <g key={p.label}>
            <title>{`${p.label}: ${formatValue(p.value, spec.unit)}`}</title>
            <text x={0} y={y + barH / 2 + 3.5} className="fill-slate-600 dark:fill-slate-300" fontSize={10.5}>
              {p.label.length > 16 ? `${p.label.slice(0, 15)}…` : p.label}
            </text>
            {/* 4px rounded data-end, square at the baseline */}
            <rect
              x={labelW} y={y} width={Math.max(w, 1)} height={barH}
              fill={shade} rx={w > 8 ? 4 : 1}
            />
            <rect x={labelW} y={y} width={Math.min(4, Math.max(w, 1))} height={barH} fill={shade} />
            <text
              x={labelW + w + 6} y={y + barH / 2 + 3.5}
              className="fill-slate-700 dark:fill-slate-200" fontSize={10.5} fontWeight={500}
            >
              {formatValue(p.value, spec.unit)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Columns — up to two series side by side, e.g. worked against required.
// ---------------------------------------------------------------------------

function Columns({ spec }: { spec: ChartSpec }) {
  const labels = spec.series[0].points.map(p => p.label);
  const max = niceMax(Math.max(
    ...spec.series.flatMap(s => s.points.map(p => Math.abs(p.value))), 0,
  ));
  const W = 460, H = 200, padL = 42, padB = 26, padT = 8;
  const plotW = W - padL - 6;
  const plotH = H - padB - padT;
  const band = plotW / Math.max(labels.length, 1);
  const n = spec.series.length;
  const barW = Math.min(BAR_MAX, Math.max(3, (band - GAP * (n + 1)) / n));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img" aria-label={spec.title}>
      {/* Hairline, solid, recessive. Never dashed. */}
      {Array.from({ length: TICKS + 1 }, (_, i) => {
        const v = (max / TICKS) * i;
        const y = padT + plotH - (v / (max || 1)) * plotH;
        return (
          <g key={i}>
            <line x1={padL} x2={W - 6} y1={y} y2={y} stroke="var(--viz-grid)" strokeWidth={1} />
            <text x={padL - 5} y={y + 3} textAnchor="end" className="fill-slate-400" fontSize={9}>
              {formatValue(v, spec.unit)}
            </text>
          </g>
        );
      })}
      {labels.map((label, li) => (
        <g key={label}>
          {spec.series.map((s, si) => {
            const p = s.points.find(x => x.label === label);
            const value = Math.abs(p?.value ?? 0);
            const h = max === 0 ? 0 : (value / max) * plotH;
            const x = padL + li * band + GAP + si * (barW + GAP);
            const y = padT + plotH - h;
            return (
              <g key={s.label}>
                <title>{`${label} · ${s.label}: ${formatValue(p?.value ?? 0, spec.unit)}`}</title>
                <rect x={x} y={y} width={barW} height={Math.max(h, value > 0 ? 1 : 0)}
                  fill={n === 1 ? 'var(--viz-seq-4)' : SLOT[si % SLOT.length]} rx={h > 8 ? 4 : 1} />
                {h > 8 && <rect x={x} y={y + h - 4} width={barW} height={4}
                  fill={n === 1 ? 'var(--viz-seq-4)' : SLOT[si % SLOT.length]} />}
              </g>
            );
          })}
          {/* Thin out x labels rather than letting them collide. */}
          {(labels.length <= 16 || li % Math.ceil(labels.length / 16) === 0) && (
            <text x={padL + li * band + band / 2} y={H - 8} textAnchor="middle"
              className="fill-slate-400" fontSize={9}>
              {label.length > 6 ? label.slice(0, 6) : label}
            </text>
          )}
        </g>
      ))}
      <line x1={padL} x2={W - 6} y1={padT + plotH} y2={padT + plotH} stroke="var(--viz-axis)" strokeWidth={1} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Line — trend over time. End-dot and end label; never a number on every point.
// ---------------------------------------------------------------------------

function Line({ spec }: { spec: ChartSpec }) {
  const labels = spec.series[0].points.map(p => p.label);
  const max = niceMax(Math.max(...spec.series.flatMap(s => s.points.map(p => p.value)), 0));
  const W = 460, H = 200, padL = 42, padB = 26, padT = 10, padR = 54;
  const plotW = W - padL - padR;
  const plotH = H - padB - padT;
  const x = (i: number) => padL + (labels.length === 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / (max || 1)) * plotH;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img" aria-label={spec.title}>
      {Array.from({ length: TICKS + 1 }, (_, i) => {
        const v = (max / TICKS) * i;
        return (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--viz-grid)" strokeWidth={1} />
            <text x={padL - 5} y={y(v) + 3} textAnchor="end" className="fill-slate-400" fontSize={9}>
              {formatValue(v, spec.unit)}
            </text>
          </g>
        );
      })}
      {spec.series.map((s, si) => {
        const colour = spec.series.length === 1 ? 'var(--viz-seq-4)' : SLOT[si % SLOT.length];
        const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.value)}`).join(' ');
        const last = s.points[s.points.length - 1];
        return (
          <g key={s.label}>
            <path d={d} fill="none" stroke={colour} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {/* End marker, with a 2px ring in the surface colour so it stays
                legible where lines cross. */}
            <circle cx={x(s.points.length - 1)} cy={y(last.value)} r={4}
              fill={colour} stroke="var(--viz-surface)" strokeWidth={2} />
            <text x={x(s.points.length - 1) + 8} y={y(last.value) + 3.5}
              className="fill-slate-700 dark:fill-slate-200" fontSize={10} fontWeight={500}>
              {formatValue(last.value, spec.unit)}
            </text>
            {s.points.map((p, i) => (
              <circle key={i} cx={x(i)} cy={y(p.value)} r={7} fill="transparent">
                <title>{`${p.label} · ${s.label}: ${formatValue(p.value, spec.unit)}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
      {labels.map((label, i) => (
        (labels.length <= 12 || i % Math.ceil(labels.length / 12) === 0) && (
          <text key={label} x={x(i)} y={H - 8} textAnchor="middle" className="fill-slate-400" fontSize={9}>
            {label.length > 6 ? label.slice(0, 6) : label}
          </text>
        )
      ))}
      <line x1={padL} x2={W - padR} y1={padT + plotH} y2={padT + plotH} stroke="var(--viz-axis)" strokeWidth={1} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Pie — part-to-whole at a glance only. Folded to six slices, every slice
// directly labelled, so identity never rests on colour.
// ---------------------------------------------------------------------------

function Pie({ spec }: { spec: ChartSpec }) {
  const points = useMemo(() => foldForPie(spec.series[0].points.filter(p => p.value > 0)), [spec]);
  const total = points.reduce((sum, p) => sum + p.value, 0);
  const id = useId();
  const W = 460, H = 210, cx = 112, cy = 105, r = 86;

  // Cumulative offsets computed up front rather than with a running variable:
  // mutating across a render pass is exactly what the React compiler forbids.
  const before = cumulative(points.map(p => p.value));

  const slices = points.map((p, i) => {
    const sweep = total === 0 ? 0 : (p.value / total) * Math.PI * 2;
    const a0 = -Math.PI / 2 + (total === 0 ? 0 : (before[i] / total) * Math.PI * 2);
    const a1 = a0 + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const d = [
      `M ${cx} ${cy}`,
      `L ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)}`,
      `A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)}`,
      'Z',
    ].join(' ');
    return { ...p, d, colour: SLOT[i % SLOT.length], pct: total === 0 ? 0 : (p.value / total) * 100 };
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img" aria-label={spec.title}>
      {slices.map(s => (
        <path key={s.label} d={s.d} fill={s.colour}
          stroke="var(--viz-surface)" strokeWidth={GAP}>
          <title>{`${s.label}: ${formatValue(s.value, spec.unit)} (${Math.round(s.pct)}%)`}</title>
        </path>
      ))}
      {/* Direct labels for every slice — the relief that light-mode contrast
          requires, and the reason the pie is readable without colour matching. */}
      {slices.map((s, i) => (
        <g key={`${id}-${s.label}`} transform={`translate(232, ${16 + i * 30})`}>
          <rect width={9} height={9} rx={2} y={-7} fill={s.colour} />
          <text x={15} y={0} className="fill-slate-700 dark:fill-slate-200" fontSize={11}>
            {s.label.length > 20 ? `${s.label.slice(0, 19)}…` : s.label}
          </text>
          <text x={15} y={13} className="fill-slate-500 dark:fill-slate-400" fontSize={10}>
            {formatValue(s.value, spec.unit)} · {Math.round(s.pct)}%
          </text>
        </g>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Stacked bar — one row, part-to-whole, with a 2px surface gap between parts.
// ---------------------------------------------------------------------------

function StackedBar({ spec }: { spec: ChartSpec }) {
  const points = spec.series[0].points.filter(p => p.value > 0);
  const total = points.reduce((sum, p) => sum + p.value, 0);
  const W = 460, barY = 10, barH = 24;

  const before = cumulative(points.map(p => p.value));
  const parts = points.map((p, i) => ({
    ...p,
    x: total === 0 ? 0 : (before[i] / total) * W,
    w: total === 0 ? 0 : (p.value / total) * W,
    colour: SLOT[i % SLOT.length],
    pct: total === 0 ? 0 : (p.value / total) * 100,
  }));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${barY + barH + 4}`} className="w-full" style={{ height: barY + barH + 4 }}
        role="img" aria-label={spec.title}>
        {parts.map((p, i) => (
          <rect key={p.label}
            x={p.x + (i === 0 ? 0 : GAP / 2)}
            y={barY}
            width={Math.max(0, p.w - (i === 0 || i === parts.length - 1 ? GAP / 2 : GAP))}
            height={barH}
            fill={p.colour}
            rx={i === 0 || i === parts.length - 1 ? 4 : 0}
          >
            <title>{`${p.label}: ${formatValue(p.value, spec.unit)} (${Math.round(p.pct)}%)`}</title>
          </rect>
        ))}
      </svg>
      {/* Interior segments have no free end to label, so the legend carries
          them — never a clipped label inside the mark. */}
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {parts.map(p => (
          <li key={p.label} className="flex items-center gap-1.5 text-[10.5px] text-slate-600 dark:text-slate-300">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: p.colour }} />
            {p.label}
            <span className="text-slate-400">{formatValue(p.value, spec.unit)} · {Math.round(p.pct)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
