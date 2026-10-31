import { WEBCHAT_ORIGIN } from './webchat-shared';

type RuntimeSources = {
  pageUrl: string;
  documentResources: Iterable<unknown>;
  manifestImports: unknown;
  performanceResources: Iterable<unknown>;
};
const MAX_MARKUP = 256;
const MAX_IMPORTS = 256;
const MAX_TIMINGS = 2048;

function runtimeUrl(value: unknown, pageUrl: string): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 2048) return;
  let url: URL;
  try { url = new URL(value, pageUrl); } catch { return; }
  if (url.origin === WEBCHAT_ORIGIN && /^\/cdn\/assets\/633146\.[a-f0-9]{8,64}\.js$/.test(url.pathname) &&
    !url.search && !url.hash && !url.username && !url.password) return url.href;
}

/**
 * Discover one fixed official runtime from public asset references only.
 * SPA navigation can remove markup and clear the resource-timing buffer while
 * the router's public entry import list still describes the loaded runtime.
 * No route data, page state, session, script source or arbitrary URL is read.
 */
export function discoverNativeRuntimeUrl(sources: RuntimeSources): string | undefined {
  let count = 0;
  for (const value of sources.documentResources) {
    if (count++ >= MAX_MARKUP) break;
    const found = runtimeUrl(value, sources.pageUrl);
    if (found) return found;
  }
  if (Array.isArray(sources.manifestImports)) {
    for (const value of sources.manifestImports.slice(0, MAX_IMPORTS)) {
      const found = runtimeUrl(value, sources.pageUrl);
      if (found) return found;
    }
  }
  count = 0;
  for (const entry of sources.performanceResources) {
    if (count++ >= MAX_TIMINGS) break;
    if (!entry || typeof entry !== 'object') continue;
    const resource = entry as { name?: unknown; initiatorType?: unknown };
    if (resource.initiatorType !== 'script' && resource.initiatorType !== 'link') continue;
    const found = runtimeUrl(resource.name, sources.pageUrl);
    if (found) return found;
  }
}
