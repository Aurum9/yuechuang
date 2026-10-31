import { allowedUrl } from './core';
import {
  MAX_RESEARCH_CALLS, researchInput,
  type ResearchClaim, type ResearchFinding, type ResearchReport, type ResearchSource, type ResearchTask, type SavedResearch
} from './research-shared';
import { secureStorage } from './store';

export const RESEARCH_STORAGE_KEY = 'researchReports';
export const MAX_SAVED_RESEARCH = 20;
export const MAX_SAVED_RESEARCH_BYTES = 1.5 * 1024 * 1024;

const taskKeys = new Set(['id', 'question', 'urls', 'sources', 'status', 'stage', 'calls', 'maxCalls', 'createdAt', 'updatedAt', 'report', 'error']);
const sourceKeys = new Set(['id', 'requestedUrl', 'url', 'title', 'status', 'findings', 'characters', 'notice', 'error']);
const savedKeys = new Set(['id', 'savedAt', 'task']);
const reportKeys = new Set(['overview', 'comparisons', 'conclusion']);
const findingKeys = new Set(['point', 'quote']);
const claimKeys = new Set(['text', 'citations']);
const citationKeys = new Set(['sourceId', 'finding']);
let queue: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.then(() => {}, () => {});
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('研究报告数据格式无效。');
  return value as Record<string, unknown>;
}
function known(data: Record<string, unknown>, keys: Set<string>, stored: boolean): void {
  if (stored && Object.keys(data).some(key => !keys.has(key))) throw new Error('研究报告包含无法识别的字段。');
}
function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) throw new Error('研究报告文本格式无效或长度超出上限。');
  return value;
}
function optionalText(value: unknown, maximum: number): string | undefined {
  return value === undefined ? undefined : text(value, maximum);
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(value)) throw new Error('研究报告标识格式无效。');
  return value;
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error('研究报告的时间或数量格式无效。');
  return value as number;
}
function url(value: unknown): string {
  const raw = text(value, 8192, true);
  if (/[\u0000-\u0020\u007f]/u.test(raw)) throw new Error('研究报告来源链接格式无效。');
  const result = allowedUrl(raw).href;
  if (result.length > 8192) throw new Error('研究报告来源链接过长。');
  return result;
}
function array(value: unknown, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error('研究报告条目数量无效。');
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) throw new Error('研究报告包含缺失条目。');
  return value;
}
function finding(value: unknown, stored: boolean): ResearchFinding {
  const data = object(value); known(data, findingKeys, stored);
  const quote = text(data.quote, 400, true);
  if (quote.length < 8) throw new Error('研究报告的原文证据过短。');
  return { point: text(data.point, 600, true), quote };
}
function source(value: unknown, requestedUrl: string, index: number, stored: boolean): ResearchSource {
  const data = object(value); known(data, sourceKeys, stored);
  if (data.id !== `S${index + 1}`) throw new Error('研究报告来源标识与输入顺序不一致。');
  if (data.status !== 'done' && data.status !== 'error') throw new Error('完成的研究报告仍包含未完成来源。');
  if (url(data.requestedUrl) !== requestedUrl) throw new Error('研究报告的来源顺序与输入链接不一致。');
  const findings = array(data.findings, data.status === 'done' ? 1 : 0, 4).map(value => finding(value, stored));
  if (data.status === 'error' && findings.length) throw new Error('失败来源不能包含已完成的研究证据。');
  const finalUrl = data.url === undefined ? undefined : url(data.url);
  const characters = data.characters === undefined ? undefined : integer(data.characters, 0, 1_000_000);
  const notice = optionalText(data.notice, 2000);
  const error = optionalText(data.error, 2000);
  return {
    id: id(data.id), requestedUrl, title: text(data.title, 500), status: data.status, findings,
    ...(finalUrl === undefined ? {} : { url: finalUrl }),
    ...(characters === undefined ? {} : { characters }),
    ...(notice === undefined ? {} : { notice }), ...(error === undefined ? {} : { error })
  };
}
function claim(value: unknown, sources: Map<string, ResearchSource>, stored: boolean): ResearchClaim {
  const data = object(value); known(data, claimKeys, stored);
  const seen = new Set<string>();
  const citations = array(data.citations, 1, 20).map(value => {
    const citation = object(value); known(citation, citationKeys, stored);
    const sourceId = id(citation.sourceId); const index = integer(citation.finding, 0, 3);
    const evidence = sources.get(sourceId);
    if (!evidence || evidence.status !== 'done' || index >= evidence.findings.length) throw new Error('研究报告引用了不存在或未完成的原文证据。');
    const identity = `${sourceId}:${index}`;
    if (seen.has(identity)) throw new Error('研究报告包含重复引用。');
    seen.add(identity);
    return { sourceId, finding: index };
  });
  return { text: text(data.text, 1500, true), citations };
}
function task(value: unknown, stored = false): ResearchTask {
  const data = object(value); known(data, taskKeys, stored);
  if (data.status !== 'done') throw new Error('请等待研究完成后再保存报告。');
  const input = researchInput(data.question, data.urls);
  const sources = array(data.sources, input.urls.length, input.urls.length).map((value, index) => source(value, input.urls[index], index, stored));
  const sourceMap = new Map(sources.map(source => [source.id, source]));
  if (sourceMap.size !== sources.length || !sources.some(source => source.status === 'done')) throw new Error('研究报告需要唯一来源标识与至少一个完成来源。');
  const reportData = object(data.report); known(reportData, reportKeys, stored);
  const report = Object.fromEntries((['overview', 'comparisons', 'conclusion'] as const).map(key => [key, array(reportData[key], key === 'overview' ? 1 : 0, 8).map(value => claim(value, sourceMap, stored))])) as unknown as ResearchReport;
  const createdAt = integer(data.createdAt, 1);
  const updatedAt = integer(data.updatedAt, createdAt);
  const maxCalls = integer(data.maxCalls, MAX_RESEARCH_CALLS, MAX_RESEARCH_CALLS);
  const calls = integer(data.calls, 1, Math.min(maxCalls, sources.length + 1));
  const error = optionalText(data.error, 2000);
  return {
    id: id(data.id), ...input, sources, status: 'done', stage: text(data.stage, 2000), calls, maxCalls, createdAt, updatedAt, report,
    ...(error === undefined ? {} : { error })
  };
}
function limits(entries: SavedResearch[]): void {
  if (entries.length > MAX_SAVED_RESEARCH) throw new Error('研究报告已达 20 条上限，请先删除部分报告后重试。');
  if (new TextEncoder().encode(JSON.stringify({ [RESEARCH_STORAGE_KEY]: entries })).byteLength > MAX_SAVED_RESEARCH_BYTES) throw new Error('研究报告已达 1.5 MiB 本机存储上限，请先删除部分报告后重试。');
}
async function snapshot(): Promise<SavedResearch[]> {
  await secureStorage;
  const stored = (await chrome.storage.local.get<Record<string, unknown>>(RESEARCH_STORAGE_KEY))[RESEARCH_STORAGE_KEY];
  if (stored === undefined) return [];
  try {
    const savedIds = new Set<string>(); const taskIds = new Set<string>();
    const entries = array(stored, 0, MAX_SAVED_RESEARCH).map(value => {
      const data = object(value); known(data, savedKeys, true);
      const savedId = id(data.id); const reportTask = task(data.task, true);
      const savedAt = integer(data.savedAt, reportTask.updatedAt);
      if (savedIds.has(savedId) || taskIds.has(reportTask.id)) throw new Error('研究报告包含重复记录。');
      savedIds.add(savedId); taskIds.add(reportTask.id);
      return { id: savedId, savedAt, task: reportTask };
    });
    limits(entries); return entries;
  } catch (error) {
    throw new Error('本机研究报告数据损坏或格式不兼容，未覆盖原数据。请先备份并修复报告数据。', { cause: error });
  }
}

export async function saveResearchReport(value: ResearchTask): Promise<SavedResearch> {
  // Capture only known, validated fields before the caller can mutate pending input.
  const payload = task(value);
  return serialize(async () => {
    const entries = await snapshot();
    const previous = entries.find(entry => entry.task.id === payload.id);
    const savedAt = Math.max(Date.now(), payload.updatedAt, ...entries.map(entry => entry.savedAt + 1));
    integer(savedAt, 1);
    const savedId = previous?.id ?? crypto.randomUUID();
    if (!previous && entries.some(entry => entry.id === savedId)) throw new Error('研究报告标识冲突，请重试。');
    const entry = { id: savedId, savedAt, task: payload };
    const next = [entry, ...entries.filter(entry => entry.id !== savedId)];
    limits(next);
    await chrome.storage.local.set({ [RESEARCH_STORAGE_KEY]: next });
    return structuredClone(entry);
  });
}
export async function listResearchReports(): Promise<SavedResearch[]> {
  return serialize(async () => (await snapshot()).sort((left, right) => right.savedAt - left.savedAt));
}
export async function deleteResearchReport(value: string): Promise<void> {
  const requested = id(value);
  return serialize(async () => {
    const entries = await snapshot();
    const next = entries.filter(entry => entry.id !== requested);
    if (next.length !== entries.length) await chrome.storage.local.set({ [RESEARCH_STORAGE_KEY]: next });
  });
}
