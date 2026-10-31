import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverNativeRuntimeUrl } from '../src/webchat-runtime-discovery.ts';

const runtime = '/cdn/assets/633146.a34c950234.js';
const absolute = `https://chatgpt.com${runtime}`;
const sources = (overrides: Partial<Parameters<typeof discoverNativeRuntimeUrl>[0]> = {}) => ({
  pageUrl: 'https://chatgpt.com/c/example', documentResources: [], manifestImports: undefined,
  performanceResources: [], ...overrides,
});

test('a long-lived SPA document discovers its runtime after markup and timing resources are cleared', () => {
  assert.equal(discoverNativeRuntimeUrl(sources({ manifestImports: ['/cdn/assets/other.js', runtime] })), absolute);
});

test('document references take precedence over the public router import list', () => {
  const markup = '/cdn/assets/633146.1234567890.js';
  assert.equal(discoverNativeRuntimeUrl(sources({ documentResources: [null, markup], manifestImports: [runtime] })), `https://chatgpt.com${markup}`);
});

test('a resource-timing script or preload is a bounded final fallback', () => {
  for (const initiatorType of ['script', 'link']) {
    assert.equal(discoverNativeRuntimeUrl(sources({ performanceResources: [{ name: absolute, initiatorType }] })), absolute);
  }
  assert.equal(discoverNativeRuntimeUrl(sources({ performanceResources: [{ name: absolute, initiatorType: 'fetch' }] })), undefined);
});

test('all discovery sources reject external, credentialed, queried and lookalike URLs', () => {
  const rejected = [
    `https://example.test${runtime}`, `https://chatgpt.com.example.test${runtime}`,
    `https://user:pass@chatgpt.com${runtime}`, `http://chatgpt.com${runtime}`,
    `${runtime}?v=1`, `${runtime}#runtime`, '/cdn/assets/633147.a34c950234.js',
    '/cdn/assets/633146.short.js', '/cdn/assets/633146.A34C950234.js',
    '/cdn/assets/async/633146.a34c950234.js', '/cdn/assets/633146.a34c950234.js/map',
    'javascript:alert(1)', 'data:text/javascript,export{}', 'not a runtime',
  ];
  for (const value of rejected) {
    assert.equal(discoverNativeRuntimeUrl(sources({ documentResources: [value] })), undefined, `markup: ${value}`);
    assert.equal(discoverNativeRuntimeUrl(sources({ manifestImports: [value] })), undefined, `manifest: ${value}`);
    assert.equal(discoverNativeRuntimeUrl(sources({ performanceResources: [{ name: value, initiatorType: 'script' }] })), undefined, `timing: ${value}`);
  }
});

test('router imports must be a string array rather than another manifest object', () => {
  for (const manifestImports of [runtime, { 0: runtime, length: 1 }, null, [null, 7, {}, ['nested', runtime]]]) {
    assert.equal(discoverNativeRuntimeUrl(sources({ manifestImports })), undefined);
  }
});

test('markup, manifest and performance scans each stop at their resource limits', () => {
  assert.equal(discoverNativeRuntimeUrl(sources({ documentResources: [...Array(256).fill(null), runtime] })), undefined);
  assert.equal(discoverNativeRuntimeUrl(sources({ manifestImports: [...Array(256).fill(null), runtime] })), undefined);
  assert.equal(discoverNativeRuntimeUrl(sources({ performanceResources: [...Array(2048).fill(null), { name: absolute, initiatorType: 'script' }] })), undefined);
  assert.equal(discoverNativeRuntimeUrl(sources({ manifestImports: [...Array(255).fill(null), runtime] })), absolute);
});

test('fallbacks do not consume performance entries when a manifest match exists', () => {
  const performanceResources = { *[Symbol.iterator]() { throw new Error('Timing details must not be read'); } };
  assert.equal(discoverNativeRuntimeUrl(sources({ manifestImports: [runtime], performanceResources })), absolute);
});

test('malformed timing records and oversized URL values are ignored', () => {
  assert.equal(discoverNativeRuntimeUrl(sources({
    documentResources: ['x'.repeat(3000)], manifestImports: [false],
    performanceResources: [null, 'not an entry', { name: 5, initiatorType: 'script' }, { name: absolute }],
  })), undefined);
});
