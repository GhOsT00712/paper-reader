import type { PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist';

interface Region {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const fullPageBudget = 4_000_000;
const previewBudget = 1_000_000;
const overscan = 160;

export function renderPdfRaster(page: PDFPageProxy, view: PageViewport, sheet: HTMLElement, scroller: HTMLElement) {
  const ratio = window.devicePixelRatio || 1;
  const area = view.width * view.height;
  const needsDetail = area * ratio ** 2 > fullPageBudget;
  const fullPage = { left: 0, top: 0, right: view.width, bottom: view.height };
  const layer = document.createElement('div');
  layer.className = 'pdf-raster';
  layer.setAttribute('aria-hidden', 'true');
  sheet.prepend(layer);

  function draw(region: Region, density: number, className: string) {
    const canvas = document.createElement('canvas');
    canvas.className = className;
    const width = region.right - region.left;
    const height = region.bottom - region.top;
    canvas.width = Math.ceil(width * density);
    canvas.height = Math.ceil(height * density);
    canvas.style.left = region.left + 'px';
    canvas.style.top = region.top + 'px';
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    const xScale = canvas.width / width;
    const yScale = canvas.height / height;
    const task = page.render({
      canvas, viewport: view,
      transform: [xScale, 0, 0, yScale, -region.left * xScale, -region.top * yScale]
    });
    return { canvas, task, region };
  }

  const preview = draw(fullPage, needsDetail ? Math.sqrt(previewBudget / area) : ratio, 'pdf-base');
  layer.append(preview.canvas);
  let rendered: ReturnType<typeof draw> | undefined;
  let pending: ReturnType<typeof draw> | undefined;
  let disposed = false;

  function covers(region: Region, visible: Region) {
    return region.left <= visible.left && region.top <= visible.top &&
      region.right >= visible.right && region.bottom >= visible.bottom;
  }

  function cancelPending() {
    const task: RenderTask | undefined = pending?.task;
    pending = undefined;
    task?.cancel();
  }

  function update() {
    if (!needsDetail || disposed) return;
    const pageBox = sheet.getBoundingClientRect();
    const scrollBox = scroller.getBoundingClientRect();
    const left = scrollBox.left + scroller.clientLeft - pageBox.left;
    const top = scrollBox.top + scroller.clientTop - pageBox.top;
    const visible = {
      left: Math.max(0, left), top: Math.max(0, top),
      right: Math.min(view.width, left + scroller.clientWidth),
      bottom: Math.min(view.height, top + scroller.clientHeight)
    };
    if (visible.left >= visible.right || visible.top >= visible.bottom) {
      cancelPending();
      rendered?.canvas.remove();
      rendered = undefined;
      return;
    }
    if (pending && covers(pending.region, visible)) return;
    cancelPending();
    if (rendered && covers(rendered.region, visible)) return;

    const region = {
      left: Math.max(0, Math.floor(visible.left - overscan)),
      top: Math.max(0, Math.floor(visible.top - overscan)),
      right: Math.min(view.width, Math.ceil(visible.right + overscan)),
      bottom: Math.min(view.height, Math.ceil(visible.bottom + overscan))
    };
    const detailArea = (region.right - region.left) * (region.bottom - region.top);
    const density = Math.min(ratio, Math.sqrt(24_000_000 / detailArea));
    const detail = draw(region, density, 'pdf-detail');
    pending = detail;
    void detail.task.promise.then(() => {
      if (pending !== detail) return;
      rendered?.canvas.remove();
      layer.append(detail.canvas);
      rendered = detail;
    }).catch(() => {
      // The full-page preview remains visible if a detail render is cancelled.
    }).finally(() => {
      if (pending === detail) pending = undefined;
    });
  }

  return {
    ready: preview.task.promise,
    update,
    destroy() {
      disposed = true;
      preview.task.cancel();
      cancelPending();
      layer.remove();
    }
  };
}
