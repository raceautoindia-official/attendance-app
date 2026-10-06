/**
 * lib/chat/openai.ts — the agent loop.
 *
 * Calls the model, runs whichever registry tools it asks for, feeds the results
 * back, and repeats until it produces a final answer. The model never touches
 * the database directly: every data access goes through `dispatch`, which
 * enforces the role check and the PII allowlist.
 */

import OpenAI from 'openai';
import { openAiTools, dispatch } from './registry';
import { SYSTEM_PROMPT, dateContext } from './prompt';
import { istToday } from './dates';
import { ChatForbiddenError, type ChatContext } from './types';
import { validateChartSpec, type ChartSpec } from '@/lib/charts/types';

/**
 * Configure via OPENAI_MODEL. Model names change often — set this to whatever
 * your account currently offers rather than relying on the default.
 *
 * Read per call rather than at module load so a caller (or the model-comparison
 * script) can override it without reloading the module.
 */
function defaultModel(): string {
  return process.env.OPENAI_MODEL || 'gpt-5.4-mini';
}

/**
 * Hard ceiling on model round trips. A normal question needs 2-3 (resolve the
 * person, fetch the data, answer). The cap stops a model that keeps calling
 * tools in a loop from spending tokens indefinitely.
 */
const MAX_ITERATIONS = 6;

/** Truncate oversized tool payloads so one query cannot blow the context. */
const MAX_TOOL_RESULT_CHARS = 24_000;

let client: OpenAI | null = null;

/**
 * Built on first use, not at import time, so the app boots normally without an
 * API key — only the chat endpoint is unavailable.
 */
function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new ChatConfigError(
      'The assistant is not configured: OPENAI_API_KEY is not set.',
    );
  }
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export class ChatConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatConfigError';
  }
}

/** One tool invocation, recorded so the UI can show where a figure came from. */
export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  /** Rows returned, or null when the tool failed. */
  rows: number | null;
  /** The period the tool actually resolved, for the provenance line. */
  range_label?: string;
  error?: string;
  ms: number;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatAnswer {
  answer: string;
  traces: ToolTrace[];
  iterations: number;
  model: string;
  /** Token usage summed across every round trip in this turn. */
  usage: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Collapse an answer that is exactly the same text twice.
 *
 * Observed intermittently on the mini tier: the model occasionally emits its
 * whole reply a second time when it answers without calling a tool. It is
 * harmless — nothing is leaked and no figure changes — but it looks broken, so
 * the duplicate is dropped.
 *
 * Deliberately conservative: only an EXACT repetition of a substantial block is
 * collapsed, so a genuine repeated phrase is never mangled.
 */
function collapseExactDuplicate(text: string): string {
  const t = text.trim();
  if (t.length < 80) return t;

  // Split on the midpoint and compare, tolerating the whitespace between halves.
  const mid = Math.floor(t.length / 2);
  for (const pivot of [mid, t.indexOf('\n\n') + 2]) {
    if (pivot <= 0 || pivot >= t.length) continue;
    const a = t.slice(0, pivot).trim();
    const b = t.slice(pivot).trim();
    if (a.length >= 40 && a === b) return a;
  }
  return t;
}

function resultShape(value: unknown): { rows: number | null; range_label?: string } {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const count = typeof v.count === 'number' ? v.count : null;
    const range = v.range as { label?: string } | undefined;
    return { rows: count, range_label: range?.label };
  }
  return { rows: null };
}

/**
 * Answer one question.
 *
 * `history` carries prior turns for context. Note that the prompt requires an
 * explicit period in every answer, which is what keeps follow-ups like "now do
 * September" from silently reusing the wrong range.
 */
export async function runChat(
  ctx: ChatContext,
  question: string,
  history: ChatTurn[] = [],
  opts: { model?: string } = {},
): Promise<ChatAnswer> {
  const openai = getClient();
  const model = opts.model ?? defaultModel();
  const tools = openAiTools();
  const traces: ToolTrace[] = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0 };

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    // Volatile content goes AFTER the frozen prompt and tool list so the
    // cacheable prefix stays byte-identical between requests.
    { role: 'system', content: dateContext(istToday()) },
    ...history.map(h => ({ role: h.role, content: h.content }) as
      OpenAI.Chat.Completions.ChatCompletionMessageParam),
    { role: 'user', content: question },
  ];

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;

    const completion = await openai.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: 'auto',
    });

    usage.prompt_tokens += completion.usage?.prompt_tokens ?? 0;
    usage.completion_tokens += completion.usage?.completion_tokens ?? 0;

    const choice = completion.choices[0];
    const message = choice?.message;
    if (!message) break;

    const toolCalls = (message.tool_calls ?? []).filter(
      (c): c is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
        c.type === 'function',
    );

    // No tool calls means this is the final answer.
    if (toolCalls.length === 0) {
      return {
        answer:
          collapseExactDuplicate(message.content ?? '') ||
          'I could not produce an answer for that.',
        traces,
        iterations,
        model,
        usage,
      };
    }

    messages.push(message);

    // Run the batch concurrently, then append every result in order. Dropping
    // or reordering a tool_result breaks the conversation contract.
    const settled = await Promise.all(
      toolCalls.map(async call => {
        const started = Date.now();
        let args: Record<string, unknown> = {};

        try {
          // Always parse — never string-match the serialised arguments.
          args = call.function.arguments
            ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
            : {};
        } catch {
          const trace: ToolTrace = {
            name: call.function.name,
            args: {},
            rows: null,
            error: 'Could not parse tool arguments.',
            ms: Date.now() - started,
          };
          return { call, trace, content: JSON.stringify({ error: trace.error }) };
        }

        try {
          const result = await dispatch(ctx, call.function.name, args);
          const shape = resultShape(result);
          const trace: ToolTrace = {
            name: call.function.name,
            args,
            rows: shape.rows,
            range_label: shape.range_label,
            ms: Date.now() - started,
          };

          let content = JSON.stringify(result);
          if (content.length > MAX_TOOL_RESULT_CHARS) {
            content = JSON.stringify({
              error:
                'Result too large to return in full. Narrow the period, or filter by employee or department, and ask again.',
              count: shape.rows,
              range: shape.range_label,
            });
            trace.error = 'result truncated — too large';
          }

          return { call, trace, content };
        } catch (err) {
          // A forbidden call must never be retried differently by the model,
          // so the message it sees is final and explicit.
          const msg =
            err instanceof ChatForbiddenError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Tool failed.';
          console.error(`[chat] tool ${call.function.name} failed:`, err);
          const trace: ToolTrace = {
            name: call.function.name,
            args,
            rows: null,
            error: msg,
            ms: Date.now() - started,
          };
          return { call, trace, content: JSON.stringify({ error: msg }) };
        }
      }),
    );

    for (const { call, trace, content } of settled) {
      traces.push(trace);
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  // Ran out of iterations with the model still calling tools.
  return {
    answer:
      'That question needed more lookups than I am allowed in one turn. Try asking for a narrower period, or one employee or department at a time.',
    traces,
    iterations,
    model,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Streaming variant
// ---------------------------------------------------------------------------

/** A download link offered by create_report_download. */
export interface DownloadEvent {
  download_url: string;
  filename: string;
  format: string;
  report_label: string;
  rows: number;
  period?: string;
}

/** Rate-limit snapshot sent once, before any model work. */
export interface ChatLimitMeta {
  used: number;
  limit: number;
  windowMinutes: number;
}

export type ChatEvent =
  | { type: 'meta'; limit: ChatLimitMeta }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_done'; name: string; rows: number | null; period?: string; error?: string }
  | { type: 'download'; file: DownloadEvent }
  | { type: 'chart'; chart: ChartSpec }
  | { type: 'delta'; text: string }
  | { type: 'done'; answer: string; traces: ToolTrace[]; model: string; usage: ChatAnswer['usage'] };

/**
 * Pull chart specs out of a build_chart result.
 *
 * The spec is re-validated here even though the tool already validated it: this
 * is the boundary where model-shaped data becomes something the browser draws,
 * and a bad spec should be dropped rather than rendered.
 */
function extractCharts(name: string, result: unknown): ChartSpec[] {
  if (name !== 'build_chart') return [];
  const r = result as { rows?: Array<{ chart?: unknown }> } | null;
  if (!Array.isArray(r?.rows)) return [];
  const out: ChartSpec[] = [];
  for (const row of r.rows) {
    const v = validateChartSpec(row?.chart);
    if ('spec' in v) out.push(v.spec);
  }
  return out;
}

/** Pull download offers out of a create_report_download result. */
function extractDownloads(name: string, result: unknown): DownloadEvent[] {
  if (name !== 'create_report_download') return [];
  const r = result as { rows?: DownloadEvent[] } | null;
  return Array.isArray(r?.rows) ? r.rows : [];
}

/**
 * Same loop as `runChat`, but streams.
 *
 * Emits a `tool_start` / `tool_done` pair per tool so the UI can show real
 * progress ("Looking up Reena…") instead of a fabricated spinner message, then
 * streams the answer token by token.
 */
export async function runChatStream(
  ctx: ChatContext,
  question: string,
  history: ChatTurn[] = [],
  onEvent: (e: ChatEvent) => void,
  opts: { model?: string } = {},
): Promise<void> {
  const openai = getClient();
  const model = opts.model ?? defaultModel();
  const tools = openAiTools();
  const traces: ToolTrace[] = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0 };

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: dateContext(istToday()) },
    ...history.map(h => ({ role: h.role, content: h.content }) as
      OpenAI.Chat.Completions.ChatCompletionMessageParam),
    { role: 'user', content: question },
  ];

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;

    const stream = await openai.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    });

    let text = '';
    // Tool calls arrive in fragments keyed by index — accumulate, never assume
    // one chunk carries a whole call.
    const acc = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage.prompt_tokens += chunk.usage.prompt_tokens ?? 0;
        usage.completion_tokens += chunk.usage.completion_tokens ?? 0;
      }

      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        onEvent({ type: 'delta', text: delta.content });
      }

      for (const tc of delta.tool_calls ?? []) {
        const cur = acc.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        acc.set(tc.index, cur);
      }
    }

    const calls = [...acc.values()].filter(c => c.id && c.name);

    if (calls.length === 0) {
      onEvent({
        type: 'done',
        answer:
          collapseExactDuplicate(text) || 'I could not produce an answer for that.',
        traces,
        model,
        usage,
      });
      return;
    }

    messages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: calls.map(c => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.args },
      })),
    });

    for (const c of calls) onEvent({ type: 'tool_start', name: c.name });

    const settled = await Promise.all(
      calls.map(async c => {
        const started = Date.now();
        let args: Record<string, unknown> = {};
        try {
          args = c.args ? (JSON.parse(c.args) as Record<string, unknown>) : {};
        } catch {
          const trace: ToolTrace = {
            name: c.name,
            args: {},
            rows: null,
            error: 'Could not parse tool arguments.',
            ms: Date.now() - started,
          };
          return { c, trace, content: JSON.stringify({ error: trace.error }), downloads: [], charts: [] };
        }

        try {
          const result = await dispatch(ctx, c.name, args);
          const shape = resultShape(result);
          const trace: ToolTrace = {
            name: c.name,
            args,
            rows: shape.rows,
            range_label: shape.range_label,
            ms: Date.now() - started,
          };

          let content = JSON.stringify(result);
          if (content.length > MAX_TOOL_RESULT_CHARS) {
            content = JSON.stringify({
              error:
                'Result too large to return in full. Narrow the period, or filter by employee or department, and ask again.',
              count: shape.rows,
              range: shape.range_label,
            });
            trace.error = 'result truncated — too large';
          }

          return { c, trace, content, downloads: extractDownloads(c.name, result), charts: extractCharts(c.name, result) };
        } catch (err) {
          const msg =
            err instanceof ChatForbiddenError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Tool failed.';
          console.error(`[chat] tool ${c.name} failed:`, err);
          const trace: ToolTrace = {
            name: c.name,
            args,
            rows: null,
            error: msg,
            ms: Date.now() - started,
          };
          return { c, trace, content: JSON.stringify({ error: msg }), downloads: [], charts: [] };
        }
      }),
    );

    for (const { c, trace, content, downloads, charts } of settled) {
      traces.push(trace);
      onEvent({
        type: 'tool_done',
        name: trace.name,
        rows: trace.rows,
        period: trace.range_label,
        error: trace.error,
      });
      for (const file of downloads) onEvent({ type: 'download', file });
      for (const chart of charts) onEvent({ type: 'chart', chart });
      messages.push({ role: 'tool', tool_call_id: c.id, content });
    }
  }

  onEvent({
    type: 'done',
    answer:
      'That question needed more lookups than I can do in one go. Could you narrow it to a shorter period, or one employee or department at a time?',
    traces,
    model,
    usage,
  });
}
