import type { PagesFunction } from '@cloudflare/workers-types';
import type { Paper } from '../../../src/paper';
import type { Env } from './index';

export const onRequestPatch: PagesFunction<Env> = async ({ env, request, params }) => {
  const id = typeof params.id === 'string' && /^[1-9]\d*$/.test(params.id) ? Number(params.id) : 0;
  const input = await request.json<{ read?: unknown }>().catch(() => null);

  if (!Number.isSafeInteger(id) || !id || typeof input?.read !== 'boolean') {
    return Response.json({ error: 'Provide a paper ID and a boolean read status.' }, { status: 400 });
  }

  const paper = await env.DB.prepare(
    'UPDATE papers SET read_at = CASE WHEN ? THEN COALESCE(read_at, ?) ELSE NULL END WHERE id = ? RETURNING *'
  ).bind(Number(input.read), new Date().toISOString(), id).first<Paper>();
  if (!paper) {
    return Response.json({ error: 'Paper not found.' }, { status: 404 });
  }
  return Response.json(paper);
};
