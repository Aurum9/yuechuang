import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';
import type { Browser, Page } from 'playwright';

let browser: Browser;
let content = '';
const extensionId = 'page-dom-extension-test';
const pagePort = 'reader-chatgpt-page';
type Fixture = Awaited<ReturnType<typeof fixture>>;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Local ChatGPT DOM fixture</title></head><body>
<main id="turns"></main><form id="composer"><div contenteditable="true" role="textbox" aria-label="询问 ChatGPT" style="min-height:40px"></div><button aria-label="发送" type="button" disabled>send</button></form>
<script>
window.fixture = { mode:'normal', sends:[], stops:0, turn:0, delay:260, cid:'test-conversation', nextText:'最终回答', login:false };
const editor=document.querySelector('[role=textbox]'), send=document.querySelector('button[aria-label="发送"]'), turns=document.querySelector('#turns');
editor.addEventListener('input',()=>{send.disabled=!editor.innerText.trim()});
send.addEventListener('click',()=>{
  const state=window.fixture, prompt=editor.innerText; state.sends.push(prompt); state.turn++;
  editor.textContent=''; send.disabled=true;
  const user=document.createElement('article'); user.dataset.testid='conversation-turn-'+(state.turn*2-1); user.innerHTML='<div data-message-author-role="user" data-message-id="u'+state.turn+'"></div>'; user.firstElementChild.textContent=prompt; turns.append(user);
  history.pushState({},'', '/c/'+state.cid);
  const stop=document.createElement('button'); stop.setAttribute('aria-label','停止'); stop.type='button'; stop.textContent='stop'; document.querySelector('#composer').append(stop);
  stop.addEventListener('click',()=>{state.stops++; stop.remove()});
  if(state.mode==='noAssistant') return;
  const answer=document.createElement('article'); answer.dataset.testid='conversation-turn-'+(state.turn*2); answer.innerHTML='<div data-message-author-role="assistant" data-message-id="a'+state.turn+'"><div class="markdown"><p>正在回答</p></div></div>'; turns.append(answer);
  setTimeout(()=>{answer.querySelector('.markdown').innerHTML='<h2>说明</h2><p><strong>'+state.nextText+'</strong></p><pre><code>let answer = 42;</code></pre><p><a href="https://example.test/doc">文档</a></p>';},80);
  if(state.mode==='hang') return;
  setTimeout(()=>{stop.remove(); if(state.mode!=='noActions') { const copy=document.createElement('button'); copy.type='button'; copy.dataset.testid='copy-turn-action-button'; copy.setAttribute('aria-label','复制'); copy.textContent='copy'; answer.append(copy); }},state.delay);
});
</script></body></html>`;

before(async () => {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) for (const candidate of ['.cache/ms-playwright', '.browsers']) if (existsSync(resolve(candidate))) { process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(candidate); break; }
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const result = await build({ configFile: false, publicDir: false, logLevel: 'silent', build: {
    write: false, minify: false, target: 'es2022', lib: { entry: resolve('src/webchat-page-content.ts'), formats: ['iife'], name: 'PageChatDOMTest' }, rollupOptions: { output: { inlineDynamicImports: true } }
  } });
  for (const bundle of Array.isArray(result) ? result : [result]) if ('output' in bundle) for (const item of bundle.output) if (item.type === 'chunk') content += item.code;
  assert.ok(content.length > 1000);
});
after(async () => { await browser?.close(); });

async function fixture(options: { url?: string; setup?: string; port?: string; sender?: unknown; modern?: boolean } = {}) {
  const page = await browser.newPage();
  const requests: string[] = [];
  await page.route('**/*', async route => {
    requests.push(route.request().url());
    if (route.request().isNavigationRequest()) await route.fulfill({ contentType: 'text/html', body: options.modern ? readFileSync(resolve('tests/fixtures/chatgpt-page.html'), 'utf8') : html });
    else await route.abort();
  });
  await page.addInitScript({ content: `(() => {
    const {id, name, sender} = ${JSON.stringify({ id: extensionId, name: options.port ?? pagePort, sender: options.sender ?? { id: extensionId, url: `chrome-extension://${extensionId}/background.js` } })};
    const scope = window;
    const hub = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(value) { this.listeners.forEach(fn => fn(value)); } });
    const connect = hub(); const port = { name, sender, onMessage: hub(), onDisconnect: hub(), disconnected: false,
      postMessage(event) { scope.events.push(event); }, disconnect() { this.disconnected = true; this.onDisconnect.emit(); } };
    scope.events = []; scope.testPort = port;
    scope.chrome = { runtime: { id, onConnect: connect } };
    scope.connect = () => connect.emit(port);
    scope.command = (command) => port.onMessage.emit(command);
    scope.listenerCount = () => connect.listeners.length;
  })();` });
  await page.goto(options.url ?? 'https://chatgpt.com/');
  if (options.setup) await page.evaluate(options.setup);
  await page.addScriptTag({ content });
  await page.evaluate(() => (window as any).connect());
  const command = (value: unknown) => page.evaluate(value => (window as any).command(value), value);
  const events = () => page.evaluate(() => (window as any).events as any[]);
  const generate = (id = 'first', extra: Record<string, unknown> = {}) => command({ type: 'generate', id, model: 'follow-page', messages: [{ role: 'user', content: '测试问题' }], ...extra });
  const event = async (type: string, id = 'first') => {
    try { await page.waitForFunction(({ type, id }) => (window as any).events.some((event: any) => event.type === type && event.id === id), { type, id }, { timeout: 5000 }); }
    catch (error) { throw new Error(`${type}/${id}: ${JSON.stringify(await events())}; ${await page.locator('body').innerHTML()}`, { cause: error }); }
    return (await events()).find(event => event.type === type && event.id === id)!;
  };
  return { page, requests, command, events, generate, event };
}
async function count(fixture: Fixture, key: 'sends' | 'stops'): Promise<number> {
  return fixture.page.evaluate(key => key === 'sends' ? (window as any).fixture.sends.length : (window as any).fixture.stops, key);
}

test('page entry is exact-origin, top-level, idempotent and rejects unrelated or foreign ports', async () => {
  for (const url of ['https://example.test/', 'https://chatgpt.com.evil.test/']) {
    const f = await fixture({ url });
    assert.equal(await f.page.evaluate(() => (window as any).listenerCount()), 0); await f.page.close();
  }
  const f = await fixture(); await f.page.addScriptTag({ content });
  assert.equal(await f.page.evaluate(() => (window as any).listenerCount()), 1);
  await f.page.close();
  for (const sender of [{ id: 'other' }, { id: extensionId, tab: { id: 2 } }, { id: extensionId, url: 'https://chatgpt.com/' }]) {
    const f = await fixture({ sender });
    assert.equal(await f.page.evaluate(() => (window as any).testPort.disconnected), true);
    await f.generate(); assert.equal(await count(f, 'sends'), 0); await f.page.close();
  }
  const other = await fixture({ port: 'ordinary-content-port' }); await other.generate();
  assert.equal(await count(other, 'sends'), 0); await other.page.close();
});

test('readiness is DOM-only, follows the webpage model and signed-out pages cannot send', async () => {
  const f = await fixture(); await f.command({ type: 'status', id: 'status' });
  assert.deepEqual((await f.event('status', 'status')).status, { state: 'ready', loggedIn: true, models: [{ id: 'follow-page', label: '跟随官网当前模型' }] });
  assert.deepEqual(f.requests, ['https://chatgpt.com/']); assert.equal(await count(f, 'sends'), 0); await f.page.close();
  const loggedOut = await fixture({ setup: `document.querySelector('form').insertAdjacentHTML('beforebegin','<button>Log in</button>')` });
  await loggedOut.command({ type: 'status', id: 'status' }); assert.equal((await loggedOut.event('status', 'status')).status.state, 'signedOut');
  await loggedOut.generate(); assert.equal((await loggedOut.event('error')).code, 'signedOut'); assert.equal(await count(loggedOut, 'sends'), 0); await loggedOut.page.close();
});

test('normal page submission streams only the new answer, preserves Markdown and emits a verified continuation', async () => {
  const f = await fixture(); await f.generate();
  const first = await f.event('done');
  assert.match(first.text, /^## 说明\n\n\*\*最终回答\*\*/); assert.match(first.text, /```\nlet answer = 42;\n```/); assert.match(first.text, /\[文档\]\(https:\/\/example.test\/doc\)/);
  assert.equal(first.conversation.id, 'test-conversation'); assert.match(first.conversation.parentId, /^[\w-]+$/);
  assert.equal(await count(f, 'sends'), 1); assert.ok((await f.events()).some(event => event.type === 'text' && event.text.includes('正在回答')));
  await f.generate('second', { conversation: first.conversation, messages: [{ role: 'user', content: '测试问题' }, { role: 'assistant', content: first.text }, { role: 'user', content: '再解释' }] });
  assert.equal((await f.event('done', 'second')).conversation.id, first.conversation.id);
  assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.sends), ['测试问题', '再解释']);
  assert.deepEqual(f.requests, ['https://chatgpt.com/']); await f.page.close();
});

test('a fresh page can receive local completed context without injecting system messages as webpage instructions', async () => {
  const f = await fixture(); await f.generate('first', { messages: [{ role: 'system', content: 'secret local system text' }, { role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' }, { role: 'user', content: '现在的问题' }] });
  await f.event('done');
  const prompt = await f.page.evaluate(() => (window as any).fixture.sends[0]);
  assert.match(prompt, /用户：\n旧问题/); assert.match(prompt, /助手：\n旧回答/); assert.match(prompt, /现在的问题$/); assert.ok(!prompt.includes('secret local system text')); await f.page.close();
});

test('drafts, attachments, another in-flight page turn and existing history are preserved without a send click', async () => {
  for (const setup of [
    `document.querySelector('[role=textbox]').textContent='用户草稿'`,
    `document.querySelector('form').insertAdjacentHTML('afterbegin','<div data-testid="attachment-1">file.txt</div>')`,
    `document.querySelector('form').insertAdjacentHTML('afterbegin','<button aria-label="停止">stop</button>')`,
    `document.querySelector('#turns').innerHTML='<article><div data-message-author-role="assistant">以前的回答</div></article>'`
  ]) {
    const f = await fixture({ setup }); await f.generate(); assert.equal((await f.event('error')).code, 'pageBusy'); assert.equal(await count(f, 'sends'), 0); await f.page.close();
  }
});

test('a forged continuation or manually changed page cannot reattach to a previous conversation', async () => {
  const f = await fixture(); await f.generate(); const first = await f.event('done');
  await f.generate('forged', { conversation: { ...first.conversation, parentId: 'not-owned' } }); assert.equal((await f.event('error', 'forged')).code, 'pageChanged');
  await f.page.evaluate(() => history.pushState({}, '', '/c/manual-conversation'));
  await f.generate('navigated', { conversation: first.conversation }); assert.equal((await f.event('error', 'navigated')).code, 'pageChanged');
  assert.equal(await count(f, 'sends'), 1); await f.page.close();
});

test('text that stops changing is insufficient for completion while the normal stop control remains', async () => {
  const f = await fixture({ setup: `window.fixture.mode='hang'` }); await f.generate(); await f.event('text');
  await f.page.waitForTimeout(450); assert.ok(!(await f.events()).some(event => event.type === 'done'));
  await f.command({ type: 'cancel', id: 'first' }); assert.equal((await f.event('error')).code, 'interrupted'); assert.equal(await count(f, 'stops'), 1); assert.equal(await count(f, 'sends'), 1); await f.page.close();
});

test('disconnect stops the positively owned turn once and cannot leak an old answer', async () => {
  const f = await fixture({ setup: `window.fixture.mode='hang'` }); await f.generate(); await f.event('text');
  await f.page.evaluate(() => (window as any).testPort.disconnect());
  await f.page.waitForTimeout(200); assert.equal(await count(f, 'stops'), 1); assert.equal(await count(f, 'sends'), 1); assert.ok(!(await f.events()).some(event => event.type === 'done')); await f.page.close();
});

test('manual webpage conversation changes abort without stopping the other conversation', async () => {
  const f = await fixture({ setup: `window.fixture.mode='hang'` }); await f.generate(); await f.event('text');
  await f.page.evaluate(() => { history.pushState({}, '', '/c/another-chat'); document.querySelector('#turns')!.innerHTML='<article><div data-message-author-role="user">他人的本轮</div></article>'; });
  assert.equal((await f.event('error')).code, 'pageChanged'); assert.equal(await count(f, 'stops'), 0); assert.equal(await count(f, 'sends'), 1); await f.page.close();
});

test('typing into the dedicated webpage during generation aborts rather than replacing the user draft', async () => {
  const f = await fixture({ setup: `window.fixture.mode='hang'` }); await f.generate(); await f.event('text');
  await f.page.locator('[role=textbox]').fill('手动草稿');
  assert.equal((await f.event('error')).code, 'pageChanged'); assert.equal(await f.page.locator('[role=textbox]').innerText(), '手动草稿'); assert.equal(await count(f, 'stops'), 1); await f.page.close();
});

test('a normal stop transition can complete even when response action controls are absent', async () => {
  const f = await fixture({ setup: `window.fixture.mode='noActions'` }); await f.generate(); assert.ok((await f.event('done')).text.includes('最终回答')); assert.equal(await count(f, 'sends'), 1); await f.page.close();
});

test('malformed commands, arbitrary models and URLs cannot cause any page request or submit', async () => {
  const f = await fixture();
  for (const command of [null, {}, { type: 'fetch', id: 'forbidden', url: 'https://example.test' }, { type: 'generate', id: '../bad', model: 'follow-page', messages: [{ role: 'user', content: 'x' }] }]) await f.command(command);
  await f.generate('model', { model: 'arbitrary-model' }); assert.equal((await f.event('error', 'model')).code, 'model');
  assert.equal(await count(f, 'sends'), 0); assert.deepEqual(f.requests, ['https://chatgpt.com/']); await f.page.close();
});

test('the current webpage semantic DOM works without legacy role attributes, including fast complete turns', async () => {
  for (const mode of ['normal', 'fast']) {
    const f = await fixture({ modern: true, setup: `window.fixture.mode=${JSON.stringify(mode)}` });
    await f.generate(); const first = await f.event('done');
    assert.match(first.text, /\*\*网页回答\*\*/); assert.match(first.text, /const answer = 42;/); assert.match(first.conversation.id, /^fixture-/);
    assert.equal(await f.page.locator('[data-message-author-role]').count(), 0);
    await f.generate('next', { conversation: first.conversation, messages: [{ role: 'user', content: '追问' }] });
    assert.equal((await f.event('done', 'next')).conversation.id, first.conversation.id); assert.equal(await count(f, 'sends'), 2);
    assert.deepEqual(f.requests, ['https://chatgpt.com/']); await f.page.close();
  }
});

test('the normal initial SPA route may change before the webpage mounts its new user turn', async () => {
  const f = await fixture({ modern: true, setup: `const turns=document.querySelector('#turns'); const append=turns.append.bind(turns); turns.append=(...nodes)=>setTimeout(()=>append(...nodes),180); window.fixture.delay=550;` });
  await f.generate(); const done = await f.event('done'); assert.match(done.conversation.id, /^fixture-/); assert.equal(await count(f, 'sends'), 1); await f.page.close();
});

test('manually stopping the official page never records a partial answer as a completed turn', async () => {
  const f = await fixture({ modern: true, setup: `window.fixture.mode='hang'` }); await f.generate(); await f.event('text');
  await f.page.locator('button[aria-label="停止"]').click();
  assert.equal((await f.event('error')).code, 'interrupted'); await f.page.waitForTimeout(250);
  assert.equal(await count(f, 'stops'), 1); assert.ok(!(await f.events()).some(event => event.type === 'done')); await f.page.close();
});

test('a newly loaded webpage may finish mounting its composer before the first submit', async () => {
  const f = await fixture({ modern: true, setup: `const form=document.querySelector('form');form.remove();setTimeout(()=>document.body.append(form),300);` });
  await f.generate(); assert.ok((await f.event('done')).text.includes('网页回答')); assert.equal(await count(f, 'sends'), 1); await f.page.close();
});
