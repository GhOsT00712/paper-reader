import type { Paper } from './paper';

const fields = ['title', 'url', 'authors', 'tags', 'note', 'created_at', 'read_at'] as const;

function csvCell(value: string) {
  const safe = /^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

function bibValue(value: string) {
  return value.replace(/[{}\\%&#_$^~]/g, character => '\\' + character).replace(/\s+/g, ' ').trim();
}

export function exportPapers(papers: Paper[], type: 'json' | 'csv' | 'bib') {
  let content: string;
  if (type === 'json') {
    content = JSON.stringify(papers, null, 2);
  } else if (type === 'csv') {
    content = [fields.join(','), ...papers.map(paper => fields.map(key => csvCell(paper[key] ?? '')).join(','))].join('\r\n');
  } else {
    content = papers.map(paper => {
      const values = [
        ['title', paper.title], ['author', paper.authors?.split(',').join(' and ')],
        ['url', paper.url], ['keywords', paper.tags], ['note', paper.note]
      ];
      return '@misc{paper' + paper.id + ',\n' + values.filter(([, value]) => value)
        .map(([key, value]) => '  ' + key + ' = {' + bibValue(value!) + '},').join('\n') + '\n}';
    }).join('\n\n');
  }
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'paper-reader.' + type;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
