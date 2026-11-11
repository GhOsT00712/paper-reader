import './style.css';
import 'pdfjs-dist/web/pdf_viewer.css';
import './reader.css';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PageViewport } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { canProxyPdf, PDF_LIMIT, pdfSource, pdfVersion } from './pdf-source';
import { ReaderSync } from './reader-sync';
import type { Highlight, Position } from './pdf-state';
import { renderPdfRaster } from './reader-raster';
import { reflowText, textSelection, highlightedText, type TextPage } from './reader-text';

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
const mobile = matchMedia('(max-width: 700px)');

interface PageSlot {
  number: number;
  node: HTMLElement;
  ratio: number;
  viewport?: PageViewport;
  raster?: ReturnType<typeof renderPdfRaster>;
  textLayer?: TextLayer;
  ready?: boolean;
  reflow?: TextPage;
  textHeight?: number;
  mounting?: symbol;
}
const pages: PageSlot[] = [];
const mounted = new Set<PageSlot>();
const textToggle = byId<HTMLButtonElement>('text-view');
const readerHeader = document.querySelector<HTMLElement>('.reader-header')!;
const readerFooter = document.querySelector<HTMLElement>('.reader-footer')!;
const more = byId<HTMLDetailsElement>('reader-more');
const idleDelay = 2400;
let controlsTimer: number | undefined;
let textView = mobile.matches && localStorage.getItem('paper-text-view') === '1';
let layoutTextView = false;
let pendingTextJump: Highlight | undefined;
let pageWidth = 0;
let frame = 0;
let pdf: PDFDocumentProxy;
let sync: ReaderSync;
let highlights: Highlight[] = [];
let page = 1;
let zoom = 1;
let selection: Highlight[] = [];
let lastScroll = 0;
let scrollTimer: number | undefined;
let resizeTimer: number | undefined;
let leaving = false;

function applyTheme() {
  document.documentElement.dataset.theme = localStorage.getItem('paper-theme') ?? (media.matches ? 'dark' : 'light');
}
applyTheme();
media.addEventListener('change', applyTheme);

function revealControls() {
  document.body.removeAttribute('data-controls-hidden');
  clearTimeout(controlsTimer);
  if (!mobile.matches || !document.body.hasAttribute('data-controls-ready')) return;
  controlsTimer = window.setTimeout(() => {
    if (selection.length || !highlightsPanel.hidden || more.open || document.activeElement === pageInput ||
        readerHeader.querySelector(':focus-visible') || readerFooter.querySelector(':focus-visible')) return;
    document.body.setAttribute('data-controls-hidden', '');
  }, idleDelay);
}

function measureControls() {
  document.body.style.setProperty('--reader-header-height', readerHeader.offsetHeight + 'px');
  document.body.style.setProperty('--reader-footer-height', readerFooter.offsetHeight + 'px');
}

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

function slotAt(y: number) {
  let first = 0;
  let last = pages.length - 1;
  while (first < last) {
    const mid = Math.ceil((first + last) / 2);
    if (pages[mid].node.offsetTop <= y + 1) first = mid;
    else last = mid - 1;
  }
  return pages[first];
}

function readingPosition(): Position {
  const y = scroller.scrollTop;
  const slot = slotAt(y);
  return {
    page: slot.number,
    offset: Math.max(0, Math.min(1, (y - slot.node.offsetTop) / slot.node.offsetHeight))
  };
}

function recordScroll() {
  clearTimeout(scrollTimer);
  if (!pages.length || Math.abs(scroller.scrollTop - lastScroll) < 1) return;
  lastScroll = scroller.scrollTop;
  sync.change({ position: readingPosition() });
}

function updateNavigation() {
  page = readingPosition().page;
  if (document.activeElement !== pageInput) pageInput.value = String(page);
  previous.disabled = page === 1;
  next.disabled = page === pages.length;
}

function restorePosition(position: Position, save = false) {
  const slot = pages[Math.min(pages.length, Math.max(1, position.page)) - 1];
  scroller.scrollTop = slot.number === 1 && position.offset === 0 ? 0 :
    slot.node.offsetTop + position.offset * slot.node.offsetHeight;
  lastScroll = scroller.scrollTop;
  updateNavigation();
  schedulePages();
  if (save) sync.change({ position: readingPosition() });
}

function renderMarks(slot: PageSlot) {
  const layer = slot.node.querySelector('.pdf-marks');
  const view = slot.viewport;
  if (!layer || !view) return;
  const marks = highlights.filter(item => item.page === slot.number).flatMap(item => item.rects.map(rect => {
    const [x1, y1] = view.convertToViewportPoint(rect[0], rect[1]);
    const [x2, y2] = view.convertToViewportPoint(rect[2], rect[3]);
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
      if (mobile.matches) setHighlightsOpen(false);
      void jumpToHighlight(highlight);
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
  mounted.forEach(renderMarks);
  renderTextMarks();
}

function setPageSize(slot: PageSlot) {
  slot.node.style.height = (textView && slot.textHeight || pageWidth * slot.ratio) + 'px';
}

function setEndPadding() {
  const last = pages.at(-1)!;
  const clearance = mobile.matches ? readerFooter.offsetHeight + 4 : 4;
  pageSlot.style.paddingBottom = Math.max(clearance, scroller.clientHeight - last.node.offsetHeight) + 'px';
}

function unmount(slot: PageSlot) {
  mounted.delete(slot);
  slot.raster?.destroy();
  slot.textLayer?.cancel();
  slot.raster = undefined;
  slot.textLayer = undefined;
  slot.viewport = undefined;
  slot.ready = false;
  slot.mounting = undefined;
  slot.reflow = undefined;
  slot.node.classList.remove('reflow-page');
  slot.node.replaceChildren();
}

async function mount(slot: PageSlot) {
  mounted.add(slot);
  const width = pageWidth;
  const mounting = Symbol();
  slot.mounting = mounting;
  try {
    const pdfPage = await pdf.getPage(slot.number);
    if (slot.mounting !== mounting) return;
    const base = pdfPage.getViewport({ scale: 1 });
    const view = pdfPage.getViewport({ scale: width / base.width });
    const ratio = view.height / view.width;
    if (Math.abs(ratio - slot.ratio) > .0001) {
      recordScroll();
      const anchor = readingPosition();
      slot.ratio = ratio;
      setPageSize(slot);
      setEndPadding();
      restorePosition(anchor);
    }

    slot.viewport = view;
    slot.node.style.setProperty('--total-scale-factor', String(view.scale * pdfPage.userUnit));
    if (textView) {
      const source = document.createElement('div');
      source.className = 'pdf-text-source';
      source.setAttribute('aria-hidden', 'true');
      const text = document.createElement('div');
      text.className = 'textLayer';
      source.append(text);
      slot.node.append(source);
      const layer = new TextLayer({ textContentSource: pdfPage.streamTextContent({ includeMarkedContent: true }), viewport: view, container: text });
      slot.textLayer = layer;
      const [structure] = await Promise.all([pdfPage.getStructTree().catch(() => null), layer.render()]);
      if (slot.mounting !== mounting) return;
      const reflow = reflowText(text, layer.textDivs, structure, slot.number === 1);
      if (reflow) {
        recordScroll();
        const anchor = readingPosition();
        slot.reflow = reflow;
        slot.node.classList.add('reflow-page');
        slot.node.append(reflow.content);
        slot.textHeight = reflow.content.offsetHeight;
        setPageSize(slot);
        setEndPadding();
        restorePosition(anchor);
        slot.ready = true;
        renderTextMarks();
        if (pendingTextJump?.page === slot.number) jumpToText(slot, pendingTextJump);
        return;
      }
      source.remove();
      slot.textHeight = pageWidth * slot.ratio;
      setPageSize(slot);
    }
    const overlay = document.createElement('div');
    overlay.className = 'pdf-marks';
    overlay.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div');
    text.className = 'textLayer';
    slot.node.append(overlay, text);
    const raster = renderPdfRaster(pdfPage, view, slot.node, scroller);
    slot.raster = raster;
    const textLayer = new TextLayer({ textContentSource: pdfPage.streamTextContent(), viewport: view, container: text });
    slot.textLayer = textLayer;
    await Promise.all([raster.ready, textLayer.render()]);
    if (slot.mounting !== mounting) return;
    raster.update();
    slot.ready = true;
    renderMarks(slot);
  } catch {
    if (slot.mounting === mounting) {
      unmount(slot);
      const message = document.createElement('p');
      message.className = 'pdf-error';
      message.textContent = 'Couldn’t render page ' + slot.number + '.';
      slot.node.append(message);
      mounted.add(slot);
    }
  }
}

function updatePages() {
  frame = 0;
  updateNavigation();
  const first = Math.max(1, page - 1);
  const lastVisible = slotAt(scroller.scrollTop + scroller.clientHeight).number;
  const last = Math.min(pages.length, Math.max(page + 1, lastVisible + 1), page + 6);
  const nativeSelection = window.getSelection();
  const selectedRange = nativeSelection?.rangeCount && !nativeSelection.isCollapsed ? nativeSelection.getRangeAt(0) : null;
  let removedText = false;
  for (const slot of mounted) {
    if ((slot.number < first || slot.number > last) && !selectedRange?.intersectsNode(slot.node)) {
      removedText ||= Boolean(slot.reflow);
      unmount(slot);
    }
  }
  if (removedText) renderTextMarks();
  for (let n = first; n <= last; n++) {
    const slot = pages[n - 1];
    if (!mounted.has(slot)) void mount(slot);
    else slot.raster?.update();
  }
}

function schedulePages() {
  if (!frame) frame = requestAnimationFrame(updatePages);
}

function layout(position: Position) {
  const width = Math.max(80, scroller.clientWidth - (mobile.matches ? 4 : 16)) * (textView ? 1 : zoom);
  if (width !== pageWidth || layoutTextView !== textView) {
    if (width !== pageWidth) pages.forEach(slot => { slot.textHeight = undefined; });
    layoutTextView = textView;
    pageWidth = width;
    document.body.dataset.view = textView ? 'text' : 'pdf';
    textToggle.setAttribute('aria-pressed', String(textView));
    pageSlot.style.setProperty('--pdf-width', width + 'px');
    for (const slot of mounted) unmount(slot);
    renderTextMarks();
    pages.forEach(setPageSize);
    setSelection([]);
  }
  setEndPadding();
  restorePosition(position);
}

function goTo(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > pages.length) {
    pageInput.value = String(page);
    return;
  }
  pendingTextJump = undefined;
  pageInput.blur();
  restorePosition({ page: value, offset: 0 }, true);
}

function renderTextMarks() {
  const ranges = [];
  for (const slot of mounted) {
    if (!slot.reflow || !slot.viewport) continue;
    const rects = highlights.filter(item => item.page === slot.number).flatMap(item => item.rects);
    ranges.push(...highlightedText(slot.reflow, rects, slot.viewport));
  }
  if (CSS.highlights) CSS.highlights.set('paper-reader-marks', new globalThis.Highlight(...ranges));
}

function jumpToText(slot: PageSlot, highlight: Highlight) {
  pendingTextJump = undefined;
  const range = highlightedText(slot.reflow!, highlight.rects, slot.viewport!)[0];
  const top = range ? range.getBoundingClientRect().top - slot.node.getBoundingClientRect().top : 0;
  restorePosition({ page: slot.number, offset: Math.max(0, top - 16) / slot.node.offsetHeight }, true);
  renderTextMarks();
}

async function jumpToHighlight(highlight: Highlight) {
  const slot = pages[highlight.page - 1];
  if (!slot) return;
  if (textView) {
    if (slot.reflow) {
      jumpToText(slot, highlight);
      return;
    }
    if (!slot.ready) {
      pendingTextJump = highlight;
      restorePosition({ page: slot.number, offset: 0 }, true);
      return;
    }
  }
  try {
    const pdfPage = await pdf.getPage(highlight.page);
    const base = pdfPage.getViewport({ scale: 1 });
    const [, y1, , y2] = highlight.rects[0];
    const top = Math.min(base.convertToViewportPoint(highlight.rects[0][0], y1)[1],
      base.convertToViewportPoint(highlight.rects[0][2], y2)[1]);
    restorePosition({ page: highlight.page, offset: Math.max(0, (top - 16) / base.height) }, true);
  } catch {
    goTo(highlight.page);
  }
}

function resize() {
  if (!pages.length) return;
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    recordScroll();
    const position = readingPosition();
    measureControls();
    layout(position);
  }, 90);
}

function setSelection(items: Highlight[]) {
  const hadSelection = selection.length > 0;
  selection = items;
  mark.disabled = !items.length;
  if (hadSelection || items.length) revealControls();
}

function trackSelection() {
  const nativeSelection = window.getSelection();
  if (!nativeSelection?.rangeCount || nativeSelection.isCollapsed) {
    setSelection([]);
    if (pages.length) schedulePages();
    return;
  }
  const range = nativeSelection.getRangeAt(0);
  const items: Highlight[] = [];
  for (const slot of mounted) {
    if (slot.reflow && slot.viewport) {
      if (!range.intersectsNode(slot.reflow.content)) continue;
      const { text, rects } = textSelection(slot.reflow, range, slot.viewport);
      if (text && rects.length && rects.length <= 100) items.push({ id: crypto.randomUUID(), page: slot.number, text, rects });
      continue;
    }
    const layer = slot.node.querySelector('.textLayer');
    if (!layer || !slot.viewport || !range.intersectsNode(layer)) continue;
    const withinPage = document.createRange();
    withinPage.selectNodeContents(layer);
    if (layer.contains(range.startContainer)) withinPage.setStart(range.startContainer, range.startOffset);
    if (layer.contains(range.endContainer)) withinPage.setEnd(range.endContainer, range.endOffset);
    const text = withinPage.toString().trim().slice(0, 4000);
    if (!text) continue;
    const bounds = slot.node.getBoundingClientRect();
    const rects: Highlight['rects'] = [];
    for (const rect of withinPage.getClientRects()) {
      const left = Math.max(rect.left, bounds.left);
      const right = Math.min(rect.right, bounds.right);
      const top = Math.max(rect.top, bounds.top);
      const bottom = Math.min(rect.bottom, bounds.bottom);
      if (right - left < 1 || bottom - top < 1) continue;
      const [x1, y1] = slot.viewport.convertToPdfPoint(left - bounds.left, top - bounds.top);
      const [x2, y2] = slot.viewport.convertToPdfPoint(right - bounds.left, bottom - bounds.top);
      const coordinates = [x1, y1, x2, y2].map(value => Math.round(value * 100) / 100) as Highlight['rects'][number];
      if (!rects.some(existing => existing.every((value, i) => value === coordinates[i]))) rects.push(coordinates);
    }
    if (rects.length && rects.length <= 100) items.push({ id: crypto.randomUUID(), page: slot.number, text, rects });
  }
  setSelection(items);
}

function setHighlightsOpen(open: boolean) {
  highlightsPanel.hidden = !open;
  panelToggle.setAttribute('aria-expanded', String(open));
  if (!open) panelToggle.focus();
  else byId('close-highlights').focus();
  revealControls();
  if (!mobile.matches) resize();
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
  const firstPage = await pdf.getPage(1);
  const dimensions = firstPage.getViewport({ scale: 1 });
  const estimatedRatio = dimensions.height / dimensions.width;
  const fragment = document.createDocumentFragment();
  for (let number = 1; number <= pdf.numPages; number++) {
    const node = document.createElement('div');
    node.className = 'pdf-sheet';
    pages.push({ number, node, ratio: estimatedRatio });
    fragment.append(node);
  }
  pageSlot.append(fragment);
  textToggle.hidden = !mobile.matches;
  byId('navigation').hidden = false;
  document.querySelector('.reader-options')!.append(original);
  byId('toolbar').hidden = false;
  notice.textContent = '';
  document.body.setAttribute('data-controls-ready', '');
  measureControls();
  revealControls();
  layout(saved.position ?? { page: 1, offset: 0 });
  renderHighlights();
  const observer = new ResizeObserver(resize);
  for (const node of [scroller, readerHeader, readerFooter]) observer.observe(node);

  window.setInterval(() => { recordScroll(); void sync.flush(); }, 60000);
  window.addEventListener('pagehide', () => { recordScroll(); void sync.flush(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { recordScroll(); void sync.flush(true); }
  });
  if (byId('sync').textContent === 'Pending sync') void sync.flush();
}

scroller.addEventListener('scroll', () => {
  if (!pages.length) return;
  revealControls();
  schedulePages();
  clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(recordScroll, 200);
}, { passive: true });
previous.addEventListener('click', () => goTo(page - 1));
next.addEventListener('click', () => goTo(page + 1));
byId<HTMLFormElement>('page-jump').addEventListener('submit', event => {
  event.preventDefault();
  goTo(pageInput.valueAsNumber);
});
byId('zoom-in').addEventListener('click', () => { zoom = Math.min(3, zoom + .25); resize(); });
byId('zoom-out').addEventListener('click', () => { zoom = Math.max(.75, zoom - .25); resize(); });
panelToggle.addEventListener('click', () => setHighlightsOpen(highlightsPanel.hidden === true));
byId('close-highlights').addEventListener('click', () => setHighlightsOpen(false));
textToggle.addEventListener('click', () => {
  recordScroll();
  textView = !textView;
  localStorage.setItem('paper-text-view', textView ? '1' : '0');
  pendingTextJump = undefined;
  layout(readingPosition());
  revealControls();
});
mobile.addEventListener('change', () => {
  textToggle.hidden = !mobile.matches;
  textView = mobile.matches && localStorage.getItem('paper-text-view') === '1';
  revealControls();
  resize();
});
scroller.addEventListener('click', revealControls);
for (const bar of [readerHeader, readerFooter]) {
  bar.addEventListener('focusin', revealControls);
  bar.addEventListener('focusout', revealControls);
  bar.addEventListener('pointerdown', revealControls);
}
more.addEventListener('toggle', revealControls);
document.addEventListener('click', event => {
  if (more.open && !more.contains(event.target as Node)) more.open = false;
});
more.addEventListener('keydown', event => {
  if (event.key === 'Escape' && more.open) {
    more.open = false;
    more.querySelector('summary')?.focus();
  }
});
highlightsPanel.addEventListener('keydown', event => {
  if (event.key === 'Escape') setHighlightsOpen(false);
});
document.addEventListener('selectionchange', trackSelection);
mark.addEventListener('pointerdown', event => event.preventDefault());
mark.addEventListener('click', () => {
  if (!selection.length) return;
  for (const item of selection) {
    highlights.push(item);
    sync.change({ add: item });
  }
  window.getSelection()?.removeAllRanges();
  setSelection([]);
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
