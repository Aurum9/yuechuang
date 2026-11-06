/** Shared by the background worker and the UI inside the selected document. */
export const CONTEXT_MENU_EXPLAIN = 'contextual-explain';
export const CONTEXT_MENU_TRANSLATE = 'contextual-translate';
export const HIDDEN_TOOLBAR_SITES = 'hiddenToolbarSites';
export const CONTEXT_PORT = 'context-reading';
export const MAX_CONTEXT_SELECTION = 6_000;
export const MAX_CONTEXT_PARAGRAPHS = 10_000;
export const MAX_CONTEXT_TITLE = 500;
export const MAX_CONTEXT_URL = 8_192;

export type ContextMode = 'explain' | 'translate';
export type ContextAnswerKind = 'core' | 'details';
export type ContextExampleKind = 'bilingual' | 'usage';

/** A short English lookup can offer bilingual examples; long translations stay focused. */
export function detailsEligibility(mode: ContextMode, text: string): ContextExampleKind | undefined {
  const selection = text.trim();
  if (!selection) return undefined;
  if (mode === 'explain') return 'usage';
  if (mode !== 'translate' || selection.length > 240 || /\n\s*\n/u.test(selection) || /[{}[\]();=<>`]|=>|::|->/u.test(selection) || /^(?:const|let|var|return|import|class|function)\s/u.test(selection)) return undefined;
  const latin = (selection.match(/[A-Za-z]/gu) ?? []).length;
  const letters = (selection.match(/\p{L}/gu) ?? []).length;
  const words = selection.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/gu) ?? [];
  const englishWord = latin >= 2 || selection === 'a' || selection === 'A' || selection === 'I';
  return englishWord && letters > 0 && latin / letters >= .65 && words.length <= 40 ? 'bilingual' : undefined;
}
export interface ContextRect { x: number; y: number; width: number; height: number }
export interface ContextSnapshot {
  text: string;
  context: string;
  title: string;
  url: string;
  /** Coordinates within the selected frame's viewport. */
  rect: ContextRect;
  capturedAt: number;
}
export interface ContextState {
  type: 'context:state';
  requestId: string;
  mode: ContextMode;
  status: 'reading' | 'running' | 'done' | 'cancelled' | 'error';
  text: string;
  coreText: string;
  detailsText: string;
  exampleKind?: ContextExampleKind;
  error?: string;
  expanded: boolean;
  canExpand: boolean;
  saved?: boolean;
  savedId?: string;
  saving?: boolean;
  saveError?: string;
}
export interface ContextCaptureMessage {
  type: 'context:capture'; requestId: string; selectedText?: string; captureId?: string;
}
export type ContextCaptureResult = { ok: true; snapshot: ContextSnapshot } | { ok: false; message: string };
export interface ContextShowMessage {
  type: 'context:show';
  requestId: string;
  mode: ContextMode;
  /** Capture failures still display an error in the same document; they never call the model. */
  snapshot?: ContextSnapshot;
  selectionText?: string;
  error?: string;
  expanded: boolean;
  captureId?: string;
  coreText?: string;
  detailsText?: string;
  exampleKind?: ContextExampleKind;
}
export interface ContextSelectionStartMessage { type: 'context:selection-start'; mode: ContextMode; captureId: string }
export interface ContextSelectionDismissMessage { type: 'context:selection-dismiss'; requestId?: string; captureId?: string }
export type ContextCommand = {
  type: 'context:stop' | 'context:close' | 'context:retry' | 'context:expand' | 'context:status' | 'context:save' | 'context:open-phrases';
  requestId: string;
};

/** Chrome and Selection APIs can differ in line breaks and runs of whitespace. */
export function normalizeContextSelection(text: string): string { return text.replace(/\s+/gu, ' ').trim(); }
