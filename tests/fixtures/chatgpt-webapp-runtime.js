// Offline test double for the publicly loaded client module. These are fixed
// synthetic markers, with no challenge algorithm or real account credential.
const fakeSession = 'fixture-session-secret-NOT-REAL';
const fakeRequirements = 'fixture-requirements-secret-NOT-REAL';
const fakeProof = 'fixture-proof-secret-NOT-REAL';
async function response(path, options, method) {
  if (!['/models', '/sentinel/chat-requirements/prepare', '/f/conversation'].includes(path)) throw new Error('Fixture refuses arbitrary paths');
  if (options.retry !== 'never' || options.cache !== 'no-store') throw new Error('Fixture requires no retries and no cache');
  return fetch('/backend-api' + path, {
    method, signal: options.signal, credentials: 'include', redirect: 'error', cache: 'no-store',
    headers: { Accept: path === '/f/conversation' ? 'text/event-stream' : 'application/json',
      Authorization: 'Bearer ' + fakeSession, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      ...options.additionalHeaders },
    ...(method === 'POST' ? { body: JSON.stringify(options.requestBody) } : {}),
  });
}
async function json(path, options, method) {
  const result = await response(path, options, method);
  if (!result.ok) throw { status: result.status, errorCode: 'fixture-http-failure' };
  return result.json();
}
const Request = {
  safeGet: (path, options) => json(path, options, 'GET'),
  safePost: (path, options) => json(path, options, 'POST'),
  postResponse: (path, options) => response(path, options, 'POST'),
};
const integrity = {
  async f(callback) {
    const prepared = await callback('fixture-normal-client-key');
    if (prepared.fixture !== true) throw new Error('Fixture prepare did not run');
    return { chatRequirements: prepared, headers: {
      'OpenAI-Sentinel-Chat-Requirements-Token': fakeRequirements,
      'OpenAI-Sentinel-Proof-Token': fakeProof,
    } };
  },
};
export function __webpack_require__(name) {
  if (name === 'Kwur') return { Request };
  if (name === 'lXEa') return integrity;
  throw new Error('Fixture module is unavailable');
}
