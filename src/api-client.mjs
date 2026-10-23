// Keep transport/session state independent of React so it can be tested offline.
// Paths are intentionally same-origin: a control-console session must not be sent
// to an API host obtained from a document, form field or other remote input.
export function createApiClient(fetchImpl = (...args) => globalThis.fetch(...args)) {
  let csrfToken = '';

  const request = async (path, options = {}) => {
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('\\')) {
      throw new TypeError('API path must be a same-origin /api/ path');
    }
    const headers = new Headers(options.headers);
    if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (csrfToken) headers.set('x-csrf-token', csrfToken);
    const response = await fetchImpl(path, { ...options, credentials: 'same-origin', redirect: 'error', headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
    return payload;
  };

  request.setCsrfToken = (token) => { csrfToken = typeof token === 'string' ? token : ''; };
  request.clearSession = () => { csrfToken = ''; };
  return request;
}
