import type { PagesFunction } from '@cloudflare/workers-types';
import type { Changes, Highlight, Position } from '../../../../src/pdf-state';
import { pdfSource } from '../../../../src/pdf-source';
import type { Env } from '../index';

const headers = { 'Cache-Control': 'no-store' };
const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const isPage = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 100000;
const validVersion = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;

async function savedPdf(env: Env, id: number) {
  const paper = await env.DB.prepare('SELECT url FROM papers WHERE id = ? AND deleted_at IS NULL')
    .bind(id).first<{ url: string }>();
  return paper && pdfSource(paper.url);
}

function isPosition(value: Position) {
  return value && isPage(value.page) && Number.isFinite(value.offset) && value.offset >= 0 && value.offset <= 1;
}

function isHighlight(value: Highlight) {
  return value && isId(value.id) && isPage(value.page) &&
    typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 4000 &&
    Array.isArray(value.rects) && value.rects.length > 0 && value.rects.length <= 100 &&
    value.rects.every(rect => Array.isArray(rect) && rect.length === 4 && rect.every(n => Number.isFinite(n) && Math.abs(n) < 1e7));
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const id = Number(params.id);
  const version = new URL(request.url).searchParams.get('version');
  if (!validVersion(version)) return Response.json({ error: 'Missing PDF version.' }, { status: 400 });
  if (!await savedPdf(env, id)) return Response.json({ error: 'PDF not found.' }, { status: 404 });

  const [position, highlights] = await env.DB.batch<{ data?: string }>([
    env.DB.prepare('SELECT page, offset FROM pdf_positions WHERE paper_id = ? AND version = ?').bind(id, version),
    env.DB.prepare('SELECT data FROM pdf_highlights WHERE paper_id = ? AND version = ? AND data IS NOT NULL').bind(id, version)
  ]);
  return Response.json({
    position: position.results[0] ?? null,
    highlights: highlights.results.map(row => JSON.parse(row.data as string))
  }, { headers });
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const id = Number(params.id);
  const raw = await request.text();
  if (raw.length > 120000) return Response.json({ error: 'Sync batch too large.' }, { status: 413 });
  let batch: (Changes & { version: string; id: string }) | null;
  try { batch = JSON.parse(raw); } catch { batch = null; }
  if (!batch || !validVersion(batch.version) || !isId(batch.id) ||
      (batch.position !== undefined && !isPosition(batch.position)) ||
      !Array.isArray(batch.adds) || batch.adds.length > 8 || !batch.adds.every(isHighlight) ||
      !Array.isArray(batch.deletes) || batch.deletes.length > 8 || !batch.deletes.every(isId)) {
    return Response.json({ error: 'Invalid PDF changes.' }, { status: 400 });
  }
  if (!await savedPdf(env, id)) return Response.json({ error: 'PDF not found.' }, { status: 404 });

  const { version, position, adds, deletes } = batch;
  const statements = [];
  if (position) statements.push(env.DB.prepare(
    `INSERT INTO pdf_positions (paper_id, version, page, offset)
     SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM pdf_sync_batches WHERE paper_id = ? AND version = ? AND id = ?)
     ON CONFLICT(paper_id, version) DO UPDATE SET page = excluded.page, offset = excluded.offset`
  ).bind(id, version, position.page, position.offset, id, version, batch.id));

  for (const highlight of adds) statements.push(env.DB.prepare(
    'INSERT OR IGNORE INTO pdf_highlights (paper_id, version, id, data) VALUES (?, ?, ?, ?)'
  ).bind(id, version, highlight.id, JSON.stringify(highlight)));
  for (const highlight of deletes) statements.push(env.DB.prepare(
    'INSERT INTO pdf_highlights (paper_id, version, id, data) VALUES (?, ?, ?, NULL) ON CONFLICT(paper_id, version, id) DO UPDATE SET data = NULL'
  ).bind(id, version, highlight));

  if (position) statements.push(env.DB.prepare('INSERT OR IGNORE INTO pdf_sync_batches VALUES (?, ?, ?)').bind(id, version, batch.id));
  if (statements.length) await env.DB.batch(statements);
  return Response.json({ saved: true }, { headers });
};
