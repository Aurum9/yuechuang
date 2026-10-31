import type { WebChatConversation, WebChatInput, WebChatPageCommand, WebChatStatus } from './webchat-shared';

export type PageChatErrorCode = 'signedOut' | 'pageBusy' | 'pageChanged' | 'pageUnsupported' | 'format' | 'interrupted' | 'timeout' | 'model';
export class PageChatError extends Error {
  constructor(readonly code: PageChatErrorCode) { super(code); }
}
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
const userSelector = '[data-message-author-role="user"], [data-user-message-bubble="true"]';
const assistantSelector = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]';
const editorSelector = '[contenteditable="true"][role="textbox"], #prompt-textarea[contenteditable="true"], textarea#prompt-textarea, textarea[data-id="root"], textarea[placeholder]';
const sendNames = /^(发送|發送|发送提示|傳送|Send|Send message|Send prompt)$/i;
const stopNames = /^(停止|停止生成|停止串流|Stop|Stop generating|Stop streaming)$/i;

export function visible(element: Element): boolean {
  if (!(element instanceof HTMLElement) || !element.isConnected || element.hidden || element.closest('[hidden],[aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}
export function chatEditor(document: Document): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(editorSelector)].find(element => visible(element) && !element.closest('dialog, [role="dialog"]'));
}
export function editorText(editor: HTMLElement): string {
  return editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText;
}
function button(document: Document, kind: 'send' | 'stop'): HTMLButtonElement | undefined {
  const names = kind === 'send' ? sendNames : stopNames;
  const testids = kind === 'send' ? ['send-button'] : ['stop-button'];
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => visible(element) && (testids.includes(element.getAttribute('data-testid') ?? '') || names.test(element.getAttribute('aria-label')?.trim() ?? '')));
}
function messageElements(document: Document, role?: 'user' | 'assistant'): HTMLElement[] {
  const candidates = [...document.querySelectorAll<HTMLElement>(role === 'user' ? userSelector : role === 'assistant' ? assistantSelector : `${userSelector}, ${assistantSelector}`)].filter(visible);
  return candidates.filter(candidate => !candidates.some(other => other !== candidate && other.contains(candidate)));
}
function pathConversation(location: Location): string | undefined {
  return /^\/c\/([a-zA-Z0-9_-]{1,200})\/?$/.exec(location.pathname)?.[1];
}
function messageKey(element: Element): string | undefined {
  return element.getAttribute('data-message-id') ?? element.closest('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id') ?? element.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids') ?? element.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') ?? undefined;
}
function sameMessage(left: Element, right: Element): boolean {
  return left === right || (!!messageKey(left) && messageKey(left) === messageKey(right));
}
function responseActions(assistant: HTMLElement): boolean {
  const turn = assistant.closest('[data-talvt-turn-state], article, [data-testid^="conversation-turn-"]') ?? assistant.parentElement;
  return !!turn && [...turn.querySelectorAll('button')].some(element => visible(element) && (
    element.getAttribute('data-testid') === 'copy-turn-action-button' || /^(复制|複製|Copy|Copy response)$/i.test(element.getAttribute('aria-label') ?? '')
  ));
}
function hasAttachment(document: Document): boolean {
  const editor = chatEditor(document);
  const composer = editor?.closest('form') ?? editor?.closest('[data-type="unified-composer"]') ?? editor?.parentElement?.parentElement;
  return !!composer && [...composer.querySelectorAll('[data-testid*="attachment"], [data-testid*="file-upload"], [data-testid="image-attachment"], button[aria-label*="Remove file"], button[aria-label*="移除文件"], button[aria-label*="删除附件"], input[type="file"]')].some(element => {
    if (element instanceof HTMLInputElement) return (element.files?.length ?? 0) > 0;
    return visible(element);
  });
}
function signedOut(document: Document): boolean {
  return [...document.querySelectorAll('a,button')].some(element => visible(element) && /^(Log in|Sign in|登录|登入)$/i.test(normalize(element.textContent ?? '')));
}
export function pageChatStatus(document: Document): WebChatStatus {
  // Presence of the normal composer is only a page-readiness check, never proof that a turn succeeded.
  if (signedOut(document)) return { state: 'signedOut', loggedIn: false, models: [] };
  if (!chatEditor(document)) return { state: 'error', loggedIn: false, models: [], error: '未识别 ChatGPT 网页输入框。请完成登录并打开普通对话页面。' };
  return { state: 'ready', loggedIn: true, models: [{ id: 'follow-page', label: '跟随官网当前模型' }] };
}

/** Copy the visible answer's semantic formatting, omitting controls, hidden text and executable content. */
export function readAnswer(assistant: HTMLElement): string {
  const body = assistant.querySelector<HTMLElement>('.markdown, [data-message-content], .prose, [data-markdown-text-style="assistant-message"]') ?? assistant;
  const render = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof HTMLElement) || !visible(node) || /^(BUTTON|SCRIPT|STYLE|SVG|NOSCRIPT)$/.test(node.tagName) || node.getAttribute('aria-hidden') === 'true') return '';
    const children = () => [...node.childNodes].map(render).join('');
    switch (node.tagName) {
      case 'BR': return '\n';
      case 'PRE': {
        const code = node.querySelector('code');
        return `\n\n\`\`\`\n${(code?.textContent ?? node.innerText).trimEnd()}\n\`\`\`\n\n`;
      }
      case 'CODE': return `\`${children()}\``;
      case 'STRONG': case 'B': return `**${children()}**`;
      case 'EM': case 'I': return `*${children()}*`;
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return `\n\n${'#'.repeat(Number(node.tagName[1]))} ${children()}\n\n`;
      case 'P': case 'DIV': case 'SECTION': return `${children()}\n\n`;
      case 'LI': return `- ${children().trim()}\n`;
      case 'UL': case 'OL': return `\n${children()}\n`;
      case 'BLOCKQUOTE': return `\n${children().trim().split('\n').map(line => `> ${line}`).join('\n')}\n`;
      case 'A': {
        const text = children();
        const href = node.getAttribute('href');
        try {
          const url = new URL(href ?? '', location.href);
          return /^https?:$/.test(url.protocol) && href ? `[${text.replaceAll(']', '\\]')}](${url.href.replaceAll(')', '%29')})` : text;
        } catch { return text; }
      }
      case 'IMG': return node.getAttribute('alt') ?? '';
      case 'TD': case 'TH': return `${children()}\t`;
      case 'TR': return `${children().trimEnd()}\n`;
      default: return children();
    }
  };
  return render(body).replace(/\n{3,}/g, '\n\n').trim();
}
export function pageChatPrompt(messages: WebChatInput[], continuation: boolean): string {
  const turns = messages.filter(message => message.role !== 'system');
  if (!turns.length || turns.at(-1)?.role !== 'user') throw new PageChatError('format');
  const prompt = continuation || turns.length === 1 ? turns.at(-1)!.content :
    `以下是我在本地侧栏中的既有对话，请结合上下文回答最后一个问题。\n\n${turns.map(message => `${message.role === 'user' ? '用户' : '助手'}：\n${message.content}`).join('\n\n')}`;
  if (!prompt.trim() || prompt.length > 200_000) throw new PageChatError('format');
  return prompt;
}
interface OwnedConversation { conversation: WebChatConversation; user: HTMLElement; prompt: string; count: number }
interface RunOptions {
  document: Document; location: Location; signal: AbortSignal;
  onText(text: string): void;
}
async function readyEditor(document: Document, signal: AbortSignal): Promise<HTMLElement> {
  const end = Date.now() + 20_000;
  while (true) {
    if (signal.aborted) throw new PageChatError(signal.reason instanceof PageChatError ? signal.reason.code : 'interrupted');
    if (signedOut(document)) throw new PageChatError('signedOut');
    const editor = chatEditor(document);
    if (editor) return editor;
    if (Date.now() >= end) throw new PageChatError('pageUnsupported');
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, 120);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

/** One driver per isolated ChatGPT document. Only a successfully completed, locally owned turn may continue. */
export class PageChatDriver {
  private owned?: OwnedConversation;
  private running = false;
  async generate(command: Extract<WebChatPageCommand, { type: 'generate' }>, options: RunOptions): Promise<{ text: string; conversation: WebChatConversation }> {
    const { document, location, signal, onText } = options;
    if (this.running) throw new PageChatError('pageBusy');
    if (command.model !== 'follow-page') throw new PageChatError('model');
    const editor = await readyEditor(document, signal);
    if (normalize(editorText(editor)) || button(document, 'stop') || hasAttachment(document)) throw new PageChatError('pageBusy');
    const baselineUsers = messageElements(document, 'user');
    const baselineAssistants = messageElements(document, 'assistant');
    const initialPath = location.pathname;
    const previous = this.owned;
    if (command.conversation) {
      if (!previous || command.conversation.id !== previous.conversation.id || command.conversation.parentId !== previous.conversation.parentId || pathConversation(location) !== previous.conversation.id || baselineUsers.length !== previous.count || !baselineUsers.at(-1) || !sameMessage(baselineUsers.at(-1)!, previous.user) || normalize(baselineUsers.at(-1)!.innerText) !== normalize(previous.prompt)) throw new PageChatError('pageChanged');
    } else if (baselineUsers.length || baselineAssistants.length || pathConversation(location)) throw new PageChatError('pageBusy');
    const prompt = pageChatPrompt(command.messages, !!command.conversation);
    this.running = true;
    // A failed/cancelled turn cannot be silently resumed in a future request.
    this.owned = undefined;
    try {
      return await new Promise((resolve, reject) => {
        let completed = false, writing = false, sent = false, seenStop = false;
        let assignedConversation = command.conversation?.id;
        let ownUser: HTMLElement | undefined, ownAssistant: HTMLElement | undefined, lastText = '';
        let poll: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
        let finishTimer: ReturnType<typeof setTimeout> | undefined;
        const observer = new MutationObserver(() => inspect());
        const currentOwnUser = () => {
          const latest = messageElements(document, 'user').at(-1);
          return ownUser && latest && sameMessage(latest, ownUser) && normalize(latest.innerText) === normalize(prompt) ? latest : undefined;
        };
        const permittedPath = () => {
          if (location.origin !== 'https://chatgpt.com') return false;
          const current = pathConversation(location);
          if (assignedConversation) return current === assignedConversation;
          if (current && sent) { assignedConversation = current; return true; }
          return location.pathname === initialPath;
        };
        const stopOwnTurn = () => {
          // Never click a global stop control until the latest submitted user turn is positively ours.
          if (sent && permittedPath() && currentOwnUser()) button(document, 'stop')?.click();
        };
        const cleanup = () => {
          observer.disconnect(); clearInterval(poll); clearTimeout(deadline); clearTimeout(finishTimer);
          signal.removeEventListener('abort', abort);
          document.removeEventListener('input', userInput, true);
          document.removeEventListener('click', userClick, true);
          window.removeEventListener('pagehide', pagehide);
        };
        const fail = (code: PageChatErrorCode, stop = false) => {
          if (completed) return;
          completed = true;
          if (stop) stopOwnTurn();
          cleanup(); reject(new PageChatError(code));
        };
        const abort = () => fail(signal.reason instanceof PageChatError ? signal.reason.code : 'interrupted', true);
        const pagehide = () => fail('pageChanged', true);
        const userInput = (event: Event) => {
          if (!writing && event.isTrusted && event.target instanceof Node && editor.contains(event.target)) fail('pageChanged', true);
        };
        const userClick = (event: Event) => {
          if (!event.isTrusted || !(event.target instanceof Element)) return;
          const clicked = event.target.closest('button');
          if (clicked && clicked === button(document, 'stop') && currentOwnUser()) fail('interrupted');
        };
        const inspect = () => {
          if (completed || !sent) return;
          const users = messageElements(document, 'user');
          if (!ownUser) {
            const candidates = users.slice(baselineUsers.length);
            if (candidates.length > 1 || candidates.some(candidate => normalize(candidate.innerText) !== normalize(prompt))) { fail('pageChanged'); return; }
            ownUser = candidates[0];
          }
          if (!permittedPath() || !editor.isConnected || (ownUser && !currentOwnUser())) { fail('pageChanged'); return; }
          if (ownUser && normalize(editorText(editor))) { fail('pageChanged', true); return; }
          const stop = button(document, 'stop');
          if (stop && ownUser) seenStop = true;
          if (!ownUser) return;
          const assistants = messageElements(document, 'assistant').filter(candidate =>
            !baselineAssistants.some(previous => sameMessage(previous, candidate)) && !!(ownUser!.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING));
          if (assistants.length > 1) { fail('pageUnsupported', true); return; }
          ownAssistant = assistants[0];
          if (!ownAssistant) return;
          const text = readAnswer(ownAssistant);
          if (text.length > 40_000) { fail('format', true); return; }
          if (text && text !== lastText) { lastText = text; onText(text); }
          const turnState = ownAssistant.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state');
          const completedByPage = turnState ? turnState === 'complete' : seenStop || responseActions(ownAssistant);
          const ready = !!text && !stop && !!chatEditor(document) && completedByPage;
          if (!ready) { clearTimeout(finishTimer); finishTimer = undefined; return; }
          if (finishTimer) return;
          // The short deferred recheck lets the webpage finish its completion DOM transaction.
          // Text stability alone never completes a turn: a normal stop/actions transition is mandatory.
          finishTimer = setTimeout(() => {
            finishTimer = undefined;
            if (completed) return;
            if (!permittedPath() || !currentOwnUser()) { fail('pageChanged'); return; }
            if (button(document, 'stop') || !ownAssistant?.isConnected || !chatEditor(document)) return;
            const finalState = ownAssistant.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state');
            if (finalState && finalState !== 'complete') return;
            const id = pathConversation(location);
            if (!id) { fail('pageUnsupported'); return; }
            const finalText = readAnswer(ownAssistant);
            if (!finalText || finalText.length > 40_000) { fail('format'); return; }
            const conversation = { id, parentId: crypto.randomUUID() };
            this.owned = { conversation, user: currentOwnUser()!, prompt, count: messageElements(document, 'user').length };
            completed = true; cleanup(); resolve({ text: finalText, conversation });
          }, 120);
        };
        if (signal.aborted) { abort(); return; }
        observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-label', 'data-testid', 'class', 'hidden'] });
        signal.addEventListener('abort', abort, { once: true });
        document.addEventListener('input', userInput, true);
        document.addEventListener('click', userClick, true);
        window.addEventListener('pagehide', pagehide, { once: true });
        poll = setInterval(inspect, 100);
        deadline = setTimeout(() => fail('timeout', true), 180_000);
        try {
          writing = true;
          editor.focus();
          if (editor instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            setter?.call(editor, prompt);
            editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
          } else {
            const selection = window.getSelection(), range = document.createRange();
            range.selectNodeContents(editor); selection?.removeAllRanges(); selection?.addRange(range);
            if (!document.execCommand('insertText', false, prompt)) {
              editor.textContent = prompt;
              editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
            }
          }
          writing = false;
          if (normalize(editorText(editor)) !== normalize(prompt)) { fail('pageUnsupported'); return; }
          const submit = () => {
            if (completed || sent) return;
            const send = button(document, 'send');
            if (!send || send.disabled || send.getAttribute('aria-disabled') === 'true') { fail('pageUnsupported'); return; }
            if (!permittedPath() || normalize(editorText(editor)) !== normalize(prompt) || button(document, 'stop')) { fail('pageChanged'); return; }
            sent = true;
            send.click();
            inspect();
          };
          // React normally enables the send button on the input event's next render.
          setTimeout(submit, 120);
        } catch { writing = false; fail('pageUnsupported'); }
      });
    } finally { this.running = false; }
  }
}
