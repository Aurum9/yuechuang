import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, type Article, type Settings, type SummaryProgress } from '../src/shared.ts';
import { estimateTokens, planSummary, splitText, summarizeArticle } from '../src/summary.ts';
import { SIWC_MAX_MESSAGE_CHARACTERS, siwcRequestBody } from '../src/siwc-protocol.ts';

const config: Settings = { ...DEFAULT_SETTINGS, baseUrl: 'https://model.test/v1', model: 'unknown-custom-model', inputBudgetTokens: 4096 };
function article(text: string): Article { return { title: '事实与更正', url: 'https://article.test/report', text, originalLength: text.length, truncated: false }; }
function response(text: string, finish = 'stop') {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}
function longArticle() {
  return article(Array.from({ length: 45 }, (_, index) => `## Section ${index + 1}\n\nF${String(index + 1).padStart(3, '0')}: ` + 'The report explains the evidence, causes and disagreements in the original sequence. '.repeat(9) + '\n\n').join('') + '\nTAIL_CORRECTION_2026_REVENUE_93: The final correction supersedes the initial number.');
}

test('unknown tokenizer estimates retain explicit margin for multilingual input; splitting is lossless and grapheme safe', () => {
  assert.ok(estimateTokens('普通中文😀') >= 16);
  assert.ok(estimateTokens('a'.repeat(300)) >= 100);
  const source = '\n标题\n\n' + ('中文 family 👨‍👩‍👧‍👦 e\u0301 code();\n'.repeat(60)) + '\n\n尾部唯一事实。\n';
  const pieces = splitText(source, 150);
  assert.equal(pieces.join(''), source);
  assert.ok(pieces.length > 1);
  const boundaries = new Set([0]);
  for (const item of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(source)) boundaries.add(item.index + item.segment.length);
  let position = 0;
  for (const piece of pieces) {
    position += piece.length;
    assert.ok(boundaries.has(position), 'every split is a complete grapheme boundary');
    assert.ok(estimateTokens(piece) <= 150);
    assert.ok(!/[\uD800-\uDBFF]$/.test(piece));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(piece));
  }
});

test('subscription summaries split at the message length limit even when the token budget fits', async () => {
  const text = 'This sentence is part of a long report. '.repeat(1100) + 'TAIL_FACT';
  const current = article(text);
  const settings = { ...config, inputBudgetTokens: 128_000 };
  assert.equal(planSummary(current, settings).strategy, 'direct');
  const plan = planSummary(current, settings, SIWC_MAX_MESSAGE_CHARACTERS);
  assert.equal(plan.strategy, 'sections');
  const sections: string[] = [];
  let requests = 0;
  const result = await summarizeArticle(settings, '', current, new AbortController().signal, () => {}, () => {}, {
    maxMessageCharacters: SIWC_MAX_MESSAGE_CHARACTERS,
    async complete(input) {
      requests++;
      const body = siwcRequestBody('gpt-synthetic', input, false);
      const label = '全文中的连续一段：\n';
      const content = body.input[0].content;
      if (content.includes(label)) {
        sections.push(content.slice(content.indexOf(label) + label.length));
        return '分段事实';
      }
      return '完整摘要';
    },
  });
  assert.equal(result, '完整摘要');
  assert.equal(requests, plan.requests);
  assert.equal(sections.join(''), text);
});

test('a short article uses one complete request including separate description, with prompt and output room reserved', async () => {
  const original = globalThis.fetch;
  const current = { ...article('Short body. TAIL_FACT_ONLY_HERE.'), description: 'An introductory description.' };
  assert.equal(planSummary(current, config).strategy, 'direct');
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init!.body as string);
    assert.ok(body.messages[1].content.endsWith(current.text));
    assert.ok(body.messages[1].content.includes('"description":"An introductory description."'));
    assert.ok(body.messages.reduce((sum: number, message: { content: string }) => sum + estimateTokens(message.content) + 8, 0) + body.max_tokens + 64 <= config.inputBudgetTokens);
    return response('模拟摘要，仅验证完整正文传输。');
  };
  try {
    const progress: SummaryProgress[] = [];
    assert.equal(await summarizeArticle(config, 'test-only-key', current, new AbortController().signal, () => {}, value => progress.push(value)), '模拟摘要，仅验证完整正文传输。');
    assert.equal(calls, 1);
    assert.deepEqual(progress, [{ stage: 'merge', current: 1, total: 1 }]);
  } finally { globalThis.fetch = original; }
});

test('the ordered full text including its unique tail reaches section requests and every merge layer without a 24k crop', async () => {
  const original = globalThis.fetch;
  const current = longArticle();
  assert.ok(current.text.length > 24_000);
  const plan = planSummary(current, config);
  assert.equal(plan.strategy, 'sections');
  const supplied: string[] = []; const merges: string[] = []; const progress: SummaryProgress[] = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init!.body as string);
    assert.ok(body.messages.reduce((sum: number, message: { content: string }) => sum + estimateTokens(message.content) + 8, 0) + body.max_tokens + 64 <= config.inputBudgetTokens);
    const content = body.messages[1].content as string;
    const section = content.split('全文中的连续一段：\n')[1];
    const input = section ?? content.split('按原文顺序排列的全部分段事实提要：\n')[1];
    assert.equal(typeof input, 'string');
    if (section !== undefined) supplied.push(section); else merges.push(input);
    const facts = [...new Set(input.match(/F\d{3}|TAIL_CORRECTION_2026_REVENUE_93/g) ?? [])];
    return response(facts.join(' | ') || 'SECTION_NOTE');
  };
  try {
    const result = await summarizeArticle(config, 'test-only-key', current, new AbortController().signal, () => {}, value => progress.push(value));
    assert.equal(supplied.join(''), current.text, 'all source characters arrive in order, exactly once');
    assert.equal(supplied.length, plan.segments);
    assert.ok(merges.length > 1, 'fixture exercises intermediate and final merge layers');
    assert.match(merges.at(-1)!, /TAIL_CORRECTION_2026_REVENUE_93/);
    assert.match(result, /F001/);
    assert.match(result, /F045/);
    assert.match(result, /TAIL_CORRECTION_2026_REVENUE_93/);
    assert.ok(calls <= plan.requests, 'planned request count is an upper bound');
    assert.equal(progress.length, calls);
    const sections = progress.filter(item => item.stage === 'section');
    const integration = progress.filter(item => item.stage === 'merge');
    assert.deepEqual(sections.map(item => item.current), Array.from({ length: plan.segments }, (_, index) => index + 1));
    assert.ok(sections.every(item => item.total === plan.segments));
    assert.deepEqual(integration.map(item => item.current), Array.from({ length: integration.length }, (_, index) => index + 1));
    assert.ok(integration.every(item => item.total === plan.requests - plan.segments));
  } finally { globalThis.fetch = original; }
});

test('cancel during the second section prevents all later requests and retains already streamed material', async () => {
  const original = globalThis.fetch; const controller = new AbortController();
  let calls = 0; let displayed = '';
  globalThis.fetch = async () => {
    calls++;
    if (calls === 2) { controller.abort(); throw new DOMException('Aborted', 'AbortError'); }
    return response('FIRST_COMPLETED_SECTION');
  };
  try {
    await assert.rejects(summarizeArticle(config, 'test-only-key', longArticle(), controller.signal, text => { displayed = text; }, () => {}), { name: 'AbortError' });
    assert.equal(calls, 2);
    assert.match(displayed, /FIRST_COMPLETED_SECTION/);
    assert.match(displayed, /尚未完成/);
  } finally { globalThis.fetch = original; }
});

test('a section error is not retried, launches no later section, and labels completed partial notes', async () => {
  const original = globalThis.fetch; let calls = 0; let displayed = '';
  globalThis.fetch = async () => ++calls === 2 ? new Response('no secret echoes', { status: 429 }) : response('FIRST_FACT_93');
  try {
    await assert.rejects(summarizeArticle(config, 'test-only-key', longArticle(), new AbortController().signal, text => { displayed = text; }, () => {}), /429/);
    assert.equal(calls, 2);
    assert.match(displayed, /尚未完成/);
    assert.match(displayed, /FIRST_FACT_93/);
  } finally { globalThis.fetch = original; }
});

test('output length termination remains an error with a visible partial and never begins the next request', async () => {
  const original = globalThis.fetch; let calls = 0; let displayed = '';
  globalThis.fetch = async () => { calls++; return response('HALF_OUTPUT', 'length'); };
  try {
    await assert.rejects(summarizeArticle(config, 'test-only-key', longArticle(), new AbortController().signal, text => { displayed = text; }, () => {}), /长度上限.*尚未完成/);
    assert.equal(calls, 1);
    assert.match(displayed, /HALF_OUTPUT/);
  } finally { globalThis.fetch = original; }
});

test('resource and budget guards stop before any network request; already aborted work never starts', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not call'); };
  try {
    assert.throws(() => planSummary(article('文'.repeat(300_000)), config), /资源上限/);
    for (const inputBudgetTokens of [0, 2047, 128001, 4096.5]) assert.throws(() => planSummary(article('x'), { ...config, inputBudgetTokens }), /预算/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(summarizeArticle(config, 'test-only-key', article('x'), controller.signal, () => {}, () => {}), { name: 'AbortError' });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
