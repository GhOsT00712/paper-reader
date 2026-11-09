import './style.css';
import 'pdfjs-dist/web/pdf_viewer.css';
import './reader.css';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PageViewport } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { canProxyPdf, PDF_LIMIT, pdfSource, pdfVersion } from './pdf-source';
import { ReaderSync } from './reader-sync';
import type { Highlight, Position } from './pdf-state';

GlobalWorkerOptions.workerSrc = workerUrl;

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const scroller = byId('viewport');
const pageSlot = byId('page');
const notice = byId('notice');
const original = byId<HTMLAnchorElement>('original');
const back = byId<HTMLAnchorElement>('back');
const pageInput = byId<HTMLInputElement>('page-number');
const previous = byId<HTMLButtonElement>('previous');
const next = byId<HTMLButtonElement>('next');
const mark = byId<HTMLButtonElement>('highlight');
const highlightsPanel = byId('highlights');
const highlightsList = byId('highlight-list');
const panelToggle = byId<HTMLButtonElement>('toggle-highlights');
const media = matchMedia('(prefers-color-scheme: dark)');
let pdf: PDFDocumentProxy;
let sync: ReaderSync;
let highlights: Highlight[] = [];
let page = 1;
let zoom = 1;
let sheet: HTMLElement | undefined;
let viewport: PageViewport | undefined;
let drawing = 0;
let renderedPage = 0;
let selection: Highlight | undefined;
let lastScroll = 0;
let scrollTimer: number | undefined;
let resizeTimer: number | undefined;
let leaving = false;

function applyTheme() {
  document.documentElement.dataset.theme = localStorage.getItem('paper-theme') ?? (media.matches ? 'dark' : 'light');
}
applyTheme();
media.addEventListener('change', applyTheme);

async function readPdf(response: Response) {
  if (!response.ok || !response.body || !/^(application\/(pdf|octet-stream))\b/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new Error('The source did not return a PDF.');
  }
  if (Number(response.headers.get('content-length')) > PDF_LIMIT) {
    await response.body.cancel();
    throw new Error('This PDF is larger than 64 MB.');
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > PDF_LIMIT) throw new Error('This PDF is larger than 64 MB.');
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.byteLength;
  }
  return data;
}

async function loadPdf(source: URL, endpoint: string) {
  const proxy = canProxyPdf(source);
  const response = await fetch(proxy ? endpoint + '/pdf' : source.href, {
    cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(50000)
  });
  if (response.status === 413) throw new Error('This PDF is larger than 64 MB.');
  const final = URL.parse(proxy ? response.headers.get('X-Pdf-Source') ?? source.href : response.url) ?? source;
  const version = pdfVersion(source, final, response.headers.get('ETag'));
  return { version, data: await readPdf(response) };
}

function offsetWithinPage() {
  return sheet ? Math.min(1, Math.max(0, scroller.scrollTop / sheet.offsetHeight)) : 0;
}

function recordScroll() {
  clearTimeout(scrollTimer);
  if (renderedPage !== page || Math.abs(scroller.scrollTop - lastScroll) < 1) return;
  lastScroll = scroller.scrollTop;
  sync.change({ position: { page, offset: offsetWithinPage() } });
}

function renderMarks() {
  const layer = sheet?.querySelector('.pdf-marks');
  if (!layer || !viewport) return;
  const current = viewport;
  const marks = highlights.filter(item => item.page === renderedPage).flatMap(item => item.rects.map(rect => {
    const [x1, y1] = current.convertToViewportPoint(rect[0], rect[1]);
    const [x2, y2] = current.convertToViewportPoint(rect[2], rect[3]);
    const node = document.createElement('div');
    node.className = 'pdf-mark';
    node.style.left = Math.min(x1, x2) + 'px';
    node.style.top = Math.min(y1, y2) + 'px';
    node.style.width = Math.abs(x2 - x1) + 'px';
    node.style.height = Math.abs(y2 - y1) + 'px';
    return node;
  }));
  layer.replaceChildren(...marks);
}

function renderHighlights() {
  highlightsList.replaceChildren();
  if (!highlights.length) {
    const empty = document.createElement('li');
    empty.textContent = 'Select PDF text to add a highlight.';
    highlightsList.append(empty);
  }
  for (const highlight of [...highlights].sort((a, b) => a.page - b.page)) {
    const row = document.createElement('li');
    const jump = document.createElement('button');
    jump.className = 'jump';
    jump.textContent = 'Page ' + highlight.page + ' · ' + highlight.text;
    jump.addEventListener('click', () => {
      if (highlight.page <= pdf.numPages) void renderPage({ page: highlight.page, offset: 0 }, true, highlight);
    });
    const remove = document.createElement('button');
    remove.className = 'secondary remove';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', 'Delete highlight: ' + highlight.text);
    remove.addEventListener('click', () => {
      highlights = highlights.filter(item => item.id !== highlight.id);
      sync.change({ delete: highlight.id });
      renderHighlights();
      (highlightsList.querySelector('button') ?? panelToggle).focus();
    });
    row.append(jump, remove);
    highlightsList.append(row);
  }
  renderMarks();
}

async function renderPage(position: Position, save = false, jump?: Highlight) {
  const generation = ++drawing;
  renderedPage = 0;
  page = Math.min(pdf.numPages, Math.max(1, position.page));
  pageInput.value = String(page);
  previous.disabled = page <= 1;
  next.disabled = page >= pdf.numPages;
  selection = undefined;
  mark.disabled = true;
  try {
    const pdfPage = await pdf.getPage(page);
    const base = pdfPage.getViewport({ scale: 1 });
    const scale = Math.max(.1, (scroller.clientWidth - 18) / base.width) * zoom;
    const view = pdfPage.getViewport({ scale });
    const node = document.createElement('div');
    node.className = 'pdf-sheet';
    node.style.width = view.width + 'px';
    node.style.height = view.height + 'px';
    node.style.setProperty('--scale-round-x', '1px');
    node.style.setProperty('--scale-round-y', '1px');
    node.style.setProperty('--total-scale-factor', String(scale * pdfPage.userUnit));
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    const pixelRatio = Math.min(devicePixelRatio, 2, Math.sqrt(12_000_000 / (view.width * view.height)));
    canvas.width = Math.ceil(view.width * pixelRatio);
    canvas.height = Math.ceil(view.height * pixelRatio);
    const overlay = document.createElement('div');
    overlay.className = 'pdf-marks';
    overlay.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div');
    text.className = 'textLayer';
    node.append(canvas, overlay, text);
    const textLayer = new TextLayer({ textContentSource: pdfPage.streamTextContent(), viewport: view, container: text });
    await Promise.all([
      pdfPage.render({ canvas, viewport: view, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] }).promise,
      textLayer.render()
    ]);
    if (generation !== drawing) return;
    pageSlot.replaceChildren(node);
    sheet = node;
    viewport = view;
    renderedPage = page;
    renderMarks();
    const target = jump?.rects[0];
    const top = target ? Math.min(view.convertToViewportPoint(target[0], target[1])[1],
      view.convertToViewportPoint(target[2], target[3])[1]) - 24 : position.offset * view.height;
    scroller.scrollTop = Math.max(0, top);
    lastScroll = scroller.scrollTop;
    notice.textContent = text.childElementCount ? '' : 'This page has no selectable text.';
    if (save) sync.change({ position: { page, offset: offsetWithinPage() } });
  } catch {
    if (generation === drawing) notice.textContent = 'Couldn’t render this page. Try another page or open the original.';
  }
}

function goTo(value: number) {
  if (Number.isInteger(value) && value >= 1 && value <= pdf.numPages) void renderPage({ page: value, offset: 0 }, true);
  else pageInput.value = String(page);
}

function resize() {
  if (!pdf) return;
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const offset = offsetWithinPage();
    recordScroll();
    void renderPage({ page, offset });
  }, 120);
}

function trackSelection() {
  const selected = window.getSelection();
  const layer = sheet?.querySelector('.textLayer');
  if (!selected?.rangeCount || selected.isCollapsed || !viewport || !sheet || renderedPage !== page ||
      !layer?.contains(selected.anchorNode) || !layer.contains(selected.focusNode)) {
    selection = undefined;
    mark.disabled = true;
    return;
  }
  const text = selected.toString().trim().slice(0, 4000);
  const bounds = sheet.getBoundingClientRect();
  const rects: Highlight['rects'] = [];
  for (const rect of selected.getRangeAt(0).getClientRects()) {
    const left = Math.max(rect.left, bounds.left);
    const right = Math.min(rect.right, bounds.right);
    const top = Math.max(rect.top, bounds.top);
    const bottom = Math.min(rect.bottom, bounds.bottom);
    if (right - left < 1 || bottom - top < 1) continue;
    const [x1, y1] = viewport.convertToPdfPoint(left - bounds.left, top - bounds.top);
    const [x2, y2] = viewport.convertToPdfPoint(right - bounds.left, bottom - bounds.top);
    const coordinates = [x1, y1, x2, y2].map(value => Math.round(value * 100) / 100) as Highlight['rects'][number];
    if (!rects.some(existing => existing.every((value, i) => value === coordinates[i]))) rects.push(coordinates);
  }
  selection = text && rects.length && rects.length <= 100 ? { id: crypto.randomUUID(), page, text, rects } : undefined;
  mark.disabled = !selection;
}

async function start() {
  const id = Number(new URLSearchParams(location.search).get('id'));
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Open a PDF from your library.');
  const endpoint = '/api/papers/' + id;
  const metadata = await fetch(endpoint);
  if (!metadata.ok) throw new Error('This paper is unavailable.');
  const paper: { title: string; url: string } = await metadata.json();
  document.title = paper.title + ' · Paper Reader';
  byId('document-title').textContent = paper.title;
  original.href = paper.url;
  original.hidden = false;
  const source = pdfSource(paper.url);
  if (!source) throw new Error('This link is not a supported PDF.');
  const { data, version } = await loadPdf(source, endpoint);
  const resources = import.meta.env.DEV ? '/node_modules/pdfjs-dist/' : '/pdf-resources/';
  pdf = await getDocument({
    data, wasmUrl: resources + 'wasm/', cMapUrl: resources + 'cmaps/',
    iccUrl: resources + 'iccs/', standardFontDataUrl: resources + 'standard_fonts/'
  }).promise;
  sync = new ReaderSync(id, version, byId('sync'));
  const saved = await sync.load();
  highlights = saved.highlights;
  pageInput.max = String(pdf.numPages);
  byId('page-count').textContent = '/ ' + pdf.numPages;
  byId('toolbar').hidden = false;
  await renderPage(saved.position ?? { page: 1, offset: 0 });
  renderHighlights();

  window.setInterval(() => { recordScroll(); void sync.flush(); }, 60000);
  window.addEventListener('pagehide', () => { recordScroll(); void sync.flush(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { recordScroll(); void sync.flush(true); }
  });
  if (byId('sync').textContent === 'Pending sync') void sync.flush();
}

scroller.addEventListener('scroll', () => {
  if (!sync || renderedPage !== page) return;
  clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(recordScroll, 200);
});
previous.addEventListener('click', () => goTo(page - 1));
next.addEventListener('click', () => goTo(page + 1));
pageInput.addEventListener('change', () => goTo(pageInput.valueAsNumber));
byId('zoom-in').addEventListener('click', () => { zoom = Math.min(3, zoom + .25); resize(); });
byId('zoom-out').addEventListener('click', () => { zoom = Math.max(.75, zoom - .25); resize(); });
window.addEventListener('resize', resize);
panelToggle.addEventListener('click', () => {
  highlightsPanel.hidden = !highlightsPanel.hidden;
  panelToggle.setAttribute('aria-expanded', String(!highlightsPanel.hidden));
  resize();
});
document.addEventListener('selectionchange', trackSelection);
mark.addEventListener('pointerdown', event => event.preventDefault());
mark.addEventListener('click', () => {
  if (!selection) return;
  highlights.push(selection);
  sync.change({ add: selection });
  window.getSelection()?.removeAllRanges();
  selection = undefined;
  mark.disabled = true;
  renderHighlights();
});
back.addEventListener('click', async event => {
  if (!sync || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (leaving) return;
  leaving = true;
  recordScroll();
  await sync.flush();
  if (byId('sync').textContent === 'Pending sync') await sync.flush();
  location.assign(back.href);
});

void start().catch(error => {
  notice.textContent = (error as Error).message + (original.hidden ? '' : ' You can try Open original.');
});
