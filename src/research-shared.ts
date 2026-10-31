import { allowedUrl } from './core';

export const MAX_RESEARCH_URLS = 5;
export const MAX_RESEARCH_QUESTION = 1500;
export const MAX_RESEARCH_CALLS = 6;
export const RESEARCH_PORT = 'research';
export interface ResearchFinding { point: string; quote: string }
export interface ResearchSource {
  id: string; requestedUrl: string; url?: string; title: string;
  status: 'queued'|'reading'|'analyzing'|'done'|'error';
  findings: ResearchFinding[]; characters?: number; notice?: string; error?: string;
}
export interface ResearchCitation { sourceId: string; finding: number }
export interface ResearchClaim { text: string; citations: ResearchCitation[] }
export interface ResearchReport { overview: ResearchClaim[]; comparisons: ResearchClaim[]; conclusion: ResearchClaim[] }
export type ResearchStatus = 'reading'|'analyzing'|'synthesizing'|'done'|'cancelled'|'error'|'interrupted';
export interface ResearchTask {
  id: string; question: string; urls: string[]; sources: ResearchSource[];
  status: ResearchStatus; stage: string; calls: number; maxCalls: number;
  createdAt: number; updatedAt: number; report?: ResearchReport; error?: string; savedId?: string;
}
export interface SavedResearch { id: string; savedAt: number; task: ResearchTask }
export const researchActive = (task?: ResearchTask | null): boolean => !!task && ['reading','analyzing','synthesizing'].includes(task.status);
export function researchInput(question: unknown, urls: unknown): { question: string; urls: string[] } {
  if (typeof question !== 'string' || !question.trim() || question.length > MAX_RESEARCH_QUESTION) throw new Error('请填写研究问题，最多 1,500 个字符。');
  if (!Array.isArray(urls) || !urls.length || urls.length > MAX_RESEARCH_URLS) throw new Error('请提供 1—5 个文档链接，每行一个。');
  const normalized = urls.map(value => {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error('文档链接格式无效。');
    return allowedUrl(value).href;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error('文档链接有重复，请保留一份。');
  return { question: question.trim(), urls: normalized };
}
export function researchMarkdown(task: ResearchTask): string {
  const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/[\[\]`*_{}<>]/g, '\\$&').replace(/^([ \t]*)([#>+\-]|\d+\.)/gm, '$1\\$2');
  const sections = ['# 阅窗 · 跨页研究报告', `问题：${escape(task.question)}`, `任务状态：${task.status === 'done' ? '完成' : '尚未完成'} · 模型调用 ${task.calls}/${task.maxCalls}`];
  if (task.error) sections.push(`说明：${escape(task.error)}`);
  if (task.report) {
    const cell = (value: string) => escape(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
    sections.push('## 来源比较表\n\n| 来源 | 与问题相关的要点 | 原文证据 |\n| --- | --- | --- |\n' + task.sources.filter(source => source.status === 'done').map(source => `| ${source.id} · ${cell(source.title)} | ${cell(source.findings.map(finding => finding.point).join('；'))} | ${source.findings.map((_, index) => `${source.id}·${index + 1}`).join('、')} |`).join('\n'));
  }
  for (const [key, title] of [['overview','资料概览'],['comparisons','比较结果'],['conclusion','结论']] as const) {
    const claims = task.report?.[key] ?? [];
    if (claims.length) sections.push(`## ${title}\n\n` + claims.map(claim => `- ${escape(claim.text)} ${claim.citations.map(citation => `[${citation.sourceId}·${citation.finding + 1}]`).join(' ')}`).join('\n'));
  }
  sections.push('## 来源与原文证据');
  for (const source of task.sources) {
    sections.push(`### ${source.id} · ${escape(source.title || '未命名网页')}\n\n<${source.url || source.requestedUrl}>\n\n${source.status === 'done' ? '已分析' : '未完成'}${source.error ? `：${escape(source.error)}` : ''}${source.notice ? `\n\n读取范围：${escape(source.notice)}` : ''}`);
    source.findings.forEach((finding, index) => sections.push(`**${source.id}·${index + 1}** ${escape(finding.point)}\n\n原文引句：${escape(finding.quote)}`));
  }
  return sections.join('\n\n') + '\n';
}
