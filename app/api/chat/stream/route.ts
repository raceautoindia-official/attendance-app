import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { insertAuditLog } from '@/lib/db';
import { runChatStream, type ChatEvent, type ChatTurn } from '@/lib/chat/openai';
import { type ChatContext } from '@/lib/chat/types';
import {
  checkChatRateLimit,
  CHAT_AUDIT_ACTION,
  CHAT_AUDIT_ENTITY,
} from '@/lib/chat/ratelimit';
import type { ApiResponse } from '@/lib/types';

const TurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
});

const ChatRequestSchema = z.object({
  question: z.string().min(2, 'Ask a question.').max(1000),
  history: z.array(TurnSchema).max(10).optional(),
});

// ---------------------------------------------------------------------------
// POST /api/chat/stream — super_admin only, Server-Sent Events
//
// Same guarantees as /api/chat (read-only, closed tool set, PII unreachable),
// but streams progress so the UI can show which record it is reading and then
// type the answer out as it is generated.
//
// Event frames are `data: {json}\n\n`. Types: tool_start, tool_done, download,
// delta, done, error.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
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
        error: `You've asked quite a few questions in a short window — the limit is ${limit.limit} every ${limit.windowMinutes} minutes. Give it a moment and try again.`,
      },
      { status: 429 },
    );
  }

  const ctx: ChatContext = { employeeId: auth.id, role: auth.role };
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: ChatEvent | { type: 'error'; message: string }) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        await runChatStream(ctx, question, history as ChatTurn[], event => {
          send(event);

          // Log once, when the turn completes, so the audit row carries the
          // full tool trace. Also the rate-limit counter.
          if (event.type === 'done') {
            void insertAuditLog({
              action: CHAT_AUDIT_ACTION,
              entity: CHAT_AUDIT_ENTITY,
              performed_by: auth.id,
              ip_address: ip,
              details: {
                question,
                model: event.model,
                streamed: true,
                tools: event.traces.map(t => ({
                  name: t.name,
                  args: t.args,
                  rows: t.rows,
                  period: t.range_label,
                  error: t.error,
                })),
                usage: event.usage,
              },
            });
          }
        });
      } catch (err) {
        console.error('[chat/stream] failed:', err);
        send({
          type: 'error',
          message:
            'Something went wrong while answering that. Please try again in a moment.',
        });
      } finally {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stops Nginx buffering the stream into one lump.
      'X-Accel-Buffering': 'no',
    },
  });
}
