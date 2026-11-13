import { applyTheme, toggleTheme, watchTheme } from './theme';
import { pdfSource } from './pdf-source';
import './style.css';
import type { Paper } from './paper';
import { normalizePaperUrl, getArxivId, paperKey } from './paper-url';
import { showToast } from './toast';
import { exportPapers } from './export';

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const tabNames = ['all', 'unread', 'read'] as const;
const sorts = ['added', 'read', 'title'] as const;
const search = byId<HTMLInputElement>('search');
const sort = byId<HTMLSelectElement>('sort');
const list = byId<HTMLUListElement>('papers');
const add = byId<HTMLButtonElement>('add');
const view = byId<HTMLButtonElement>('view');
const hint = byId('hint');
const panel = byId('papers-panel');
const empty = byId('empty');
const count = byId('result-count');
const dialog = byId<HTMLDialogElement>('paper-dialog');
const form = byId<HTMLFormElement>('paper-form');
const urlField = form.elements.namedItem('url') as HTMLInputElement;
const titleField = form.elements.namedItem('title') as HTMLInputElement;
const authors = form.elements.namedItem('authors') as HTMLInputElement;
const tags = form.elements.namedItem('tags') as HTMLInputElement;
const note = form.elements.namedItem('note') as HTMLTextAreaElement;
const save = byId<HTMLButtonElement>('save');
const close = byId<HTMLButtonElement>('close-dialog');
const formStatus = byId('form-status');
const duplicate = byId('duplicate');
const fields = byId('paper-details');
const lookup = byId('lookup');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
let papers: Paper[] = [];
let state: 'loading' | 'ready' | 'error' = 'loading';
let activeTab: typeof tabNames[number] = 'unread';
let query = '';
let searchTimer: number | undefined;
let lookupTimer: number | undefined;
let lookupController: AbortController | null = null;
let resolvedUrl = '';
let duplicatePaper: Paper | undefined;
let editing: Paper | undefined;
let saving = false;
let returnFocus: HTMLElement | null = null;
let listView = localStorage.getItem('paper-view') === 'list';
const pending = new Set<number>();

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

function button(text: string, action: () => void, className = 'secondary') {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

async function request<T>(path = '', method = 'GET', data?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/papers' + path, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
    signal
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result === null) throw new Error(result?.error ?? 'Something went wrong. Try again.');
  return result;
}

function readLocation() {
  const params = new URLSearchParams(location.search);
  const tab = tabNames.find(name => name === params.get('tab'));
  activeTab = tab ?? 'unread';
  query = params.get('q') ?? '';
  search.value = query;
  sort.value = sorts.find(value => value === params.get('sort')) ?? 'added';
}

function saveLocation() {
  const url = new URL(location.href);
  for (const [key, value] of [['tab', activeTab === 'unread' ? '' : activeTab], ['q', query], ['sort', sort.value === 'added' ? '' : sort.value]]) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history.replaceState(null, '', url);
}

function selectTab(tab: typeof activeTab, focus = false) {
  activeTab = tab;
  saveLocation();
  render();
  if (!reduceMotion.matches) list.animate([{opacity: .65}, {opacity: 1}], {duration: 150, easing: 'ease'});
  if (focus) byId('tab-' + activeTab).focus();
}

function sourceLabel(raw: string) {
  const url = new URL(raw);
  const id = getArxivId(url);
  if (id) return 'arXiv · ' + id;
  const host = url.hostname.replace(/^www\./, '');
  const labels: Record<string, string> = {
    'dl.acm.org': 'ACM', 'aclanthology.org': 'ACL', 'ieeexplore.ieee.org': 'IEEE',
    'doi.org': 'DOI', 'openreview.net': 'OpenReview', 'usenix.org': 'USENIX',
    'proceedings.mlr.press': 'PMLR', 'link.springer.com': 'Springer'
  };
  return labels[host] ?? (/\.pdf$/i.test(url.pathname) ? 'PDF · ' + host : host);
}

function render() {
  const unread = papers.filter(paper => !paper.read_at).length;
  const counts = [papers.length, unread, papers.length - unread];
  tabs.forEach((tab, index) => {
    const selected = tab.dataset.tab === activeTab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tab.querySelector('span')!.textContent = String(counts[index]);
  });
  panel.setAttribute('aria-labelledby', 'tab-' + activeTab);
  byId('panel-heading').textContent = activeTab[0].toUpperCase() + activeTab.slice(1) + ' papers';
  add.disabled = state !== 'ready';
  list.setAttribute('aria-busy', String(state === 'loading'));
  byId('load-error').hidden = state !== 'error';
  empty.hidden = true;
  count.hidden = true;
  hint.hidden = state !== 'ready' || !papers.length || localStorage.getItem('paper-hint-dismissed') === '1';
  list.classList.toggle('list-view', listView);
  view.textContent = listView ? 'Grid view' : 'List view';
  if (state === 'loading') {
    list.replaceChildren(...Array.from({ length: 6 }, () => {
      const card = element('li', '', 'skeleton');
      card.setAttribute('aria-hidden', 'true');
      return card;
    }));
    return;
  }

  const term = query.trim().toLocaleLowerCase();
  const visible = state === 'ready' ? papers.filter(paper =>
    (activeTab === 'all' || (activeTab === 'read') === Boolean(paper.read_at)) &&
    (!term || [paper.title, paper.authors, paper.tags, sourceLabel(paper.url), new URL(paper.url).hostname].join(' ').toLocaleLowerCase().includes(term))
  ) : [];
  visible.sort((a, b) => {
    if (activeTab === 'unread' && Boolean(a.pinned) !== Boolean(b.pinned)) return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (sort.value === 'title') return collator.compare(a.title, b.title);
    if (sort.value === 'read') return (b.read_at ?? '').localeCompare(a.read_at ?? '') || b.created_at.localeCompare(a.created_at);
    return b.created_at.localeCompare(a.created_at) || b.id - a.id;
  });
  list.replaceChildren(...visible.map(paperCard));
  if (state !== 'ready') return;
  if (term) {
    count.hidden = false;
    count.textContent = visible.length + (visible.length === 1 ? ' paper' : ' papers');
  }
  if (visible.length) return;

  empty.hidden = false;
  const heading = element('h2', 'Nothing here yet.', 'empty-title');
  if (term) {
    heading.textContent = 'No results.';
    empty.replaceChildren(heading, element('p', 'No papers match “' + query.trim() + '”.'),
      button('Clear search', () => {
        search.value = '';
        updateSearch();
        search.focus();
      }));
    return;
  }
  const description = !papers.length ? 'Add your first paper by link, arXiv ID or DOI.' :
    activeTab === 'read' ? 'Papers you mark as read will appear here.' : 'You’ve read all the papers in your library.';
  const inline = element('form', '', 'empty-add');
  const input = element('input');
  input.placeholder = 'Paste a link, arXiv ID or DOI';
  input.setAttribute('aria-label', input.placeholder);
  input.required = true;
  input.maxLength = 2048;
  const submit = element('button', 'Add paper', 'primary');
  inline.append(input, submit);
  inline.addEventListener('submit', event => {
    event.preventDefault();
    openEditor(undefined, input.value);
  });
  const example = button('2401.12345', () => {
    input.value = '2401.12345';
    input.focus();
  }, 'example-id');
  example.setAttribute('aria-label', 'Fill example arXiv ID 2401.12345');
  empty.replaceChildren(heading, element('p', description), inline, example);
}

function relativeDate(paper: Paper) {
  const timestamp = paper.read_at ?? paper.created_at;
  const date = new Date(timestamp);
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  const text = days ? relative.format(-days, 'day') : 'today';
  const time = element('time', (paper.read_at ? 'Read ' : 'Added ') + text, 'muted');
  time.dateTime = timestamp;
  time.title = date.toLocaleString();
  return time;
}

function paperCard(paper: Paper) {
  const card = element('li', '', 'paper-card');
  card.dataset.id = String(paper.id);
  const link = element('a', '', 'paper-page');
  const pdf = pdfSource(paper.url);
  link.href = pdf ? '/reader.html?id=' + paper.id : paper.url;
  if (!pdf) link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = paper.title;
  link.setAttribute('aria-label', paper.title + (pdf ? ' (read PDF)' : ' (opens in a new tab)'));
  card.classList.toggle('is-unread', !paper.read_at);
  link.append(element('h3', paper.title, 'paper-title'));
  const url = new URL(paper.url);
  const arxiv = getArxivId(url);
  const key = paperKey(url);
  const venue = arxiv ? 'arXiv' : sourceLabel(paper.url);
  const meta = element('div', '', 'paper-source-row');
  meta.append(element('span', [paper.authors, venue, arxiv && /^\d{4}\./.test(arxiv) ? '20' + arxiv.slice(0, 2) : ''].filter(Boolean).join(' · '), 'paper-source'));
  const identifier = arxiv ?? (key.startsWith('doi:') ? url.pathname.slice(1) : null);
  if (identifier) meta.append(element('span', identifier, 'paper-id'));
  if (pdf) meta.append(element('span', 'PDF', 'pdf-badge'));
  link.append(meta);
  if (paper.note) link.append(element('span', paper.note, 'paper-note'));
  if (paper.tags) {
    const chips = element('span', '', 'tags');
    renderTags(chips, paper.tags);
    link.append(chips);
  }

  const overflow = element('details', '', 'menu card-menu');
  const trigger = element('summary', '⋯', 'icon-button');
  trigger.setAttribute('aria-label', 'Actions for ' + paper.title);
  trigger.title = 'Paper actions';
  const actions = element('div', '', 'menu-items');
  const menuAction = (label: string, action: () => void) => button(label, () => {
    overflow.open = false;
    trigger.focus();
    action();
  }, '');
  actions.append(menuAction('Edit title', () => openEditor(paper)),
    menuAction('Copy link', () => {
      void navigator.clipboard.writeText(paper.url).then(() => showToast('Link copied'), () => showToast('Couldn’t copy link'));
    }),
    menuAction(paper.pinned ? 'Unpin' : 'Pin', () => void changePaper(paper, { pinned: !paper.pinned }, '')),
    menuAction('Delete', () => void deletePaper(paper)));
  actions.querySelector('button:last-child')?.classList.add('danger-action');
  overflow.append(trigger, actions);
  const footer = element('div', '', 'card-footer');
  const toggle = button(paper.read_at ? '↶' : '✓',
    () => void changePaper(paper, { read: !paper.read_at }, paper.read_at ? 'Moved to unread' : 'Marked as read'), 'icon-button read-action');
  const label = paper.read_at ? 'Move to unread' : 'Mark as read';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  toggle.disabled = pending.has(paper.id);
  const open = element('a', '↗', 'icon-button');
  open.href = link.href;
  open.target = link.target;
  open.rel = link.rel;
  open.setAttribute('aria-label', pdf ? 'Open PDF' : 'Open paper');
  open.title = pdf ? 'Open PDF' : 'Open paper';
  const status = element('div', '', 'paper-status');
  status.append(relativeDate(paper));
  if (paper.pinned) status.append(element('span', 'Pinned', 'pin-label'));
  footer.append(status, toggle, open, overflow);
  card.append(link, footer);
  return card;
}

function replacePaper(paper: Paper) {
  papers = [...papers.filter(item => item.id !== paper.id), paper];
}

async function mutate(paper: Paper, operation: () => Promise<void>, remove: boolean) {
  if (pending.has(paper.id)) return;
  pending.add(paper.id);
  const card = list.querySelector<HTMLElement>('[data-id="' + paper.id + '"]');
  const action = card?.querySelector<HTMLButtonElement>('.read-action');
  const neighbors = [card?.nextElementSibling, card?.previousElementSibling, card]
    .map(node => (node as HTMLElement | undefined)?.dataset.id).filter(Boolean);
  const hadFocus = card?.contains(document.activeElement) || false;
  const activeAtStart = document.activeElement;
  if (action) action.disabled = true;
  try {
    await operation();
    if (card?.isConnected && !reduceMotion.matches) {
      const updated = papers.find(item => item.id === paper.id);
      if (updated) card.classList.toggle('is-unread', !updated.read_at);
      if (remove) await card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: 'forwards' }).finished.catch(() => {});
      else if (updated?.read_at !== paper.read_at) await new Promise(resolve => setTimeout(resolve, 150));
    }
  } catch (error) {
    showToast((error as Error).message);
  } finally {
    pending.delete(paper.id);
    const restoreFocus = hadFocus && (document.activeElement === activeAtStart || document.activeElement === document.body);
    const focusedCard = document.activeElement?.closest<HTMLElement>('.paper-card');
    render();
    if (restoreFocus || focusedCard) {
      const candidates = restoreFocus ? neighbors : [focusedCard?.dataset.id];
      const next = candidates.map(id => list.querySelector<HTMLButtonElement>('[data-id="' + id + '"] .read-action')).find(node => node && !node.disabled);
      (next ?? list.querySelector<HTMLButtonElement>('.read-action:not(:disabled)') ?? byId('tab-' + activeTab)).focus();
    }
  }
}

async function changePaper(paper: Paper, data: { read?: boolean; pinned?: boolean }, message: string) {
  let updated: Paper | undefined;
  await mutate(paper, async () => {
    updated = await request<Paper>('/' + paper.id, 'PATCH', data);
    replacePaper(updated);
  }, data.read !== undefined && activeTab !== 'all');
  if (message && updated && Boolean(updated.read_at) === data.read) {
    const expectedReadAt = updated.read_at;
    showToast(message, async () => {
      replacePaper(await request<Paper>('/' + paper.id, 'PATCH', { restoreReadAt: paper.read_at, expectedReadAt }));
      render();
      showToast('Reading status restored');
    });
  }
}

async function deletePaper(paper: Paper) {
  let token: string | undefined;
  await mutate(paper, async () => {
    ({ token } = await request<{ token: string }>('/' + paper.id, 'DELETE'));
    papers = papers.filter(item => item.id !== paper.id);
  }, true);
  if (token) showToast('Paper deleted', async () => {
    replacePaper(await request<Paper>('/' + paper.id, 'PATCH', { restore: token }));
    render();
    showToast('Paper restored');
  });
}

async function load() {
  state = 'loading';
  render();
  try {
    papers = await request<Paper[]>();
    state = 'ready';
  } catch {
    state = 'error';
  }
  render();
}

function updateSearch() {
  clearTimeout(searchTimer);
  query = search.value;
  saveLocation();
  render();
}

function renderTags(container: HTMLElement, value: string) {
  container.replaceChildren(...value.split(',').map(tag => tag.trim()).filter(Boolean).map(tag => element('span', tag, 'tag')));
}

function abortLookup() {
  clearTimeout(lookupTimer);
  lookupController?.abort();
  lookupController = null;
  lookup.hidden = true;
}

function revealFields() {
  fields.hidden = false;
  titleField.disabled = false;
}

function updateSave() {
  save.disabled = saving || Boolean(lookupController) || Boolean(duplicatePaper);
}

function resetLookup() {
  abortLookup();
  resolvedUrl = '';
  duplicatePaper = undefined;
  duplicate.hidden = true;
  fields.hidden = true;
  titleField.disabled = true;
  titleField.value = '';
  authors.value = '';
  formStatus.textContent = '';
  updateSave();
}

async function findTitle(url: URL) {
  if (!dialog.open || resolvedUrl === url.href) return;
  abortLookup();
  resolvedUrl = url.href;
  duplicatePaper = papers.find(paper => {
    const saved = normalizePaperUrl(paper.url);
    return saved && paperKey(saved) === paperKey(url);
  });
  if (duplicatePaper) {
    const link = element('a', duplicatePaper.title);
    link.href = duplicatePaper.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    duplicate.replaceChildren('Already in your library (' + (duplicatePaper.read_at ? 'Read' : 'Unread') + '). ', link);
    duplicate.hidden = false;
    updateSave();
    return;
  }

  const controller = new AbortController();
  lookupController = controller;
  lookup.hidden = false;
  formStatus.textContent = '';
  updateSave();
  try {
    const result = await request<{ title: string | null; authors?: string }>('/title', 'POST', { url: url.href }, controller.signal);
    if (controller.signal.aborted) return;
    titleField.value = result.title ?? '';
    authors.value = result.authors ?? '';
    if (!result.title) formStatus.textContent = 'Enter a title to save this paper.';
  } catch {
    if (!controller.signal.aborted) formStatus.textContent = 'Title lookup failed. You can enter a title.';
  } finally {
    if (lookupController === controller) {
      lookupController = null;
      lookup.hidden = true;
      revealFields();
      updateSave();
    }
  }
}

function scheduleLookup() {
  resetLookup();
  const url = normalizePaperUrl(urlField.value);
  const chip = byId('link-type');
  chip.hidden = !url;
  chip.textContent = url ? getArxivId(url) ? 'arXiv' : paperKey(url).startsWith('doi:') ? 'DOI' : 'Link' : '';
  if (url) lookupTimer = window.setTimeout(() => void findTitle(url), 280);
}

function openEditor(paper?: Paper, input = '') {
  if (state !== 'ready' || dialog.open) return;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  editing = paper;
  form.reset();
  resetLookup();
  byId('link-type').hidden = true;
  byId<HTMLDetailsElement>('optional-fields').open = Boolean(paper && (paper.authors || paper.tags || paper.note));
  byId('dialog-title').textContent = paper ? 'Edit paper' : 'Add paper';
  byId('link-field').hidden = Boolean(paper);
  urlField.disabled = Boolean(paper);
  urlField.value = paper?.url ?? input;
  if (paper) {
    titleField.value = paper.title;
    authors.value = paper.authors ?? '';
    tags.value = paper.tags ?? '';
    note.value = paper.note ?? '';
    revealFields();
  }
  renderTags(byId('tag-preview'), tags.value);
  dialog.showModal();
  (paper ? titleField : urlField).focus();
  if (!paper && input) scheduleLookup();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (saving || lookupController || duplicatePaper) return;
  const url = normalizePaperUrl(urlField.value);
  if (!editing) {
    if (!url) {
      formStatus.textContent = 'Enter a paper link, arXiv ID or DOI.';
      urlField.focus();
      return;
    }
    await findTitle(url);
    if (!dialog.open || normalizePaperUrl(urlField.value)?.href !== url.href || duplicatePaper || lookupController || saving) return;
  }
  if (!form.reportValidity()) return;
  const details = { title: titleField.value, authors: authors.value, tags: tags.value, note: note.value };
  saving = true;
  close.disabled = true;
  updateSave();
  try {
    const paper = editing
      ? await request<Paper>('/' + editing.id, 'PATCH', details)
      : await request<Paper>('', 'POST', { ...details, url: url!.href });
    replacePaper(paper);
    if (!editing && activeTab === 'read') activeTab = 'unread';
    saveLocation();
    render();
    dialog.close();
    showToast('Paper saved');
  } catch (error) {
    formStatus.textContent = (error as Error).message;
  } finally {
    saving = false;
    close.disabled = false;
    updateSave();
  }
});

urlField.addEventListener('input', scheduleLookup);
urlField.addEventListener('blur', () => {
  const url = normalizePaperUrl(urlField.value);
  if (dialog.open && url && !editing) void findTitle(url);
});
tags.addEventListener('input', () => renderTags(byId('tag-preview'), tags.value));
byId('cancel-lookup').addEventListener('click', () => {
  abortLookup();
  revealFields();
  updateSave();
  titleField.focus();
});
close.addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
dialog.addEventListener('close', () => {
  abortLookup();
  (returnFocus?.isConnected ? returnFocus : editing && list.querySelector<HTMLElement>('[data-id="' + editing.id + '"] summary') || add).focus();
});

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tabNames[index]));
  tab.addEventListener('keydown', event => {
    const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (!offset && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + offset + tabs.length) % tabs.length;
    selectTab(tabNames[next], true);
  });
});
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(updateSearch, 180);
});
sort.addEventListener('change', () => { saveLocation(); render(); });
view.addEventListener('click', () => {
  listView = !listView;
  localStorage.setItem('paper-view', listView ? 'list' : 'grid');
  render();
});
add.addEventListener('click', () => openEditor());
byId('retry').addEventListener('click', () => void load());
byId('dismiss-hint').addEventListener('click', () => {
  localStorage.setItem('paper-hint-dismissed', '1');
  hint.hidden = true;
  byId('tab-' + activeTab).focus();
});
window.addEventListener('popstate', () => { clearTimeout(searchTimer); readLocation(); render(); });

function updateTheme() {
  const dark = applyTheme();
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
  byId('theme').setAttribute('aria-label', label);
  byId('theme').title = label;
}
byId('theme').addEventListener('click', () => {
  toggleTheme();
  updateTheme();
});
watchTheme(updateTheme);

document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('.menu[open]')) {
    if (!menu.contains(event.target as Node)) menu.open = false;
  }
});
byId('export-menu').addEventListener('click', event => {
  const type = (event.target as HTMLElement).dataset.export;
  if (type === 'json' || type === 'csv' || type === 'bib') {
    exportPapers(papers, type);
    byId<HTMLDetailsElement>('export-menu').open = false;
    byId('export-menu').querySelector('summary')?.focus();
  }
});

function isTyping(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    const menu = (event.target as HTMLElement).closest<HTMLDetailsElement>('.menu[open]');
    if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); }
  }
  if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]') || isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.toLowerCase() === 'n') openEditor();
  else if (event.key === '/') search.focus();
  else if (/^[123]$/.test(event.key)) selectTab(tabNames[Number(event.key) - 1], true);
  else if (event.key === '?') byId<HTMLDialogElement>('shortcuts').showModal();
  else return;
  event.preventDefault();
});

function receiveLink(event: ClipboardEvent | DragEvent, input: string) {
  if (state !== 'ready' || document.querySelector('dialog[open]') || isTyping(event.target) || !normalizePaperUrl(input)) return;
  event.preventDefault();
  openEditor(undefined, input.trim());
}
document.addEventListener('paste', event => receiveLink(event, event.clipboardData?.getData('text/plain') ?? ''));
document.addEventListener('dragover', event => {
  if (!isTyping(event.target) && event.dataTransfer?.types.some(type => type === 'text/uri-list' || type === 'text/plain')) event.preventDefault();
});
document.addEventListener('drop', event => {
  const data = event.dataTransfer;
  const uri = data?.getData('text/uri-list').split(/\r?\n/).find(line => line && !line.startsWith('#'));
  receiveLink(event, uri ?? data?.getData('text/plain') ?? '');
});

readLocation();
void load();
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
