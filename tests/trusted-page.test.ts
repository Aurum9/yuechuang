import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedPage } from '../src/trusted-page.ts';
const ID = 'panel-trust-test';
(globalThis as unknown as { chrome: unknown }).chrome = { runtime: { id: ID, getURL: (file: string) => `chrome-extension://${ID}/${file}` } };
test('standalone and fixed packaged panel documents are trusted within their individual role', () => {
  const sender = { id: ID, frameId: 0, origin: `chrome-extension://${ID}`, url: `chrome-extension://${ID}/options.html` };
  assert.equal(trustedPage(sender, 'options.html'), true);
  assert.equal(trustedPage({ ...sender, frameId: 1 }, 'options.html'), false);
  assert.equal(trustedPage({ ...sender, frameId: 8, url: sender.url + '?panel=1#permissions' }, 'options.html'), true);
  assert.equal(trustedPage({ ...sender, frameId: 8, url: sender.url + '?panel=1' }, 'research.html'), false);
});
test('query tricks, ordinary web senders and foreign origins never gain extension page roles', () => {
  const url = `chrome-extension://${ID}/options.html`, sender = { id: ID, frameId: 5, url: url + '?panel=1' };
  for (const source of [{ ...sender, id: 'other' }, { ...sender, origin: 'https://site.test' }, { ...sender, url: 'https://site.test/options.html?panel=1' }, { ...sender, url: url + '?panel=1&extra=1' }, { ...sender, url: url + '?panel=01' }, { ...sender, url: url + '/?panel=1' }]) assert.equal(trustedPage(source, 'options.html'), false);
});
