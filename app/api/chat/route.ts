import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import OpenAI from 'openai';
import { requireAuth } from '@/lib/auth';
import { insertAuditLog } from '@/lib/db';
import { runChat, ChatConfigError, type ChatTurn } from '@/lib/chat/openai';
import { ChatForbiddenError, type ChatContext } from '@/lib/chat/types';
import {
  checkChatRateLimit,
  CHAT_AUDIT_ACTION,
  CHAT_AUDIT_ENTITY,
} from '@/lib/chat/ratelimit';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
});

const ChatRequestSchema = z.object({
  question: z.string().min(2, 'Ask a question.').max(1000),
  /** Prior turns for context. Capped to keep the request bounded. */
  history: z.array(TurnSchema).max(10).optional(),
});

interface ChatResponseData {
  answer: string;
  /** Where each figure came from — surfaced in the UI as a provenance line. */
  sources: Array<{
    tool: string;
    rows: number | null;
    period?: string;
    error?: string;
    ms: number;
  }>;
  model: string;
}

// ---------------------------------------------------------------------------
// POST /api/chat — super_admin only
//
// Read-only. Every data access goes through lib/chat/registry.ts, which exposes
// a closed set of SELECT-only functions; there is no raw-SQL path and no way to
// reach bank, PAN or Aadhaar columns. Questions outside that set are
// unanswerable by construction rather than by instruction.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // v1 is super_admin only. requireAuth enforces it here; every tool also
  // re-checks via requireSuperAdmin so widening this line cannot silently
  // widen data access.
  const auth = await requireAuth(request, ['super_admin']);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  const { question, history = [] } = parsed.data;

  const limit = await checkChatRateLimit(auth.id);
  if (!limit.allowed) {
    return NextResponse.json<ApiResponse>(
      {
        success: false,
        error: `Too many questions — the limit is ${limit.limit} every ${limit.windowMinutes} minutes. Please wait a moment.`,
      },
      { status: 429 },
    );
  }

  const ctx: ChatContext = { employeeId: auth.id, role: auth.role };
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    null;

  try {
    const result = await runChat(ctx, question, history as ChatTurn[]);

    // Provenance record. Also the rate-limit counter (see lib/chat/ratelimit.ts).
    // The question and the tools consulted are logged; answers are not, to keep
    // the log a record of access rather than a second copy of the data.
    await insertAuditLog({
      action: CHAT_AUDIT_ACTION,
      entity: CHAT_AUDIT_ENTITY,
      performed_by: auth.id,
      ip_address: ip,
      details: {
        question,
        model: result.model,
        iterations: result.iterations,
        tools: result.traces.map(t => ({
          name: t.name,
          args: t.args,
          rows: t.rows,
          period: t.range_label,
          error: t.error,
        })),
        usage: result.usage,
      },
    });

    return NextResponse.json<ApiResponse<ChatResponseData>>({
      success: true,
      data: {
        answer: result.answer,
        sources: result.traces.map(t => ({
          tool: t.name,
          rows: t.rows,
          period: t.range_label,
          error: t.error,
          ms: t.ms,
        })),
        model: result.model,
      },
    });
  } catch (err) {
    if (err instanceof ChatConfigError) {
      console.error('[chat] not configured:', err.message);
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'The assistant is not configured on this server.' },
        { status: 503 },
      );
    }

    if (err instanceof ChatForbiddenError) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: err.message },
        { status: 403 },
      );
    }

    // Most specific first. Never leak the upstream message to the client.
    if (err instanceof OpenAI.AuthenticationError) {
      console.error('[chat] OpenAI auth failed — check OPENAI_API_KEY');
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'The assistant is not configured correctly.' },
        { status: 503 },
      );
    }

    if (err instanceof OpenAI.RateLimitError) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'The assistant is busy. Please try again shortly.' },
        { status: 429 },
      );
    }

    if (err instanceof OpenAI.APIConnectionError) {
      console.error('[chat] could not reach OpenAI:', err.message);
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'Could not reach the assistant service.' },
        { status: 503 },
      );
    }

    if (err instanceof OpenAI.APIError) {
      console.error(`[chat] OpenAI API error ${err.status}:`, err.message);
      return NextResponse.json<ApiResponse>(
        { success: false, error: 'The assistant could not answer that right now.' },
        { status: 502 },
      );
    }

    console.error('[chat] unexpected failure:', err);
    return NextResponse.json<ApiResponse>(
      { success: false, error: 'Something went wrong answering that.' },
      { status: 500 },
    );
  }
}
