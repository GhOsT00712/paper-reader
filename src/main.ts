import './style.css';
import type { Paper } from './paper';

const form = document.querySelector<HTMLFormElement>('#add-paper')!;
const save = form.querySelector('button')!;
const urlInput = document.querySelector<HTMLInputElement>('#paper-url')!;
const titleInput = document.querySelector<HTMLInputElement>('#paper-title')!;
const titleField = document.querySelector<HTMLElement>('#title-field')!;
const addStatus = document.querySelector<HTMLElement>('#add-status')!;
const addHint = addStatus.textContent!;
let reviewedUrl: string | null = null;
const unread = document.querySelector<HTMLButtonElement>('#unread')!;
const read = document.querySelector<HTMLButtonElement>('#read')!;
const status = document.querySelector<HTMLElement>('#status')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;
const dialog = document.querySelector<HTMLDialogElement>('#add-dialog')!;
const closeDialog = document.querySelector<HTMLButtonElement>('#close-dialog')!;
closeDialog.addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', event => {
  if (urlInput.readOnly) event.preventDefault();
});
dialog.addEventListener('close', () => document.querySelector<HTMLButtonElement>('.add-page')?.focus());
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

  list.replaceChildren(addTile(), ...visible.map(paperRow));
}

function addTile() {
  const tile = document.createElement('li');
  tile.className = 'add-tile';
  const button = document.createElement('button');
  button.className = 'add-page';
  button.type = 'button';
  button.disabled = !loaded;
  const plus = document.createElement('span');
  plus.className = 'plus';
  plus.textContent = '+';
  plus.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = 'Add paper';
  button.append(plus, label);
  button.addEventListener('click', () => {
    dialog.showModal();
    urlInput.focus();
  });
  tile.append(button);
  return tile;
}

function paperRow(paper: Paper) {
  const row = document.createElement('li');
  row.className = 'paper-card';
  const link = document.createElement('a');
  link.className = 'paper-page';
  link.href = paper.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `${paper.title} (opens in a new tab)`);

  const source = document.createElement('span');
  source.className = 'paper-source';
  source.textContent = new URL(paper.url).hostname;
  const title = document.createElement('h2');
  title.className = 'paper-title';
  title.textContent = paper.title;
  const rules = document.createElement('span');
  rules.className = 'page-rules';
  rules.setAttribute('aria-hidden', 'true');
  const open = document.createElement('span');
  open.className = 'open-paper';
  open.textContent = 'Open paper ↗';
  link.append(source, title, rules, open);
  const controls = document.createElement('div');
  controls.className = 'paper-controls';
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
  controls.append(action);
  row.append(link, controls);
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

function resetTitle() {
  reviewedUrl = null;
  titleField.hidden = true;
  titleInput.disabled = true;
  titleInput.required = false;
  titleInput.value = '';
  save.textContent = 'Find title';
  addStatus.textContent = addHint;
}

urlInput.addEventListener('input', resetTitle);

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (save.disabled) return;

  const url = urlInput.value.trim();
  if (URL.parse(url)?.protocol !== 'https:') {
    addStatus.textContent = 'Enter an HTTPS paper link.';
    urlInput.focus();
    return;
  }

  save.disabled = true;
  urlInput.readOnly = true;
  closeDialog.disabled = true;
  try {
    if (reviewedUrl !== url) {
      addStatus.textContent = 'Looking up the paper title…';
      const result = await request<{ title: string | null }>('/title', 'POST', { url }).catch(() => null);
      reviewedUrl = url;
      titleInput.value = result?.title ?? '';
      titleField.hidden = false;
      titleInput.disabled = false;
      titleInput.required = true;
      save.textContent = 'Save paper';
      addStatus.textContent = result?.title
        ? 'Title found. Edit it if needed, then save.'
        : 'Couldn’t find a title. Enter it below to save the link.';
      titleInput.focus();
      return;
    }

    const paper = await request<Paper>('', 'POST', { title: titleInput.value, url });
    papers = [paper, ...papers];
    showingRead = false;
    form.reset();
    resetTitle();
    status.textContent = 'Paper saved.';
    render();
    dialog.close();
  } catch (error) {
    addStatus.textContent = (error as Error).message;
  } finally {
    save.disabled = false;
    urlInput.readOnly = false;
    closeDialog.disabled = false;
  }
});

void load();
