import { requireSuperAdmin, type ChatContext, type ToolResult } from '../types';
import {
  validateChartSpec,
  type ChartSpec,
} from '@/lib/charts/types';

/**
 * lib/chat/tools/charts.ts — turn figures already fetched into a chart.
 *
 * The model passes DATA, not drawing instructions: labels, values, a form and a
 * unit. The browser decides colours, geometry and formatting. Nothing the model
 * writes is rendered as markup, so a chart cannot become a channel for anything
 * other than numbers — and those numbers have to have come from another tool's
 * result, because the model is forbidden from inventing or calculating them.
 *
 * The tool is deliberately dumb: it validates the shape, refuses the forms that
 * would mislead, and hands the spec back. It does not fetch anything itself.
 * Giving it its own query path would create a second way to read attendance,
 * with its own bugs and its own idea of what a week off is.
 */

export interface ChartToolResult {
  chart: ChartSpec;
  /** Shown to the user as the assistant's own words about the picture. */
  summary: string;
}

export async function buildChart(
  ctx: ChatContext,
  args: { spec?: unknown } & Record<string, unknown>,
): Promise<ToolResult<ChartToolResult>> {
  requireSuperAdmin(ctx);

  // The model may pass the spec nested or flat; accept both rather than fail on
  // a shape that is obviously the right data.
  const candidate = args.spec ?? args;
  const result = validateChartSpec(candidate);

  if ('error' in result) {
    throw new Error(
      `${result.error} A chart has a type, a title, a unit and a list of series, `
      + 'each with labelled points. Every value must come from a tool result you have already read.',
    );
  }

  const { spec } = result;
  const notes: string[] = [];

  // Steer away from forms that are legible but wrong for the job. These are
  // nudges in the result rather than refusals, because the model can see the
  // data and may have a reason.
  if (spec.type === 'pie' && spec.series[0].points.length > 6) {
    notes.push(
      `${spec.series[0].points.length} slices is too many to read; the smallest have been `
      + 'grouped as "Other". A bar chart would compare them better.',
    );
  }
  if (spec.type === 'pie') {
    const vals = [...spec.series[0].points].map(p => p.value).sort((a, b) => b - a);
    const total = vals.reduce((s, v) => s + v, 0);
    // Slices within a few per cent of each other cannot be told apart by angle.
    const close = vals.length > 2 && total > 0
      && vals.every((v, i) => i === 0 || Math.abs(v - vals[i - 1]) / total < 0.03);
    if (close) {
      notes.push(
        'These shares are all close together, which a pie shows poorly — say so, and '
        + 'offer a bar chart if the user wants to compare them properly.',
      );
    }
  }

  return {
    count: 1,
    rows: [{
      chart: spec,
      summary: `${spec.title}${spec.subtitle ? ` — ${spec.subtitle}` : ''}`,
    }],
    notes: [
      'The chart is now on screen for the user. Describe what it shows in a sentence '
      + 'or two — do not list every value back, the chart and its table view already have them.',
      ...notes,
    ],
  };
}
