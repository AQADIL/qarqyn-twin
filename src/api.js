let csrf = '';
let sessionRefresh;
function validatePage(path, method, body) {
  if (method !== 'GET') return;
  const [resource, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  if (!params.has('page') && !params.has('pageSize')) return;
  if (
    !/^\/(?:scenarios|incidents|conversations|audit|flow-studies|action-plans)$|^\/datasets\/[^/]+\/versions$/.test(
      resource
    )
  )
    return;
  if (
    Array.isArray(body) ||
    !Array.isArray(body.items) ||
    !body.items.every(
      (item) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ) ||
    !Number.isInteger(body.total) ||
    body.total < 0 ||
    !Number.isInteger(body.page) ||
    body.page < 1 ||
    !Number.isInteger(body.pageSize) ||
    body.pageSize < 1 ||
    body.pageSize > 200 ||
    body.items.length > body.pageSize ||
    body.total < body.items.length
  ) {
    const error = new Error(
      'Сервер и интерфейс используют несовместимые версии списка. Обновите страницу после перезапуска сервера.'
    );
    error.code = 'API_CONTRACT_MISMATCH';
    throw error;
  }
}
export async function api(path, method = 'GET', data, signal) {
  if (method !== 'GET' && !csrf && !path.startsWith('/auth/')) {
    sessionRefresh ||= api('/session').finally(() => {
      sessionRefresh = undefined;
    });
    await sessionRefresh;
  }
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(path === '/assistant' ? 195000 : 35000)])
      : AbortSignal.timeout(path === '/assistant' ? 195000 : 35000),
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  let malformed = false;
  let body = await response.json().catch(() => {
    malformed = true;
    return { error: 'Сервер вернул неверный ответ' };
  });
  if (body === null || typeof body !== 'object') {
    malformed = true;
    body = { error: 'Сервер вернул неверный ответ' };
  }
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') {
      csrf = '';
      window.dispatchEvent(new Event('qarqyn:session-expired'));
    }
    const error = new Error(body.error || 'Не удалось выполнить запрос');
    error.status = response.status;
    if (Array.isArray(body.issues)) error.issues = body.issues;
    throw error;
  }
  if (malformed) throw new Error('Сервер вернул неверный ответ. Повторите загрузку.');
  validatePage(path, method, body);
  if (body.csrf) csrf = body.csrf;
  if (path === '/auth/logout') csrf = '';
  return body;
}
export async function apiStream(path, data, onEvent, signal) {
  if (!csrf) {
    sessionRefresh ||= api('/session').finally(() => {
      sessionRefresh = undefined;
    });
    await sessionRefresh;
  }
  const timeout = AbortSignal.timeout(195000);
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      Accept: 'text/event-stream'
    },
    body: JSON.stringify(data),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      csrf = '';
      window.dispatchEvent(new Event('qarqyn:session-expired'));
    }
    const error = new Error(body.error || 'Не удалось открыть диалог');
    error.status = response.status;
    throw error;
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
    throw new Error('Сервер не открыл поток ответа');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    answered = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 262144) throw new Error('Ответ превысил допустимый размер');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let eventName = 'message';
        const content = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          if (line.startsWith('data:')) content.push(line.slice(5).trimStart());
        }
        if (!content.length) continue;
        let event;
        try {
          event = JSON.parse(content.join('\n'));
        } catch {
          throw new Error('Не удалось прочитать ответ помощника');
        }
        if (eventName === 'error') {
          const error = new Error(event.error || 'Помощник не завершил ответ');
          error.status = event.status;
          throw error;
        }
        if (eventName === 'answer') answered = true;
        onEvent(eventName, event);
      }
      if (done) break;
    }
    if (!answered)
      throw new Error(
        'Соединение завершилось до готовности ответа. Диалог сохранён, обновите его.'
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export const format = (value, digits = 0) =>
  value === null || value === undefined
    ? '—'
    : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value);
export function downloadJson(data, name) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
