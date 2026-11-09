import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../index';
import { canProxyPdf, pdfSource, PDF_LIMIT } from '../../../../src/pdf-source';

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const paper = await env.DB.prepare('SELECT url FROM papers WHERE id = ? AND deleted_at IS NULL')
    .bind(Number(params.id)).first<{ url: string }>();
  const source = paper && pdfSource(paper.url);
  if (!source || !canProxyPdf(source)) return Response.json({ error: 'This PDF source cannot be forwarded.' }, { status: 404 });

  try {
    let url = source;
    const signal = AbortSignal.timeout(45_000);
    for (let hop = 0; hop < 5; hop++) {
      if (!canProxyPdf(url)) break;
      const response = await fetch(url.href, { redirect: 'manual', signal, headers: { Accept: 'application/pdf' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = URL.parse(response.headers.get('location') ?? '', url.href);
        await response.body?.cancel();
        if (!next || next.href === url.href) break;
        url = next;
        continue;
      }
      if (!response.ok || !response.body || !/^(application\/(pdf|octet-stream))\b/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        break;
      }
      if (Number(response.headers.get('content-length')) > PDF_LIMIT) {
        await response.body.cancel();
        return Response.json({ error: 'This PDF is larger than 64 MB.' }, { status: 413 });
      }
      const headers = new Headers({
        'Content-Type': 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'X-Pdf-Source': url.href
      });
      const etag = response.headers.get('etag');
      if (etag) headers.set('ETag', etag);
      let bytes = 0;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > PDF_LIMIT) controller.error(new Error('PDF exceeds size limit'));
          else controller.enqueue(chunk);
        }
      }));
      return new Response(body, { headers });
    }
  } catch {
    // Show the original link when the source is unavailable.
  }
  return Response.json({ error: 'The source didn’t return a readable PDF.' }, { status: 502 });
};
