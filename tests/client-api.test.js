import test from 'node:test';
import assert from 'node:assert/strict';

test('client restores missing CSRF before a mutation and preserves cancellation', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/session') ? { csrf: 'test-csrf-token' } : { ok: true }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const { api } = await import('../src/api.js?csrf-restoration');
  const controller = new AbortController();
  await api('/impact', 'POST', { targetGoodOutput: 109 }, controller.signal);
  assert.equal(calls[0].url, '/api/session');
  assert.equal(calls[1].url, '/api/impact');
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'test-csrf-token');
  assert.equal(calls[1].options.signal.aborted, false);
  controller.abort();
  assert.equal(calls[1].options.signal.aborted, true);
});

test('client-owned abort controller does not disable the request timeout', async (t) => {
  const originalFetch = globalThis.fetch;
  let passedSignal;
  globalThis.fetch = async (url, options) => {
    passedSignal = options.signal;
    return new Response('{}', { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(new DOMException('Request expired', 'TimeoutError')));
  const { api } = await import('../src/api.js?timeout-composition');
  const controller = new AbortController();
  await api('/forecast/allur', 'GET', undefined, controller.signal);
  assert.equal(controller.signal.aborted, false);
  assert.equal(passedSignal.aborted, true);
  assert.equal(passedSignal.reason.name, 'TimeoutError');
});

test('expired protected session is recoverable while invalid login does not discard a valid session', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const target = new EventTarget();
  globalThis.window = target;
  let expired = 0;
  target.addEventListener('qarqyn:session-expired', () => expired++);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Session expired' }), { status: 401 });
  t.after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
  const { api } = await import('../src/api.js?auth-expiry');
  await assert.rejects(api('/datasets'), (error) => error.status === 401);
  assert.equal(expired, 1);
  await assert.rejects(api('/auth/login', 'POST', { username: 'test', password: 'invalid' }), (error) => error.status === 401);
  assert.equal(expired, 1);
});
