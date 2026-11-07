import type { PagesFunction } from '@cloudflare/workers-types';
import { decodeHTML } from 'entities';

const sources = new Set([
  'arxiv.org', 'www.arxiv.org', 'openreview.net', 'aclanthology.org',
  'proceedings.mlr.press', 'proceedings.neurips.cc', 'papers.nips.cc',
  'dl.acm.org', 'ieeexplore.ieee.org', 'www.usenix.org', 'www.nature.com',
  'link.springer.com', 'www.sciencedirect.com', 'doi.org', 'www.biorxiv.org',
  'www.medrxiv.org', 'pubmed.ncbi.nlm.nih.gov', 'pmc.ncbi.nlm.nih.gov',
  'www.vldb.org', 'research.google', 'www.microsoft.com', 'www.semanticscholar.org'
]);

function attributes(tag: string) {
  const values = new Map<string, string>();
  for (const [, name, double, single, bare] of tag.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    values.set(name.toLowerCase(), double ?? single ?? bare);
  }
  return values;
}

function extractTitle(html: string) {
  const metadata = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = attributes(tag);
    const name = (attrs.get('name') ?? attrs.get('property'))?.toLowerCase();
    const content = attrs.get('content');
    if (name && content && !metadata.has(name)) metadata.set(name, content);
  }

  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1]?.replace(/<[^>]*>/g, '');
  const pageTitle = html.match(/<title\b[^>]*>([^<]*)<\/title\s*>/i)?.[1];
  for (const candidate of [metadata.get('citation_title'), metadata.get('dc.title'), heading, metadata.get('og:title'), pageTitle]) {
    if (!candidate) continue;
    const title = decodeHTML(candidate).replace(/\s+/g, ' ').trim().replace(/^Title:\s*/i, '');
    if (title && title.length <= 300) return title;
  }
  return null;
}

async function readHtml(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let html = '';
  let remaining = 512 * 1024;
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value.subarray(0, remaining), { stream: true });
      remaining -= value.length;
    }
    return html + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export const onRequestPost: PagesFunction = async ({ request }) => {
  const input = await request.json<{ url?: unknown }>().catch(() => null);
  let url = typeof input?.url === 'string' && input.url.length <= 2048 ? URL.parse(input.url) : null;
  const signal = AbortSignal.timeout(6500);

  try {
    for (let hop = 0; hop < 4 && url; hop++) {
      // Limit this public endpoint to known sources, including every redirect.
      if (url.protocol !== 'https:' || url.port || url.username || url.password || !sources.has(url.hostname)) break;
      if (url.hostname === 'arxiv.org' || url.hostname === 'www.arxiv.org') {
        url.pathname = url.pathname.replace(/^\/(?:pdf|html)\/(.+?)(?:\.pdf)?$/, '/abs/$1');
      }
      const response = await fetch(url.href, { redirect: 'manual', signal, headers: { Accept: 'text/html' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        url = location ? URL.parse(location, url.href) : null;
        continue;
      }
      if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
        return Response.json({ title: extractTitle(await readHtml(response)) });
      }
      await response.body?.cancel();
      break;
    }
  } catch {
    // Manual entry stays available if a publisher blocks or delays the lookup.
  }
  return Response.json({ title: null });
};
