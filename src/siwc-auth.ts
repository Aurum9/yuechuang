import { secureStorage } from './store';
import { record, SiwcFailure } from './siwc-protocol';
import { SIWC_AUTH_ORIGIN, SIWC_AUTH_ORIGINS } from './siwc-shared';

// These keys are private to the extension's trusted contexts. Never include them
// in configuration exports, UI responses, diagnostics, or content-script RPCs.
export const SIWC_CREDENTIAL_KEY = 'siwcCredentialsV1';
export const SIWC_PENDING_KEY = 'siwcPendingAuthV1';
const CALLBACK = 'http://127.0.0.1:1455/auth/callback';
const RESOURCE = 'https://api.openai.com/v1';
const ALARM = 'siwc-auth-expiry';
const LIFETIME = 5 * 60_000;
type Account = {
  id: string; clientId: string; subject: string; email: string; label: string;
  accessToken: string; refreshToken: string; idToken: string; expiresAt: number;
  scopes: string[]; needsLogin?: boolean;
};
type Registration = Pick<Account, 'clientId' | 'subject' | 'email'>;
type Credentials = { version: 1; hostId: string; active?: Account; registration?: Registration; pendingClientId?: string };
type Pending = {
  id: string; tabId: number; expiresAt: number; state: string; nonce: string;
  verifier: string; clientId?: string; subject?: string; newAccount: boolean;
};
type Waiter = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
const label = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const credential = (v: unknown): v is string => typeof v === 'string' && /^[\x21-\x7e]{1,32000}$/.test(v);
const registeredClient = (v: unknown): v is string => label(v, 200) && /^[A-Za-z0-9_.:-]+$/.test(v) && v !== 'dynamic_agent_client';
const aborted = () => new DOMException('Aborted', 'AbortError');
const failure = (error: unknown) => error instanceof SiwcFailure || error instanceof DOMException && error.name === 'AbortError' ? error : new SiwcFailure('auth');
function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new SiwcFailure('identity');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
}
function base64(value: Uint8Array): string { return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function random(): string { return base64(crypto.getRandomValues(new Uint8Array(32))); }
function ownedEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new SiwcFailure('identity');
  const url = new URL(value);
  if (url.origin !== SIWC_AUTH_ORIGIN || url.username || url.password || url.hash) throw new SiwcFailure('identity');
  return url.href;
}

/** Browser-only OAuth. One MV3 worker owns all token rotation and mutations. */
export class SiwcAuth {
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private waiters = new Map<string, Waiter>();
  private controllers = new Set<AbortController>();
  private generation = 0;
  private notify: (completed: boolean) => void = () => {};

  initialize(onRecovered: (completed: boolean) => void = () => {}): void {
    this.notify = onRecovered;
    if (this.initialized) return;
    this.initialized = true;
    // Registered synchronously so Chrome can wake a suspended worker. The PKCE
    // transaction lives in storage.session, never solely in a waiting Promise.
    chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.url) this.observe(tabId, change.url); });
    chrome.webNavigation.onBeforeNavigate.addListener(event => { if (event.frameId === 0) this.observe(event.tabId, event.url); });
    chrome.tabs.onRemoved.addListener(tabId => {
      void this.serial(async () => {
        const pending = await this.pending();
        if (pending?.tabId === tabId) await this.finish(pending, aborted());
      }).catch(() => {});
    });
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === ALARM) void this.serial(async () => {
        const pending = await this.pending();
        if (pending && pending.expiresAt <= Date.now()) await this.finish(pending, new SiwcFailure('timeout'));
      }).catch(() => {});
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => { await secureStorage; return operation(); });
    this.queue = next.catch(() => {});
    return next;
  }
  private async permissions(): Promise<void> {
    if (!await chrome.permissions.contains({ origins: [...SIWC_AUTH_ORIGINS] })) throw new SiwcFailure('permission');
  }
  private async credentials(): Promise<Credentials> {
    const raw: unknown = (await chrome.storage.local.get(SIWC_CREDENTIAL_KEY))[SIWC_CREDENTIAL_KEY];
    if (raw === undefined) return { version: 1, hostId: `urn:uuid:${crypto.randomUUID()}` };
    if (!record(raw) || raw.version !== 1 || typeof raw.hostId !== 'string' || !/^urn:uuid:[0-9a-f-]{36}$/.test(raw.hostId)) throw new SiwcFailure('auth');
    if (raw.pendingClientId !== undefined && !registeredClient(raw.pendingClientId)) throw new SiwcFailure('auth');
    if (raw.registration !== undefined && (!record(raw.registration) || !registeredClient(raw.registration.clientId) || !label(raw.registration.subject, 500) || typeof raw.registration.email !== 'string')) throw new SiwcFailure('auth');
    const a = raw.active;
    if (a !== undefined && (!record(a) || !label(a.id) || !registeredClient(a.clientId) || !label(a.subject, 500) || typeof a.email !== 'string' || !label(a.label) ||
      !credential(a.idToken) || !Array.isArray(a.scopes) || a.scopes.length > 100 || !a.scopes.every(s => label(s, 200)) ||
      typeof a.expiresAt !== 'number' || !Number.isFinite(a.expiresAt) || !credential(a.accessToken) && !(a.needsLogin === true && a.accessToken === '') ||
      !credential(a.refreshToken) && !(a.needsLogin === true && a.refreshToken === ''))) throw new SiwcFailure('auth');
    return raw as Credentials;
  }
  private async save(value: Credentials): Promise<void> { await chrome.storage.local.set({ [SIWC_CREDENTIAL_KEY]: value }); }
  private async pending(): Promise<Pending | undefined> {
    const raw: unknown = (await chrome.storage.session.get(SIWC_PENDING_KEY))[SIWC_PENDING_KEY];
    if (raw === undefined) return;
    if (!record(raw) || !label(raw.id) || !Number.isInteger(raw.tabId) || typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt) ||
      !credential(raw.state) || !credential(raw.nonce) || !credential(raw.verifier) || typeof raw.newAccount !== 'boolean' ||
      raw.clientId !== undefined && !registeredClient(raw.clientId) || raw.subject !== undefined && !label(raw.subject, 500)) throw new SiwcFailure('auth');
    return raw as Pending;
  }
  private safeStatus(value: Credentials, pending = false, remoteRevocationConfirmed?: boolean) {
    const a = value.active;
    const planAuthorized = !!a && a.scopes.includes('chatgpt.tokens.use.direct') && a.scopes.includes('resource.invoke');
    return {
      state: !a ? 'signedOut' : a.needsLogin ? 'reauthRequired' : planAuthorized ? 'ready' : 'planDenied',
      ...(a ? { account: { id: a.id, label: a.label, planAuthorized } } : {}), loginPending: pending,
      ...(remoteRevocationConfirmed === undefined ? {} : { remoteRevocationConfirmed }),
    };
  }
  private async json(url: string, init: RequestInit, signal?: AbortSignal): Promise<{ response: Response; value: Record<string, unknown> }> {
    const response = await fetch(url, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000) });
    const reader = response.body?.getReader();
    if (!reader) throw new SiwcFailure('auth');
    const decoder = new TextDecoder(); let text = '', size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) { text += decoder.decode(); break; }
        size += chunk.value.byteLength;
        if (size > 256_000) throw new SiwcFailure('auth');
        text += decoder.decode(chunk.value, { stream: true });
      }
      const value: unknown = JSON.parse(text);
      if (!record(value)) throw new SiwcFailure('auth');
      return { response, value };
    } finally { await reader.cancel().catch(() => {}); }
  }
  private async metadata(signal: AbortSignal): Promise<Record<string, unknown>> {
    const { response, value } = await this.json(`${SIWC_AUTH_ORIGIN}/.well-known/openid-configuration`, {}, signal);
    if (!response.ok || value.issuer !== SIWC_AUTH_ORIGIN) throw new SiwcFailure('identity');
    return value;
  }
  private async identity(token: string, clientId: string, signal: AbortSignal, nonce?: string): Promise<Record<string, unknown>> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new SiwcFailure('identity');
    const header: unknown = JSON.parse(new TextDecoder().decode(bytes(parts[0])));
    if (!record(header) || header.alg !== 'RS256' || !label(header.kid)) throw new SiwcFailure('identity');
    const metadata = await this.metadata(signal);
    const { response, value } = await this.json(ownedEndpoint(metadata.jwks_uri), {}, signal);
    if (!response.ok || !Array.isArray(value.keys) || value.keys.length > 100) throw new SiwcFailure('identity');
    const jwk = value.keys.find(k => record(k) && k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
    if (!jwk) throw new SiwcFailure('identity');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new SiwcFailure('identity');
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes(parts[1])));
    if (!record(claims)) throw new SiwcFailure('identity');
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== SIWC_AUTH_ORIGIN || !label(claims.sub, 500) || !audience.includes(clientId) ||
      (audience.length > 1 || claims.azp !== undefined) && claims.azp !== clientId ||
      typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() ||
      nonce !== undefined && claims.nonce !== nonce) throw new SiwcFailure('identity');
    return claims;
  }
  private async exchange(form: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const { response, value } = await this.json(`${SIWC_AUTH_ORIGIN}/api/accounts/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...form, resource: RESOURCE }),
    }, signal);
    if (!response.ok) {
      if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(String(value.error))) throw new SiwcFailure('signedOut');
      throw new SiwcFailure('auth');
    }
    return value;
  }
  private tokens(value: Record<string, unknown>, previous?: Account) {
    if (!credential(value.access_token) || value.token_type !== 'Bearer' && value.token_type !== 'bearer' ||
      typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 86400) throw new SiwcFailure('auth');
    const refreshToken = value.refresh_token ?? previous?.refreshToken;
    if (!credential(refreshToken)) throw new SiwcFailure('auth');
    const scopes = typeof value.scope === 'string' ? value.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
    if (!scopes || scopes.length > 100 || !scopes.every(s => label(s, 200))) throw new SiwcFailure('auth');
    return { accessToken: value.access_token, refreshToken, expiresAt: Date.now() + value.expires_in * 1000, scopes, needsLogin: false };
  }
  private async closeTab(tabId: number): Promise<void> { await chrome.tabs.remove(tabId).catch(() => {}); }
  private async finish(pending: Pending, error?: unknown, result?: unknown): Promise<void> {
    if ((await this.pending())?.id !== pending.id) return;
    const waiter = this.waiters.get(pending.id); this.waiters.delete(pending.id);
    try { await chrome.storage.session.remove(SIWC_PENDING_KEY); }
    catch { error = new SiwcFailure('auth'); }
    await chrome.alarms.clear(ALARM).catch(() => false);
    // Never wait for a tab-removal event while holding the mutation queue.
    await this.closeTab(pending.tabId);
    if (waiter) error ? waiter.reject(failure(error)) : waiter.resolve(result);
    else this.notify(!error);
  }
  private observe(tabId: number, raw: string): void {
    let url: URL;
    try { url = new URL(raw); } catch { return; }
    if (url.origin !== 'http://127.0.0.1:1455' || url.pathname !== '/auth/callback' || url.username || url.password || url.hash) return;
    const generation = this.generation;
    void this.serial(async () => {
      const pending = await this.pending();
      if (!pending || pending.tabId !== tabId || generation !== this.generation) return;
      const controller = new AbortController(); this.controllers.add(controller);
      const deadline = setTimeout(() => controller.abort(), Math.max(1, pending.expiresAt - Date.now()));
      try {
        if (pending.expiresAt <= Date.now()) throw new SiwcFailure('timeout');
        const q = url.searchParams;
        if (['state', 'code', 'client_id', 'error'].some(k => q.getAll(k).length > 1) || q.get('state') !== pending.state) throw new SiwcFailure('identity');
        if (q.has('error')) throw new SiwcFailure('authDenied');
        const clientId = q.get('client_id') || pending.clientId;
        if (!registeredClient(clientId) || pending.clientId && pending.clientId !== clientId || !credential(q.get('code'))) throw new SiwcFailure('identity');
        await this.permissions();
        const saved = await this.credentials();
        // Retain the issued registration even if code exchange needs a retry.
        if (!pending.subject) { saved.pendingClientId = clientId; await this.save(saved); }
        const value = await this.exchange({ grant_type: 'authorization_code', client_id: clientId, code: q.get('code')!, code_verifier: pending.verifier, redirect_uri: CALLBACK }, controller.signal);
        if (!credential(value.id_token)) throw new SiwcFailure('identity');
        const claims = await this.identity(value.id_token, clientId, controller.signal, pending.nonce);
        if (pending.subject && claims.sub !== pending.subject) throw new SiwcFailure('identity');
        controller.signal.throwIfAborted();
        if (generation !== this.generation || (await this.pending())?.id !== pending.id) throw aborted();
        const previous = structuredClone(saved);
        const email = label(claims.email, 160) ? claims.email : '';
        const id = base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${clientId}\0${claims.sub}`))));
        controller.signal.throwIfAborted();
        if (generation !== this.generation) throw aborted();
        saved.active = { ...this.tokens(value), id, clientId, subject: claims.sub as string, email, label: `${email || 'ChatGPT 账号'} · ${id.slice(0, 6)}`, idToken: value.id_token };
        saved.registration = { clientId, subject: saved.active.subject, email };
        delete saved.pendingClientId;
        await this.save(saved);
        if (generation !== this.generation) { await this.save(previous); throw aborted(); }
        await this.finish(pending, undefined, this.safeStatus(saved));
      } catch (error) { await this.finish(pending, pending.expiresAt <= Date.now() ? new SiwcFailure('timeout') : error); }
      finally { clearTimeout(deadline); this.controllers.delete(controller); }
    }).catch(() => {});
  }

  async call(command: string, signal?: AbortSignal, payload: { newAccount?: boolean } = {}): Promise<unknown> {
    signal?.throwIfAborted();
    try {
      if (command === 'login') return await this.login(signal, payload.newAccount === true);
      if (command === 'cancelLogin') { await this.cancel(); return {}; }
      if (command === 'logout') return await this.logout();
      return await this.serial(async () => {
        signal?.throwIfAborted();
        const pending = await this.pending();
        if (pending && pending.expiresAt <= Date.now()) await this.finish(pending, new SiwcFailure('timeout'));
        const saved = await this.credentials();
        if (command === 'status') return this.safeStatus(saved, !!pending && pending.expiresAt > Date.now());
        if (command !== 'getAccessToken') throw new SiwcFailure('auth');
        await this.permissions();
        signal?.throwIfAborted();
        const a = saved.active;
        if (!a || a.needsLogin) throw new SiwcFailure('signedOut');
        if (!a.scopes.includes('chatgpt.tokens.use.direct') || !a.scopes.includes('resource.invoke')) throw new SiwcFailure('planDenied');
        if (a.expiresAt <= Date.now() + 60_000) {
          const controller = new AbortController(); this.controllers.add(controller);
          const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
          const generation = this.generation;
          try {
            const value = await this.exchange({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: a.refreshToken }, controller.signal);
            let idToken = a.idToken;
            if (value.id_token !== undefined) {
              if (!credential(value.id_token) || (await this.identity(value.id_token, a.clientId, controller.signal)).sub !== a.subject) throw new SiwcFailure('identity');
              idToken = value.id_token;
            }
            controller.signal.throwIfAborted();
            if (generation !== this.generation) throw aborted();
            saved.active = { ...a, ...this.tokens(value, a), idToken }; await this.save(saved);
          } catch (error) {
            if (error instanceof SiwcFailure && error.code === 'signedOut') {
              saved.active = { ...a, accessToken: '', refreshToken: '', needsLogin: true }; await this.save(saved);
            }
            throw error;
          } finally { this.controllers.delete(controller); signal?.removeEventListener('abort', abort); }
        }
        if (!saved.active!.scopes.includes('chatgpt.tokens.use.direct') || !saved.active!.scopes.includes('resource.invoke')) throw new SiwcFailure('planDenied');
        return { accessToken: saved.active!.accessToken, expiresAt: saved.active!.expiresAt, accountId: saved.active!.id };
      });
    } catch (error) { throw failure(error); }
  }
  private async login(signal: AbortSignal | undefined, newAccount: boolean): Promise<unknown> {
    let waiter!: Waiter;
    const result = new Promise<unknown>((resolve, reject) => { waiter = { resolve, reject }; });
    // A failed start must never leave an unobserved rejected login Promise.
    void result.catch(() => {});
    const pending = await this.serial(async () => {
      await this.permissions(); signal?.throwIfAborted();
      const existing = await this.pending();
      if (existing && existing.expiresAt > Date.now()) throw new SiwcFailure('authBusy');
      if (existing) await this.finish(existing, new SiwcFailure('timeout'));
      const saved = await this.credentials(); await this.save(saved);
      const a = newAccount ? undefined : saved.active ?? saved.registration;
      const verifier = random();
      const challenge = base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      if (tab.id === undefined) throw new SiwcFailure('auth');
      const pending: Pending = { id: crypto.randomUUID(), tabId: tab.id, expiresAt: Date.now() + LIFETIME, state: random(), nonce: random(), verifier, newAccount,
        ...(a ? { clientId: a.clientId, subject: a.subject } : !newAccount && saved.pendingClientId ? { clientId: saved.pendingClientId } : {}) };
      try {
        signal?.throwIfAborted();
        await chrome.storage.session.set({ [SIWC_PENDING_KEY]: pending });
        this.waiters.set(pending.id, waiter);
        await chrome.alarms.create(ALARM, { when: pending.expiresAt });
        const query = new URLSearchParams({ client_id: pending.clientId || 'dynamic_agent_client', ext_agent_host_id: saved.hostId, response_type: 'code', redirect_uri: CALLBACK,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: RESOURCE, state: pending.state, nonce: pending.nonce, code_challenge_method: 'S256', code_challenge: challenge });
        if (!pending.clientId) query.set('agent_name_hint', '阅窗');
        else if (a?.email) query.set('login_hint', a.email);
        await chrome.tabs.update(tab.id, { url: `${SIWC_AUTH_ORIGIN}/api/accounts/authorize?${query}` });
        return pending;
      } catch (error) { await this.finish(pending, error); await this.closeTab(tab.id); throw error; }
    });
    const abort = () => { void this.cancel(pending.id).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    // Chrome API activity keeps normal interactive authorization alive. Event
    // listeners + session storage still recover after an actual worker restart.
    const keepAlive = setInterval(() => { void chrome.runtime.getPlatformInfo().catch(() => {}); }, 20_000);
    const timer = setTimeout(() => { void this.cancel(pending.id, new SiwcFailure('timeout')).catch(() => {}); }, LIFETIME);
    try { return await result; }
    finally { clearInterval(keepAlive); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  private async cancel(id?: string, error: unknown = aborted()): Promise<void> {
    ++this.generation; for (const controller of this.controllers) controller.abort();
    await this.serial(async () => { const pending = await this.pending(); if (pending && (!id || pending.id === id)) await this.finish(pending, error); });
  }
  private async logout(): Promise<unknown> {
    await this.cancel();
    return this.serial(async () => {
      const saved = await this.credentials(); const a = saved.active;
      // Commit local logout before any network wait. Revocation uses the token
      // held by this operation, even if the worker is later suspended.
      if (a) {
        saved.registration = { clientId: a.clientId, subject: a.subject, email: a.email };
        delete saved.active;
      }
      delete saved.pendingClientId;
      await this.save(saved);
      let revoked = !a?.refreshToken;
      if (a?.refreshToken) {
        try {
          const metadata = await this.metadata(AbortSignal.timeout(25_000));
          const response = await fetch(ownedEndpoint(metadata.revocation_endpoint), { method: 'POST', body: new URLSearchParams({ token: a.refreshToken, token_type_hint: 'refresh_token', client_id: a.clientId }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(25_000) });
          revoked = response.status === 200; await response.body?.cancel();
        } catch { revoked = false; }
      }
      return this.safeStatus(saved, false, revoked);
    });
  }
}
export const siwcAuth = new SiwcAuth();
