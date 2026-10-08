let csrf = '';
let sessionRefresh;
export async function api(path, method = 'GET', data, signal) {
  if (method !== 'GET' && !csrf && !path.startsWith('/auth/')) {
    sessionRefresh ||= api('/session').finally(() => { sessionRefresh = undefined; });
    await sessionRefresh;
  }
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(path === '/assistant' ? 100000 : 35000)])
      : AbortSignal.timeout(path === '/assistant' ? 100000 : 35000),
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  const body = await response.json().catch(() => ({ error: 'Сервер вернул неверный ответ' }));
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') {
      csrf = '';
      window.dispatchEvent(new Event('qarqyn:session-expired'));
    }
    const error = new Error(body.error || 'Не удалось выполнить запрос');
    error.status = response.status;
    throw error;
  }
  if (body.csrf) csrf = body.csrf;
  if (path === '/auth/logout') csrf = '';
  return body;
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
