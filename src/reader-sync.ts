import type { Changes, Highlight, Position, ReaderState } from './pdf-state';

interface Batch extends Changes {
  id: string;
  version: string;
  created: number;
}

export class ReaderSync {
  private readonly prefix: string;
  private readonly endpoint: string;
  private readonly memory = new Map<string, Batch>();
  private draft: Batch | null = null;
  private sending: Promise<boolean> | null = null;

  constructor(paperId: number, private readonly version: string, private readonly status: HTMLElement) {
    this.endpoint = '/api/papers/' + paperId + '/reader';
    this.prefix = 'paper-reader-outbox:' + paperId + ':' + encodeURIComponent(version) + ':';
  }

  private queued() {
    const batches = new Map(this.memory);
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(this.prefix) || batches.has(key)) continue;
        const value = localStorage.getItem(key);
        if (value) batches.set(key, JSON.parse(value) as Batch);
      }
    } catch {
      // The in-memory queue can still sync if storage is blocked.
    }
    return [...batches.entries()].sort(([, a], [, b]) => a.created - b.created);
  }

  change(update: { position: Position } | { add: Highlight } | { delete: string }) {
    if (!this.draft || this.draft.adds.length >= 4 || this.draft.deletes.length >= 8) {
      this.draft = { id: crypto.randomUUID(), version: this.version, created: Date.now(), adds: [], deletes: [] };
    }
    // A new ID prevents a tab syncing an older snapshot from acknowledging this edit.
    const previous = this.prefix + this.draft.id;
    const batch = { ...this.draft, id: crypto.randomUUID() };
    if ('position' in update) batch.position = update.position;
    if ('add' in update) batch.adds = [...batch.adds, update.add];
    if ('delete' in update) batch.deletes = [...batch.deletes, update.delete];
    this.draft = batch;
    const key = this.prefix + batch.id;
    this.memory.set(key, batch);
    this.memory.delete(previous);
    try {
      localStorage.setItem(key, JSON.stringify(batch));
      localStorage.removeItem(previous);
      this.status.textContent = 'Pending sync';
    } catch {
      this.status.textContent = 'Pending sync. Keep this tab open.';
    }
  }

  async load(): Promise<ReaderState> {
    let state: ReaderState = { position: null, highlights: [] };
    let online = false;
    try {
      const response = await fetch(this.endpoint + '?' + new URLSearchParams({ version: this.version }), {
        signal: AbortSignal.timeout(8000), cache: 'no-store'
      });
      if (response.ok) {
        state = await response.json();
        online = true;
      }
    } catch {
      // Pending edits remain available on this browser.
    }
    const highlights = new Map(state.highlights.map(item => [item.id, item]));
    const pending = this.queued();
    for (const [, batch] of pending) {
      if (batch.position) state.position = batch.position;
      for (const item of batch.adds) highlights.set(item.id, item);
      for (const id of batch.deletes) highlights.delete(id);
    }
    this.status.textContent = pending.length ? 'Pending sync' : online ? 'Synced' : 'Shared state unavailable';
    return { position: state.position, highlights: [...highlights.values()] };
  }

  flush(keepalive = false): Promise<boolean> {
    if (this.sending) return this.sending;
    this.draft = null;
    const queued = this.queued();
    if (!queued.length) return Promise.resolve(true);
    this.status.textContent = 'Syncing…';
    this.sending = (async () => {
      try {
        for (const [key, batch] of queued) {
          const body = JSON.stringify(batch);
          // Unload requests have a small per-browser body budget.
          if (keepalive && new TextEncoder().encode(body).length > 60_000) break;
          const response = await fetch(this.endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body, keepalive, signal: keepalive ? undefined : AbortSignal.timeout(8000)
          });
          if (!response.ok) throw new Error('Sync failed');
          this.memory.delete(key);
          try { localStorage.removeItem(key); } catch { /* Storage is unavailable. */ }
        }
      } catch {
        // Retry the same IDs on the next sync.
      }
      const synced = !this.queued().length;
      this.status.textContent = synced ? 'Synced' : 'Pending sync';
      return synced;
    })().finally(() => { this.sending = null; });
    return this.sending;
  }
}
