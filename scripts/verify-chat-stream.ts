/**
 * scripts/verify-chat-stream.ts — route-level checks for the SSE chat stream.
 *
 *   npx tsx --env-file=.env.local scripts/verify-chat-stream.ts
 *
 * SPENDS REAL MONEY on the one case that reaches the model.
 *
 * The other suites call `runChat` directly, so nothing covered the route
 * itself: the auth gate, the rate-limit `meta` frame, and the exact wire
 * framing (`data: {json}\n\n`) that ChatPanel parses. A mistake in any of those
 * is invisible to a unit test and obvious to a user.
 */

import { NextRequest } from 'next/server';
import { POST } from '../app/api/chat/stream/route';
import { signAccessToken, currentTokenVersion } from '../lib/auth';
import { queryOne, pool } from '../lib/db';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

interface Frame {
  type: string;
  [k: string]: unknown;
}

/** Parse the response body exactly the way the browser client does. */
async function readFrames(res: Response): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = '';
  let leftovers = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find(l => l.startsWith('data: '));
      if (!line) {
        leftovers += 1;
        continue;
      }
      frames.push(JSON.parse(line.slice(6)) as Frame);
    }
  }

  check('every frame carried a data: line', leftovers === 0, `${leftovers} unparseable`);
  check('stream ended on a frame boundary', buffer.trim() === '', JSON.stringify(buffer.slice(0, 40)));
  return frames;
}

function request(body: unknown, token?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Cookie: `access_token=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function main() {
  console.log('\n— auth gate —');

  const anon = await POST(request({ question: 'who is absent today?' }));
  check('no cookie is rejected', anon.status === 401, `HTTP ${anon.status}`);

  const employee = await queryOne<{ id: number; role: string }>(
    "SELECT id, role FROM employees WHERE role = 'employee' AND is_active = 1 LIMIT 1",
  );
  if (employee) {
    const tv = await currentTokenVersion(employee.id);
    const token = signAccessToken({ id: employee.id, role: employee.role, tv } as never);
    const res = await POST(request({ question: 'who is absent today?' }, token));
    check('a plain employee is rejected', res.status === 403, `HTTP ${res.status}`);
  } else {
    check('a plain employee is rejected', false, 'no active employee row to test with');
  }

  const admin = await queryOne<{ id: number; role: string }>(
    "SELECT id, role FROM employees WHERE role = 'super_admin' AND is_active = 1 LIMIT 1",
  );
  if (!admin) {
    check('a super_admin exists to test with', false, 'none found');
    return;
  }
  const adminTv = await currentTokenVersion(admin.id);
  const adminToken = signAccessToken({ id: admin.id, role: admin.role, tv: adminTv } as never);

  console.log('\n— validation —');
  const short = await POST(request({ question: 'a' }, adminToken));
  check('a one-character question is rejected', short.status === 400, `HTTP ${short.status}`);

  const badJson = new NextRequest('http://localhost:3000/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `access_token=${adminToken}` },
    body: 'not json',
  });
  check('malformed JSON is rejected', (await POST(badJson)).status === 400);

  console.log('\n— stream shape —');
  const res = await POST(request({ question: 'How many employees are active?' }, adminToken));
  check('super_admin gets 200', res.status === 200, `HTTP ${res.status}`);
  check(
    'content type is an event stream',
    (res.headers.get('content-type') ?? '').startsWith('text/event-stream'),
    res.headers.get('content-type') ?? 'missing',
  );
  check('nginx buffering is disabled', res.headers.get('x-accel-buffering') === 'no');

  const frames = await readFrames(res);
  check('frames arrived', frames.length > 0, `${frames.length} frames`);

  const first = frames[0];
  check('the first frame is meta', first?.type === 'meta', `got ${first?.type}`);

  const lim = first?.limit as { used?: number; limit?: number; windowMinutes?: number } | undefined;
  check(
    'meta carries a usable rate-limit triple',
    typeof lim?.used === 'number' && typeof lim?.limit === 'number' && typeof lim?.windowMinutes === 'number',
    JSON.stringify(lim),
  );
  check(
    'used counts this question, and is within the limit',
    (lim?.used ?? 0) >= 1 && (lim?.used ?? 0) <= (lim?.limit ?? 0),
    `used=${lim?.used} of ${lim?.limit}`,
  );

  const done = frames.find(f => f.type === 'done');
  check('a done frame closed the turn', Boolean(done));
  check('done names the model', typeof done?.model === 'string' && (done.model as string).length > 0, String(done?.model));

  const usage = done?.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  check(
    'done carries the token counts the UI prints',
    typeof usage?.prompt_tokens === 'number' && typeof usage?.completion_tokens === 'number',
    JSON.stringify(usage),
  );

  const deltas = frames.filter(f => f.type === 'delta');
  check('the answer streamed as deltas', deltas.length > 0, `${deltas.length} deltas`);
  check(
    'concatenated deltas match the final answer',
    deltas.map(d => String(d.text)).join('') === String(done?.answer ?? ''),
    'collapseExactDuplicate may have rewritten it, which is expected when it fires',
  );

  const traces = (done?.traces as unknown[]) ?? [];
  check('at least one tool was used', traces.length > 0, `${traces.length} traces`);
  check(
    'every tool_start has a tool_done',
    frames.filter(f => f.type === 'tool_start').length === frames.filter(f => f.type === 'tool_done').length,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch(err => {
    console.error(err);
    failed += 1;
  })
  .finally(async () => {
    await pool.end();
    process.exit(failed === 0 ? 0 : 1);
  });
