import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeRuntimeLastError, isBackgroundSender, notifyBackground } from '../src/content-runtime';

test('retired content notification catches synchronous throws and asynchronous rejections', async () => {
  for (const asynchronous of [false, true]) {
    let failures = 0;
    (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { sendMessage() {
      if (asynchronous) return Promise.reject(new Error('Extension context invalidated.'));
      throw new Error('Extension context invalidated.');
    } } };
    assert.doesNotThrow(() => notifyBackground({ type: 'context:selection-dismiss' }, () => { failures++; }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failures, 1);
    // A stale UI failure callback must not create another unhandled rejection.
    assert.doesNotThrow(() => notifyBackground({ type: 'settings:open' }, () => { throw new Error('retired document'); }));
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('disconnect acknowledgment tolerates an invalidated lastError accessor', () => {
  let reads = 0;
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { get lastError() { reads++; throw new Error('Extension context invalidated.'); } } };
  assert.doesNotThrow(() => consumeRuntimeLastError());
  assert.equal(reads, 1);
});

test('background sender validation keeps identity restrictions and rejects retired accessors', () => {
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const validSender = { id, url: `chrome-extension://${id}/background.js` };
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { id, getURL: (value: string) => `chrome-extension://${id}/${value}` } };
  assert.equal(isBackgroundSender(validSender), true);
  assert.equal(isBackgroundSender({ id }), true);
  assert.equal(isBackgroundSender({ ...validSender, id: 'forged' }), false);
  assert.equal(isBackgroundSender({ ...validSender, tab: { id: 1 } as chrome.tabs.Tab }), false);
  assert.equal(isBackgroundSender({ ...validSender, url: 'https://example.test/background.js' }), false);
  for (const retiredId of [undefined, '']) {
    (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { id: retiredId } };
    assert.equal(isBackgroundSender({}), false);
    assert.equal(isBackgroundSender({ id: retiredId }), false);
  }
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { get id() { throw new Error('Extension context invalidated.'); } } };
  assert.equal(isBackgroundSender(validSender), false);
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { id, getURL() { throw new Error('Extension context invalidated.'); } } };
  assert.equal(isBackgroundSender(validSender), false);
});
