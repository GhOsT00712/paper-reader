import type { PagesFunction } from '@cloudflare/workers-types';
import type { Paper } from '../../../src/paper';
import type { Env } from './index';
import { readDetails } from '../../lib/details';

export const onRequestPatch: PagesFunction<Env> = async ({ env, request, params }) => {
  const id = Number(params.id);
  const input = await request.json<Record<string, unknown>>().catch(() => null);
  const details = input && readDetails(input, true);
  if (!Number.isSafeInteger(id) || id < 1 || !input || !details ||
      (input.read !== undefined && typeof input.read !== 'boolean') ||
      (input.pinned !== undefined && typeof input.pinned !== 'boolean')) {
    return Response.json({ error: 'Invalid paper update.' }, { status: 400 });
  }
  if (typeof input.restore === 'string') {
    const restored = await env.DB.prepare('UPDATE papers SET deleted_at = NULL WHERE id = ? AND deleted_at = ? AND NOT EXISTS (SELECT 1 FROM papers AS active WHERE active.paper_key = papers.paper_key AND active.deleted_at IS NULL) RETURNING *')
      .bind(id, input.restore).first<Paper>();
    if (!restored) return Response.json({ error: 'This deletion can no longer be undone.' }, { status: 409 });
    return Response.json(restored);
  }

  if ('restoreReadAt' in input) {
    const { restoreReadAt, expectedReadAt } = input;
    if (![restoreReadAt, expectedReadAt].every(value =>
      value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    )) return Response.json({ error: 'Invalid reading status.' }, { status: 400 });
    const restored = await env.DB.prepare(
      'UPDATE papers SET read_at = ? WHERE id = ? AND deleted_at IS NULL AND read_at IS ? RETURNING *'
    ).bind(restoreReadAt, id, expectedReadAt).first<Paper>();
    if (!restored) return Response.json({ error: 'The reading status has already changed.' }, { status: 409 });
    return Response.json(restored);
  }

  const paper = await env.DB.prepare(
    `UPDATE papers SET title = COALESCE(?, title), authors = COALESCE(?, authors),
     tags = COALESCE(?, tags), note = COALESCE(?, note), pinned = COALESCE(?, pinned),
     read_at = CASE ? WHEN 1 THEN COALESCE(read_at, ?) WHEN 0 THEN NULL ELSE read_at END
     WHERE id = ? AND deleted_at IS NULL RETURNING *`
  ).bind(details.title ?? null, details.authors ?? null, details.tags ?? null, details.note ?? null,
    typeof input.pinned === 'boolean' ? Number(input.pinned) : null,
    typeof input.read === 'boolean' ? Number(input.read) : null, new Date().toISOString(), id).first<Paper>();
  if (!paper) return Response.json({ error: 'Paper not found.' }, { status: 404 });
  return Response.json(paper);
};

export const onRequestDelete: PagesFunction<Env> = async ({ env, params }) => {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1) return Response.json({ error: 'Invalid paper ID.' }, { status: 400 });
  const paper = await env.DB.prepare(
    'UPDATE papers SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ? RETURNING deleted_at'
  ).bind(new Date().toISOString(), id).first<{ deleted_at: string }>();
  if (!paper) return Response.json({ error: 'Paper not found.' }, { status: 404 });
  return Response.json({ token: paper.deleted_at });
};

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const paper = await env.DB.prepare('SELECT id, title, url FROM papers WHERE id = ? AND deleted_at IS NULL')
    .bind(Number(params.id)).first();
  if (!paper) return Response.json({ error: 'Paper not found.' }, { status: 404 });
  return Response.json(paper, { headers: { 'Cache-Control': 'no-store' } });
};
