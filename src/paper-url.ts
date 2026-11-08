const arxivHost = /^(?:www\.)?arxiv\.org$/;
const arxivId = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i;

export function normalizePaperUrl(value: string): URL | null {
  let raw = value.trim();
  const id = raw.replace(/^arxiv:\s*/i, '');
  if (arxivId.test(id)) raw = 'https://arxiv.org/abs/' + id;
  if (/^(?:doi:\s*)?10\.\d{4,9}\/\S+$/i.test(raw)) {
    raw = 'https://doi.org/' + raw.replace(/^doi:\s*/i, '');
  }
  const url = URL.parse(raw.replace(/^http:\/\//i, 'https://'));
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) return null;
  url.hash = '';
  return url;
}

export function getArxivId(url: URL) {
  if (!arxivHost.test(url.hostname)) return null;
  const id = url.pathname.replace(/^\/(?:abs|pdf|html)\//, '').replace(/\.pdf$/, '');
  return arxivId.test(id) ? id : null;
}

export function paperKey(url: URL) {
  const id = getArxivId(url);
  if (id) return 'arxiv:' + id.toLowerCase();
  if (url.hostname === 'doi.org' || url.hostname === 'dx.doi.org') return 'doi:' + url.pathname.toLowerCase();
  return url.href;
}
