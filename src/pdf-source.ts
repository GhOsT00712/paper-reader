export const PDF_LIMIT = 64 * 1024 * 1024;

const arxiv = /^(?:www\.)?arxiv\.org$/;
const arxivPath = /^\/(?:abs|pdf|html)\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?)(?:\.pdf)?\/?$/i;

export function pdfSource(value: string) {
  const url = new URL(value);
  if (arxiv.test(url.hostname)) {
    const id = url.pathname.match(arxivPath)?.[1];
    if (id) return new URL('https://arxiv.org/pdf/' + id);
  }
  if (url.hostname === 'openreview.net' && ['/forum', '/pdf'].includes(url.pathname) && url.searchParams.has('id')) {
    url.pathname = '/pdf';
    return url;
  }
  if (/\.pdf$/i.test(url.pathname)) {
    url.hash = '';
    return url;
  }
  return null;
}

const proxyHosts = new Set([
  'arxiv.org', 'www.arxiv.org', 'export.arxiv.org', 'openreview.net',
  'aclanthology.org', 'proceedings.mlr.press', 'proceedings.neurips.cc',
  'papers.nips.cc', 'www.usenix.org', 'www.vldb.org', 'www.cs.cmu.edu',
  'www.cs.umd.edu', 'www.microsoft.com', 'research.google', 'storage.googleapis.com'
]);

export function canProxyPdf(url: URL) {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && proxyHosts.has(url.hostname);
}

export function pdfVersion(source: URL, final: URL, etag: string | null) {
  for (const url of [final, source]) {
    const id = arxiv.test(url.hostname) && url.pathname.match(arxivPath)?.[1];
    if (id && /v\d+$/i.test(id)) return 'arxiv:' + id.toLowerCase();
  }
  final.hash = '';
  return final.href + (etag && /^"[^"]*"$/.test(etag) ? ' ' + etag : '');
}
