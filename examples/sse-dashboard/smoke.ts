/**
 * Smoke test for sse-dashboard — drives the real app.ts against the
 * workspace `src/` (the resolve hook in ../ts-resolve.mjs redirects the
 * public `s200*` entry names there), over a real HTTP server on an
 * ephemeral port.
 *
 * Reads the raw /events stream through a ReadableStream reader and parses
 * the SSE framing by hand (event/data lines, heartbeat comments), proving
 * the wire format — no EventSource client involved.
 *
 * Run: node smoke.ts — exits 0 when every check passes.
 */
import '../ts-resolve.mjs';

const { app } = await import('./app.ts');
const { serve } = await import('s200/node');

let failures = 0;
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures += 1;
};

/** One parsed SSE frame: named fields + comment lines seen alongside. */
type SseFrame = { event?: string; data: string[] };
type ParsedStream = { frames: SseFrame[]; comments: string[] };

/** Parses the event-stream wire format: frames end at a blank line,
 * comments start with ':'. A trailing partial frame is ignored. */
const parseSse = (text: string): ParsedStream => {
  const parsed: ParsedStream = { frames: [], comments: [] };
  for (const rawFrame of text.split('\n\n')) {
    if (rawFrame === '') continue;
    const frame: SseFrame = { data: [] };
    for (const line of rawFrame.split('\n')) {
      if (line.startsWith(':')) {
        parsed.comments.push(line.slice(2));
      } else if (line.startsWith('event: ')) {
        frame.event = line.slice('event: '.length);
      } else if (line.startsWith('data: ')) {
        frame.data.push(line.slice('data: '.length));
      }
    }
    parsed.frames.push(frame);
  }
  return parsed;
};

const server = await serve(app, { port: 0 });
const base = server.url;

try {
  // The dashboard page serves as text/html with the client wiring in it.
  const page = await fetch(`${base}/`);
  const html = await page.text();
  check('GET / serves the dashboard', page.status === 200);
  check(
    'dashboard content-type is text/html',
    (page.headers.get('content-type') ?? '').startsWith('text/html')
  );
  check(
    'page wires fetch + EventSource to /events',
    html.includes('EventSource') && html.includes("'/events'") && html.includes('fetch(')
  );

  // Health endpoint the page fetches on load.
  const health = await fetch(`${base}/health`);
  check(
    'GET /health → {"ok":true}',
    health.status === 200 && ((await health.json()) as { ok?: boolean }).ok === true
  );

  // The raw event stream: content-type first, then frame-by-frame parsing.
  const events = await fetch(`${base}/events`);
  check(
    '/events is text/event-stream',
    (events.headers.get('content-type') ?? '').startsWith('text/event-stream')
  );

  const reader = events.body?.getReader();
  if (reader === undefined) {
    check('/events returns a readable body', false, 'no body reader');
  } else {
    const decoder = new TextDecoder();
    let wire = '';
    let streamDone = false;
    // The pump is bounded (5 ticks + done, ~150 ms), so this loop ends on
    // its own — no timeout guard needed.
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        streamDone = true;
      } else {
        wire += decoder.decode(value, { stream: true });
      }
    }
    wire += decoder.decode();

    const { frames, comments } = parseSse(wire);
    const ticks = frames.filter((f) => f.event === 'tick');
    const tickNumbers = ticks.map((f) => (JSON.parse(f.data.join('\n')) as { n: number }).n);
    const doneFrame = frames.find((f) => f.event === 'done');

    check('stream closed by itself (bounded pump)', streamDone);
    check(
      'five tick frames, in order',
      ticks.length === 5 && JSON.stringify(tickNumbers) === '[1,2,3,4,5]',
      `got ${JSON.stringify(tickNumbers)}`
    );
    check(
      'tick payloads are JSON objects with n and at',
      ticks.every((f) => {
        const payload = JSON.parse(f.data.join('\n')) as { n?: unknown; at?: unknown };
        return typeof payload.n === 'number' && typeof payload.at === 'number';
      })
    );
    check('one heartbeat comment frame', comments.length === 1 && comments[0] === 'heartbeat');
    check(
      'done event terminates the stream',
      doneFrame !== undefined && doneFrame.data.join('\n') === 'stream complete' &&
        frames[frames.length - 1] === doneFrame
    );
  }
} finally {
  await server.close();
  check('server closed (no longer listening)', server.server.listening === false);
}

process.exit(failures === 0 ? 0 : 1);
