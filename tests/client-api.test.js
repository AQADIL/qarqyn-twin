import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('JSON client rejects a successful HTTP response with a non-JSON body', async (t) => {
  const { api } = await client(
    t,
    () =>
      new Response('<html>Proxy fallback</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      })
  );
  await assert.rejects(api('/datasets/allur'), /неверный ответ/);
});

test('mixed backend/frontend paginated contracts fail clearly instead of reaching component renders', async (t) => {
  const invalid = [
    [],
    { items: null, total: 0, page: 1, pageSize: 20 },
    { items: [], total: -1, page: 1, pageSize: 20 },
    { items: [null], total: 1, page: 1, pageSize: 20 },
    { items: [], total: 0, page: 0, pageSize: 20 },
    { items: [], total: 0, page: 1, pageSize: 500 }
  ];
  const { api } = await client(t, () => Response.json(invalid.shift()));
  for (const path of [
    '/scenarios?datasetId=allur&page=1',
    '/incidents?page=1',
    '/conversations?pageSize=20',
    '/audit?page=1',
    '/datasets/allur/versions?page=1',
    '/scenarios?pageSize=20'
  ])
    await assert.rejects(
      api(path),
      (error) =>
        error.code === 'API_CONTRACT_MISMATCH' && /несовместимые версии/.test(error.message)
    );
});

test('validated pagination preserves actual rows and unpaged arrays remain supported', async (t) => {
  const page = { items: [{ id: 'actual-record', version: 2 }], total: 41, page: 3, pageSize: 20 };
  let call = 0;
  const { api } = await client(t, () => Response.json(call++ ? [] : page));
  assert.deepEqual(await api('/scenarios?datasetId=allur&page=3&pageSize=20'), page);
  assert.deepEqual(await api('/datasets'), []);
});

async function client(t, response) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/session') return Response.json({ csrf: 'test-session-token' });
    return response(options);
  });
  const api = await import(`../src/api.js?test=${randomUUID()}`);
  return { ...api, requests };
}

function fragmentedResponse(text, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      }
    }),
    { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }
  );
}

test('assistant stream decodes fragmented UTF-8, CRLF, comments and multiline data in order', async (t) => {
  const stream =
    ': heartbeat\r\n\r\nevent: status\r\ndata: {"state":"processing","requestId":"r1"}\r\n\r\nevent: answer\r\ndata: {"summary":"Поток производства: Әліш 🚘",\r\ndata: "datasetVersion":2}\r\n\r\n';
  const { apiStream, requests } = await client(t, () => fragmentedResponse(stream));
  const events = [];
  await apiStream(
    '/assistant/stream',
    { conversationId: 'c1', question: 'Где резерв?' },
    (event, data) => events.push({ event, data })
  );
  assert.deepEqual(events, [
    { event: 'status', data: { state: 'processing', requestId: 'r1' } },
    { event: 'answer', data: { summary: 'Поток производства: Әліш 🚘', datasetVersion: 2 } }
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers['X-CSRF-Token'], 'test-session-token');
  assert.equal(requests[1].options.headers.Accept, 'text/event-stream');
  assert.equal(requests[1].options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    conversationId: 'c1',
    question: 'Где резерв?'
  });
});

test('assistant stream surfaces a server error with its status and cancels the reader', async (t) => {
  let cancelled = false;
  const { apiStream } = await client(
    t,
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: error\ndata: {"error":"Лимит исчерпан","status":429}\n\n'
              )
            );
          },
          cancel() {
            cancelled = true;
          }
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
  );
  await assert.rejects(
    apiStream('/assistant/stream', {}, () => assert.fail('Error events must reject')),
    (error) => error.status === 429 && error.message === 'Лимит исчерпан'
  );
  assert.equal(cancelled, true);
});

test('assistant stream rejects a clean close before the answer and malformed JSON', async (t) => {
  const streams = [
    'event: status\ndata: {"state":"processing"}\n\n',
    'event: answer\ndata: {broken}\n\n'
  ];
  const { apiStream } = await client(t, () => fragmentedResponse(streams.shift(), 3));
  await assert.rejects(
    apiStream('/assistant/stream', {}, () => {}),
    /до готовности ответа/
  );
  await assert.rejects(
    apiStream('/assistant/stream', {}, () => {}),
    /прочитать ответ/
  );
});

test('assistant stream abort stops reading while a response is pending', async (t) => {
  const abort = new AbortController();
  let readerController;
  const { apiStream } = await client(t, (options) => {
    options.signal.addEventListener('abort', () => readerController.error(options.signal.reason), {
      once: true
    });
    return new Response(
      new ReadableStream({
        start(controller) {
          readerController = controller;
          controller.enqueue(
            new TextEncoder().encode('event: status\ndata: {"state":"processing"}\n\n')
          );
        }
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  });
  await assert.rejects(
    apiStream(
      '/assistant/stream',
      {},
      (event) => {
        if (event === 'status') abort.abort();
      },
      abort.signal
    ),
    (error) => error.name === 'AbortError'
  );
});

test('assistant stream rejects wrong content type and oversized unfinished frames', async (t) => {
  let count = 0;
  const { apiStream } = await client(t, () =>
    count++ === 0
      ? new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } })
      : fragmentedResponse('data: ' + 'x'.repeat(262145), 4096)
  );
  await assert.rejects(
    apiStream('/assistant/stream', {}, () => {}),
    /не открыл поток/
  );
  await assert.rejects(
    apiStream('/assistant/stream', {}, () => {}),
    /допустимый размер/
  );
});

test('expired stream session emits logout signal and API retains validation issues', async (t) => {
  const windowTarget = new EventTarget();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: windowTarget, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  });
  let expired = 0;
  windowTarget.addEventListener('qarqyn:session-expired', () => expired++);
  let count = 0;
  const { apiStream, api } = await client(t, () =>
    count++ === 0
      ? Response.json({ error: 'Сессия завершилась' }, { status: 401 })
      : Response.json(
          {
            error: 'Исправьте данные',
            issues: [{ path: 'production.0.actual', message: 'Недопустимое значение' }]
          },
          { status: 422 }
        )
  );
  await assert.rejects(
    apiStream('/assistant/stream', {}, () => {}),
    (error) => error.status === 401
  );
  assert.equal(expired, 1);
  await assert.rejects(
    api('/datasets/validate', 'POST', {}),
    (error) => error.status === 422 && error.issues[0].path === 'production.0.actual'
  );
});
