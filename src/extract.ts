import { Readability } from '@mozilla/readability';
import type { Article } from './shared';

/** A resource guard, never a silent excerpt length. Reaching it rejects extraction. */
export const ARTICLE_LIMIT = 300_000;
export const READER_ROOT_ATTRIBUTE = 'data-local-reader-root';
const MIN_ARTICLE_LENGTH = 180;
const OMIT = 'script,style,noscript,template,iframe,svg,canvas,form,input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],[data-local-reader-root]';
const LANDMARKS = 'nav,footer,aside,[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"]';
const PAYWALL_TEXT = /(?:subscribe|sign[ -]?in|log[ -]?in|subscription|membership|register).{0,45}(?:to (?:continue|read|access|unlock)|(?:full|rest of (?:this|the)) (?:article|story))|(?:unlock|read).{0,25}(?:with (?:a |your )?(?:subscription|membership)|subscriber[ -]?only)|(?:article|story|content).{0,25}(?:for (?:subscribers|members)|subscriber[ -]?only|member[ -]?only)|(?:订阅|付费|购买|开通会员|登录|登陆|注册).{0,18}(?:继续阅读|阅读全文|阅读剩余|解锁(?:全文|内容)|后可见)|(?:剩余|以下)内容.{0,15}(?:订阅|付费|会员)|会员专享/i;

export type ExtractionResult = { ok: true; article: Article } | { ok: false; reason: 'access' | 'empty' | 'limit'; message: string };
type TextResult = { text: string; limit: boolean };
type Candidate = TextResult & { root: Element };

function normalizeText(value: string): string {
  return value.replace(/\r/g, '').replace(/[\t ]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

/** Keep code whitespace and paragraph boundaries without serializing executable HTML. */
function plainText(root: Element): TextResult {
  let output = '';
  let limit = false;
  let nextSizeCheck = ARTICLE_LIMIT;
  const append = (value: string) => {
    if (limit) return;
    output += value;
    // Check normalized size, so paragraph delimiters at the edges do not reject
    // an otherwise in-budget article. Stop traversal as soon as the guard fires.
    if (output.length >= nextSizeCheck) {
      if (normalizeText(output).length >= ARTICLE_LIMIT) limit = true;
      // A large whitespace tail may normalize away. Avoid rescanning it for
      // every tiny DOM text node while still bounding substantive content.
      nextSizeCheck = output.length + 4_096;
    }
  };
  const visit = (node: Node): void => {
    if (limit) return;
    if (node.nodeType === 3) { append(node.textContent ?? ''); return; }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === 'pre') { append(`\n\n[代码]\n${element.textContent ?? ''}\n[/代码]\n\n`); return; }
    if (tag === 'br') { append('\n'); return; }
    const block = /^(p|div|section|article|main|h[1-6]|ul|ol|li|blockquote|table|tr|dl|dt|dd)$/.test(tag);
    if (block) append('\n');
    if (tag === 'li') append('• ');
    if (tag === 'td' || tag === 'th') append(' | ');
    for (const child of element.childNodes) { visit(child); if (limit) break; }
    if (block) append('\n');
  };
  visit(root);
  const text = limit ? '' : normalizeText(output);
  return { text: text.length >= ARTICLE_LIMIT ? '' : text, limit: limit || text.length >= ARTICLE_LIMIT };
}

function visiblyPresent(element: Element, doc: Document): boolean {
  if (element.closest('[hidden],[aria-hidden="true"]')) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = doc.defaultView?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse'
      || style?.contentVisibility === 'hidden' || style?.opacity === '0') return false;
  }
  return true;
}

/** Match original/clone elements before pruning; computed styles belong to the live document. */
function visibleClone(doc: Document): { clone: Document; notice?: string } {
  const clone = doc.cloneNode(true) as Document;
  const originals = [...doc.querySelectorAll('*')];
  const copies = [...clone.querySelectorAll('*')];
  const excluded = new Set<Element>();
  let clipped = false;
  for (let i = 0; i < originals.length; i++) {
    const original = originals[i];
    const copy = copies[i];
    if (original.parentElement && excluded.has(original.parentElement)) { excluded.add(original); continue; }
    // Head metadata is deliberately separate from the body. Its default display
    // is none, but description and rel=next remain useful non-executable hints.
    const style = original.closest('head') ? undefined : doc.defaultView?.getComputedStyle(original);
    const hidden = original.matches(OMIT) || style?.display === 'none' || style?.visibility === 'hidden'
      || style?.visibility === 'collapse' || style?.contentVisibility === 'hidden' || style?.opacity === '0'
      || /\bblur\((?!0(?:px)?\))/.test(style?.filter ?? '')
      || (style?.clip !== undefined && style.clip !== 'auto' && /rect\(0px,? 0px,? 0px,? 0px\)/.test(style.clip))
      || /inset\(50%|inset\(100%/.test(style?.clipPath ?? '');
    // A clipped/line-clamped text block can contain an inaccessible paid tail.
    // Omit the whole uncertain block rather than reading text behind its mask.
    const clippedBlock = !!style && !/^(HTML|BODY|PRE|CODE)$/.test(original.tagName)
      && /^(hidden|clip)$/.test(style.overflowY) && original.clientHeight > 0
      && original.scrollHeight > original.clientHeight + 2;
    if (hidden || clippedBlock) {
      if (clippedBlock) clipped = true;
      excluded.add(original);
      copy.remove();
    }
  }
  // A closed details element hides all content except its first summary,
  // including direct text nodes that CSS element checks cannot remove.
  for (const details of clone.querySelectorAll('details:not([open])')) {
    const summary = details.querySelector(':scope > summary');
    for (const child of [...details.childNodes]) if (child !== summary) child.remove();
  }
  // Detect visible access/pagination notices before removing their navigation
  // containers. Only the already sanitized clone is inspected for text.
  const notice = partialNotice(clone, clipped);
  for (const element of clone.querySelectorAll(LANDMARKS)) element.remove();
  for (const header of clone.querySelectorAll('header')) {
    if (!header.closest('article,main,[role="main"],[itemprop~="articleBody"]')) header.remove();
  }
  return { clone, notice };
}

function longestCandidate(root: Document, selector: string): Candidate | undefined {
  let best: Candidate | undefined;
  for (const element of root.querySelectorAll(selector)) {
    const candidate = { root: element, ...plainText(element) };
    if (candidate.limit) return candidate;
    if (!best || candidate.text.length > best.text.length) best = candidate;
  }
  return best;
}

function partialNotice(clone: Document, clipped: boolean): string | undefined {
  const parts: string[] = [];
  const visiblePaywall = [...clone.querySelectorAll('p,h1,h2,h3,h4,[role="dialog"],[role="alert"],[class*="paywall" i],[id*="paywall" i]')]
    .some(element => {
      // Look only at text left in the visible clone, never script/JSON-LD data.
      const text = plainText(element);
      return !text.limit && text.text.length < 4_000 && PAYWALL_TEXT.test(text.text);
    });
  if (visiblePaywall) parts.push('页面显示登录、订阅或付费阅读提示，仅包含当前已加载且可见的内容');
  const pagination = clone.querySelector('link[rel~="next"]')
    || [...clone.querySelectorAll('a[rel~="next"],[aria-label*="pagination" i] a,[class*="pagination" i] a,[id*="pagination" i] a')]
      .some(anchor => /(?:下一页|下页|下一章|next(?:\s+page)?|^\d+$)/i.test(anchor.textContent ?? '')
        || /(?:[?&](?:page|p)=\d|\/page\/\d)/i.test(anchor.getAttribute('href') ?? ''));
  if (pagination) parts.push('页面存在分页，仅包含当前页，未读取后续页面');
  if (clipped) parts.push('已跳过受裁切或折叠限制的内容');
  return parts.length ? `${parts.join('；')}。` : undefined;
}

/** Extraction always operates on a visible clone and never reads editable field values. */
export function extractArticle(doc: Document = document, url = doc.URL): ExtractionResult {
  const { clone, notice } = visibleClone(doc);
  const body = longestCandidate(clone, '[itemprop~="articleBody"]');
  const article = body?.limit || (body && body.text.replace(/\s/g, '').length >= MIN_ARTICLE_LENGTH) ? body : longestCandidate(clone, 'article');
  const main = article?.limit || (article && article.text.replace(/\s/g, '').length >= MIN_ARTICLE_LENGTH) ? undefined : longestCandidate(clone, 'main,[role="main"]');
  const structured = article?.limit || (article && article.text.replace(/\s/g, '').length >= MIN_ARTICLE_LENGTH) ? article : main ?? article;
  const password = [...doc.querySelectorAll('input[type="password"]')].some(element => visiblyPresent(element, doc));
  const challenge = [...doc.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenge"],[class*="cf-challenge"],[id*="captcha"]')]
    .some(element => visiblyPresent(element, doc));
  const accessTitle = /(?:sign[ -]?in|log[ -]?in|登录|登陆|人机验证|安全验证|access denied|verify (?:you|your)|just a moment|checking your browser)/i.test(doc.title);
  if ((password || challenge || accessTitle) && !structured?.limit && (structured?.text.length ?? 0) < 800) {
    return { ok: false, reason: 'access', message: '当前页面需要登录或完成访问验证。请在原网页完成后，点击“重新读取并总结”。' };
  }

  let title = doc.title.trim();
  let chosen = structured;
  // Explicit articleBody/article/main roots retain all their visible sections. A
  // successful short Readability result must not replace the rest of an article.
  if (!structured?.limit && (!structured || structured.text.replace(/\s/g, '').length < MIN_ARTICLE_LENGTH)) {
    try {
      const parsed = new Readability<Node>(clone.cloneNode(true) as Document, {
        charThreshold: MIN_ARTICLE_LENGTH,
        disableJSONLD: true,
        serializer: node => node,
      }).parse();
      if (parsed?.content?.nodeType === 1) {
        const readable = { root: parsed.content as Element, ...plainText(parsed.content as Element) };
        if (readable.limit || readable.text.length > (structured?.text.length ?? 0)) chosen = readable;
        if (chosen === readable && parsed.title?.trim()) title = parsed.title.trim();
      }
    } catch { /* The visible semantic structure remains available as a fallback. */ }
  }
  if (!chosen?.limit && !chosen?.text && !doc.querySelector('nav,header,footer,aside')) {
    const root = clone.body ?? clone.documentElement;
    chosen = { root, ...plainText(root) };
  }
  if (chosen?.limit) {
    return { ok: false, reason: 'limit', message: '已加载正文达到本机单篇处理上限（300,000 字符），本次未发送模型请求。请打开较短的文章或具体章节后重试。' };
  }
  if (!chosen || chosen.text.replace(/\s/g, '').length < MIN_ARTICLE_LENGTH) {
    return { ok: false, reason: 'empty', message: '未取得足够可见正文。页面可能仍在加载，或正文位于图片、PDF、嵌入页面或受限区域中；稍后可重新读取。' };
  }
  // A visible standfirst is often a sibling immediately before article/articleBody.
  // Keep it separate from the body and do not scan unrelated recommendation cards.
  let lead: string | undefined;
  let sibling = (chosen.root.closest('article') ?? chosen.root).previousElementSibling;
  for (let distance = 0; sibling && distance < 3; distance++, sibling = sibling.previousElementSibling) {
    if (!sibling.matches('.lead,.standfirst,.abstract,.article-summary,[itemprop~="description"],[class*="article-lead" i]')) continue;
    const candidate = plainText(sibling);
    if (!candidate.limit && candidate.text.length > 10 && candidate.text.length <= 2_000) { lead = candidate.text; break; }
  }
  const description = lead ?? clone.querySelector('meta[name="description" i],meta[property="og:description" i]')?.getAttribute('content')?.trim().slice(0, 2_000);
  const headings = [...chosen.root.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .map(element => normalizeText(element.textContent ?? '').slice(0, 300)).filter(Boolean).slice(0, 200);
  return { ok: true, article: {
    title: title.slice(0, 500) || '未命名页面', url, text: chosen.text,
    truncated: false, originalLength: chosen.text.length,
    ...(description ? { description } : {}), ...(headings.length ? { headings } : {}),
    coverage: notice ? 'partial' : 'visible', ...(notice ? { notice } : {}),
  } };
}

function isReaderMutation(record: MutationRecord): boolean {
  const target = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
  return !!target?.closest(`[${READER_ROOT_ATTRIBUTE}]`);
}

/** Wait briefly for real DOM content, with a hard deadline even on busy pages. */
export async function waitForArticle(signal?: AbortSignal, doc: Document = document): Promise<ExtractionResult> {
  if (signal?.aborted) throw new DOMException('已取消读取', 'AbortError');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let changed = started;
    let finished = false;
    const observer = new MutationObserver(records => {
      if (records.some(record => !isReaderMutation(record))) changed = Date.now();
    });
    const cleanup = () => { observer.disconnect(); clearInterval(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { if (finished) return; finished = true; cleanup(); reject(new DOMException('已取消读取', 'AbortError')); };
    const check = () => {
      const elapsed = Date.now() - started;
      if (elapsed < 700 || (Date.now() - changed < 650 && elapsed < 5_000)) return;
      const result = extractArticle(doc, doc.URL);
      if (!result.ok && result.reason === 'empty' && elapsed < 5_000) return;
      finished = true;
      cleanup();
      resolve(result);
    };
    const timer = setInterval(check, 180);
    observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    signal?.addEventListener('abort', abort, { once: true });
  });
}
