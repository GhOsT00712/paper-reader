import type { D1Database, PagesFunction } from '@cloudflare/workers-types';
import type { Paper } from '../../../src/paper';

export type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const { results } = await env.DB.prepare('SELECT * FROM papers ORDER BY id DESC').all<Paper>();
  return Response.json(results, { headers: { 'Cache-Control': 'no-store' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const input = await request.json<{ title?: unknown; url?: unknown }>().catch(() => null);
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const rawUrl = typeof input?.url === 'string' ? input.url.trim() : '';
  const url = URL.parse(rawUrl);

  if (!title || title.length > 300) {
    return Response.json({ error: 'Enter a title of 1 to 300 characters.' }, { status: 400 });
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) {
    return Response.json({ error: 'Enter a valid HTTPS paper link.' }, { status: 400 });
  }

  const paper = await env.DB.prepare(
    'INSERT INTO papers (title, url) VALUES (?, ?) ON CONFLICT(url) DO NOTHING RETURNING *'
  ).bind(title, url.href).first<Paper>();
  if (!paper) {
    return Response.json({ error: 'This paper link is already saved.' }, { status: 409 });
  }
  return Response.json(paper, { status: 201 });
};
