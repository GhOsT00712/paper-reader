import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import type { Highlight } from './pdf-state';

type Structure = Awaited<ReturnType<PDFPageProxy['getStructTree']>>;

interface Heading {
  level: number;
}

interface TextRun {
  source: HTMLElement;
  visible: HTMLSpanElement;
  box: DOMRect;
  heading?: Heading;
}

interface Row {
  top: number;
  height: number;
  runs: TextRun[];
}

export interface TextPage {
  content: HTMLElement;
  runs: TextRun[];
  origin: HTMLElement;
}

function groupRows(runs: TextRun[]): Row[] {
  const rows: Row[] = [];
  for (const run of [...runs].sort((a, b) => a.box.top - b.box.top)) {
    const row = rows.at(-1);
    if (row && Math.abs(row.top - run.box.top) < Math.min(row.height, run.box.height) * .55) {
      row.runs.push(run);
      row.height = Math.max(row.height, run.box.height);
    } else {
      rows.push({ top: run.box.top, height: run.box.height, runs: [run] });
    }
  }
  return rows;
}

function readingRows(runs: TextRun[], bounds: DOMRect) {
  const rows = groupRows(runs);
  const middle = bounds.left + bounds.width / 2;
  const gutter = bounds.width * .013;
  const side = (run: TextRun) => run.box.right <= middle + gutter ? -1 : run.box.left >= middle - gutter ? 1 : 0;
  const body = runs.filter(run => run.box.width > bounds.width * .12);
  const leftRows = groupRows(body.filter(run => side(run) < 0));
  const rightRows = groupRows(body.filter(run => side(run) > 0));
  // Columns often start on different baselines. Look for several overlapping
  // lines with substantial text on both sides of the gutter.
  const paired = leftRows.filter(left => rightRows.some(right =>
    Math.abs(left.top - right.top) < Math.max(left.height, right.height) &&
    Math.min(...right.runs.map(run => run.box.left)) -
      Math.max(...left.runs.map(run => run.box.right)) > gutter));
  if (paired.length < 3 || rightRows.length < 3) return rows;

  const ordered: Row[] = [];
  let columns: TextRun[] = [];
  const flush = () => {
    ordered.push(...groupRows(columns.filter(run => side(run) < 0)),
      ...groupRows(columns.filter(run => side(run) > 0)));
    columns = [];
  };
  for (const row of rows) {
    if (row.runs.some(run => side(run) === 0)) {
      flush();
      ordered.push(row);
    } else {
      columns.push(...row.runs);
    }
  }
  flush();
  return ordered;
}

function taggedHeadings(tree: Structure | null) {
  const headings = new Map<string, Heading>();
  function visit(node: Structure | Structure['children'][number], heading?: Heading) {
    if ('role' in node) {
      const level = /^H([1-6])?$/.exec(node.role);
      const tagged = node.role === 'Title' ? { level: 2 } :
        level ? { level: Math.min(6, Number(level[1] ?? 1) + 1) } : heading;
      for (const child of node.children) visit(child, tagged);
    } else if (heading && node.type === 'content') {
      headings.set(node.id, heading);
    }
  }
  if (tree) visit(tree);
  return headings;
}

function headingFor(source: HTMLElement, headings: Map<string, Heading>) {
  for (let node = source.parentElement; node?.classList.contains('markedContent'); node = node.parentElement) {
    const heading = headings.get(node.id);
    if (heading) return heading;
  }
}

function inferredHeading(line: string, row: Row, previous: Row | undefined, body: number, firstPage: boolean) {
  const label = line.trim().replace(/:$/, '');
  if (label.length < 2 || label.length > 160 || /[.!?]$/.test(label) ||
      /^(?:figure|fig\.|table)\s+\d/i.test(label)) return 0;
  const section = /^(?:abstract|introduction|background|related work|method(?:s|ology)?|results|discussion|conclusions?|references|bibliography|acknowledg[e]?ments?|appendix(?: [a-z])?|limitations|future work)$/i;
  if (section.test(label)) return 3;
  const numbered = /^(\d{1,2}(?:\.\d{1,2})*)\.?\s+\p{L}/u.exec(label);
  const startsBlock = !previous || row.top <= previous.top || row.top - previous.top > body * 1.4;
  if (numbered && label.length <= 100 && (startsBlock || row.height >= body * 1.12)) {
    return Math.min(6, 3 + numbered[1].split('.').length - 1);
  }
  if (row.height >= body * 1.22 && (startsBlock || row.height > (previous?.height ?? body) * 1.14)) {
    return firstPage && row.height >= body * 1.45 ? 2 : 3;
  }
  return 0;
}

export function reflowText(origin: HTMLElement, spans: HTMLElement[], structure: Structure | null, firstPage: boolean): TextPage | null {
  const headings = taggedHeadings(structure);
  const runs = spans.flatMap(source => {
    if (!source.textContent?.trim() || source.firstChild?.nodeType !== Node.TEXT_NODE) return [];
    const visible = document.createElement('span');
    visible.textContent = source.textContent;
    return [{ source, visible, box: source.getBoundingClientRect(), heading: headingFor(source, headings) }];
  });
  if (!runs.length) return null;

  const content = document.createElement('div');
  content.className = 'reflow-text';
  let block: HTMLElement | undefined;
  let previous: Row | undefined;
  let previousHeading: Heading | undefined;
  const ordered: TextRun[] = [];
  const rows = readingRows(runs, origin.getBoundingClientRect());
  const heights = rows.map(row => row.height).sort((a, b) => a - b);
  const bodyHeight = heights[Math.floor(heights.length / 2)];
  for (const row of rows) {
    const line = row.runs.sort((a, b) => a.box.left - b.box.left);
    const tagged = line[0].heading;
    const level = tagged?.level ?? inferredHeading(line.map(run => run.visible.textContent).join(' '), row, previous, bodyHeight, firstPage);
    const sameHeading = tagged && tagged === previousHeading;
    if (!block || !sameHeading && (level || previousHeading || block.tagName !== 'P' || !previous ||
        row.top < previous.top || row.top - previous.top > Math.max(row.height, previous.height) * 1.65 ||
        row.height > previous.height * 1.25 || previous.height > row.height * 1.25)) {
      block = document.createElement(level ? 'h' + level : 'p');
      block.dir = 'auto';
      content.append(block);
    } else {
      block.append(' ');
    }
    line.forEach((run, index) => {
      const prior = line[index - 1];
      if (prior && run.box.left - prior.box.right > row.height * .15) block!.append(' ');
      block!.append(run.visible);
      ordered.push(run);
    });
    previous = row;
    previousHeading = tagged;
  }
  return { content, runs: ordered, origin };
}

function sourceRange(run: TextRun, start: number, end: number) {
  const range = document.createRange();
  range.setStart(run.source.firstChild!, start);
  range.setEnd(run.source.firstChild!, end);
  return range;
}

export function textSelection(page: TextPage, selection: Range, viewport: PageViewport) {
  const origin = page.origin.getBoundingClientRect();
  const rects: Highlight['rects'] = [];
  const passage = document.createRange();
  passage.selectNodeContents(page.content);
  if (page.content.contains(selection.startContainer)) passage.setStart(selection.startContainer, selection.startOffset);
  if (page.content.contains(selection.endContainer)) passage.setEnd(selection.endContainer, selection.endOffset);
  for (const run of page.runs) {
    if (!selection.intersectsNode(run.visible)) continue;
    const node = run.visible.firstChild!;
    const start = selection.startContainer === node ? selection.startOffset : 0;
    const end = selection.endContainer === node ? selection.endOffset : node.textContent!.length;
    if (end <= start) continue;
    for (const box of sourceRange(run, start, end).getClientRects()) {
      if (box.width < 1 || box.height < 1) continue;
      const [x1, y1] = viewport.convertToPdfPoint(box.left - origin.left, box.top - origin.top);
      const [x2, y2] = viewport.convertToPdfPoint(box.right - origin.left, box.bottom - origin.top);
      rects.push([x1, y1, x2, y2]);
    }
  }
  return { text: passage.toString().trim().slice(0, 4000), rects };
}

export function highlightedText(page: TextPage, rects: Highlight['rects'], viewport: PageViewport) {
  const origin = page.origin.getBoundingClientRect();
  const boxes = rects.map(([x1, y1, x2, y2]) => {
    const a = viewport.convertToViewportPoint(x1, y1);
    const b = viewport.convertToViewportPoint(x2, y2);
    return { left: origin.left + Math.min(a[0], b[0]), right: origin.left + Math.max(a[0], b[0]),
      top: origin.top + Math.min(a[1], b[1]), bottom: origin.top + Math.max(a[1], b[1]) };
  });
  const ranges: Range[] = [];
  for (const run of page.runs) {
    const bounds = run.source.getBoundingClientRect();
    const candidates = boxes.filter(box => Math.min(box.bottom, bounds.bottom) - Math.max(box.top, bounds.top) >= bounds.height * .45 &&
      box.right > bounds.left && box.left < bounds.right);
    run.visible.classList.toggle('reflow-highlight', candidates.length > 0 && !CSS.highlights);
    if (!candidates.length || !CSS.highlights) continue;
    const node = run.visible.firstChild!;
    const source = sourceRange(run, 0, 0);
    for (let i = 0; i < node.textContent!.length; i++) {
      source.setStart(run.source.firstChild!, i);
      source.setEnd(run.source.firstChild!, i + 1);
      const glyph = source.getBoundingClientRect();
      if (!glyph.width || !candidates.some(box =>
        Math.min(glyph.right, box.right) - Math.max(glyph.left, box.left) >= glyph.width * .5)) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      ranges.push(range);
    }
  }
  return ranges;
}
