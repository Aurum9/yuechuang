import http from 'node:http';
import { startResearchFixtures } from './research-server.mjs';

export const CHAT_HTML_MARKER = '<img src=x onerror="document.documentElement.dataset.chatXss=1">';
const CHAT_MARKDOWN_PREFIX = [
  '# Markdown 阅读示例',
  '',
  '**重点**、*强调*、~~过时信息~~与 `inline()` 都应有格式。',
  '',
  '- 第一项',
  '  - 嵌套子项',
  '- 第二项',
  '',
  '1. 第一步',
  '2. 第二步',
  '',
  '> 引用：消费需求决定生产速度。',
  '',
  '```ts',
  'const streamingFence = "先显示未闭合代码块";',
  ''
].join('\n');
export const CHAT_MARKDOWN = CHAT_MARKDOWN_PREFIX + [
  'const veryLongLine = "' + 'streaming_backpressure_'.repeat(9) + '";',
  '```',
  '',
  '| 方案标识 | 消费端需求 | 生产端处理 | 缓冲策略 | 兼容性说明 |',
  '| --- | --- | --- | --- | --- |',
  '| demand_driven_stream | request_from_consumer | pause_upstream_producer | bounded_queue | explicit_backpressure_contract |',
  '| push_stream | implicit_consumer | observe_downstream_status | bounded_ring_buffer | compatible_with_stream_reader |',
  '',
  '[安全文档链接](https://example.com/guide?q=markdown)',
  '[禁止脚本链接](javascript:alert%281%29)',
  '[禁止数据链接](data:text/html;base64,SGVsbG8=)',
  '',
  '![不加载远程图片](https://markdown-image.invalid/pixel.png)',
  '',
  CHAT_HTML_MARKER,
  '',
  '<script>document.documentElement.dataset.chatXss = "script"</script>'
].join('\n');

/** Deterministic loopback-only chat SSE plus the existing research articles/model fixture. */
export async function startSidebarFixtures({ port = 4357, researchPort = 4358 } = {}) {
  const research = await startResearchFixtures({ port: researchPort });
  const sockets = new Set(), timers = new Set();
  let serial = 0, requests = [];
  const later = (operation, delay) => { const timer = setTimeout(() => { timers.delete(timer); operation(); }, delay); timers.add(timer); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) { raw += chunk.toString('utf8'); if (raw.length > 1_000_000) { res.writeHead(413); res.end(); return; } }
      let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
      let input; try { input = JSON.parse(body.messages?.[1]?.content || 'null'); } catch { /* Direct chat contains ordinary text. */ }
      if (typeof input?.article === 'string' || Array.isArray(input?.sources)) {
        // Research and chat share one configured endpoint in the concurrency test.
        // Only the research fixture records this request; avoid counting proxy hops twice.
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          const upstream = await fetch(research.origin + url.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) }, body: raw, signal: controller.signal });
          res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream; charset=utf-8' }); res.flushHeaders();
          if (upstream.body) for await (const chunk of upstream.body) { if (res.destroyed) break; res.write(chunk); }
          if (!res.destroyed) res.end();
        } catch { if (!res.destroyed) { if (!res.headersSent) res.writeHead(502); res.end(); } }
        return;
      }
      const record = { id: ++serial, body, model: body.model, authPresent: !!req.headers.authorization, authorizationScheme: req.headers.authorization?.split(' ')[0] || '', startedAt: Date.now(), completed: false, aborted: false };
      requests.push(record); res.on('close', () => { if (!record.completed) record.aborted = true; });
      const prompt = String(body.messages?.at(-1)?.content || '');
      const markdown = prompt.includes('Markdown 渲染');
      const source = markdown ? CHAT_MARKDOWN : prompt.includes('安全渲染') ? `安全字面文本：${CHAT_HTML_MARKER}\n普通段落保留。` : `本地模拟回复 ${record.id}：背压通过消费需求协调生产速度。\n这是流式回答，仅用于测试。`;
      const pieces = markdown ? [CHAT_MARKDOWN_PREFIX] : [];
      for (let index = markdown ? CHAT_MARKDOWN_PREFIX.length : 0; index < source.length; index += 10) pieces.push(source.slice(index, index + 10));
      const chunks = [': deterministic sidebar fixture\r\n\r\n', ...pieces.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\r\n\r\n`), 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'];
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' }); res.flushHeaders();
      let index = 0;
      const write = () => {
        if (res.destroyed) return;
        if (index < chunks.length) {
          if (markdown && index === 2) record.markdownFenceReleased = true;
          const bytes = Buffer.from(chunks[index++]); res.write(bytes.subarray(0, 9)); res.write(bytes.subarray(9));
          later(write, markdown && index === 2 ? 900 : String(body.model).includes('slow') && index >= 2 ? 1800 : 20);
        } else { record.completed = true; record.finishedAt = Date.now(); res.end(); }
      };
      later(write, 20); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sidebar sender boundary fixture</title></head><body><article><h1>Untrusted ordinary webpage</h1><p>This page tests that a panel=1 query cannot obtain extension settings or private storage.</p></article></body></html>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { await research.close(); throw error; }
  return {
    origin: `http://127.0.0.1:${server.address().port}`, research,
    getStats: () => ({ requests, count: requests.length, totalRequestsSinceStart: serial }),
    reset: () => { requests = []; },
    close: async () => { for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await research.close(); }
  };
}
