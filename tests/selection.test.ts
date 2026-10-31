import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import type { Browser, Page } from 'playwright';
import { completeSentenceContext, usableContextCapture } from '../src/context-content.ts';
import { placeContextPanel } from '../src/context-ui.ts';
import { placeSelectionToolbar } from '../src/selection-toolbar.ts';
import { normalizeContextSelection, type ContextCaptureResult } from '../src/context-shared.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = { text: 'stale records', context: 'Readers reject stale records.', title: 'Cache', url: 'https://article.test/cache', rect: { x: 10, y: 20, width: 60, height: 20 }, capturedAt: 1000 };
test('native menu cache requires the same text, URL and unexpired trusted capture', () => {
  const capture = { result: { ok: true, snapshot } as ContextCaptureResult, url: snapshot.url, capturedAt: snapshot.capturedAt };
  assert.equal(normalizeContextSelection(' stale\n\t records '), 'stale records');
  assert.equal(usableContextCapture(capture, 'stale\n records', snapshot.url, 61_000).ok, true);
  for (const result of [usableContextCapture(capture, 'other text', snapshot.url, 1001), usableContextCapture(capture, snapshot.text, `${snapshot.url}#changed`, 1001), usableContextCapture(capture, snapshot.text, snapshot.url, 61_001), usableContextCapture(capture, snapshot.text, snapshot.url, 999), usableContextCapture(undefined, snapshot.text, snapshot.url, 1001), usableContextCapture(capture, '', snapshot.url, 1001), usableContextCapture(capture, 'x'.repeat(6001), snapshot.url, 1001)]) assert.equal(result.ok, false);
  const copied = usableContextCapture(capture, snapshot.text, snapshot.url, 1001);
  assert.ok(copied.ok); copied.snapshot.rect.x = 88; assert.equal(snapshot.rect.x, 10);
  const emptyMenu = { ...capture, result: { ok: false, message: 'empty newest menu' } as ContextCaptureResult };
  assert.deepEqual(usableContextCapture(emptyMenu, snapshot.text, snapshot.url, 1001), { ok: false, message: 'empty newest menu' });
});
test('oversized paragraph reduction keeps complete local sentences and rejects an oversized sentence', () => {
  const text = 'Previous sentence. A cache uses version 3.14 and rejects stale records. Next sentence.';
  const start = text.indexOf('stale');
  assert.equal(completeSentenceContext(text, start, start + 5), 'A cache uses version 3.14 and rejects stale records.');
  const fullStart = text.indexOf('A cache'); const fullEnd = text.indexOf(' Next');
  assert.equal(completeSentenceContext(text, fullStart, fullEnd), 'A cache uses version 3.14 and rejects stale records.');
  assert.equal(completeSentenceContext('前文。缓存拒绝旧记录。后文。', 5, 7), '缓存拒绝旧记录。');
  assert.equal(completeSentenceContext('x'.repeat(10001), 1, 5), undefined);
});
test('nearby answer placement stays in narrow and short viewports at every selection edge', () => {
  for (const [width, height] of [[1280, 800], [320, 280], [210, 165], [60, 80]]) {
    for (const rect of [{ x: 0, y: 0, width: 40, height: 20 }, { x: width - 20, y: height - 10, width: 100, height: 20 }, { x: -30, y: -100, width: 1, height: 12 }]) {
      const placement = placeContextPanel(rect, width, height, 350);
      assert.ok(placement.left >= 0 && placement.top >= 0);
      assert.ok(placement.left + placement.width <= width + 0.01);
      assert.ok(placement.top + Math.min(350, placement.maxHeight) <= height + 0.01);
    }
  }
});
test('selection toolbar fits a frame and stays hidden when three controls cannot fit', () => {
  for (const [width, height] of [[1000, 700], [320, 280], [180, 100]]) {
    const placed = placeSelectionToolbar({ x: width - 10, y: height - 10, width: 70, height: 20 }, width, height);
    assert.equal(placed.visible, true); assert.ok(placed.left >= 0 && placed.top >= 0); assert.ok(placed.left + placed.width <= width); assert.ok(placed.top + 40 <= height);
  }
  assert.equal(placeSelectionToolbar({ x: 0, y: 0, width: 10, height: 20 }, 120, 200).visible, false);
  assert.equal(placeSelectionToolbar({ x: 0, y: 0, width: 10, height: 20 }, 320, 40).visible, false);
});

let browser: Browser;
let page: Page;
let bundleCode: string;
before(async () => {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) for (const directory of ['.cache/ms-playwright', '.browsers']) {
    if (existsSync(path.join(root, directory))) { process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, directory); break; }
  }
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const result = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: path.join(root, 'src/context-content.ts'), name: 'ContextReading', formats: ['iife'] } } });
  const outputs = Array.isArray(result) ? result.flatMap(item => item.output) : 'output' in result ? result.output : [];
  const bundle = outputs.find(item => item.type === 'chunk');
  assert.ok(bundle?.type === 'chunk');
  bundleCode = bundle.code;
});
after(async () => { await browser?.close(); });

async function capture(html: string, selector: string, phrase: string, endSelector?: string) {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto('about:blank');
  await page.setContent(`<!doctype html><html><head><title>Technical reading</title><style>body{font:18px/1.5 sans-serif;padding:20px}p{max-width:700px}</style></head><body>${html}</body></html>`);
  await page.addScriptTag({ content: bundleCode });
  return page.evaluate(({ selector, phrase, endSelector }) => {
    const api = (window as unknown as { ContextReading: { captureContextSelection(doc: Document, now?: number): ContextCaptureResult } }).ContextReading;
    const element = document.querySelector(selector)!;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null; let selected: Text | undefined;
    while ((node = walker.nextNode())) if ((node.textContent ?? '').includes(phrase)) { selected = node as Text; break; }
    if (!selected) throw new Error('selection phrase missing');
    const range = document.createRange(); const offset = selected.data.indexOf(phrase);
    range.setStart(selected, offset);
    if (endSelector) { const target = document.querySelector(endSelector)!; range.setEnd(target.firstChild!, target.textContent!.length); }
    else range.setEnd(selected, offset + phrase.length);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    const visible = range.getBoundingClientRect();
    if (visible.y > innerHeight - 50 || visible.bottom < 0) scrollBy(0, visible.y - 100);
    return api.captureContextSelection(document, 12345);
  }, { selector, phrase, endSelector });
}

test('DOM capture keeps local complete paragraphs and excludes hidden fields from context', async () => {
  const result = await capture('<article><p>Previous paragraph gives cache background.</p><p id="target">Readers reject stale records.<span hidden>HIDDEN_SECRET</span><span style="opacity:0">MASKED_SECRET</span><input value="INPUT_SECRET"></p><p>Next paragraph explains version checking.</p><p>UNRELATED_FAR_TEXT</p></article>', '#target', 'stale records');
  assert.ok(result.ok); assert.equal(result.snapshot.text, 'stale records');
  assert.match(result.snapshot.context, /Previous paragraph/); assert.match(result.snapshot.context, /Next paragraph/);
  for (const hidden of ['HIDDEN_SECRET', 'MASKED_SECRET', 'INPUT_SECRET', 'UNRELATED_FAR_TEXT']) assert.ok(!result.snapshot.context.includes(hidden));
  assert.equal(result.snapshot.capturedAt, 12345); assert.equal(result.snapshot.title, 'Technical reading');
  assert.ok(result.snapshot.rect.width > 0 && result.snapshot.rect.height > 0);
});
test('paragraph selection ending at the next block offset zero does not pull in a distant paragraph', async () => {
  await capture('<p id="target">A complete paragraph about ecosystem resilience.</p><p id="next">One adjacent paragraph is useful.</p><p id="far">FAR_CONTEXT_MUST_NOT_BE_INCLUDED</p>', '#target', 'A complete paragraph');
  const result = await page.evaluate(() => {
    const selection = getSelection()!;
    const range = selection.getRangeAt(0).cloneRange();
    range.setEnd(document.querySelector('#next')!, 0);
    selection.removeAllRanges(); selection.addRange(range);
    return (window as unknown as { ContextReading: { captureContextSelection(doc: Document): ContextCaptureResult } }).ContextReading.captureContextSelection(document);
  });
  assert.ok(result.ok); assert.match(result.snapshot.context, /ecosystem resilience/);
  assert.match(result.snapshot.context, /One adjacent paragraph/);
  assert.doesNotMatch(result.snapshot.context, /FAR_CONTEXT_MUST_NOT_BE_INCLUDED/);
});

test('DOM capture rejects editors, form text, extension UI, invisible and oversized selections', async () => {
  for (const wrapper of ['<div contenteditable="true">', '<form>', '<div class="monaco-editor">', '<div data-local-reader-root="context">', '<div style="opacity:0">']) {
    const result = await capture(`${wrapper}<p id="target">stale records</p></div></form>`, '#target', 'stale records');
    assert.equal(result.ok, false, wrapper);
  }
  const oversized = await capture(`<p id="target">${'x'.repeat(6001)}</p>`, '#target', 'x'.repeat(6001)); assert.equal(oversized.ok, false);
});
test('DOM capture rejects intermediate hidden content in a selected range', async () => {
  const result = await capture('<p id="target">Start phrase.</p><p style="opacity:0">DO_NOT_READ_HIDDEN</p><p id="end">End phrase.</p>', '#target', 'Start phrase.', '#end');
  assert.equal(result.ok, false);
});
test('DOM capture reads a visible closed-details summary and rejects clipped content', async () => {
  const visible = await capture('<details><summary id="target">Visible summary sentence.</summary><p>HIDDEN_DETAILS_SECRET</p></details>', '#target', 'summary');
  assert.ok(visible.ok); assert.ok(!visible.snapshot.context.includes('HIDDEN_DETAILS_SECRET'));
  const clipped = await capture('<p id="target" style="height:30px;overflow:hidden">Visible first line. <br>Clipped sentinel text.</p>', '#target', 'sentinel');
  assert.equal(clipped.ok, false);
});
test('DOM capture reduces a very long paragraph around the actual selected occurrence', async () => {
  const prefix = 'Earlier unrelated sentence. '.repeat(600);
  const result = await capture(`<p id="target">${prefix}The selected sentinel means obsolete data. Later separate sentence.</p>`, '#target', 'selected sentinel');
  assert.ok(result.ok); assert.equal(result.snapshot.context, 'The selected sentinel means obsolete data.');
  assert.equal(result.snapshot.text, 'selected sentinel');
});
test('DOM capture rejects a paragraph whose complete selected sentence cannot fit', async () => {
  const result = await capture(`<p id="target">sentinel ${'unbroken '.repeat(1400)}</p>`, '#target', 'sentinel');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /10,000/);
});
test('DOM capture works for plain text nodes and preserves selection and scroll position', async () => {
  const result = await capture('A plain technical paragraph explains stale records without block tags.', 'body', 'stale records');
  assert.ok(result.ok); assert.match(result.snapshot.context, /^A plain technical paragraph/);
  const before = await page.evaluate(() => ({ text: document.getSelection()?.toString(), x: scrollX, y: scrollY }));
  const after = await page.evaluate(() => {
    (window as unknown as { ContextReading: { captureContextSelection(doc: Document): unknown } }).ContextReading.captureContextSelection(document);
    return { text: document.getSelection()?.toString(), x: scrollX, y: scrollY };
  });
  assert.deepEqual(after, before);
});
async function installUiFixture() {
  await capture('<p id="other">Browser <span id="other-term">microtasks</span> run before rendering.</p><p id="target">Version checking preserves <span id="term">coherence</span> among readers.</p><p><a id="drag-link" href="#other" draggable="true">Drag a real link</a></p><div contenteditable="true" id="editor">editable text</div><div style="height:900px"></div>', '#term', 'coherence');
  await page.setViewportSize({ width: 320, height: 300 });
  await page.evaluate('globalThis.__name = value => value');
  await page.evaluate(() => {
    type Listener = (...args: any[]) => void;
    const messages: any[] = [];
    const runtimeMessages: Listener[] = [];
    const ports: any[] = [];
    const fixture: any = { messages, runtimeMessages, ports, escapedParent: 0, serial: 0, current: undefined };
    // about:blank has no secure origin. Production runs only on authorized
    // HTTPS/loopback pages, where the browser supplies crypto.randomUUID.
    if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => `unit-capture-${++fixture.serial}` });
    const sender = { id: 'selection-test', url: 'chrome-extension://selection-test/background.js' };
    const notify = (message: any) => { let response: any; runtimeMessages.forEach(listener => listener(message, sender, (value: any) => { response = value; })); return response; };
    fixture.notify = notify;
    fixture.emit = (coreText: string, detailsText = '', expanded = false) => {
      const current = fixture.current;
      const state = { type: 'context:state', requestId: current.requestId, mode: current.mode, status: 'done', text: coreText + (detailsText ? '\n\n' + detailsText : ''), coreText, detailsText, exampleKind: current.mode === 'translate' ? 'bilingual' : 'usage', expanded, canExpand: !expanded };
      ports.at(-1).states.forEach((listener: Listener) => listener(state));
    };
    Object.defineProperty(window, 'chrome', { configurable: true, value: { runtime: {
      id: 'selection-test', getURL: (name: string) => `chrome-extension://selection-test/${name}`,
      onMessage: { addListener: (listener: Listener) => runtimeMessages.push(listener) },
      sendMessage: async (message: any) => {
        messages.push(message);
        if (message.type === 'context:selection-eligible') return { ok: true, enabled: true };
        if (message.type === 'context:selection-start') {
          const requestId = `ui-test-${++fixture.serial}`;
          const capture = notify({ type: 'context:capture', requestId, captureId: message.captureId });
          if (!capture?.ok) return { ok: false, error: capture?.message || 'capture failed' };
          fixture.current = { type: 'context:show', requestId, mode: message.mode, snapshot: capture.snapshot, captureId: message.captureId, expanded: false };
          return notify(fixture.current);
        }
        return { ok: true };
      },
      connect: () => {
        const states: Listener[] = [], disconnects: Listener[] = [];
        const port = { states, postMessage: (message: unknown) => messages.push(message), onMessage: { addListener: (listener: Listener) => states.push(listener) }, onDisconnect: { addListener: (listener: Listener) => disconnects.push(listener) }, disconnect: () => disconnects.forEach(listener => listener()) };
        ports.push(port); return port;
      },
    } } });
    (window as any).__contextFixture = fixture;
    (window as any).ContextReading.bootContextReading();
    document.addEventListener('keydown', event => { if (event.key === 'Escape') fixture.escapedParent++; });
  });
}

test('trusted selection creates a compact toolbar and a single click opens a nonce-bound answer', async () => {
  await installUiFixture();
  const toolbar = page.locator('local-reader-selection-toolbar');
  await page.waitForTimeout(30); assert.equal(await toolbar.count(), 0, 'programmatic selection alone must not show a toolbar');
  await page.locator('#term').dblclick(); await toolbar.locator('.toolbar').waitFor({ state: 'visible' });
  const captureId = await toolbar.getAttribute('data-capture-id'); assert.ok(captureId);
  const before = await page.evaluate(() => ({ text: document.getSelection()?.toString(), x: scrollX, y: scrollY }));
  assert.equal(before.text?.trim(), 'coherence');
  const toolbarBox = await toolbar.locator('.toolbar').boundingBox(); assert.ok(toolbarBox); assert.ok(toolbarBox.x >= 0 && toolbarBox.x + toolbarBox.width <= 320 && toolbarBox.y >= 0 && toolbarBox.y + toolbarBox.height <= 300);
  await toolbar.locator('[data-selection-action="translate"]').evaluate(node => (node as HTMLButtonElement).click());
  assert.equal(await page.evaluate(() => (window as any).__contextFixture.messages.filter((message: any) => message.type === 'context:selection-start').length), 0);
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await toolbar.locator('.toolbar').screenshot({ path: path.join(root, 'test-results/selection-toolbar-narrow.png') });
  await toolbar.locator('[data-selection-action="translate"]').click();
  const host = page.locator('local-reader-context');
  await host.waitFor({ state: 'visible' }); assert.equal(await toolbar.count(), 0);
  await page.evaluate(() => (window as any).__contextFixture.emit('一致性：多个读取者看到相同版本的缓存值。'));
  const box = await host.locator('.panel').boundingBox(); assert.ok(box);
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 320.1 && box.y + box.height <= 300.1);
  assert.equal(await host.locator('[data-context-action="expand"]').isEnabled(), true);
  assert.equal(await host.locator('[data-context-action="expand"]').innerText(), '双语例句');
  assert.equal(await host.locator('[data-context-details]').isVisible(), false);
  assert.equal(await page.evaluate(() => (window as any).__contextFixture.messages.filter((message: any) => message.type === 'context:selection-start').length), 1);
  await host.locator('[data-context-action="close"]').evaluate(node => (node as HTMLButtonElement).click());
  assert.equal(await host.count(), 1, 'synthetic page click must not close the answer');
  await page.evaluate(() => {
    const fixture = (window as any).__contextFixture;
    fixture.current = { ...fixture.current, requestId: 'ui-details', expanded: true, coreText: '一致性：多个读取者看到相同版本的缓存值。', exampleKind: 'bilingual' };
    fixture.notify(fixture.current);
    fixture.emit('一致性：多个读取者看到相同版本的缓存值。', 'The cache maintains coherence.\n这个缓存维持一致性。', true);
  });
  assert.equal(await host.locator('[data-context-core]').innerText(), '一致性：多个读取者看到相同版本的缓存值。');
  assert.match(await host.locator('[data-context-details]').innerText(), /The cache maintains coherence/);
  assert.equal(await host.locator('.details .answer-label').innerText(), '双语例句');
  await host.locator('.panel').screenshot({ path: path.join(root, 'test-results/context-ui-narrow.png') });
  await host.locator('[data-context-action="close"]').click();
  assert.equal(await host.count(), 0);
  const after = await page.evaluate(() => ({ text: document.getSelection()?.toString(), x: scrollX, y: scrollY, messages: (window as any).__contextFixture.messages }));
  assert.deepEqual({ text: after.text, x: after.x, y: after.y }, before);
  assert.ok(after.messages.some((message: any) => message.type === 'context:close' && message.requestId === 'ui-details'));
  await page.locator('#term').dblclick(); await toolbar.locator('.toolbar').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  assert.equal(await toolbar.count(), 0);
  assert.equal(await page.evaluate(() => (window as any).__contextFixture.escapedParent), 0, 'Escape must stay within the nearby answer');
});

test('new or cleared selection invalidates nonce, cancels the old UI and does not auto-submit', async () => {
  await installUiFixture(); const toolbar = page.locator('local-reader-selection-toolbar'); const host = page.locator('local-reader-context');
  await page.locator('#term').dblclick(); await toolbar.locator('.toolbar').waitFor({ state: 'visible' }); const oldCapture = await toolbar.getAttribute('data-capture-id');
  await toolbar.locator('[data-selection-action="explain"]').click(); await host.waitFor({ state: 'visible' }); await page.evaluate(() => (window as any).__contextFixture.emit('缓存一致性表示各读取者对数据版本达成一致。'));
  assert.equal(await host.locator('[data-context-action="expand"]').innerText(), '用法示例');
  await page.evaluate(() => { const node = document.querySelector('#other-term')!.firstChild!; const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  await host.waitFor({ state: 'detached' }); assert.equal(await toolbar.count(), 0, 'a script selection change can clear UI but cannot create another toolbar');
  const stale = await page.evaluate(captureId => (window as any).__contextFixture.notify({ type: 'context:capture', requestId: 'stale', captureId }), oldCapture); assert.equal(stale.ok, false);
  assert.equal(await page.evaluate(() => (window as any).__contextFixture.messages.filter((message: any) => message.type === 'context:selection-start').length), 1);
  await page.locator('#other-term').dblclick(); await toolbar.locator('.toolbar').waitFor({ state: 'visible' }); assert.notEqual(await toolbar.getAttribute('data-capture-id'), oldCapture);
  await page.evaluate(() => scrollBy(0, 35)); await toolbar.waitFor({ state: 'detached' });
  await page.locator('#editor').dblclick(); await page.waitForTimeout(25); assert.equal(await toolbar.count(), 0);
  assert.equal(await page.evaluate(() => (window as any).__contextFixture.messages.filter((message: any) => message.type === 'context:selection-start').length), 1);
});
test('native-menu capture survives browser selection collapse while toolbar nonce is invalidated', async () => {
  await installUiFixture(); const toolbar = page.locator('local-reader-selection-toolbar');
  await page.locator('#term').dblclick(); await toolbar.locator('.toolbar').waitFor({ state: 'visible' }); const captureId = await toolbar.getAttribute('data-capture-id');
  await page.evaluate(() => { document.addEventListener('contextmenu', event => { (window as any).__contextFixture.nativeMenu = { trusted: event.isTrusted, prevented: event.defaultPrevented }; }); });
  await page.locator('#term').click({ button: 'right' });
  await page.evaluate(() => getSelection()?.removeAllRanges()); await toolbar.waitFor({ state: 'detached' });
  const result = await page.evaluate(captureId => {
    const fixture = (window as any).__contextFixture;
    return { native: fixture.notify({ type: 'context:capture', requestId: 'native-collapse', selectedText: 'coherence' }), nonce: fixture.notify({ type: 'context:capture', requestId: 'old-toolbar', captureId }), menu: fixture.nativeMenu };
  }, captureId);
  assert.equal(result.native.ok, true); assert.equal(result.native.snapshot.text, 'coherence'); assert.equal(result.nonce.ok, false);
  assert.deepEqual(result.menu, { trusted: true, prevented: false });
  await page.mouse.click(3, 3);
  const cleared = await page.evaluate(() => (window as any).__contextFixture.notify({ type: 'context:capture', requestId: 'after-click', selectedText: 'coherence' })); assert.equal(cleared.ok, false);
});
