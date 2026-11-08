import type { D1Database, PagesFunction } from '@cloudflare/workers-types';
import type { Paper } from '../../../src/paper';
import { normalizePaperUrl, paperKey } from '../../../src/paper-url';
import { readDetails } from '../../lib/details';

export type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const { results } = await env.DB.prepare('SELECT id, title, url, created_at, read_at, authors, tags, note, pinned FROM papers WHERE deleted_at IS NULL ORDER BY id DESC').all<Paper>();
  return Response.json(results, { headers: { 'Cache-Control': 'no-store' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const input = await request.json<Record<string, unknown>>().catch(() => null);
  const details = input && readDetails(input);
  const url = typeof input?.url === 'string' ? normalizePaperUrl(input.url) : null;
  if (!details || !url) return Response.json({ error: 'Enter a valid paper link and title. Check the field lengths.' }, { status: 400 });

  const { results } = await env.DB.prepare('SELECT url FROM papers WHERE deleted_at IS NULL').all<{ url: string }>();
  if (results.some(paper => {
    const saved = normalizePaperUrl(paper.url);
    return saved && paperKey(saved) === paperKey(url);
  })) return Response.json({ error: 'This paper is already in your library.' }, { status: 409 });

  const paper = await env.DB.prepare(
    `INSERT INTO papers (title, url, authors, tags, note, paper_key) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET title = excluded.title, authors = excluded.authors,
       tags = excluded.tags, note = excluded.note, paper_key = excluded.paper_key, read_at = NULL, pinned = 0,
       created_at = excluded.created_at, deleted_at = NULL WHERE papers.deleted_at IS NOT NULL
     ON CONFLICT DO NOTHING
     RETURNING *`
  ).bind(details.title, url.href, details.authors ?? '', details.tags ?? '', details.note ?? '', paperKey(url)).first<Paper>();
  if (!paper) return Response.json({ error: 'This paper is already in your library.' }, { status: 409 });
  return Response.json(paper, { status: 201 });
};
