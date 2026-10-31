import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import './chat-markdown.css';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

// A private parser keeps model content out of the extension's HTML and resource APIs.
const markdown = new Marked({
  async: false,
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    image: ({ text }) => escapeHtml(text || '（图片）'),
    checkbox: ({ checked }) => checked ? '☑ ' : '☐ ',
  },
});

export function renderChatMarkdown(target: HTMLElement, source: string): void {
  try {
    const fragment = DOMPurify.sanitize(markdown.parse(source, { async: false }), {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
      ALLOWED_ATTR: ['href', 'title', 'start', 'align', 'class'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
    for (const link of fragment.querySelectorAll('a')) {
      let url: URL | undefined;
      try { url = new URL(link.getAttribute('href') || ''); } catch { /* Relative and malformed destinations have no safe external target. */ }
      if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        link.replaceWith(...link.childNodes);
        continue;
      }
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.referrerPolicy = 'no-referrer';
    }
    for (const table of fragment.querySelectorAll('table')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-table-scroll';
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', '表格，可横向滚动');
      table.replaceWith(wrapper);
      wrapper.append(table);
    }
    for (const code of fragment.querySelectorAll('pre')) {
      code.tabIndex = 0;
      code.setAttribute('aria-label', '代码，可横向滚动');
    }
    target.replaceChildren(fragment);
    target.classList.add('markdown-body');
  } catch {
    // A parser failure must still preserve the complete answer as readable text.
    target.textContent = source;
    target.classList.remove('markdown-body');
  }
}
