import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { SiwcFailure } from '../src/siwc-protocol';

type Loose = Record<string, any>;
class Hub {
  listeners: ((...args: any[]) => void)[] = [];
  addListener = (fn: (...args: any[]) => void) => { this.listeners.push(fn); };
  emit(...args: any[]) { for (const fn of this.listeners) fn(...args); }
}
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
const local: Loose = {}, session: Loose = {};
const accessLevels: string[] = [], requests: { url: string; init: RequestInit }[] = [];
let updated = new Hub(), removed = new Hub(), navigation = new Hub(), alarms = new Hub();
let permission = true, nextTab = 1, failRevocation = false, failSave = false;
let tokenError = '', tokenStatus = 400, claimsPatch: Loose = {}, grantedScope = 'openid email offline_access resource.invoke chatgpt.tokens.use.direct';
let signatureFailure = false, holdExchange = false, refreshCount = 0;
let holdRevocation: Promise<void> | undefined;
const tabs = new Map<number, string>(), closed: number[] = [];
const api = {
  storage: {
    local: { setAccessLevel: async ({ accessLevel }: Loose) => { accessLevels.push(accessLevel); }, get: async (key: string) => ({ [key]: structuredClone(local[key]) }),
      set: async (value: Loose) => { if (failSave) throw new Error('PRIVATE_STORAGE_ERROR'); Object.assign(local, structuredClone(value)); } },
    session: { setAccessLevel: async ({ accessLevel }: Loose) => { accessLevels.push(accessLevel); }, get: async (key: string) => ({ [key]: structuredClone(session[key]) }),
      set: async (value: Loose) => Object.assign(session, structuredClone(value)), remove: async (key: string) => { delete session[key]; } },
  },
  permissions: { contains: async () => permission },
  tabs: {
    get onUpdated() { return updated; }, get onRemoved() { return removed; },
    create: async ({ url }: Loose) => { const id = nextTab++; tabs.set(id, url); return { id }; },
    update: async (id: number, { url }: Loose) => { tabs.set(id, url); return { id }; },
    remove: async (id: number) => { tabs.delete(id); closed.push(id); removed.emit(id); },
  },
  webNavigation: { get onBeforeNavigate() { return navigation; } },
  alarms: { get onAlarm() { return alarms; }, create: async () => {}, clear: async () => true },
  runtime: { getPlatformInfo: async () => ({ os: 'mac' }) },
};
Object.assign(globalThis, { chrome: api });
const { SiwcAuth, SIWC_CREDENTIAL_KEY: KEY, SIWC_PENDING_KEY: PENDING } = await import('../src/siwc-auth');
function jwt(nonce: string): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-key' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', sub: 'synthetic-person', aud: 'oaiapp_synthetic', exp: Math.floor(Date.now() / 1000) + 3600, nonce, email: 'test@example.test', ...claimsPatch })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signatureFailure ? signature.slice(0, -8) + 'AAAAAAAA' : signature}`;
}
globalThis.fetch = async (input, init = {}) => {
  const url = String(input); requests.push({ url, init });
  assert.equal(new URL(url).origin, 'https://auth.openai.com');
  assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.referrerPolicy, 'no-referrer');
  if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/revoke' });
  if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
  if (url.endsWith('/revoke')) {
    await holdRevocation;
    if (failRevocation) throw new Error('PRIVATE_NETWORK_ERROR');
    return new Response(null, { status: 200 });
  }
  assert.ok(url.endsWith('/api/accounts/oauth/token'));
  const form = new URLSearchParams(init.body as URLSearchParams);
  assert.equal(form.get('client_id'), 'oaiapp_synthetic'); assert.equal(form.get('resource'), 'https://api.openai.com/v1');
  if (holdExchange) return await new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
  if (tokenError) return Response.json({ error: tokenError, error_description: 'PRIVATE_SERVER_ERROR' }, { status: tokenStatus });
  if (form.get('grant_type') === 'refresh_token') {
    refreshCount++;
    assert.ok(form.get('refresh_token')?.startsWith('synthetic-refresh-'));
    return Response.json({ access_token: `synthetic-access-${refreshCount}`, refresh_token: `synthetic-refresh-${refreshCount}`, token_type: 'Bearer', expires_in: 3600, scope: grantedScope });
  }
  assert.equal(form.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.equal(form.get('code_verifier'), session[PENDING].verifier);
  return Response.json({ access_token: 'synthetic-access-initial', refresh_token: 'synthetic-refresh-initial', id_token: jwt(session[PENDING].nonce), token_type: 'Bearer', expires_in: 3600, scope: grantedScope });
};
function fixture() {
  for (const key of Object.keys(local)) delete local[key];
  for (const key of Object.keys(session)) delete session[key];
  updated = new Hub(); removed = new Hub(); navigation = new Hub(); alarms = new Hub();
  permission = true; failRevocation = false; failSave = false; tokenError = ''; tokenStatus = 400; claimsPatch = {}; signatureFailure = false; holdExchange = false; refreshCount = 0;
  holdRevocation = undefined;
  grantedScope = 'openid email offline_access resource.invoke chatgpt.tokens.use.direct';
  requests.length = 0; closed.length = 0; tabs.clear();
  const auth = new SiwcAuth(); auth.initialize(); return auth;
}
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('OAuth fixture timed out');
}
async function begin(auth: InstanceType<typeof SiwcAuth>, newAccount = false) {
  const controller = new AbortController();
  const result = auth.call('login', controller.signal, { newAccount });
  void result.catch(() => {});
  await until(() => !!session[PENDING] && tabs.get(session[PENDING].tabId)?.startsWith('https://auth.openai.com/') === true);
  return { controller, result, pending: structuredClone(session[PENDING]), url: new URL(tabs.get(session[PENDING].tabId)!) };
}
function callback(pending: Loose, query: Loose = {}) {
  const q = new URLSearchParams({ state: pending.state, code: 'synthetic-code', client_id: 'oaiapp_synthetic', ...query });
  return `http://127.0.0.1:1455/auth/callback?${q}`;
}
async function signedIn(auth: InstanceType<typeof SiwcAuth>) {
  const login = await begin(auth); updated.emit(login.pending.tabId, { url: callback(login.pending) }); await login.result;
}

test('saved login is local-only and both storage areas reject untrusted contexts', async () => {
  const auth = fixture(); const status = await auth.call('status') as Loose;
  assert.equal(status.state, 'signedOut'); assert.equal(requests.length, 0); assert.equal(tabs.size, 0);
  assert.deepEqual(accessLevels, ['TRUSTED_CONTEXTS', 'TRUSTED_CONTEXTS']);
});
test('PKCE login uses this app identity and accepts only its owned tab and exact loopback callback', async () => {
  const auth = fixture(), login = await begin(auth);
  const q = login.url.searchParams;
  assert.equal(q.get('client_id'), 'dynamic_agent_client'); assert.equal(q.get('agent_name_hint'), '阅窗');
  assert.equal(q.get('code_challenge_method'), 'S256'); assert.equal(q.get('code_challenge'), createHash('sha256').update(login.pending.verifier).digest('base64url'));
  assert.equal(q.get('ext_agent_host_id'), local[KEY].hostId);
  updated.emit(login.pending.tabId + 1, { url: callback(login.pending) });
  updated.emit(login.pending.tabId, { url: callback(login.pending).replace('127.0.0.1', 'localhost') });
  updated.emit(login.pending.tabId, { url: callback(login.pending).replace('/auth/callback', '/callback') });
  await auth.call('status'); assert.equal(requests.length, 0); assert.ok(session[PENDING]);
  // Both Chrome events may observe the same URL. The exchange must occur once.
  navigation.emit({ frameId: 0, tabId: login.pending.tabId, url: callback(login.pending) });
  updated.emit(login.pending.tabId, { url: callback(login.pending) });
  const status = await login.result as Loose;
  assert.equal(status.state, 'ready'); assert.equal(status.account.planAuthorized, true); assert.equal(session[PENDING], undefined);
  assert.equal(requests.filter(r => r.url.endsWith('/oauth/token')).length, 1); assert.ok(closed.includes(login.pending.tabId));
  assert.ok(!JSON.stringify(status).includes('synthetic-access')); assert.ok(!JSON.stringify(await auth.call('status')).includes('synthetic-refresh'));
});
test('state, duplicate parameters, issued client ID and denied consent fail before exchange', async () => {
  for (const kind of ['state', 'duplicate', 'client', 'denied']) {
    const auth = fixture(), login = await begin(auth);
    let url = callback(login.pending, kind === 'state' ? { state: 'wrong' } : kind === 'client' ? { client_id: 'dynamic_agent_client' } : kind === 'denied' ? { error: 'access_denied' } : {});
    if (kind === 'duplicate') url += '&state=duplicate';
    updated.emit(login.pending.tabId, { url });
    await assert.rejects(login.result, (e: unknown) => e instanceof SiwcFailure && e.code === (kind === 'denied' ? 'authDenied' : 'identity'));
    assert.equal(local[KEY].active, undefined); assert.equal(requests.length, 0); assert.equal(session[PENDING], undefined);
  }
});
test('ID token requires the signature, issuer, audience, expiry and nonce; failed account switching preserves the original', async () => {
  for (const patch of [{ iss: 'https://evil.test' }, { aud: 'other' }, { aud: ['oaiapp_synthetic', 'other'], azp: 'other' }, { exp: 1 }, { nonce: 'wrong' }]) {
    const auth = fixture(); await signedIn(auth); const previous = structuredClone(local[KEY].active);
    claimsPatch = patch;
    const login = await begin(auth, true); updated.emit(login.pending.tabId, { url: callback(login.pending) });
    await assert.rejects(login.result, (e: unknown) => e instanceof SiwcFailure && e.code === 'identity');
    assert.deepEqual(local[KEY].active, previous);
  }
  const auth = fixture(); signatureFailure = true; const login = await begin(auth);
  updated.emit(login.pending.tabId, { url: callback(login.pending) });
  await assert.rejects(login.result, (e: unknown) => e instanceof SiwcFailure && e.code === 'identity');
});
test('identity-only consent never grants an inference credential', async () => {
  const auth = fixture(); grantedScope = 'openid email offline_access'; await signedIn(auth);
  assert.equal((await auth.call('status') as Loose).state, 'planDenied');
  const count = requests.length;
  await assert.rejects(auth.call('getAccessToken'), (e: unknown) => e instanceof SiwcFailure && e.code === 'planDenied');
  assert.equal(requests.length, count);
});
test('a returning login reuses its own issued client and host; wrong account is rejected', async () => {
  const auth = fixture(); await signedIn(auth); const previous = structuredClone(local[KEY]);
  const login = await begin(auth);
  assert.equal(login.url.searchParams.get('client_id'), previous.active.clientId); assert.equal(login.url.searchParams.has('agent_name_hint'), false);
  assert.equal(login.url.searchParams.get('ext_agent_host_id'), previous.hostId);
  claimsPatch = { sub: 'another-person' }; updated.emit(login.pending.tabId, { url: callback(login.pending) });
  await assert.rejects(login.result, (e: unknown) => e instanceof SiwcFailure && e.code === 'identity');
  assert.deepEqual(local[KEY].active, previous.active);
});
test('concurrent refreshes serialize rotation and a new worker reads the replacement credentials', async () => {
  const auth = fixture(); await signedIn(auth); local[KEY].active.expiresAt = 1;
  const values = await Promise.all([auth.call('getAccessToken'), auth.call('getAccessToken'), auth.call('getAccessToken')]) as Loose[];
  assert.equal(refreshCount, 1); assert.ok(values.every(v => v.accessToken === 'synthetic-access-1'));
  assert.equal(local[KEY].active.refreshToken, 'synthetic-refresh-1');
  const restarted = new SiwcAuth(); assert.equal((await restarted.call('getAccessToken') as Loose).accessToken, 'synthetic-access-1');
  assert.equal(refreshCount, 1);
});
test('transient refresh failure preserves credentials; a terminal refresh failure clears unusable tokens', async () => {
  const auth = fixture(); await signedIn(auth); local[KEY].active.expiresAt = 1;
  const previous = structuredClone(local[KEY]); tokenError = 'temporarily_unavailable'; tokenStatus = 503;
  await assert.rejects(auth.call('getAccessToken'), (e: unknown) => e instanceof SiwcFailure && !e.message.includes('PRIVATE_'));
  assert.deepEqual(local[KEY], previous);
  tokenError = 'invalid_grant'; tokenStatus = 400;
  await assert.rejects(auth.call('getAccessToken'), (e: unknown) => e instanceof SiwcFailure && e.code === 'signedOut');
  assert.equal((await auth.call('status') as Loose).state, 'reauthRequired');
  assert.equal(local[KEY].active.accessToken, ''); assert.equal(local[KEY].active.refreshToken, '');
  assert.equal(local[KEY].active.clientId, previous.active.clientId);
});
test('cancellation and closing the login tab clear the owned transaction; late callbacks cannot sign in', async () => {
  for (const mode of ['abort', 'close']) {
    const auth = fixture(), login = await begin(auth);
    if (mode === 'abort') login.controller.abort(); else removed.emit(login.pending.tabId);
    await assert.rejects(login.result, (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
    updated.emit(login.pending.tabId, { url: callback(login.pending) }); await auth.call('status');
    assert.equal(local[KEY].active, undefined); assert.equal(requests.length, 0); assert.equal(session[PENDING], undefined);
  }
});
test('cancellation during code exchange aborts network work and cannot restore credentials', async () => {
  const auth = fixture(), login = await begin(auth); holdExchange = true;
  updated.emit(login.pending.tabId, { url: callback(login.pending) });
  await until(() => requests.length > 0); login.controller.abort();
  await assert.rejects(login.result, (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
  assert.equal(local[KEY].active, undefined); assert.equal(session[PENDING], undefined);
});
test('cancel supersedes a queued callback before its exchange begins', async () => {
  const auth = fixture(), login = await begin(auth);
  updated.emit(login.pending.tabId, { url: callback(login.pending) });
  await Promise.all([auth.call('cancelLogin'), assert.rejects(login.result, { name: 'AbortError' })]);
  assert.equal(requests.length, 0);
  assert.equal(local[KEY].active, undefined);
  assert.equal(session[PENDING], undefined);
});
test('worker restart recovers a pending callback using only session storage and real JWT verification', async () => {
  const auth = fixture();
  local[KEY] = { version: 1, hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' };
  session[PENDING] = { id: 'recovered', tabId: 88, expiresAt: Date.now() + 60000, state: 'synthetic-state', nonce: 'synthetic-nonce', verifier: 'synthetic-verifier', newAccount: true };
  let recovered = 0; auth.initialize(() => { recovered++; });
  updated.emit(88, { url: callback(session[PENDING]) });
  await until(() => recovered === 1);
  assert.equal((await auth.call('status') as Loose).state, 'ready'); assert.equal(session[PENDING], undefined);
});
test('expired pending authorization is cleared on a wakeup alarm', async () => {
  const auth = fixture();
  session[PENDING] = { id: 'expired', tabId: 89, expiresAt: 1, state: 'synthetic-state', nonce: 'synthetic-nonce', verifier: 'synthetic-verifier', newAccount: true };
  alarms.emit({ name: 'siwc-auth-expiry' }); await auth.call('status');
  assert.equal(session[PENDING], undefined); assert.ok(closed.includes(89)); assert.equal(requests.length, 0);
});
test('a recovered authorization can be cancelled without an in-memory login waiter', async () => {
  const auth = fixture();
  const pending = { id: 'recovered-cancel', tabId: 90, expiresAt: Date.now() + 60000, state: 'synthetic-state', nonce: 'synthetic-nonce', verifier: 'synthetic-verifier', newAccount: true };
  session[PENDING] = pending;
  await auth.call('cancelLogin');
  updated.emit(90, { url: callback(pending) }); await auth.call('status');
  assert.equal(session[PENDING], undefined); assert.ok(closed.includes(90)); assert.equal(requests.length, 0);
});
test('logout clears stored credentials before waiting for remote revocation', async () => {
  for (const fail of [false, true]) {
    const auth = fixture(); await signedIn(auth); const previous = structuredClone(local[KEY]); failRevocation = fail;
    let release!: () => void;
    holdRevocation = new Promise<void>(resolve => { release = resolve; });
    const pending = auth.call('logout');
    try {
      await until(() => requests.some(request => request.url.endsWith('/revoke')));
      assert.equal(local[KEY].active, undefined);
    } finally { release(); }
    const out = await pending as Loose;
    assert.equal(out.state, 'signedOut'); assert.equal(out.remoteRevocationConfirmed, !fail);
    assert.ok(!JSON.stringify(local).includes('synthetic-access')); assert.ok(!JSON.stringify(local).includes('synthetic-refresh')); assert.ok(!JSON.stringify(local).includes(previous.active.idToken));
    const login = await begin(auth);
    assert.equal(login.url.searchParams.get('client_id'), previous.active.clientId); assert.equal(login.pending.subject, previous.active.subject);
    login.controller.abort(); await assert.rejects(login.result);
  }
});
test('missing permissions and failed credential writes never open authorization or claim success', async () => {
  const auth = fixture(); permission = false;
  await assert.rejects(auth.call('login'), (e: unknown) => e instanceof SiwcFailure && e.code === 'permission');
  assert.equal(tabs.size, 0); assert.equal(requests.length, 0);
  permission = true; failSave = true;
  await assert.rejects(auth.call('login'), (e: unknown) => e instanceof SiwcFailure && !e.message.includes('PRIVATE_'));
  assert.equal(tabs.size, 0);
});
