import './style.css';
import type { Paper } from './paper';

const form = document.querySelector<HTMLFormElement>('#add-paper')!;
const save = form.querySelector('button')!;
const unread = document.querySelector<HTMLButtonElement>('#unread')!;
const read = document.querySelector<HTMLButtonElement>('#read')!;
const status = document.querySelector<HTMLElement>('#status')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;
const empty = document.querySelector<HTMLElement>('#empty')!;
const list = document.querySelector<HTMLUListElement>('#papers')!;

let papers: Paper[] = [];
let showingRead = false;
let loaded = false;
const pending = new Set<number>();

async function request<T>(path = '', method = 'GET', data?: object): Promise<T> {
  const response = await fetch('/api/papers' + path, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result === null) {
    throw new Error(result?.error ?? 'The reading list is unavailable. Try again.');
  }
  return result;
}

function render() {
  unread.setAttribute('aria-pressed', String(!showingRead));
  read.setAttribute('aria-pressed', String(showingRead));

  const unreadCount = papers.filter(paper => paper.read_at === null).length;
  unread.textContent = `Unread (${unreadCount})`;
  read.textContent = `Read (${papers.length - unreadCount})`;

  const visible = papers.filter(paper => Boolean(paper.read_at) === showingRead);
  empty.hidden = !loaded || visible.length > 0;
  empty.textContent = showingRead ? 'Finished papers will appear here.' : 'No unread papers. Add a link to start your list.';
  list.replaceChildren(...visible.map(paperRow));
}

function paperRow(paper: Paper) {
  const row = document.createElement('li');
  const details = document.createElement('div');
  const link = document.createElement('a');
  link.href = paper.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = paper.title;
  link.setAttribute('aria-label', `${paper.title} (opens in a new tab)`);

  const source = document.createElement('small');
  source.textContent = new URL(paper.url).hostname;
  details.append(link, source);

  const action = document.createElement('button');
  action.type = 'button';
  action.textContent = paper.read_at ? 'Move to unread' : 'Mark as read';
  action.disabled = pending.has(paper.id);
  action.addEventListener('click', async () => {
    pending.add(paper.id);
    action.disabled = true;
    status.textContent = '';
    try {
      const updated = await request<Paper>(`/${paper.id}`, 'PATCH', { read: !paper.read_at });
      papers = papers.map(item => item.id === updated.id ? updated : item);
      status.textContent = updated.read_at ? 'Marked as read.' : 'Moved to unread.';
    } catch (error) {
      status.textContent = (error as Error).message;
    } finally {
      pending.delete(paper.id);
      const restoreFocus = document.activeElement === action || document.activeElement === document.body;
      render();
      if (restoreFocus) (showingRead ? read : unread).focus();
    }
  });
  row.append(details, action);
  return row;
}

async function load() {
  save.disabled = true;
  retry.hidden = true;
  status.textContent = 'Loading papers…';
  try {
    papers = await request<Paper[]>();
    loaded = true;
    status.textContent = '';
  } catch (error) {
    status.textContent = (error as Error).message;
    retry.hidden = false;
  } finally {
    save.disabled = !loaded;
    render();
  }
}

unread.addEventListener('click', () => { showingRead = false; render(); });
read.addEventListener('click', () => { showingRead = true; render(); });
retry.addEventListener('click', load);

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (save.disabled) return;

  const data = new FormData(form);
  save.disabled = true;
  status.textContent = '';
  try {
    const paper = await request<Paper>('', 'POST', { title: data.get('title'), url: data.get('url') });
    papers = [paper, ...papers];
    showingRead = false;
    form.reset();
    status.textContent = 'Paper saved.';
    render();
  } catch (error) {
    status.textContent = (error as Error).message;
  } finally {
    save.disabled = false;
  }
});

void load();
